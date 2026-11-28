import express from "express";
import { Keypair, Networks, nativeToScVal } from "@stellar/stellar-sdk";
import { decodeEvent } from "./decoder.js";
import { generateStreamProof } from "./proof.js";
import { StreamStore } from "./store.js";
import { getGlobalRpcManager } from "./rpc-manager.js";
import type { EndpointHealth, RateBudgetSnapshot } from "./rpc-manager.js";
import { IngestPipeline, type EventsPage, type TickReport } from "./ingest/pipeline.js";
import type { SequencerMetrics } from "./ingest/sequencer.js";
import { WebhookDispatcher } from "./webhooks/dispatcher.js";
import type { WebhookEndpoint } from "./webhooks/types.js";
import { validateWebhookUrl } from "./webhooks/ssrf.js";
import { WebhookSubscriptionRegistry, SubscriptionError } from "./webhooks/registry.js";
import { TenantDirectory, directoryFromEnv, type Principal } from "./webhooks/tenants.js";
import { WebhookMetrics } from "./webhooks/metrics.js";
import { SecretCipher } from "./webhooks/secrets.js";
import { sanitizeAttributes, sanitizeError } from "./privacy.js";
import { OutboxDispatcher } from "./outbox/dispatcher.js";
import { OutboxMetrics } from "./outbox/metrics.js";
import { httpPushTransport } from "./outbox/http-transport.js";
import { traceCorrelationRegistry } from "./telemetry.js";
import { createGracefulShutdown, installShutdownHandlers } from "./shutdown.js";
import { AnomalyEngine } from "./anomaly/engine.js";
import type { AnomalyAlertSink } from "./anomaly/alerts.js";
import { FanOutAlertSink, LogAlertSink, WebhookAlertSink, redactEvidence, redactSubject } from "./anomaly/alerts.js";
import {
  DEFAULT_SUPPRESSION_TTL_MS,
  HYDRATE_LEDGERS_ENV,
  REPLAY_MAX_EVENTS_ENV,
  SUPPRESSION_TTL_ENV,
  TenantRuleSource,
  defaultModeFromEnv,
  promotionReport,
  ruleOverridesFromEnv,
  type PromotionReport,
} from "./anomaly/config.js";
import { AnomalyMetrics } from "./anomaly/metrics.js";
import type { AnomalyStore } from "./anomaly/store.js";
import { parseIncidentKey } from "./anomaly/dedup.js";
import { RULE_IDS, RuleConfigError, effectiveRule, type EffectiveRule } from "./anomaly/rules.js";
import { DEFAULT_REPLAY_MAX_EVENTS, replayDetection } from "./anomaly/replay.js";
import { toObservation } from "./anomaly/observations.js";
import { FEEDBACK_LABELS, type Detection, type FeedbackLabel, type Observation, type RuleMode, type TenantRuleOverride } from "./anomaly/types.js";
import { AnalyticsMetrics } from "./analytics/metrics.js";
import { AnalyticsRefresher } from "./analytics/refresh.js";
import { registerAnalyticsRoutes, type AnalyticsApiConfig } from "./analytics/api.js";
import { ANALYTICS_ENV, DEFAULT_ANALYTICS_CONFIG } from "./analytics/types.js";
import { GrpcIndexerServer } from "./grpc/server.js";
import { loadRotationConfig, rpcAuthHeaders } from "./secrets/config.js";
import { WebhookKeyRotation } from "./secrets/rotation.js";
import { registerGraphQLRoutes, type GraphQLHandlerOptions } from "./graphql/index.js";
import { TimeTravelError, TimeTravelService, type TimeTravelPolicy } from "./history/time-travel.js";
import { WasmPluginHost } from "./wasm/host.js";
import { PluginDispatcher } from "./wasm/dispatcher.js";
import type { DecodedEvent, EventValue, Stream } from "./types.js";

/** Express types a path parameter as `string | string[]`; routes take one id. */
function routeId(req: express.Request, name = "id"): string {
  return String(req.params[name] ?? "");
}

/**
 * Keep the legacy single-tenant webhook routes on their upstream wire contract.
 * The tenant registry exposes its richer subscription DTOs separately; the
 * store's encryption/tenancy metadata must not leak into these responses.
 */
function legacyWebhookEndpoint(endpoint: WebhookEndpoint) {
  return {
    id: endpoint.id,
    url: endpoint.url,
    secret: endpoint.secret,
    previous_secret: endpoint.previous_secret,
    events: endpoint.events,
    status: endpoint.status,
    created_at: endpoint.created_at,
    updated_at: endpoint.updated_at,
  };
}

function parseCursor(raw: unknown): number {
  const value = Number(raw ?? 0);
  return Number.isInteger(value) && value >= 0 ? value : -1;
}

function parseLimit(raw: unknown, def: number, max: number): number {
  const value = Number(raw ?? def);
  return Number.isInteger(value) && value >= 1 && value <= max ? value : def;
}

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** Same as `envInt`, but 0 is a legitimate value. */
function envNonNegativeInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

/** A fraction in [0, 1], the shape every SLA breach budget takes. */
function envRatio(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be a fraction between 0 and 1`);
  return value;
}

/** Ledger to index from on a fresh database; unset means "start at the tip". */
function configuredStartLedger(): number | undefined {
  const raw = process.env.START_LEDGER;
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw)) throw new Error("START_LEDGER must be an integer ledger sequence");
  return Number(raw) > 0 ? Number(raw) : undefined;
}

/** What the ingestion pipelines report on `/health` and `/api/ingest/stats`. */
export interface IngestStats {
  lastTick: TickReport | null;
  sequencer: SequencerMetrics;
  budget: RateBudgetSnapshot;
}

/**
 * Signing material for `/streams/:id/proof` (issue #182). The proof endpoint is
 * only meaningful with a checkpoint signer, so it is supplied by `run()` from
 * the environment and left out of `createApp` calls from tests — an unconfigured
 * app answers 503 on that route instead of failing to boot.
 */
export interface ProofConfig {
  networkPassphrase: string;
  contractId: string;
  signer: Keypair;
}

/**
 * Tenant isolation for the webhook management API (issue #585). Supplied by
 * `run()`; left out of `createApp` calls from tests, which then keep the
 * historical single-tenant behaviour against the raw store.
 */
export interface WebhookApiConfig {
  directory: TenantDirectory;
  registry: WebhookSubscriptionRegistry;
  metrics?: WebhookMetrics;
  /** Tenant used when the deployment provisions no keys, i.e. trusts its transport. */
  defaultTenantId?: string;
}

/**
 * The heuristic anomaly detector's management surface (issue #582): which
 * rules a tenant runs with, what they fired on, whether a detection replays,
 * and whether a shadow rule has earned the right to page anyone.
 */
export interface AnomalyApiConfig {
  engine: AnomalyEngine;
  store: AnomalyStore;
  rules: TenantRuleSource;
  directory: TenantDirectory;
  metrics: AnomalyMetrics;
  /** Tenant used when the deployment provisions no keys, i.e. trusts its transport. */
  defaultTenantId?: string;
  /** How long a false-positive review suppresses its subject, absent a request override. */
  suppressionTtlMs?: number;
  /** Cap on the events one replay may read. */
  replayMaxEvents?: number;
}

function ruleView(rule: EffectiveRule): Record<string, unknown> {
  return {
    id: rule.id,
    version: rule.version,
    summary: rule.summary,
    scope: rule.scope,
    severity: rule.config.severity,
    mode: rule.config.mode,
    false_positive_budget: rule.config.falsePositiveBudget,
    min_reviews: rule.config.minReviews,
    params: Object.entries(rule.config.params).map(([name, value]) => ({
      name,
      value,
      default: rule.params[name]?.default,
      min: rule.params[name]?.min,
      max: rule.params[name]?.max,
      description: rule.params[name]?.description,
    })),
  };
}

/** Redacted for the wire: identifiers keep their prefix, amounts never appear. */
function detectionView(detection: Detection): Record<string, unknown> {
  return {
    id: detection.id,
    rule_id: detection.ruleId,
    rule_version: detection.ruleVersion,
    severity: detection.severity,
    mode: detection.mode,
    subject: redactSubject(detection.subjectKey),
    citation: {
      from_ledger: detection.citation.fromLedger,
      to_ledger: detection.citation.toLedger,
      first_event_id: detection.citation.firstEventId,
      last_event_id: detection.citation.lastEventId,
      start_ms: detection.citation.startMs,
      end_ms: detection.citation.endMs,
    },
    fingerprint: detection.fingerprint,
    evidence: { ...redactEvidence(detection.evidence), cited_event_ids: detection.evidence.citedEventIds },
    params: detection.params,
    created_at_ms: detection.createdAtMs,
  };
}

function bearerToken(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1] : undefined;
}

/** The part of an API config needed to identify a caller. */
interface PrincipalConfig {
  directory: TenantDirectory;
  defaultTenantId?: string;
}

/**
 * Identify the caller of a management API request.
 *
 * With credentials provisioned, the tenant key is presented in
 * `x-streampay-webhook-key` (or a bearer token) and the tenant comes from the
 * directory — never from the request body, which is what makes the isolation
 * unforgeable. With none provisioned the deployment is declaring itself
 * single-tenant, so every request is that one tenant.
 */
function webhookPrincipal(config: PrincipalConfig, req: express.Request): Principal | null {
  if (!config.directory.enforcesAuthentication) {
    return config.directory.principalFor(config.defaultTenantId ?? "default");
  }
  const header = req.headers["x-streampay-webhook-key"];
  const presented = typeof header === "string" && header !== "" ? header : bearerToken(req.headers.authorization);
  return config.directory.resolveKey(presented);
}

/**
 * WASM plugin dispatch for the HTTP API (issue #580). When absent, no
 * `/api/wasm/*` routes exist and SSE behaves exactly as before.
 */
export interface WasmOptions {
  dispatcher: PluginDispatcher;
}

/**
 * Time-travel / as-of read options (issue #577). When absent, the default
 * retention window and cost budget apply and addresses are not redacted —
 * the current REST default.
 */
export interface HistoryOptions {
  policy?: Partial<TimeTravelPolicy>;
  redactAddresses?: boolean;
}

type FeatureApiConfig = WebhookApiConfig | AnomalyApiConfig | AnalyticsApiConfig;
type OptionalApiConfig = GraphQLHandlerOptions | WasmOptions | HistoryOptions | FeatureApiConfig;

function isWebhookApiConfig(value: OptionalApiConfig | undefined): value is WebhookApiConfig {
  return value !== undefined && "registry" in value;
}

function isAnomalyApiConfig(value: OptionalApiConfig | undefined): value is AnomalyApiConfig {
  return value !== undefined && "engine" in value;
}

function isAnalyticsApiConfig(value: OptionalApiConfig | undefined): value is AnalyticsApiConfig {
  return value !== undefined && "refresher" in value;
}

function isFeatureApiConfig(value: OptionalApiConfig | undefined): value is FeatureApiConfig {
  return isWebhookApiConfig(value) || isAnomalyApiConfig(value) || isAnalyticsApiConfig(value);
}

export function createApp(
  store: StreamStore,
  dispatcher?: WebhookDispatcher,
  outboxDispatcher?: OutboxDispatcher,
  outboxMetrics?: OutboxMetrics,
  rpcHealth?: () => EndpointHealth[],
  ingestStats?: () => IngestStats,
  proofConfig?: ProofConfig,
  graphqlOptions?: GraphQLHandlerOptions | FeatureApiConfig,
  wasmOptions?: WasmOptions | FeatureApiConfig,
  historyOptions?: HistoryOptions | FeatureApiConfig,
  webhookApi?: WebhookApiConfig,
  anomalyApi?: AnomalyApiConfig,
  analyticsApi?: AnalyticsApiConfig
): express.Express {
  // Before the upstream transports were added, slots 8–10 held the webhook,
  // anomaly and analytics configs. Recognise those shapes while retaining the
  // upstream GraphQL/WASM/history positions and the appended feature slots.
  for (const option of [graphqlOptions, wasmOptions, historyOptions]) {
    if (isWebhookApiConfig(option)) webhookApi ??= option;
    else if (isAnomalyApiConfig(option)) anomalyApi ??= option;
    else if (isAnalyticsApiConfig(option)) analyticsApi ??= option;
  }
  if (isFeatureApiConfig(graphqlOptions)) graphqlOptions = undefined;
  if (isFeatureApiConfig(wasmOptions)) wasmOptions = undefined;
  if (isFeatureApiConfig(historyOptions)) historyOptions = undefined;

  const app = express();
  app.set("trust proxy", analyticsApi?.trustProxyHops ?? 0);
  app.use(express.json());

  // GraphQL read API over the same projections (#576). REST routes below
  // are unchanged; GraphQL is an additional read surface only.
  registerGraphQLRoutes(app, store, graphqlOptions);

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      status: "ok",
      lastLedger: store.getState("lastLedger") ?? null,
      cursor: store.getState("cursor") ?? null,
      ingest: ingestStats?.() ?? null,
      rpcEndpoints: rpcHealth?.() ?? [],
      checkpointSigner: proofConfig?.signer.publicKey() ?? null,
    });
  });

  // GET /events/stream (SSE push endpoint)
  app.get("/events/stream", (req, res) => {
    const address = req.query.address as string | undefined;
    const streamId = req.query.streamId as string | undefined;
    const lastEventId = (req.headers["last-event-id"] as string | undefined) ?? (req.query.lastEventId as string | undefined);

    if (address && !/^[GCB][A-Z2-7]{55}$/.test(address)) {
      return res.status(400).json({ error: "invalid Stellar address" });
    }
    if (streamId && !/^\d+$/.test(streamId)) {
      return res.status(400).json({ error: "stream id must be an unsigned integer" });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });

    if (typeof (res as unknown as { flushHeaders?: () => void }).flushHeaders === "function") {
      (res as unknown as { flushHeaders: () => void }).flushHeaders();
    }

    // Initial keepalive greeting
    res.write(": ok\n\n");

    const formatSse = (evt: {
      id: string;
      /** Null for an event the registry decoded without a stream id binding. */
      streamId: string | null;
      name: string;
      ledger: number;
      ledgerClosedAt: string;
      payload: Record<string, unknown>;
      stream?: unknown;
    }): string => {
      const data = JSON.stringify({
        id: evt.id,
        streamId: evt.streamId,
        eventType: evt.name,
        ledger: evt.ledger,
        ledgerClosedAt: evt.ledgerClosedAt,
        data: evt.payload,
        stream: evt.stream,
      });
      return `id: ${evt.id}\nevent: ${evt.name}\ndata: ${data}\n\n`;
    };

    // Heartbeat ping every 15 seconds to prevent reverse proxy/load-balancer timeouts
    const pingInterval = setInterval(() => {
      res.write(": ping\n\n");
    }, 15000);

    // WASM plugin dispatch (#580): opt-in per connection with
    // `?tenant=<tenant>&plugin=<digest>`. When both are present (and a
    // dispatcher was configured), live *and* replayed events for this
    // connection run through the tenant's approved plugin — in order, via
    // a promise chain, with live events that arrive during the replay
    // buffered rather than reordered. Dropped events are not written;
    // a failed plugin falls back to the raw (redacted) event. Without
    // those query params the path below is the historical behaviour.
    const wasmTenant = typeof req.query.tenant === "string" ? req.query.tenant : undefined;
    const wasmDigest = typeof req.query.plugin === "string" ? req.query.plugin : undefined;
    const wasm =
      wasmOptions && wasmTenant && wasmDigest
        ? { dispatcher: wasmOptions.dispatcher, tenant: wasmTenant, pluginDigest: wasmDigest }
        : undefined;

    let onLiveEvent: ((event: DecodedEvent, stream?: Stream) => void) | undefined;

    if (wasm) {
      const subscriptionId = `sse:${streamId ?? address ?? "all"}:${wasm.tenant}`;
      wasm.dispatcher.subscribe(subscriptionId, wasm.tenant, wasm.pluginDigest);
      // Serialise dispatch so one connection's events keep journal order
      // even though each transform runs in its own worker thread.
      let chain: Promise<void> = Promise.resolve();
      const enqueue = (fn: () => Promise<void>): void => {
        chain = chain.then(async () => {
          try {
            await fn();
          } catch (err) {
            console.error("[wasm] SSE dispatch failed:", err);
          }
        });
      };
      const dispatchAndWrite = async (event: DecodedEvent, stream?: Stream): Promise<void> => {
        if (streamId && event.streamId !== streamId) return;
        if (address && stream && stream.sender !== address && stream.recipient !== address) return;
        const result = await wasm.dispatcher.dispatch(event, subscriptionId);
        if (!result.event) return; // dropped by the plugin
        res.write(
          formatSse({
            id: result.event.id,
            streamId: result.event.streamId,
            name: result.event.name,
            ledger: result.event.ledger,
            ledgerClosedAt: result.event.ledgerClosedAt,
            payload: result.event.data as Record<string, unknown>,
            stream,
          }),
        );
      };
      let replayDone = false;
      const pending: Array<{ event: DecodedEvent; stream?: Stream }> = [];
      onLiveEvent = (event, stream) => {
        if (!replayDone) {
          pending.push({ event, stream });
          return;
        }
        enqueue(() => dispatchAndWrite(event, stream));
      };
      store.on("event", onLiveEvent);
      void (async () => {
        if (lastEventId) {
          const historical = store.getEventsAfter(lastEventId, address, streamId);
          for (const evt of historical) {
            await dispatchAndWrite(
              {
                id: evt.id,
                pagingToken: evt.id,
                ledger: evt.ledger,
                ledgerClosedAt: evt.ledgerClosedAt,
                contractId: "",
                name: evt.name,
                streamId: evt.streamId,
                data: evt.payload as Record<string, EventValue>,
              },
              evt.stream,
            );
          }
        }
        replayDone = true;
        for (const item of pending.splice(0)) {
          enqueue(() => dispatchAndWrite(item.event, item.stream));
        }
      })();
      req.on("close", () => {
        clearInterval(pingInterval);
        if (onLiveEvent) store.off("event", onLiveEvent);
        wasm.dispatcher.unsubscribe(subscriptionId);
        res.end();
      });
      return;
    }

    // Replay historical events if lastEventId was supplied
    if (lastEventId) {
      const historical = store.getEventsAfter(lastEventId, address, streamId);
      for (const evt of historical) {
        res.write(formatSse(evt));
      }
    }

    // Subscribe to live events
    onLiveEvent = (event: DecodedEvent, stream?: Stream) => {
      if (streamId && event.streamId !== streamId) {
        return;
      }
      if (address && stream && stream.sender !== address && stream.recipient !== address) {
        return;
      }
      res.write(
        formatSse({
          id: event.id,
          streamId: event.streamId,
          name: event.name,
          ledger: event.ledger,
          ledgerClosedAt: event.ledgerClosedAt,
          payload: event.data as Record<string, unknown>,
          stream,
        }),
      );
    };

    store.on("event", onLiveEvent);

    req.on("close", () => {
      clearInterval(pingInterval);
      if (onLiveEvent) store.off("event", onLiveEvent);
      res.end();
    });
  });

  // Trace correlation endpoints for distributed tracing across the async event seam
  app.post("/api/traces/correlate", (req, res) => {
    const { txHash, traceContext, streamId } = req.body || {};
    if (!txHash || !traceContext?.traceId || !traceContext?.spanId) {
      return res.status(400).json({ error: "txHash, traceContext.traceId, and traceContext.spanId are required" });
    }
    traceCorrelationRegistry.register(String(txHash), traceContext, streamId ? String(streamId) : undefined);
    return res.status(200).json({ ok: true, txHash, streamId });
  });

  app.get("/api/traces/correlate", (req, res) => {
    const txHash = req.query.txHash as string | undefined;
    const streamId = req.query.streamId as string | undefined;
    const context = (txHash ? traceCorrelationRegistry.get(txHash) : null) || (streamId ? traceCorrelationRegistry.getByStream(streamId) : null);
    if (!context) {
      return res.status(404).json({ error: "correlation not found" });
    }
    return res.json({ ok: true, context });
  });

  // Full ingestion accounting for the parallel ingester (issue #117): the depth
  // the budget allowed, how deep the reorder buffer actually got, and the
  // late/duplicate/gap counters that tell an operator whether the ordering
  // guards are being exercised in production.
  app.get("/api/ingest/stats", (_req, res) => {
    const stats = ingestStats?.();
    return stats ? res.json(stats) : res.status(503).json({ error: "ingestion not running" });
  });

  // GET /streams?recipient=<address>
  app.get("/streams", (req, res) => {
    const recipient = req.query.recipient as string | undefined;
    if (!recipient) {
      return res.json([]);
    }
    const streams = store.listStreamsByRecipient(recipient);
    return res.json(streams);
  });

  // GET /streams/:id/history
  app.get("/streams/:id/history", (req, res) => {
    const streamId = routeId(req);
    if (!streamId) {
      return res.json([]);
    }
    const history = store.getStreamHistory(streamId);
    return res.json(history);
  });

  // GET /streams/:id
  app.get("/streams/:id", (req, res) => {
    if (!/^\d+$/.test(routeId(req))) return res.status(400).json({ error: "stream id must be an unsigned integer" });
    const stream = store.getStream(routeId(req));
    return stream ? res.json(stream) : res.status(404).json({ error: "stream not found" });
  });

  // GET /streams/:id/proof — light-client checkpoint proof (#182). The indexer
  // hashes every stream it has projected into a Merkle state root and signs the
  // checkpoint, so a client can verify one stream's state against the signed root
  // instead of trusting this endpoint's word for it. `streamToProofEntry` builds
  // the canonical ledger-entry XDR, so the leaf the client re-hashes is the leaf
  // the chain would have produced.
  app.get("/streams/:id/proof", (req, res) => {
    if (!/^\d+$/.test(routeId(req))) return res.status(400).json({ error: "stream id must be an unsigned integer" });
    if (!proofConfig) return res.status(503).json({ error: "proof endpoint is not configured: set CHECKPOINT_SIGNER_SECRET" });
    const stream = store.getStream(routeId(req));
    if (!stream) return res.status(404).json({ error: "stream not found" });
    const ledger = Number(store.getState("lastLedger") ?? stream.lastLedger);
    const ledgerCloseTime = Math.floor(new Date(stream.updatedAt).getTime() / 1000) || Math.floor(Date.now() / 1000);
    const proof = generateStreamProof({
      networkPassphrase: proofConfig.networkPassphrase,
      contractId: proofConfig.contractId,
      ledger,
      ledgerCloseTime,
      streams: store.listAllStreams(),
      targetStreamId: routeId(req),
      signer: proofConfig.signer,
    });
    return res.json(proof);
  });

  // GET /streams/:id/as-of?ledger=<seq> — time-travel read (#577): the
  // record the projection held at that ledger, the journal events that
  // produce it, and a Merkle proof a client can verify without trusting
  // this endpoint. Expired history is 410, an over-budget fold is 413 —
  // never a silently partial answer.
  const timeTravel = new TimeTravelService(store, historyOptions?.policy);
  const historyRedaction = (): boolean =>
    historyOptions?.redactAddresses ?? process.env.REDACT_ADDRESSES === "1";
  const parseAsOfLedger = (req: express.Request, res: express.Response): number | undefined => {
    const raw = req.query.ledger;
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
      res.status(400).json({ error: "ledger query parameter must be a non-negative integer ledger sequence", code: "invalid_ledger" });
      return undefined;
    }
    return Number(raw);
  };
  const sendTimeTravelError = (res: express.Response, err: unknown): void => {
    if (err instanceof TimeTravelError) {
      const status = err.code === "history_expired" ? 410 : err.code === "cost_budget_exceeded" ? 413 : 400;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  };

  app.get("/streams/:id/as-of", (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "stream id must be an unsigned integer" });
    const ledger = parseAsOfLedger(req, res);
    if (ledger === undefined) return;
    try {
      const result = timeTravel.getStreamAsOf(req.params.id, ledger, { redact: historyRedaction() });
      return result
        ? res.json(result)
        : res.status(404).json({ error: `stream ${req.params.id} has no state at ledger ${ledger}` });
    } catch (err) {
      return sendTimeTravelError(res, err);
    }
  });

  // GET /address/:addr/as-of?ledger=<seq> — the address's whole portfolio
  // reconstructed at that ledger, each stream with its own proof (#577).
  app.get("/address/:addr/as-of", (req, res) => {
    if (!/^[GCB][A-Z2-7]{55}$/.test(req.params.addr)) {
      return res.status(400).json({ error: "invalid Stellar address" });
    }
    const ledger = parseAsOfLedger(req, res);
    if (ledger === undefined) return;
    try {
      return res.json(timeTravel.getPortfolioAsOf(req.params.addr, ledger, { redact: historyRedaction() }));
    } catch (err) {
      return sendTimeTravelError(res, err);
    }
  });

  // GET /streams/:id/events?after=<seq>&limit=<n> — transactional-outbox replay.
  // Consumers replay from their last durable cursor; duplicates (at-least-once
  // transport) are detectable via the per-row idempotency_key and seq ordering.
  app.get("/streams/:id/events", (req, res) => {
    if (!/^\d+$/.test(routeId(req))) return res.status(400).json({ error: "stream id must be an unsigned integer" });
    const after = parseCursor(req.query.after);
    if (after < 0) return res.status(400).json({ error: "after must be a non-negative integer cursor" });
    const limit = parseLimit(req.query.limit, 100, 1000);
    return res.json(store.outbox.replayEvents(routeId(req), after, limit));
  });

  // ---------- outbox management API ----------

  app.get("/api/outbox/consumers", (_req, res) => res.json(store.outbox.listConsumers()));

  app.post("/api/outbox/consumers", async (req, res) => {
    const { id, kind, url, secret, max_attempts: maxAttempts, rate_limit_per_sec: rateLimit } = req.body || {};
    if (kind !== "push" && kind !== "pull") return res.status(400).json({ error: "kind must be push or pull" });
    if (kind === "push") {
      if (!url || typeof url !== "string") return res.status(400).json({ error: "push consumers require a url" });
      const ssrf = await validateWebhookUrl(url);
      if (!ssrf.safe) return res.status(400).json({ error: `SSRF validation failed: ${ssrf.reason}` });
    }
    try {
      const consumer = store.outbox.createConsumer({
        id: typeof id === "string" ? id : undefined,
        kind,
        url: typeof url === "string" ? url : null,
        secret: typeof secret === "string" ? secret : null,
        max_attempts: typeof maxAttempts === "number" ? maxAttempts : undefined,
        rate_limit_per_sec: typeof rateLimit === "number" && rateLimit > 0 ? rateLimit : null,
      });
      return res.status(201).json(consumer);
    } catch (err: unknown) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/outbox/consumers/:id", (req, res) => {
    const consumer = store.outbox.getConsumer(routeId(req));
    return consumer ? res.json(consumer) : res.status(404).json({ error: "consumer not found" });
  });

  app.post("/api/outbox/consumers/:id/status", (req, res) => {
    const status = req.body?.status;
    if (status !== "active" && status !== "disabled") return res.status(400).json({ error: "status must be active or disabled" });
    const ok = store.outbox.setConsumerStatus(routeId(req), status);
    return ok ? res.json({ ok: true }) : res.status(404).json({ error: "consumer not found" });
  });

  app.delete("/api/outbox/consumers/:id", (req, res) => {
    const deleted = store.outbox.deleteConsumer(routeId(req));
    return deleted ? res.json({ ok: true }) : res.status(404).json({ error: "consumer not found" });
  });

  app.get("/api/outbox/intents", (req, res) => {
    const state = req.query.state as string | undefined;
    if (state && !["pending", "in_flight", "delivered", "dead"].includes(state)) {
      return res.status(400).json({ error: "invalid state filter" });
    }
    const limit = parseLimit(req.query.limit, 50, 500);
    return res.json(store.outbox.listIntents({
      state: state as "pending" | undefined,
      consumerId: typeof req.query.consumer === "string" ? req.query.consumer : undefined,
      limit,
    }));
  });

  app.post("/api/outbox/intents/:id/replay", (req, res) => {
    const id = Number(routeId(req));
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "intent id must be a positive integer" });
    const replayed = store.outbox.replayIntent(id);
    return replayed ? res.json({ ok: true }) : res.status(404).json({ error: "dead-letter intent not found" });
  });

  // Reorg retraction hook, called by the dual-read reconciliation service when
  // the indexer journal diverges from on-chain truth above a ledger boundary.
  app.post("/api/outbox/retract", (req, res) => {
    const afterLedger = Number(req.body?.after_ledger);
    if (!Number.isInteger(afterLedger) || afterLedger < 0) return res.status(400).json({ error: "after_ledger must be a non-negative integer" });
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "reorg";
    const result = store.outbox.retractAfterLedger(afterLedger, reason);
    outboxMetrics?.observeRetract(result.events_retracted, result.intents_retracted);
    return res.json(result);
  });

  app.get("/api/outbox/stats", (_req, res) => res.json(store.outbox.stats()));

  if (analyticsApi) registerAnalyticsRoutes(app, store.analytics, analyticsApi);

  app.post("/api/outbox/flush", async (_req, res) => {
    if (!outboxDispatcher) return res.status(503).json({ error: "outbox dispatcher not configured" });
    return res.json(await outboxDispatcher.tick());
  });

  // Prometheus text exposition on the indexer's own surface.
  app.get("/metrics", (_req, res) => {
    const sections: string[] = [];
    if (outboxMetrics) sections.push(outboxMetrics.render(store.outbox.stats()).trimEnd());
    if (webhookApi?.metrics) {
      sections.push(webhookApi.metrics.render(store.webhooks.deliveryStats()).trimEnd());
    }
    if (anomalyApi) sections.push(anomalyApi.metrics.render().trimEnd());
    if (analyticsApi && analyticsApi.enabled !== false) sections.push(analyticsApi.metrics.render(store.analytics.snapshot()).trimEnd());
    if (sections.length === 0) sections.push("# no metrics configured");
    res.setHeader("Content-Type", "text/plain; version=0.0.4");
    return res.send(`${sections.join("\n")}\n`);
  });

  // GET /address/:addr/streams
  app.get("/address/:addr/streams", (req, res) => {
    const address = req.params.addr;
    if (!/^[GCB][A-Z2-7]{55}$/.test(address)) return res.status(400).json({ error: "invalid Stellar address" });
    const streams = store.listAddress(address);
    return res.json({ address, count: streams.length, streams });
  });

  // ── Webhook management API ─────────────────────────────────────────────────
  // With a registry configured every route is tenant-scoped: the tenant comes
  // from the presented credential, another tenant's id reads as 404, and no
  // response but the one that mints a secret ever carries secret material.
  // Without one, the routes behave as they always did for a single-tenant
  // deployment.
  const tenantRoute =
    (handler: (principal: Principal, req: express.Request, res: express.Response) => unknown | Promise<unknown>) =>
    async (req: express.Request, res: express.Response): Promise<void> => {
      let principal: Principal = { tenantId: "", keyId: "legacy", authenticated: false };
      if (webhookApi) {
        try {
          principal = webhookPrincipal(webhookApi, req) ?? principal;
          if (principal.keyId === "legacy") {
            res.status(401).json({
              error: "a tenant webhook key is required in x-streampay-webhook-key",
              code: "unauthenticated",
            });
            return;
          }
        } catch (err: unknown) {
          res.status(503).json({ error: sanitizeError(err), code: "tenant_unprovisioned" });
          return;
        }
      }
      try {
        const result = await handler(principal, req, res);
        if (result !== undefined && !res.headersSent) res.json(result);
      } catch (err: unknown) {
        if (err instanceof SubscriptionError) {
          res.status(err.status).json(err.toJSON());
          return;
        }
        res.status(500).json({ error: sanitizeError(err), code: "internal_error" });
      }
    };

  /** Registry-only routes answer 503 for a deployment that runs the legacy single-tenant store. */
  const registryOnly = (res: express.Response): boolean => {
    if (webhookApi) return true;
    res.status(503).json({ error: "webhook registry not configured", code: "registry_unavailable" });
    return false;
  };

  app.get(
    "/api/webhooks/endpoints",
    tenantRoute((principal) => {
      if (!webhookApi) return store.webhooks.listEndpoints().map(legacyWebhookEndpoint);
      return webhookApi.registry.list(principal).subscriptions;
    })
  );

  app.post(
    "/api/webhooks/endpoints",
    tenantRoute(async (principal, req, res) => {
      if (!webhookApi) {
        const { url, events, secret } = req.body || {};
        if (!url || typeof url !== "string") {
          res.status(400).json({ error: "URL is required" });
          return;
        }
        const ssrf = await validateWebhookUrl(url);
        if (!ssrf.safe) {
          res.status(400).json({ error: `SSRF validation failed: ${ssrf.reason}` });
          return;
        }
        return legacyWebhookEndpoint(store.webhooks.createEndpoint({
          url,
          events: Array.isArray(events) ? events : ["*"],
          secret: typeof secret === "string" ? secret : undefined,
        }));
      }
      const { url, events, secret } = req.body || {};
      const created = await webhookApi.registry.create(principal, {
        url,
        events: Array.isArray(events) ? events : undefined,
        secret: typeof secret === "string" ? secret : undefined,
      });
      // The signing secret is disclosed here and never again.
      res.status(201);
      return { ...created.subscription, secret: created.secret_once };
    })
  );

  app.get(
    "/api/webhooks/endpoints/:id",
    tenantRoute((principal, req, res) => {
      if (!webhookApi) {
        const ep = store.webhooks.getEndpoint(routeId(req));
        if (!ep) {
          res.status(404).json({ error: "Endpoint not found" });
          return;
        }
        return legacyWebhookEndpoint(ep);
      }
      return webhookApi.registry.get(principal, routeId(req));
    })
  );

  app.patch(
    "/api/webhooks/endpoints/:id",
    tenantRoute(async (principal, req, res) => {
      if (!registryOnly(res)) return;
      const { url, events, status } = req.body || {};
      return webhookApi!.registry.update(principal, routeId(req), {
        url,
        events: Array.isArray(events) ? events : undefined,
        status: status === "active" || status === "disabled" ? status : undefined,
      });
    })
  );

  app.post(
    "/api/webhooks/endpoints/:id/rotate-secret",
    tenantRoute((principal, req, res) => {
      if (!webhookApi) {
        try {
          return store.webhooks.rotateEndpointSecret(routeId(req));
        } catch (err: unknown) {
          res.status(404).json({ error: sanitizeError(err) });
          return;
        }
      }
      const rotated = webhookApi.registry.rotateSecret(principal, routeId(req));
      return {
        secret: rotated.secret_once,
        previous_secret: null,
        fingerprint: rotated.fingerprint,
        previous_fingerprint: rotated.previous_fingerprint,
        expires_at: rotated.expires_at,
      };
    })
  );

  app.get(
    "/api/webhooks/endpoints/:id/rotations",
    tenantRoute((principal, req, res) => {
      if (!registryOnly(res)) return;
      return webhookApi!.registry.rotationHistory(principal, routeId(req), parseLimit(req.query.limit, 20, 100));
    })
  );

  app.get(
    "/api/webhooks/quota",
    tenantRoute((principal, _req, res) => {
      if (!registryOnly(res)) return;
      return webhookApi!.registry.list(principal).quota;
    })
  );

  app.delete(
    "/api/webhooks/endpoints/:id",
    tenantRoute((principal, req, res) => {
      if (!webhookApi) {
        const deleted = store.webhooks.deleteEndpoint(routeId(req));
        if (!deleted) {
          res.status(404).json({ error: "Endpoint not found" });
          return;
        }
        return { ok: true };
      }
      return webhookApi.registry.remove(principal, routeId(req));
    })
  );

  app.post(
    "/api/webhooks/endpoints/:id/test",
    tenantRoute(async (principal, req, res) => {
      if (!dispatcher) {
        res.status(503).json({ error: "Webhook dispatcher not configured", code: "dispatcher_unavailable" });
        return;
      }
      // Ownership is checked before the dispatcher, which is tenant-blind.
      if (webhookApi) webhookApi.registry.get(principal, routeId(req));
      return await dispatcher.testFireEndpoint(routeId(req));
    })
  );

  app.get(
    "/api/webhooks/deliveries",
    tenantRoute((principal, req) => {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
      if (!webhookApi) return store.webhooks.listDeliveries(limit);
      return webhookApi.registry.deliveries(principal, limit);
    })
  );

  app.get(
    "/api/webhooks/dlq",
    tenantRoute((principal, req) => {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
      if (!webhookApi) return store.webhooks.listDLQ(limit);
      return webhookApi.registry.dlq(principal, limit);
    })
  );

  app.post(
    "/api/webhooks/dlq/:id/retry",
    tenantRoute((principal, req, res) => {
      if (!webhookApi) {
        const success = store.webhooks.replayDLQItem(routeId(req));
        if (!success) {
          res.status(404).json({ error: "DLQ item not found" });
          return;
        }
        return { ok: true, replayed: true };
      }
      return webhookApi.registry.replayDlq(principal, routeId(req));
    })
  );

  app.get(
    "/api/webhooks/sla",
    tenantRoute((principal, _req, res) => {
      if (!registryOnly(res)) return;
      return webhookApi!.registry.sla(principal);
    })
  );

  app.post(
    "/api/webhooks/rotations/expire",
    tenantRoute((_principal, _req, res) => {
      if (!registryOnly(res)) return;
      return webhookApi!.registry.retireExpiredRotations();
    })
  );

  // ── Anomaly detection API (issue #582) ─────────────────────────────────────
  // Rules are configuration, detections are evidence, and a detection is only
  // as good as the ledger range it cites: every read here is tenant-scoped and
  // every identifier leaving here is redacted.
  if (anomalyApi) {
    const api = anomalyApi;

    const anomalyRoute =
      (handler: (tenantId: string, req: express.Request, res: express.Response) => unknown | Promise<unknown>) =>
      async (req: express.Request, res: express.Response): Promise<void> => {
        let tenantId = api.defaultTenantId ?? "default";
        if (api.directory.enforcesAuthentication) {
          const principal = webhookPrincipal(api, req);
          if (principal === null) {
            res.status(401).json({
              error: "a tenant key is required in x-streampay-webhook-key",
              code: "unauthenticated",
            });
            return;
          }
          tenantId = principal.tenantId;
        }
        try {
          const result = await handler(tenantId, req, res);
          if (result !== undefined && !res.headersSent) res.json(result);
        } catch (err: unknown) {
          if (err instanceof RuleConfigError) {
            res.status(err.code === "unknown_rule" ? 404 : 400).json({ error: err.message, code: err.code, details: err.details });
            return;
          }
          res.status(500).json({ error: sanitizeError(err), code: "internal_error" });
        }
      };

    /** Owned by the caller tenant, or invisible: a foreign id must not confirm existence. */
    const ownedDetection = (tenantId: string, id: string, res: express.Response): Detection | undefined => {
      const detection = api.store.getDetection(id);
      if (detection === undefined || detection.tenantId !== tenantId) {
        res.status(404).json({ error: "detection not found", code: "not_found" });
        return undefined;
      }
      return detection;
    };

    app.get(
      "/api/anomaly/rules",
      anomalyRoute((tenantId) => ({ tenant_id: tenantId, rules: api.rules.rulesFor(tenantId).map(ruleView) }))
    );

    app.post(
      "/api/anomaly/rules/:ruleId/override",
      anomalyRoute((tenantId, req) => {
        const ruleId = routeId(req, "ruleId");
        const body = (req.body ?? {}) as Record<string, unknown>;
        const override: TenantRuleOverride = {};
        if (typeof body["mode"] === "string") override.mode = body["mode"] as RuleMode;
        if (typeof body["severity"] === "string") override.severity = body["severity"] as Detection["severity"];
        if (body["params"] !== undefined && typeof body["params"] === "object") {
          override.params = body["params"] as Record<string, number>;
        }
        if (typeof body["false_positive_budget"] === "number") override.false_positive_budget = body["false_positive_budget"];
        if (typeof body["min_reviews"] === "number") override.min_reviews = body["min_reviews"];

        // A POST replaces the tenant's override for that rule; an unknown rule
        // or param is a validation error, never a silent default.
        const rule = effectiveRule(ruleId, override);
        api.store.setOverride(tenantId, ruleId, override, Date.now());
        api.rules.invalidate(tenantId);
        return { rule: ruleView(rule) };
      })
    );

    app.delete(
      "/api/anomaly/rules/:ruleId/override",
      anomalyRoute((tenantId, req) => {
        const ruleId = routeId(req, "ruleId");
        if (!RULE_IDS.includes(ruleId)) {
          throw new RuleConfigError("unknown_rule", `unknown rule '${ruleId}'`, { rule: ruleId, known: RULE_IDS });
        }
        api.store.setOverride(tenantId, ruleId, null, Date.now());
        api.rules.invalidate(tenantId);
        return { rule: ruleView(effectiveRule(ruleId)) };
      })
    );

    app.get(
      "/api/anomaly/detections",
      anomalyRoute((tenantId, req) => {
        const limit = parseLimit(req.query.limit, 50, 200);
        const mode = typeof req.query.mode === "string" ? (req.query.mode as RuleMode) : undefined;
        if (mode !== undefined && mode !== "shadow" && mode !== "enforce") {
          return { error: "mode must be 'shadow' or 'enforce'", code: "invalid_mode" };
        }
        const ruleId = typeof req.query.rule === "string" ? req.query.rule : undefined;
        return {
          tenant_id: tenantId,
          detections: api.store
            .listDetections({ tenantId, ruleId, mode, limit })
            .map(detectionView),
        };
      })
    );

    app.get(
      "/api/anomaly/detections/:id",
      anomalyRoute((tenantId, req, res) => {
        const detection = ownedDetection(tenantId, routeId(req), res);
        if (detection === undefined) return undefined;
        return { detection: detectionView(detection), feedback: api.store.listFeedback(detection.id) };
      })
    );

    app.post(
      "/api/anomaly/detections/:id/replay",
      anomalyRoute((tenantId, req, res) => {
        const detection = ownedDetection(tenantId, routeId(req), res);
        if (detection === undefined) return undefined;
        const outcome = replayDetection(store, detection, { maxEvents: api.replayMaxEvents });
        api.metrics.recordReplay(
          outcome.verified ? "verified" : outcome.reason === "not_reproduced" ? "mismatch" : "unavailable"
        );
        return outcome;
      })
    );

    app.post(
      "/api/anomaly/detections/:id/feedback",
      anomalyRoute((tenantId, req, res) => {
        const detection = ownedDetection(tenantId, routeId(req), res);
        if (detection === undefined) return undefined;
        const body = (req.body ?? {}) as Record<string, unknown>;
        const label = body["label"];
        if (typeof label !== "string" || !(FEEDBACK_LABELS as readonly string[]).includes(label)) {
          res.status(400).json({ error: `label must be one of ${FEEDBACK_LABELS.join(", ")}`, code: "invalid_label" });
          return undefined;
        }
        const typedLabel = label as FeedbackLabel;
        const existing = api.store.listFeedback(detection.id);
        if (existing.length > 0 && !api.store.hasFeedback(detection.id, typedLabel)) {
          // Two contradictory reviews of one detection make the budget a
          // function of who looked last, so the first verdict stands.
          res.status(409).json({ error: "detection already reviewed", code: "already_reviewed", label: existing[0]?.label });
          return undefined;
        }

        let suppressedUntilMs: number | null = null;
        if (typedLabel === "false_positive" && existing.length === 0) {
          const requested = typeof body["suppress_ms"] === "number" ? body["suppress_ms"] : (api.suppressionTtlMs ?? DEFAULT_SUPPRESSION_TTL_MS);
          const ttl = Math.min(30 * 24 * 60 * 60 * 1000, Math.max(0, Math.floor(requested)));
          suppressedUntilMs = Date.now() + ttl;
          api.store.suppress({
            tenantId,
            ruleId: detection.ruleId,
            subjectKey: detection.subjectKey,
            expiresAtMs: suppressedUntilMs,
            reason: "operator_false_positive",
          });
        }

        if (existing.length === 0) {
          api.store.recordFeedback({
            id: `fbr_${detection.id}`,
            detectionId: detection.id,
            tenantId,
            label: typedLabel,
            note: typeof body["note"] === "string" ? body["note"].slice(0, 500) : null,
            createdAtMs: Date.now(),
          });
          api.metrics.recordFeedback(detection.ruleId, typedLabel);
        }
        return { detection_id: detection.id, label: typedLabel, suppressed_until_ms: suppressedUntilMs };
      })
    );

    app.get(
      "/api/anomaly/promotion",
      anomalyRoute((tenantId) => {
        const reports: PromotionReport[] = [];
        for (const ruleId of RULE_IDS) {
          const report = promotionReport(api.store, api.rules, tenantId, ruleId, Date.now());
          api.metrics.recordPromotionReady(ruleId, tenantId, report.ready);
          reports.push(report);
        }
        return { tenant_id: tenantId, reports };
      })
    );

    app.post(
      "/api/anomaly/rules/:ruleId/promote",
      anomalyRoute((tenantId, req, res) => {
        const ruleId = routeId(req, "ruleId");
        const report = promotionReport(api.store, api.rules, tenantId, ruleId, Date.now());
        api.metrics.recordPromotionReady(ruleId, tenantId, report.ready);
        if (!report.ready) {
          res.status(409).json({
            error: "the rule has not been validated well enough to page on",
            code: "promotion_not_ready",
            reasons: report.reasons,
            report,
          });
          return undefined;
        }
        const override: TenantRuleOverride = { ...api.store.getOverride(tenantId, ruleId), mode: "enforce" };
        const rule = effectiveRule(ruleId, override);
        api.store.setOverride(tenantId, ruleId, override, Date.now());
        api.rules.invalidate(tenantId);
        return { rule: ruleView(rule), report };
      })
    );

    app.get(
      "/api/anomaly/incidents",
      anomalyRoute((tenantId) => {
        const now = Date.now();
        return {
          tenant_id: tenantId,
          incidents: api.engine
            .openIncidentKeys()
            .map((key) => parseIncidentKey(key))
            .filter((parsed) => parsed.tenantId === tenantId)
            .map((parsed) => ({ rule_id: parsed.ruleId, subject: redactSubject(parsed.subjectKey) })),
          tracked_subjects: {
            sender: api.engine.trackedSubjects("sender").length,
            pair: api.engine.trackedSubjects("pair").length,
          },
          suppressions: api.store.listSuppressions(tenantId, now).map((record) => ({
            rule_id: record.ruleId,
            subject: redactSubject(record.subjectKey),
            expires_at_ms: record.expiresAtMs,
            reason: record.reason,
          })),
        };
      })
    );
  }

  // ---------- WASM plugin management API (#580) ----------
  // Only present when a dispatcher was configured. Plugins are registered
  // by content digest and must be approved per tenant before they can run;
  // see indexer/README.md ("WASM plugin filters") for the full flow.
  if (wasmOptions) {
    const { dispatcher: wasmDispatcher } = wasmOptions;
    const digestParam = (req: express.Request, res: express.Response): string | undefined => {
      const digest = req.params.digest;
      if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
        res.status(400).json({ error: "digest must be a lowercase hex sha256" });
        return undefined;
      }
      return digest;
    };

    app.get("/api/wasm/plugins", (_req, res) => res.json(store.wasm.listPlugins()));

    app.post("/api/wasm/plugins", (req, res) => {
      const { bytesBase64, version, name } = req.body || {};
      if (typeof bytesBase64 !== "string" || typeof version !== "string") {
        return res.status(400).json({ error: "bytesBase64 and version are required" });
      }
      try {
        const bytes = Buffer.from(bytesBase64, "base64");
        const record = store.wasm.register(bytes, version, typeof name === "string" ? name : undefined);
        return res.status(201).json({ digest: record.digest, version: record.version, name: record.name, size: record.bytes.length });
      } catch (err: unknown) {
        return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.post("/api/wasm/plugins/:digest/approve", (req, res) => {
      const digest = digestParam(req, res);
      if (!digest) return;
      const tenant = req.body?.tenant;
      if (typeof tenant !== "string" || !tenant) return res.status(400).json({ error: "tenant is required" });
      try {
        return res.json(store.wasm.approve(tenant, digest));
      } catch (err: unknown) {
        return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.post("/api/wasm/plugins/:digest/revoke", (req, res) => {
      const digest = digestParam(req, res);
      if (!digest) return;
      const tenant = req.body?.tenant;
      if (typeof tenant !== "string" || !tenant) return res.status(400).json({ error: "tenant is required" });
      return res.json({ ok: true, revoked: store.wasm.revoke(tenant, digest) });
    });

    app.post("/api/wasm/subscriptions", (req, res) => {
      const { subscriptionId, tenant, pluginDigest } = req.body || {};
      if (typeof subscriptionId !== "string" || typeof tenant !== "string" || typeof pluginDigest !== "string") {
        return res.status(400).json({ error: "subscriptionId, tenant and pluginDigest are required" });
      }
      try {
        wasmDispatcher.subscribe(subscriptionId, tenant, pluginDigest);
        return res.status(201).json({ subscriptionId, tenant, pluginDigest });
      } catch (err: unknown) {
        return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.delete("/api/wasm/subscriptions/:id", (req, res) => {
      const id = req.params.id;
      if (typeof id !== "string") return res.status(400).json({ error: "subscription id must be a string" });
      return res.json({ ok: true, removed: wasmDispatcher.unsubscribe(id) });
    });

    app.get("/api/wasm/fallbacks", (_req, res) => {
      return res.json(wasmDispatcher.fallbackLog.slice(-100));
    });
  }

  return app;
}

export async function run(): Promise<void> {
  const rpcUrl = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
  const contractId = process.env.CONTRACT_ID;
  const pollInterval = Number(process.env.POLL_INTERVAL_MS ?? 5000);
  const port = Number(process.env.PORT ?? 8787);
  const dbPath = process.env.DATABASE_PATH ?? "./data/streampay.sqlite";

  if (!contractId) throw new Error("CONTRACT_ID is required");
  if (!Number.isFinite(pollInterval) || pollInterval < 250) throw new Error("POLL_INTERVAL_MS must be at least 250");

  const webhookCipher = SecretCipher.fromEnv();
  if (webhookCipher === null) {
    console.warn(
      "[indexer] WEBHOOK_SECRET_ENCRYPTION_KEY is unset: webhook signing secrets are stored in the clear. " +
        "Set it to a 32-byte hex key before serving more than one tenant."
    );
  }
  const analyticsEnabled = process.env[ANALYTICS_ENV.enabled] !== "0";
  const initialLedger = configuredStartLedger();
  if (analyticsEnabled && initialLedger === undefined) {
    throw new Error("START_LEDGER must name a ledger before the contract's first event when analytics is enabled");
  }
  const analyticsConfig = {
    bucketMs: envInt(ANALYTICS_ENV.bucketMs, DEFAULT_ANALYTICS_CONFIG.bucketMs),
    refreshIntervalMs: envInt(ANALYTICS_ENV.refreshMs, DEFAULT_ANALYTICS_CONFIG.refreshIntervalMs),
    batchSize: envInt(ANALYTICS_ENV.batchSize, DEFAULT_ANALYTICS_CONFIG.batchSize),
    sloMs: envInt(ANALYTICS_ENV.sloMs, DEFAULT_ANALYTICS_CONFIG.sloMs),
    maxWaitMs: envNonNegativeInt(ANALYTICS_ENV.maxWaitMs, DEFAULT_ANALYTICS_CONFIG.maxWaitMs),
    waitPollMs: envInt(ANALYTICS_ENV.waitPollMs, DEFAULT_ANALYTICS_CONFIG.waitPollMs),
    throughputBudgetPerSecond: envInt(ANALYTICS_ENV.budgetEps, DEFAULT_ANALYTICS_CONFIG.throughputBudgetPerSecond),
  };
  const store = new StreamStore(dbPath, {
    webhookCipher,
    analytics: { config: analyticsConfig, historyStartLedger: initialLedger, certifyHistory: analyticsEnabled },
  });
  const analyticsMetrics = new AnalyticsMetrics();
  const analyticsRefresher = new AnalyticsRefresher(store.analytics, analyticsMetrics);
  if (analyticsEnabled) analyticsRefresher.start();

  const { directory, defaultTenantId } = directoryFromEnv();
  const webhookMetrics = new WebhookMetrics({
    slaMs: envInt("WEBHOOK_SLA_MS", 5_000),
    breachBudget: envRatio("WEBHOOK_SLA_BREACH_BUDGET", 0.01),
    minSamples: envInt("WEBHOOK_SLA_MIN_SAMPLES", 20),
  });
  const webhookRegistry = new WebhookSubscriptionRegistry({
    store: store.webhooks,
    directory,
    metrics: webhookMetrics,
    rotationOverlapMs: envInt("WEBHOOK_SECRET_ROTATION_OVERLAP_MS", 24 * 60 * 60 * 1000),
    requireEncryption: process.env.WEBHOOK_REQUIRE_ENCRYPTION === "1",
    // One JSON line per registry action, with the URL masked and the secret
    // represented only by its fingerprint.
    onAudit: (event) =>
      console.log(
        JSON.stringify({
          service: "streampay-indexer",
          component: "webhooks",
          ...sanitizeAttributes({ ...event, fingerprint: undefined, secret_fingerprint: event.fingerprint }),
        })
      ),
  });

  // ── Heuristic anomaly detection (issue #582) ───────────────────────────────
  // Rules run on ledger-close time, so a restart has to rebuild the windows
  // from the journal before a wide-window rule can be trusted again.
  const anomalyMetrics = new AnomalyMetrics();
  const anomalyRules = new TenantRuleSource({
    store: store.anomaly,
    directory,
    base: ruleOverridesFromEnv(),
    defaultMode: defaultModeFromEnv(),
    defaultTenantId,
  });
  const anomalySinks: AnomalyAlertSink[] = [new LogAlertSink()];
  if (process.env.ANOMALY_WEBHOOK_ALERTS !== "0") anomalySinks.push(new WebhookAlertSink(store.webhooks));
  const anomalyEngine = new AnomalyEngine({
    rules: anomalyRules,
    store: store.anomaly,
    sinks: [new FanOutAlertSink(anomalySinks)],
    metrics: anomalyMetrics,
    dedupOptions: {
      flapWindowMs: envInt("ANOMALY_FLAP_WINDOW_MS", 120_000),
      renotifyAfterMs: envNonNegativeInt("ANOMALY_RENOTIFY_AFTER_MS", 0),
    },
  });

  const hydrateLedgers = envNonNegativeInt(HYDRATE_LEDGERS_ENV, 2_880);
  const lastLedgerRaw = store.getState("lastLedger");
  if (lastLedgerRaw !== undefined && hydrateLedgers > 0) {
    const to = Number(lastLedgerRaw);
    const page = store.eventsForAnomaly(Math.max(0, to - hydrateLedgers), to, envInt("ANOMALY_HYDRATE_MAX_EVENTS", 50_000));
    if (page.truncated) {
      console.warn(
        `[indexer] anomaly windows hydrated from a truncated range; wide-window rules under-report until the pattern advances past it`
      );
    }
    // Hydrate, do not re-observe: sweeping is muted while the historical range
    // is replayed, because the restored incidents are not in the engine's live
    // window set yet and an intermediate cycle would read a half-restored
    // process as "everything resolved" and page a second time.
    anomalyEngine.hydrate(
      page.events
        .map(toObservation)
        .filter((observation): observation is Observation => observation !== null)
    );
  }

  store.on("event", (event: DecodedEvent) => {
    try {
      anomalyEngine.observe(
        toObservation({
          id: event.id,
          name: event.name,
          ledger: event.ledger,
          ledgerClosedAt: event.ledgerClosedAt,
          streamId: event.streamId,
          data: event.data as Record<string, unknown>,
        })
      );
    } catch (error) {
      // A detector failure must never take ingestion down with it.
      console.error("[indexer] anomaly evaluation failed:", error);
    }
  });

  // ── Checkpoint signer for `/streams/:id/proof` (#182) ──────────────────────
  // An ephemeral `Keypair.random()` keeps a throwaway indexer running, but its
  // signatures die with the process and a client cannot pin them, so a real
  // deploy must set CHECKPOINT_SIGNER_SECRET.
  const checkpointSigner = process.env.CHECKPOINT_SIGNER_SECRET
    ? Keypair.fromSecret(process.env.CHECKPOINT_SIGNER_SECRET)
    : Keypair.random();
  const networkPassphrase = process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET;

  // ── RPC manager: shared across the indexer, replaces the ad-hoc fetch helper.
  // Additional endpoints can be added via RPC_URL_FALLBACK_1, RPC_URL_FALLBACK_2 env vars.
  //
  // Credentials travel as per-request headers (issue #615), so a rotation swaps
  // them between requests instead of tearing down client connections.
  const rpcHeaders = rpcAuthHeaders(process.env);
  const rpcEndpoints = [{ url: rpcUrl, headers: rpcHeaders }];
  for (let i = 1; i <= 5; i++) {
    const extra = process.env[`RPC_URL_FALLBACK_${i}`];
    if (extra) rpcEndpoints.push({ url: extra, headers: rpcHeaders });
  }
  const manager = getGlobalRpcManager({
    endpoints: rpcEndpoints,
    maxRps: Number(process.env.RPC_MAX_RPS ?? "10"),
    failureThreshold: 3,
    lagThresholdSeconds: 60,
    hedgeDelayMs: 300,
    healthCheckIntervalMs: 15_000,
    timeoutMs: 20_000,
  });

  const dispatcher = new WebhookDispatcher(store.webhooks, 2000, { metrics: webhookMetrics });
  dispatcher.start();

  // ── Webhook signing-key rotation (issue #615): the sweep retires a previous
  // key once its overlap window has elapsed. Verification already refuses an
  // expired previous key, so a paused or delayed sweep can only keep a key for
  // its full window — never longer.
  const rotationConfig = loadRotationConfig(process.env);
  const webhookRotation = new WebhookKeyRotation(store.webhooks, { policy: rotationConfig.policy });
  const webhookSweep = setInterval(
    () => webhookRotation.sweep(),
    rotationConfig.webhookSweepIntervalMs
  );
  webhookSweep.unref();

  const outboxMetrics = new OutboxMetrics({
    alarmWindow: envInt("OUTBOX_ALARM_WINDOW", 8),
    alarmMinDepth: envInt("OUTBOX_ALARM_MIN_DEPTH", 1000),
  });
  const outboxDispatcher = new OutboxDispatcher(store.outbox, httpPushTransport, outboxMetrics, {
    tickMs: envInt("OUTBOX_TICK_MS", 1000),
    batchSize: Math.min(1000, envInt("OUTBOX_BATCH_SIZE", 200)),
    claimTimeoutMs: envInt("OUTBOX_CLAIM_TIMEOUT_MS", 60_000),
    maxDepth: process.env.OUTBOX_MAX_DEPTH ? envInt("OUTBOX_MAX_DEPTH", 1) : undefined,
  });
  outboxDispatcher.start();

  // ── WASM plugin filters (#580) ──────────────────────────────────────────
  // Plugins run sandboxed per subscription; a runaway plugin falls back to
  // the raw stream (see src/wasm/). Redaction of delivered events is opt-in
  // via WASM_REDACTION_ENABLED=1 and always runs after plugin transforms.
  const wasmHost = new WasmPluginHost({
    timeoutMs: Number(process.env.WASM_PLUGIN_TIMEOUT_MS ?? "500"),
  });
  const wasmDispatcher = new PluginDispatcher(store.wasm, wasmHost, {
    redactionEnabled: process.env.WASM_REDACTION_ENABLED === "1",
    onFallback: (alert) =>
      console.warn(
        `[wasm] fallback subscription=${alert.subscriptionId} event=${alert.eventId} reason=${alert.reason}`,
      ),
  });

  // `stream_refund_target_changed` (#204) is projected into `streams.refund_target`
  // by the store, so it has to be fetched for that column to ever be filled.
  // `batch_withdraw_summary` (#205) names no single stream — it is keyed by the
  // recipient and covers the whole `withdraw_many` call. The per-stream
  // `withdrawn` events the same call publishes remain the authoritative source
  // for the projections, so subscribing to the summary adds the batch record to
  // the journal without touching any row.
  const eventNames = [
    "stream_created",
    "withdrawn",
    "stream_cancelled",
    "stream_topped_up",
    "stream_paused",
    "stream_resumed",
    "rate_change_accepted",
    "ownership_accepted",
    "sender_transferred",
    "stream_refund_target_changed",
    "batch_withdraw_summary",
    "streams_created",
  ];
  const topicFilters = eventNames.map((name) => [nativeToScVal(name, { type: "symbol" }).toXDR("base64")]);

  // ── Parallel ledger-window ingestion (issue #117) ──────────────────────────
  // Concurrency is not a constant here: the pipeline reads the same rate budget
  // the RPC manager enforces (issue #56/#100) and never plans more in-flight
  // requests than that budget can fund. INGEST_MAX_IN_FLIGHT only lowers the
  // ceiling, it cannot raise the budget.
  let lastTick: TickReport | undefined;
  const pipeline = new IngestPipeline({
    source: {
      getLatestLedger: () => manager.getLatestLedger(),
      getEvents: (params) => manager.getEvents(params) as Promise<EventsPage>,
      getRateBudget: () => manager.getRateBudget(),
    },
    sink: store,
    decode: (event) => decodeEvent(event, { contractId }),
    filters: [{ type: "contract", contractIds: [contractId], topics: topicFilters }],
    initialLedger,
    pageLimit: envInt("INGEST_PAGE_LIMIT", 1000),
    windowLedgers: envInt("INGEST_WINDOW_LEDGERS", 20),
    maxWindowLedgers: envInt("INGEST_MAX_WINDOW_LEDGERS", 5_000),
    maxWindowsPerTick: envInt("INGEST_MAX_WINDOWS_PER_TICK", 200),
    maxInFlight: envInt("INGEST_MAX_IN_FLIGHT", 8),
    confirmations: envNonNegativeInt("INGEST_CONFIRMATIONS", 0),
    maxPagesPerWindow: envInt("INGEST_MAX_PAGES_PER_WINDOW", 8),
    parallel: process.env.INGEST_PARALLEL !== "0",
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  const app = createApp(
    store,
    dispatcher,
    outboxDispatcher,
    outboxMetrics,
    () => manager.getHealth(),
    () => ({
      lastTick: lastTick ?? null,
      sequencer: pipeline.metrics(),
      budget: manager.getRateBudget(),
    }),
    { networkPassphrase, contractId, signer: checkpointSigner },
    undefined,
    { dispatcher: wasmDispatcher },
    undefined,
    { directory, registry: webhookRegistry, metrics: webhookMetrics, defaultTenantId },
    {
      engine: anomalyEngine,
      store: store.anomaly,
      rules: anomalyRules,
      directory,
      metrics: anomalyMetrics,
      defaultTenantId,
      suppressionTtlMs: envInt(SUPPRESSION_TTL_ENV, DEFAULT_SUPPRESSION_TTL_MS),
      replayMaxEvents: envInt(REPLAY_MAX_EVENTS_ENV, DEFAULT_REPLAY_MAX_EVENTS),
    },
    {
      refresher: analyticsRefresher,
      metrics: analyticsMetrics,
      enabled: analyticsEnabled,
      apiToken: process.env[ANALYTICS_ENV.apiToken]?.trim() || undefined,
      mutationRateLimitPerSecond: Math.max(1, envInt(ANALYTICS_ENV.mutationRate, 5)),
      trustProxyHops: envNonNegativeInt("TRUST_PROXY_HOPS", 0),
    }
  );

  async function poll(): Promise<void> {
    lastTick = await pipeline.runTick();
    if (!lastTick.ok) throw new Error(`ingest tick failed: ${lastTick.error ?? "unknown error"}`);
    if (!lastTick.caughtUp) {
      console.warn(`[indexer] tick stopped at ledger ${lastTick.resumeAt ?? "?"} with a lagging endpoint or dense window; resuming next tick`);
    }
  }

  const server = app.listen(port, () => console.log(`StreamPay indexer listening on http://localhost:${port}`));

  // gRPC streaming transport (issue #579): server-streaming Subscribe on
  // node:http2, alongside REST/SSE. Disabled with GRPC_PORT=0.
  const grpcPort = Number(process.env.GRPC_PORT ?? 8788);
  let grpcServer: GrpcIndexerServer | undefined;
  if (grpcPort > 0) {
    grpcServer = new GrpcIndexerServer(store, {
      port: grpcPort,
      maxSubscriptionsPerTenant: envInt("GRPC_MAX_SUBSCRIPTIONS_PER_TENANT", 5),
      maxEventsPerSecondPerTenant: envInt("GRPC_MAX_EVENTS_PER_SECOND_PER_TENANT", 100),
      maxQueuePerSubscription: envInt("GRPC_MAX_QUEUE_PER_SUBSCRIPTION", 100),
    });
    const actualGrpcPort = await grpcServer.listen(grpcPort);
    console.log(`StreamPay indexer gRPC listening on http://localhost:${actualGrpcPort} (streampay.indexer.v1.StreamPayIndexer/Subscribe)`);
  }
  let inFlightPoll: Promise<void> | null = null;
  let shuttingDown = false;

  async function pollSafely(): Promise<void> {
    if (inFlightPoll || shuttingDown) return;
    inFlightPoll = (async () => {
      try {
        await poll();
      } catch (error) {
        console.error("Indexer poll failed:", error);
      }
    })();
    try {
      await inFlightPoll;
    } finally {
      inFlightPoll = null;
    }
  }

  void pollSafely();
  const pollTimer = setInterval(() => void pollSafely(), pollInterval);

  // SIGTERM/SIGINT: drain in-flight ingest and outbox dispatch, bounded by
  // SHUTDOWN_DRAIN_MS, before closing the store (see ./shutdown.ts).
  const shutdown = createGracefulShutdown({
    drainMs: envInt("SHUTDOWN_DRAIN_MS", 10_000),
    stopAccepting: () => {
      shuttingDown = true;
      clearInterval(pollTimer);
      analyticsRefresher.stop();
      server.close();
      // SSE streams never end on their own; without this `close()` would wait forever.
      server.closeAllConnections();
      void grpcServer?.close();
    },
    pipeline,
    inFlightIngest: () => inFlightPoll,
    outbox: outboxDispatcher,
    webhooks: dispatcher,
    store,
    exit: (code) => process.exit(code),
    log: (message) => console.warn(message),
  });
  installShutdownHandlers(process, ["SIGINT", "SIGTERM"], shutdown);
}

// Auto-run if executed directly as entrypoint
if (process.argv[1] && (process.argv[1].endsWith("index.js") || process.argv[1].endsWith("index.ts"))) {
  void run();
}
