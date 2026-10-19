import express from "express";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { decodeEvent } from "./decoder.js";
import { StreamStore } from "./store.js";
import type { RpcEvent } from "./types.js";
import { getGlobalRpcManager } from "./rpc-manager.js";
import type { EndpointHealth } from "./rpc-manager.js";
import { WebhookDispatcher } from "./webhooks/dispatcher.js";
import { validateWebhookUrl } from "./webhooks/ssrf.js";
import { OutboxDispatcher } from "./outbox/dispatcher.js";
import { OutboxMetrics } from "./outbox/metrics.js";
import { httpPushTransport } from "./outbox/http-transport.js";

function parseCursor(raw: unknown): number {
  const value = Number(raw ?? 0);
  return Number.isInteger(value) && value >= 0 ? value : -1;
}

function parseLimit(raw: unknown, def: number, max: number): number {
  const value = Number(raw ?? def);
  return Number.isInteger(value) && value >= 1 && value <= max ? value : def;
}

export function createApp(
  store: StreamStore,
  dispatcher?: WebhookDispatcher,
  outboxDispatcher?: OutboxDispatcher,
  outboxMetrics?: OutboxMetrics,
  rpcHealth?: () => EndpointHealth[]
): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      status: "ok",
      lastLedger: store.getState("lastLedger") ?? null,
      cursor: store.getState("cursor") ?? null,
      rpcEndpoints: rpcHealth?.() ?? [],
    });
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
    const streamId = req.params.id;
    if (!streamId) {
      return res.json([]);
    }
    const history = store.getStreamHistory(streamId);
    return res.json(history);
  });

  // GET /streams/:id
  app.get("/streams/:id", (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "stream id must be an unsigned integer" });
    const stream = store.getStream(req.params.id);
    return stream ? res.json(stream) : res.status(404).json({ error: "stream not found" });
  });

  // GET /streams/:id/events?after=<seq>&limit=<n> — transactional-outbox replay.
  // Consumers replay from their last durable cursor; duplicates (at-least-once
  // transport) are detectable via the per-row idempotency_key and seq ordering.
  app.get("/streams/:id/events", (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "stream id must be an unsigned integer" });
    const after = parseCursor(req.query.after);
    if (after < 0) return res.status(400).json({ error: "after must be a non-negative integer cursor" });
    const limit = parseLimit(req.query.limit, 100, 1000);
    return res.json(store.outbox.replayEvents(req.params.id, after, limit));
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
    const consumer = store.outbox.getConsumer(req.params.id);
    return consumer ? res.json(consumer) : res.status(404).json({ error: "consumer not found" });
  });

  app.post("/api/outbox/consumers/:id/status", (req, res) => {
    const status = req.body?.status;
    if (status !== "active" && status !== "disabled") return res.status(400).json({ error: "status must be active or disabled" });
    const ok = store.outbox.setConsumerStatus(req.params.id, status);
    return ok ? res.json({ ok: true }) : res.status(404).json({ error: "consumer not found" });
  });

  app.delete("/api/outbox/consumers/:id", (req, res) => {
    const deleted = store.outbox.deleteConsumer(req.params.id);
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
    const id = Number(req.params.id);
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

  app.post("/api/outbox/flush", async (_req, res) => {
    if (!outboxDispatcher) return res.status(503).json({ error: "outbox dispatcher not configured" });
    return res.json(await outboxDispatcher.tick());
  });

  // Prometheus text exposition on the indexer's own surface.
  app.get("/metrics", (_req, res) => {
    const body = outboxMetrics
      ? outboxMetrics.render(store.outbox.stats())
      : "# no outbox metrics configured\n";
    res.setHeader("Content-Type", "text/plain; version=0.0.4");
    return res.send(body);
  });

  // GET /address/:addr/streams
  app.get("/address/:addr/streams", (req, res) => {
    const address = req.params.addr;
    if (!/^[GCB][A-Z2-7]{55}$/.test(address)) return res.status(400).json({ error: "invalid Stellar address" });
    const streams = store.listAddress(address);
    return res.json({ address, count: streams.length, streams });
  });

  // Webhook management API
  app.get("/api/webhooks/endpoints", (_req, res) => {
    res.json(store.webhooks.listEndpoints());
  });

  app.post("/api/webhooks/endpoints", async (req, res) => {
    const { url, events, secret } = req.body || {};
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL is required" });
    }
    const ssrf = await validateWebhookUrl(url);
    if (!ssrf.safe) {
      return res.status(400).json({ error: `SSRF validation failed: ${ssrf.reason}` });
    }
    const endpoint = store.webhooks.createEndpoint({
      url,
      events: Array.isArray(events) ? events : ["*"],
      secret: typeof secret === "string" ? secret : undefined,
    });
    return res.status(201).json(endpoint);
  });

  app.get("/api/webhooks/endpoints/:id", (req, res) => {
    const ep = store.webhooks.getEndpoint(req.params.id);
    if (!ep) return res.status(404).json({ error: "Endpoint not found" });
    return res.json(ep);
  });

  app.post("/api/webhooks/endpoints/:id/rotate-secret", (req, res) => {
    try {
      const result = store.webhooks.rotateEndpointSecret(req.params.id);
      return res.json(result);
    } catch (err: unknown) {
      return res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/api/webhooks/endpoints/:id", (req, res) => {
    const deleted = store.webhooks.deleteEndpoint(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Endpoint not found" });
    return res.json({ ok: true });
  });

  app.post("/api/webhooks/endpoints/:id/test", async (req, res) => {
    if (!dispatcher) {
      return res.status(500).json({ error: "Webhook dispatcher not configured" });
    }
    const result = await dispatcher.testFireEndpoint(req.params.id);
    return res.json(result);
  });

  app.get("/api/webhooks/deliveries", (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
    return res.json(store.webhooks.listDeliveries(limit));
  });

  app.get("/api/webhooks/dlq", (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
    return res.json(store.webhooks.listDLQ(limit));
  });

  app.post("/api/webhooks/dlq/:id/retry", (req, res) => {
    const success = store.webhooks.replayDLQItem(req.params.id);
    if (!success) return res.status(404).json({ error: "DLQ item not found" });
    return res.json({ ok: true, replayed: true });
  });

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

  const store = new StreamStore(dbPath);

  // ── RPC manager: shared across the indexer, replaces the ad-hoc fetch helper.
  // Additional endpoints can be added via RPC_URL_FALLBACK_1, RPC_URL_FALLBACK_2 env vars.
  const rpcEndpoints = [{ url: rpcUrl }];
  for (let i = 1; i <= 5; i++) {
    const extra = process.env[`RPC_URL_FALLBACK_${i}`];
    if (extra) rpcEndpoints.push({ url: extra });
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

  const dispatcher = new WebhookDispatcher(store.webhooks);
  dispatcher.start();

  const envInt = (name: string, def: number): number => {
    const raw = process.env[name];
    if (raw === undefined) return def;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
  };
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

  const app = createApp(store, dispatcher, outboxDispatcher, outboxMetrics, () => manager.getHealth());

  const eventNames = ["stream_created", "withdrawn", "stream_cancelled", "stream_topped_up", "stream_paused", "stream_resumed"];
  const topicFilters = eventNames.map((name) => [nativeToScVal(name, { type: "symbol" }).toXDR("base64")]);

  interface EventsResult {
    events: RpcEvent[];
    cursor: string;
    latestLedger: number;
  }

  async function poll(): Promise<void> {
    let cursor = store.getState("cursor");
    let startLedger: number | undefined;
    if (!cursor) {
      const configured = process.env.START_LEDGER;
      if (configured && !/^\d+$/.test(configured)) throw new Error("START_LEDGER must be an integer ledger sequence");
      startLedger = configured ? Number(configured) : (await manager.getLatestLedger()).sequence;
    }
    for (;;) {
      const params = {
        ...(cursor ? { cursor } : { startLedger }),
        filters: [{ type: "contract", contractIds: [contractId], topics: topicFilters }],
        pagination: { limit: 1000 },
        xdrFormat: "base64",
      };
      const page = await manager.getEvents(params) as EventsResult;
      const nextCursor = page.cursor || cursor;
      store.ingestPage(page.events.map(decodeEvent), nextCursor, page.latestLedger);
      cursor = nextCursor;
      if (page.events.length < 1000 || !cursor) break;
    }
  }

  app.listen(port, () => console.log(`StreamPay indexer listening on http://localhost:${port}`));
  let polling = false;

  async function pollSafely(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      await poll();
    } catch (error) {
      console.error("Indexer poll failed:", error);
    } finally {
      polling = false;
    }
  }

  void pollSafely();
  setInterval(() => void pollSafely(), pollInterval);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      dispatcher.stop();
      outboxDispatcher.stop();
      store.close();
      process.exit(0);
    });
  }
}

// Auto-run if executed directly as entrypoint
if (process.argv[1] && (process.argv[1].endsWith("index.js") || process.argv[1].endsWith("index.ts"))) {
  void run();
}
