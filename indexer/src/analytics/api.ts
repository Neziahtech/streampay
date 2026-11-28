import { timingSafeEqual } from "node:crypto";
import type express from "express";
import { sanitizeError } from "../privacy.js";
import type { AnalyticsMetrics } from "./metrics.js";
import type { AnalyticsRefresher } from "./refresh.js";
import type { AnalyticsStore } from "./store.js";
import { VIEW_HELP, type ReadGate, type ViewName } from "./types.js";

export interface AnalyticsApiConfig {
  refresher: AnalyticsRefresher;
  metrics: AnalyticsMetrics;
  /** The tables exist either way; this switches the operational surface. */
  enabled?: boolean;
  /** Bearer token required by every analytics route when configured. */
  apiToken?: string;
  /** Per-client fixed-window budget for rebuild and refresh requests. */
  mutationRateLimitPerSecond?: number;
  /** Exact reverse-proxy depth used to derive the rate-limit client address. */
  trustProxyHops?: number;
}

const MAX_FORECAST_POINTS = 10_000;

class RouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function queryInt(raw: unknown, name: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new RouteError(400, `${name} must be a non-negative safe integer`);
  }
  return Number(raw);
}

function queryText(raw: unknown, name: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim() === "" || raw.length > 128) {
    throw new RouteError(400, `${name} must be a non-empty string of at most 128 characters`);
  }
  return raw.trim();
}

function readGate(req: express.Request): ReadGate {
  return {
    minLedger: queryInt(req.query["min_ledger"], "min_ledger"),
    maxLagEvents: queryInt(req.query["max_lag_events"], "max_lag_events"),
    waitMs: queryInt(req.query["wait_ms"], "wait_ms"),
  };
}

/** BigInt amounts cross the wire as decimal strings, never IEEE-754 numbers. */
function sendJson(res: express.Response, status: number, body: unknown): express.Response {
  return res
    .status(status)
    .type("application/json")
    .send(JSON.stringify(body, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value)));
}

async function serveGated<T>(
  res: express.Response,
  store: AnalyticsStore,
  metrics: AnalyticsMetrics,
  view: ViewName,
  gate: ReadGate,
  read: () => T
): Promise<express.Response> {
  const result = await store.readGated(view, gate, read);
  metrics.observeGate(result.ok ? "served" : "waited_out", result.waited_ms);
  if (!result.ok) {
    return sendJson(res, 503, {
      code: "stale_view",
      error: "the requested view did not reach the required freshness before the wait expired",
      view,
      staleness: result.staleness,
      waited_ms: result.waited_ms,
    });
  }
  return sendJson(res, 200, { view, data: result.data, staleness: result.staleness, waited_ms: result.waited_ms });
}

/** Register the materialized-view and recovery surface. */
export function registerAnalyticsRoutes(app: express.Express, store: AnalyticsStore, api: AnalyticsApiConfig): void {
  const enabled = api.enabled !== false;
  const disabled = (res: express.Response): express.Response | null =>
    enabled ? null : sendJson(res, 503, { code: "analytics_disabled", error: "materialized analytics are disabled" });

  const mutationCounts = new Map<string, { startedMs: number; count: number }>();
  const mutationLimit = Math.max(1, Math.floor(api.mutationRateLimitPerSecond ?? 5));
  const allowMutation = (req: express.Request): boolean => {
    const now = Date.now();
    for (const [key, entry] of mutationCounts) {
      if (now - entry.startedMs >= 1000) mutationCounts.delete(key);
    }
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const entry = mutationCounts.get(key);
    if (!entry) {
      if (mutationCounts.size >= 1024) return false;
      mutationCounts.set(key, { startedMs: now, count: 1 });
      return true;
    }
    if (entry.count >= mutationLimit) return false;
    entry.count += 1;
    return true;
  };
  const authorize = (req: express.Request, res: express.Response): boolean => {
    if (!api.apiToken) return true;
    const header = req.headers.authorization;
    const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const expected = Buffer.from(api.apiToken);
    const actual = Buffer.from(supplied);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      sendJson(res, 401, { code: "unauthorized", error: "a valid analytics bearer token is required" });
      return false;
    }
    return true;
  };
  const route =
    (handler: (req: express.Request, res: express.Response) => unknown | Promise<unknown>, mutation = false) =>
    (req: express.Request, res: express.Response): void => {
      if (!authorize(req, res)) return;
      if (mutation && !allowMutation(req)) {
        sendJson(res, 429, { code: "rate_limited", error: "analytics mutation rate limit exceeded" });
        return;
      }
      void Promise.resolve()
        .then(() => handler(req, res))
        .catch((err: unknown) => {
          if (err instanceof RouteError) {
            res.status(err.status).json({ error: err.message });
            return;
          }
          res.status(500).json({ error: sanitizeError(err), code: "internal_error" });
        });
    };

  app.get(
    "/api/analytics/views",
    route((_req, res) => {
      const unavailable = disabled(res);
      if (unavailable) return unavailable;
      const snapshot = store.snapshot();
      return sendJson(res, 200, {
        ...snapshot,
        views: snapshot.views.map((entry) => ({ ...entry, help: VIEW_HELP[entry.view] })),
      });
    })
  );

  app.get(
    "/api/analytics/addresses/:address",
    route(async (req, res) => {
      const unavailable = disabled(res);
      if (unavailable) return unavailable;
      const address = String(req.params.address ?? "");
      if (!/^[GCB][A-Z2-7]{55}$/.test(address)) throw new RouteError(400, "invalid Stellar address");
      const role = queryText(req.query["role"], "role");
      if (role !== undefined && role !== "sender" && role !== "recipient" && role !== "refund") {
        throw new RouteError(400, "role must be sender, recipient or refund");
      }
      const token = queryText(req.query["token"], "token");
      const gate = readGate(req);
      return serveGated(res, store, api.metrics, "address_totals", gate, () => store.readAddress(address, { role, token }));
    })
  );

  app.get(
    "/api/analytics/assets",
    route(async (req, res) => {
      const unavailable = disabled(res);
      if (unavailable) return unavailable;
      const token = queryText(req.query["token"], "token");
      const gate = readGate(req);
      return serveGated(res, store, api.metrics, "asset_totals", gate, () => store.readAsset(token));
    })
  );

  app.get(
    "/api/analytics/accrual",
    route(async (req, res) => {
      const unavailable = disabled(res);
      if (unavailable) return unavailable;
      const token = queryText(req.query["token"], "token");
      const fromMs = queryInt(req.query["from_ms"], "from_ms");
      const toMs = queryInt(req.query["to_ms"], "to_ms");
      if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
        throw new RouteError(400, "from_ms must not exceed to_ms");
      }
      const limit = queryInt(req.query["limit"], "limit") ?? 500;
      if (limit < 1 || limit > 10_000) throw new RouteError(400, "limit must be between 1 and 10000");
      const gate = readGate(req);
      return serveGated(res, store, api.metrics, "accrual_buckets", gate, () =>
        store.readBuckets({ token, fromMs, toMs, limit })
      );
    })
  );

  app.get(
    "/api/analytics/forecast",
    route(async (req, res) => {
      const unavailable = disabled(res);
      if (unavailable) return unavailable;
      const token = queryText(req.query["token"], "token");
      if (!token) throw new RouteError(400, "token is required");
      const atMs = queryInt(req.query["at_ms"], "at_ms") ?? Date.now();
      const horizonMs = queryInt(req.query["horizon_ms"], "horizon_ms") ?? 3_600_000;
      if (horizonMs < 1) throw new RouteError(400, "horizon_ms must be positive");
      if (!Number.isSafeInteger(atMs + horizonMs)) throw new RouteError(400, "at_ms + horizon_ms exceeds the safe integer range");
      const bucketMs = store.config.bucketMs;
      const points = Math.ceil((horizonMs + (atMs % bucketMs)) / bucketMs);
      if (points > MAX_FORECAST_POINTS) throw new RouteError(400, `forecast would produce more than ${MAX_FORECAST_POINTS} points`);
      const gate = readGate(req);
      return serveGated(res, store, api.metrics, "rate_ladder", gate, () =>
        store.forecast({ token, atMs, horizonMs })
      );
    })
  );

  app.post(
    "/api/analytics/rebuild",
    route((req, res) => {
      const unavailable = disabled(res);
      if (unavailable) return unavailable;
      const reason = typeof req.body?.reason === "string" && req.body.reason.trim() !== ""
        ? req.body.reason.trim().slice(0, 200)
        : "manual";
      return sendJson(res, 200, store.rebuild(reason));
    }, true)
  );

  app.post(
    "/api/analytics/refresh",
    route((_req, res) => {
      const unavailable = disabled(res);
      if (unavailable) return unavailable;
      return sendJson(res, 200, api.refresher.tick());
    }, true)
  );

  app.get(
    "/api/analytics/refresh/stats",
    route((_req, res) => {
      const unavailable = disabled(res);
      if (unavailable) return unavailable;
      return sendJson(res, 200, { ...store.stats(), worker: api.refresher.stats() });
    })
  );
}
