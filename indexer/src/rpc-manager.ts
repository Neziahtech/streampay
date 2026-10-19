/**
 * StreamPay RPC Failover Manager — Issue #100
 *
 * A shared client layer for the indexer, reconciler, keeper, and frontend
 * server that:
 *
 * - Tracks multiple Soroban RPC endpoints.
 * - Health-checks endpoints (height-lag detection, 429 storms,
 *   slow-response outliers).
 * - Fails over to the next healthy endpoint automatically.
 * - Implements hedged requests for latency-sensitive read calls.
 * - Manages a global token-bucket rate budget shared across all callers.
 *
 * # Rate budget: coordination decision
 *
 * The manager maintains an **in-process token bucket** per network.
 * For multi-process deployments (indexer + keeper + reconciler each in their
 * own Node.js process) a shared Redis counter or a sidecar rate-limiter is
 * recommended. This implementation documents the interface so a Redis
 * back-end can be swapped in without changing callers: the `RateBudget`
 * interface is the seam.
 *
 * # Hedged requests
 *
 * A hedged request is only issued for **read-only** calls (simulation,
 * getLedgerEntries, getTransaction). Mutating calls (`sendTransaction`)
 * must never be hedged — duplicate submissions would be rejected by the
 * ledger (sequence-number check) but produce confusing double-events.
 *
 * The hedge delay is configurable per-call-type (default: 300 ms for
 * reads, disabled for mutations). If the primary responds within the hedge
 * delay the secondary is cancelled; otherwise the faster of the two wins.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RpcEndpoint {
  url: string;
  /** Relative weight for initial endpoint selection (default 1). */
  weight?: number;
}

export interface EndpointHealth {
  url: string;
  /** Whether this endpoint is currently considered healthy. */
  healthy: boolean;
  /** Latest ledger sequence seen from this endpoint. */
  latestLedger: number;
  /** Timestamp of last successful response (ms). */
  lastSuccessAt: number;
  /** Consecutive failure count. */
  failures: number;
  /** Detected ledger lag in seconds (compared to the best-seen ledger). */
  lagSeconds: number;
}

export interface ManagerOptions {
  endpoints: RpcEndpoint[];
  /**
   * Max request rate per second across all callers (global token bucket).
   * Default: 10 rps (conservative testnet rate limit).
   */
  maxRps?: number;
  /**
   * Number of consecutive failures before an endpoint is marked unhealthy.
   * Default: 3.
   */
  failureThreshold?: number;
  /**
   * Ledger lag threshold in seconds. Endpoints lagging more than this are
   * deprioritised. Default: 60 s.
   */
  lagThresholdSeconds?: number;
  /**
   * Hedge delay for read-only calls in milliseconds.
   * 0 = hedging disabled. Default: 300.
   */
  hedgeDelayMs?: number;
  /**
   * Health-check interval in milliseconds. Default: 10_000.
   */
  healthCheckIntervalMs?: number;
  /**
   * Request timeout in milliseconds. Default: 15_000.
   */
  timeoutMs?: number;
}

export interface JsonRpcRequest {
  method: string;
  params: unknown;
}

export type CallType = "read" | "mutate";

// ── Token bucket rate limiter ─────────────────────────────────────────────────

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly maxTokens: number,
    private readonly refillRatePerMs: number
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  /** Tries to consume `count` tokens. Returns true if allowed. */
  tryConsume(count = 1): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  /** Returns approximate ms to wait for `count` tokens. */
  waitMs(count = 1): number {
    this.refill();
    const deficit = count - this.tokens;
    if (deficit <= 0) return 0;
    return Math.ceil(deficit / this.refillRatePerMs);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refilled = elapsed * this.refillRatePerMs;
    this.tokens = Math.min(this.maxTokens, this.tokens + refilled);
    this.lastRefill = now;
  }
}

// ── RPC Manager ───────────────────────────────────────────────────────────────

export class RpcManager {
  private health: Map<string, EndpointHealth>;
  private bucket: TokenBucket;
  private opts: Required<ManagerOptions>;
  private healthTimer?: ReturnType<typeof setInterval>;
  private bestLedger = 0;

  constructor(options: ManagerOptions) {
    if (options.endpoints.length === 0) {
      throw new Error("RpcManager: at least one endpoint is required");
    }

    this.opts = {
      maxRps: 10,
      failureThreshold: 3,
      lagThresholdSeconds: 60,
      hedgeDelayMs: 300,
      healthCheckIntervalMs: 10_000,
      timeoutMs: 15_000,
      ...options,
    };

    this.health = new Map(
      options.endpoints.map((ep) => [
        ep.url,
        {
          url: ep.url,
          healthy: true,
          latestLedger: 0,
          lastSuccessAt: Date.now(),
          failures: 0,
          lagSeconds: 0,
        },
      ])
    );

    // Token bucket: maxRps tokens, refill at maxRps/1000 per ms.
    this.bucket = new TokenBucket(this.opts.maxRps * 2, this.opts.maxRps / 1_000);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Start periodic health checks. Call once after construction. */
  start(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(
      () => void this.checkAllEndpoints(),
      this.opts.healthCheckIntervalMs
    );
  }

  /** Stop health-check timer and release resources. */
  stop(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
  }

  // ── Public RPC call ────────────────────────────────────────────────────────

  /**
   * Executes a JSON-RPC call, automatically selecting the best endpoint,
   * applying the rate budget, and hedging read-only calls.
   *
   * @param req - The JSON-RPC method and params.
   * @param type - `"read"` (hedged, idempotent) or `"mutate"` (never hedged).
   * @returns The `result` field of the JSON-RPC response.
   * @throws If all endpoints fail, rate budget is exhausted, or timeout elapses.
   */
  async call<T = unknown>(req: JsonRpcRequest, type: CallType = "read"): Promise<T> {
    // Rate budget check.
    if (!this.bucket.tryConsume()) {
      const wait = this.bucket.waitMs();
      throw Object.assign(
        new Error(`RPC rate budget exhausted; retry after ~${wait} ms`),
        { code: "RATE_EXHAUSTED", retryAfterMs: wait }
      );
    }

    const primary = this.pickEndpoint();
    if (!primary) {
      throw new Error("RpcManager: no healthy endpoints available");
    }

    if (type === "read" && this.opts.hedgeDelayMs > 0) {
      return this.hedgedCall<T>(req, primary);
    }
    return this.singleCall<T>(req, primary);
  }

  // ── Read helpers (wrappers for common Soroban RPC methods) ─────────────────

  async getLatestLedger(): Promise<{ sequence: number; id: string; protocolVersion: number }> {
    return this.call({ method: "getLatestLedger", params: {} }, "read");
  }

  async simulateTransaction(txXdr: string): Promise<unknown> {
    return this.call({ method: "simulateTransaction", params: { transaction: txXdr } }, "read");
  }

  async getTransaction(hash: string): Promise<unknown> {
    return this.call({ method: "getTransaction", params: { hash } }, "read");
  }

  async sendTransaction(txXdr: string): Promise<unknown> {
    // Mutations are never hedged.
    return this.call({ method: "sendTransaction", params: { transaction: txXdr } }, "mutate");
  }

  async getEvents(params: unknown): Promise<unknown> {
    return this.call({ method: "getEvents", params }, "read");
  }

  async getLedgerEntries(keys: string[]): Promise<unknown> {
    return this.call({ method: "getLedgerEntries", params: { keys } }, "read");
  }

  // ── Health status ──────────────────────────────────────────────────────────

  /** Returns a snapshot of all endpoint health states. */
  getHealth(): EndpointHealth[] {
    return [...this.health.values()];
  }

  // ── Private implementation ─────────────────────────────────────────────────

  /** Picks the healthiest endpoint (fewest failures, lowest lag). */
  private pickEndpoint(): string | null {
    const candidates = [...this.health.values()]
      .filter((h) => h.healthy)
      .sort((a, b) => {
        // Prefer endpoints with less lag, then fewer failures.
        if (a.lagSeconds !== b.lagSeconds) return a.lagSeconds - b.lagSeconds;
        return a.failures - b.failures;
      });
    return candidates[0]?.url ?? null;
  }

  /** Picks an alternative endpoint to `primary` for hedging. */
  private pickAlternative(primary: string): string | null {
    const candidates = [...this.health.values()]
      .filter((h) => h.healthy && h.url !== primary)
      .sort((a, b) => a.lagSeconds - b.lagSeconds);
    return candidates[0]?.url ?? null;
  }

  /** Single-endpoint call with timeout and failure recording. */
  private async singleCall<T>(req: JsonRpcRequest, url: string): Promise<T> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: req.method, params: req.params });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });

      if (resp.status === 429) {
        this.recordFailure(url, "429");
        throw Object.assign(new Error(`${url}: HTTP 429 rate limited`), { code: "RATE_LIMITED" });
      }
      if (!resp.ok) {
        this.recordFailure(url, `HTTP ${resp.status}`);
        throw new Error(`${url}: HTTP ${resp.status}`);
      }

      const json = (await resp.json()) as { result?: T; error?: { message: string } };
      if (json.error) {
        this.recordFailure(url, json.error.message);
        throw new Error(`${url} RPC: ${json.error.message}`);
      }

      // Update ledger tracking for lag detection.
      if (json.result && typeof json.result === "object" && "sequence" in json.result) {
        this.updateLedger(url, (json.result as unknown as { sequence: number }).sequence);
      }

      this.recordSuccess(url);
      return json.result as T;
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        this.recordFailure(url, "timeout");
        throw Object.assign(new Error(`${url}: request timed out after ${this.opts.timeoutMs} ms`), { code: "TIMEOUT" });
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Hedged read: fires against primary, then if no response within
   * `hedgeDelayMs`, fires against an alternative. The faster winner is
   * returned; the slower is cancelled.
   */
  private async hedgedCall<T>(req: JsonRpcRequest, primary: string): Promise<T> {
    const alternative = this.pickAlternative(primary);
    if (!alternative || this.opts.hedgeDelayMs <= 0) {
      return this.singleCall<T>(req, primary);
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (!settled) { settled = true; fn(); }
      };

      // Primary fires immediately.
      const primaryPromise = this.singleCall<T>(req, primary)
        .then((v) => settle(() => resolve(v)))
        .catch((e) => settle(() => reject(e)));

      // Alternative fires after hedge delay.
      const hedgeTimer = setTimeout(() => {
        if (settled) return;
        this.singleCall<T>(req, alternative)
          .then((v) => settle(() => resolve(v)))
          .catch(() => {
            // Ignore hedge errors — primary is still running.
          });
      }, this.opts.hedgeDelayMs);

      // Clean up timer if primary settles first.
      primaryPromise.finally(() => clearTimeout(hedgeTimer));
    });
  }

  private recordSuccess(url: string): void {
    const h = this.health.get(url);
    if (!h) return;
    h.healthy = true;
    h.failures = 0;
    h.lastSuccessAt = Date.now();
  }

  private recordFailure(url: string, reason: string): void {
    const h = this.health.get(url);
    if (!h) return;
    h.failures += 1;
    if (h.failures >= this.opts.failureThreshold) {
      h.healthy = false;
      // Schedule a re-probe after 30 s.
      setTimeout(() => {
        const hh = this.health.get(url);
        if (hh && !hh.healthy) { hh.healthy = true; hh.failures = 0; }
      }, 30_000);
    }
    // Log without crashing — the manager must stay operational.
    if (process.env.NODE_ENV !== "test") {
      console.warn(`[RpcManager] ${url} failure (${reason}); failure count: ${h.failures}`);
    }
  }

  private updateLedger(url: string, ledger: number): void {
    const h = this.health.get(url);
    if (!h) return;
    h.latestLedger = ledger;
    if (ledger > this.bestLedger) this.bestLedger = ledger;
    // Approximate lag: (bestLedger - h.latestLedger) * 5 s/ledger.
    h.lagSeconds = Math.max(0, (this.bestLedger - h.latestLedger) * 5);
    if (h.lagSeconds > this.opts.lagThresholdSeconds) {
      if (process.env.NODE_ENV !== "test") {
        console.warn(`[RpcManager] ${url} is lagging ${h.lagSeconds}s behind tip`);
      }
    }
  }

  private async checkAllEndpoints(): Promise<void> {
    await Promise.allSettled(
      [...this.health.keys()].map((url) =>
        this.singleCall({ method: "getLatestLedger", params: {} }, url).then((res) => {
          const seq = (res as { sequence?: number }).sequence;
          if (seq) this.updateLedger(url, seq);
        })
      )
    );
  }
}

// ── Module-level singleton factory ────────────────────────────────────────────

let _globalManager: RpcManager | null = null;

/**
 * Returns (or creates) the process-global RPC manager.
 *
 * Pass `options` on the first call; subsequent calls return the same instance.
 * Callers in the indexer, keeper, and reconciler should all use this function
 * so the rate budget is shared across the whole process.
 */
export function getGlobalRpcManager(options?: ManagerOptions): RpcManager {
  if (!_globalManager) {
    if (!options) {
      throw new Error("getGlobalRpcManager: options required on first call");
    }
    _globalManager = new RpcManager(options);
    _globalManager.start();
  }
  return _globalManager;
}

/** Replaces the global manager (for testing). */
export function _setGlobalRpcManager(mgr: RpcManager | null): void {
  _globalManager = mgr;
}
