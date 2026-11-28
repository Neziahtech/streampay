import type Database from "better-sqlite3";
import { bucketStart, emptyDeltas, foldEvents, type FoldContext, type FoldDeltas } from "./fold.js";
import {
  ANALYTICS_DIRTY_LEDGER_KEY,
  ANALYTICS_DIRTY_REASON_KEY,
  ANALYTICS_HISTORY_KEY,
  ANALYTICS_HISTORY_VERSION,
  ANALYTICS_HISTORY_START_LEDGER_KEY,
  DEFAULT_ANALYTICS_CONFIG,
  RATE_SCALE,
  VIEW_NAMES,
  type AccrualBucketRow,
  type AddressTotalsRow,
  type AnalyticsConfig,
  type AnalyticsSnapshot,
  type AssetTotalsRow,
  type GateResult,
  type JournalEvent,
  type JournalSource,
  type ReadGate,
  type RateEventRow,
  type RateLadderRow,
  type RefreshBatch,
  type RefreshStats,
  type Role,
  type Staleness,
  type StreamDim,
  type ViewName,
  type Watermark,
} from "./types.js";

/** Counters durable enough to matter: a restart must not launder a rebuild history. */
const COUNTER_KEYS = { rebuilds: "rebuilds", errors: "errors", lastRebuildReason: "last_rebuild_reason", lastError: "last_error" } as const;

type DeltaRow = AddressTotalsRow | AssetTotalsRow | AccrualBucketRow | RateLadderRow;

function ceilDiv(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

function formatScaledRate(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / RATE_SCALE;
  const places = RATE_SCALE.toString().length - 1;
  const fraction = (absolute % RATE_SCALE).toString().padStart(places, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

const TABLES = {
  address_totals: "analytics_address_totals",
  asset_totals: "analytics_asset_totals",
  accrual_buckets: "analytics_accrual_buckets",
  rate_ladder: "analytics_rate_ladder",
  streams: "analytics_streams",
} as const;
const RATE_EVENTS_TABLE = "analytics_rate_events";

/** Amount columns of each view, in the order the writer accumulates them. */
const MEASURES: Record<keyof typeof TABLES, string[]> = {
  address_totals: ["streams_created", "streams_active", "funded", "claimed", "settled", "refunded", "rate_per_second"],
  asset_totals: ["streams_created", "streams_active", "funded", "claimed", "settled", "refunded", "rate_per_second"],
  accrual_buckets: ["funded", "claimed", "settled", "refunded", "streams_created", "cancellations", "withdrawals"],
  rate_ladder: ["rate_delta", "rate_scaled_delta", "active_delta"],
  streams: [],
};

const KEYS: Record<keyof typeof TABLES, string[]> = {
  address_totals: ["address", "role", "token"],
  asset_totals: ["token"],
  accrual_buckets: ["token", "bucket_start_ms"],
  rate_ladder: ["token", "bucket_start_ms"],
  streams: ["stream_id"],
};

export interface ForecastPoint {
  bucket_start_ms: number;
  /** Live fixed-point rate at the opening of this response bucket. */
  rate_per_second: string;
  /** What that rate accrues inside this bucket, clipped to the horizon. */
  projected: string;
}

export interface ForecastView {
  token: string;
  /** When the projection was taken, so a stale answer is still readable. */
  at_ms: number;
  horizon_ms: number;
  bucket_ms: number;
  total_projected: string;
  points: ForecastPoint[];
  /** Conservative bound for bucket quantization, fixed-point residue and per-span rounding. */
  max_error_per_bucket: string;
}

export interface AnalyticsOptions {
  config?: Partial<AnalyticsConfig>;
  /** First ledger ingestion will read; it must precede the contract's first event. */
  historyStartLedger?: number;
  /** False only while the operational analytics surface is disabled. */
  certifyHistory?: boolean;
  now?: () => number;
}

/**
 * The materialized side of analytics: journal rows in, view rows out, plus a
 * watermark that says exactly how far the fold got.
 *
 * Both refresh paths share the fold and the writer, and a rebuild folds the
 * whole journal into memory before publishing that result inside one
 * transaction. So a reader sees the previous complete state or the new
 * complete state, never a half-rebuilt one, and a crash at any point leaves
 * the views at a real fold position rather than at an invented one.
 */
export class AnalyticsStore {
  readonly config: AnalyticsConfig;
  private readonly journal: JournalSource;
  private readonly db: Database.Database;
  private readonly now: () => number;
  private batches = 0;
  private eventsApplied = 0;
  private eventsCountedOnly = 0;
  private eventsUnknown = 0;
  private lastBatch: RefreshBatch | null = null;
  private readonly historyReady: boolean;

  constructor(db: Database.Database, journal: JournalSource, options: AnalyticsOptions = {}) {
    this.db = db;
    this.journal = journal;
    this.config = { ...DEFAULT_ANALYTICS_CONFIG, ...(options.config ?? {}) };
    this.now = options.now ?? Date.now;

    const tableExists = (table: string): boolean => this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) !== undefined;
    const history = tableExists("analytics_counters")
      ? this.counterText(ANALYTICS_HISTORY_KEY)
      : null;
    const recordedStartLedger = tableExists("analytics_counters")
      ? this.counterText(ANALYTICS_HISTORY_START_LEDGER_KEY)
      : null;
    const existingRows = ["outbox_events", "streams", "events"].reduce((sum, table) => {
      if (!tableExists(table)) return sum;
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      return sum + row.n;
    }, 0);
    const hasIngestState = tableExists("indexer_state") && this.db
      .prepare("SELECT 1 FROM indexer_state LIMIT 1")
      .get() !== undefined;
    const configuredStartLedger = options.historyStartLedger;
    const historyStartLedger = configuredStartLedger ?? 1;
    const certifyHistory = options.certifyHistory !== false;
    if (!Number.isSafeInteger(historyStartLedger) || historyStartLedger < 1) {
      throw new Error("Analytics historyStartLedger must be a positive safe integer");
    }
    if (history !== null && history !== ANALYTICS_HISTORY_VERSION) {
      throw new Error("Analytics history version is newer than this indexer; upgrade the indexer before opening this database");
    }
    if (history !== null) {
      if (recordedStartLedger === null) {
        throw new Error("Analytics complete-history marker has no start ledger; reindex into a fresh database");
      }
      if (!/^\d+$/.test(recordedStartLedger)) {
        throw new Error("Analytics complete-history start ledger must be a positive safe integer");
      }
      const recorded = Number(recordedStartLedger);
      if (!Number.isSafeInteger(recorded) || recorded < 1) {
        throw new Error("Analytics complete-history start ledger must be a positive safe integer");
      }
      if (configuredStartLedger !== undefined && recorded !== configuredStartLedger) {
        throw new Error(
          `Analytics complete-history start ledger ${recorded} does not match configured START_LEDGER ${configuredStartLedger}`
        );
      }
    }
    this.historyReady = history !== null;
    if (history === null && certifyHistory && (tableExists("analytics_watermarks") || existingRows > 0 || hasIngestState)) {
      throw new Error(
        "Analytics requires complete event history, but this database predates the current event subscriptions. " +
        "Reindex into a fresh database before enabling analytics."
      );
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS analytics_address_totals (
        address TEXT NOT NULL, role TEXT NOT NULL, token TEXT NOT NULL,
        streams_created TEXT NOT NULL DEFAULT '0', streams_active TEXT NOT NULL DEFAULT '0',
        funded TEXT NOT NULL DEFAULT '0', claimed TEXT NOT NULL DEFAULT '0',
        settled TEXT NOT NULL DEFAULT '0', refunded TEXT NOT NULL DEFAULT '0',
        rate_per_second TEXT NOT NULL DEFAULT '0', updated_seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (address, role, token)
      );
      CREATE TABLE IF NOT EXISTS analytics_asset_totals (
        token TEXT PRIMARY KEY,
        streams_created TEXT NOT NULL DEFAULT '0', streams_active TEXT NOT NULL DEFAULT '0',
        funded TEXT NOT NULL DEFAULT '0', claimed TEXT NOT NULL DEFAULT '0',
        settled TEXT NOT NULL DEFAULT '0', refunded TEXT NOT NULL DEFAULT '0',
        rate_per_second TEXT NOT NULL DEFAULT '0', updated_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS analytics_accrual_buckets (
        token TEXT NOT NULL, bucket_start_ms INTEGER NOT NULL,
        funded TEXT NOT NULL DEFAULT '0', claimed TEXT NOT NULL DEFAULT '0',
        settled TEXT NOT NULL DEFAULT '0', refunded TEXT NOT NULL DEFAULT '0',
        streams_created TEXT NOT NULL DEFAULT '0', cancellations TEXT NOT NULL DEFAULT '0',
        withdrawals TEXT NOT NULL DEFAULT '0', updated_seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (token, bucket_start_ms)
      );
      CREATE TABLE IF NOT EXISTS analytics_rate_ladder (
        token TEXT NOT NULL, bucket_start_ms INTEGER NOT NULL,
        rate_delta TEXT NOT NULL DEFAULT '0',
        rate_scaled_delta TEXT NOT NULL DEFAULT '0',
        active_delta TEXT NOT NULL DEFAULT '0',
        rate_scaled_through_bucket TEXT NOT NULL DEFAULT '0',
        active_through_bucket TEXT NOT NULL DEFAULT '0',
        updated_seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (token, bucket_start_ms)
      );
      CREATE TABLE IF NOT EXISTS analytics_rate_events (
        token TEXT NOT NULL, effective_ms INTEGER NOT NULL,
        rate_delta TEXT NOT NULL DEFAULT '0',
        rate_scaled_delta TEXT NOT NULL DEFAULT '0',
        active_delta TEXT NOT NULL DEFAULT '0',
        updated_seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (token, effective_ms)
      );
      CREATE TABLE IF NOT EXISTS analytics_streams (
        stream_id TEXT PRIMARY KEY, token TEXT NOT NULL, sender TEXT NOT NULL,
        recipient TEXT NOT NULL, deposit TEXT NOT NULL, claimed TEXT NOT NULL DEFAULT '0',
        start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
        rate_per_second TEXT NOT NULL, status TEXT NOT NULL,
        paused_at_ms INTEGER, visible_from_ms INTEGER NOT NULL DEFAULT 0,
        schedule_json TEXT NOT NULL DEFAULT '[]',
        refund_target TEXT, created_seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS analytics_accrual_time ON analytics_accrual_buckets(bucket_start_ms, token);
      CREATE INDEX IF NOT EXISTS analytics_ladder_time ON analytics_rate_ladder(token, bucket_start_ms);
      CREATE INDEX IF NOT EXISTS analytics_rate_events_time ON analytics_rate_events(token, effective_ms);
      CREATE TABLE IF NOT EXISTS analytics_watermarks (
        view TEXT PRIMARY KEY, last_seq INTEGER NOT NULL, last_ledger INTEGER NOT NULL,
        last_event_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS analytics_counters (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    try {
      this.db.exec("ALTER TABLE analytics_streams ADD COLUMN refund_target TEXT;");
    } catch {}
    for (const column of ["rate_scaled_through_bucket", "active_through_bucket"]) {
      const columns = this.db.pragma("table_info(analytics_rate_ladder)") as Array<{ name: string }>;
      if (!columns.some((entry) => entry.name === column)) {
        this.db.exec(`ALTER TABLE analytics_rate_ladder ADD COLUMN ${column} TEXT NOT NULL DEFAULT '0'`);
      }
    }
    if (history === null && certifyHistory) {
      this.db
        .prepare("INSERT INTO analytics_counters(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(ANALYTICS_HISTORY_KEY, ANALYTICS_HISTORY_VERSION);
      this.db
        .prepare("INSERT INTO analytics_counters(key,value) VALUES(?,?)")
        .run(ANALYTICS_HISTORY_START_LEDGER_KEY, String(historyStartLedger));
      this.historyReady = true;
    }

    for (const view of VIEW_NAMES) {
      this.db
        .prepare(
          `INSERT INTO analytics_watermarks (view, last_seq, last_ledger, last_event_ms, updated_at_ms) VALUES (?, 0, 0, 0, ?)
           ON CONFLICT(view) DO NOTHING`
        )
        .run(view, this.now());
    }
  }

  // ---------- refresh ----------

  /**
   * Fold up to `maxEvents` journal rows in one write transaction. Measures,
   * dimensions and the watermark commit together, which is what makes the
   * position resumable: the watermark is the only cursor, and it cannot point
   * past rows that were not written. Taking the write lock before reading the
   * cursor also serializes analytics with ingestion and reorg retraction.
   */
  refreshOnce(maxEvents = this.config.batchSize): RefreshBatch | null {
    this.assertHistoryReady();
    const limit = Math.max(1, Math.min(this.config.batchSize, Math.floor(maxEvents)));
    const started = Date.now();
    const batch = this.db.transaction((): RefreshBatch | null => {
      const dirty = this.counterText(ANALYTICS_DIRTY_LEDGER_KEY);
      if (dirty !== null) {
        const reason = `reorg_retracted above ledger ${dirty} (${this.counterText(ANALYTICS_DIRTY_REASON_KEY) ?? "unspecified"})`;
        return this.rebuildLocked(reason, started).batch;
      }

      const fromSeq = this.appliedSeq();
      const events = this.journal.journalAfterSeq(fromSeq, limit);
      if (events.length === 0) return null;
      const context = this.foldContext();
      this.loadDims(context, events);
      foldEvents(context, events);
      const writes = this.writeDeltas(context.deltas);
      this.advanceWatermarks(context.deltas, this.watermarkEventMs(context.deltas));
      return {
        events_read: events.length,
        applied: context.deltas.events_applied,
        counted_only: context.deltas.events_counted_only,
        unknown: context.deltas.events_unknown,
        from_seq: fromSeq,
        to_seq: context.deltas.last_seq,
        duration_ms: Math.max(1, Date.now() - started),
        writes,
      };
    }).immediate();
    if (batch !== null) this.recordBatch(batch);
    return batch;
  }

  /** Fold everything outstanding; bounded so a caller cannot spin forever. */
  drain(limit = 10_000): { batches: number; events_read: number; last_batch: RefreshBatch | null } {
    let batches = 0;
    let eventsRead = 0;
    let last: RefreshBatch | null = null;
    for (let i = 0; i < limit; i += 1) {
      const batch = this.refreshOnce();
      if (batch === null) break;
      batches += 1;
      eventsRead += batch.events_read;
      last = batch;
    }
    return { batches, events_read: eventsRead, last_batch: last };
  }

  /**
   * Re-fold the whole journal and publish the result atomically. The recovery
   * path after a reorg retraction — inverse deltas cannot be derived after the
   * fact — and the operator's answer to "the dashboard looks wrong".
   *
   * The write lock spans the journal read as well as publication. A retraction
   * therefore either precedes the rebuild and is included, or follows it and
   * marks the freshly published views dirty; it cannot be cleared by a rebuild
   * that never saw it.
   */
  rebuild(reason: string): { events_read: number; writes: number; duration_ms: number; batch: RefreshBatch } {
    this.assertHistoryReady();
    const started = Date.now();
    const result = this.db.transaction(() => this.rebuildLocked(reason, started)).immediate();
    this.recordBatch(result.batch);
    return result;
  }

  private rebuildLocked(reason: string, started: number): { events_read: number; writes: number; duration_ms: number; batch: RefreshBatch } {
    const fromSeq = this.appliedSeq();
    const context = this.foldContext();

    let cursor = 0;
    let read = 0;
    let applied = 0;
    let countedOnly = 0;
    let unknown = 0;
    for (;;) {
      const events = this.journal.journalAfterSeq(cursor, this.config.batchSize);
      if (events.length === 0) break;
      read += events.length;
      cursor = events[events.length - 1]!.seq;
      this.loadDims(context, events);
      foldEvents(context, events);
      applied += context.deltas.events_applied;
      countedOnly += context.deltas.events_counted_only;
      unknown += context.deltas.events_unknown;
      context.deltas.events_applied = 0;
      context.deltas.events_counted_only = 0;
      context.deltas.events_unknown = 0;
      if (events.length < this.config.batchSize) break;
    }

    const eventMs = context.deltas.last_seq > 0 ? context.deltas.last_event_ms : this.lastJournalEventMs();
    for (const table of [...Object.values(TABLES), RATE_EVENTS_TABLE]) this.db.exec(`DELETE FROM ${table}`);
    const writes = this.writeDeltas(context.deltas);
    this.advanceWatermarks(context.deltas, eventMs);
    this.bumpCounter(COUNTER_KEYS.rebuilds, 1);
    this.setCounter(COUNTER_KEYS.lastRebuildReason, reason);
    this.db.prepare("DELETE FROM analytics_counters WHERE key IN (?, ?)").run(ANALYTICS_DIRTY_LEDGER_KEY, ANALYTICS_DIRTY_REASON_KEY);

    const batch: RefreshBatch = {
      events_read: read,
      applied,
      counted_only: countedOnly,
      unknown,
      from_seq: fromSeq,
      to_seq: context.deltas.last_seq,
      duration_ms: Math.max(1, Date.now() - started),
      writes,
    };
    return { events_read: read, writes, duration_ms: batch.duration_ms, batch };
  }

  /**
   * A reorg retraction can make rows the fold already applied untrue, so mark
   * the views dirty and rebuild on the next tick. The marker is durable and is
   * written in the retraction transaction by the outbox, so a crash cannot
   * expose the retracted fold as current after restart.
   */
  invalidateAfterLedger(ledger: number, reason: string): void {
    this.db.transaction(() => {
      this.setCounter(ANALYTICS_DIRTY_LEDGER_KEY, String(ledger));
      this.setCounter(ANALYTICS_DIRTY_REASON_KEY, reason);
    })();
  }

  get isDirty(): boolean {
    return this.counterText(ANALYTICS_DIRTY_LEDGER_KEY) !== null;
  }

  private recordBatch(batch: RefreshBatch): void {
    this.batches += 1;
    this.eventsApplied += batch.applied;
    this.eventsCountedOnly += batch.counted_only;
    this.eventsUnknown += batch.unknown;
    this.lastBatch = batch;
  }

  /**
   * Record a failed fold. Deliberately never throws: the most likely reason a
   * refresh failed is the database, and losing the write must not turn into a
   * crash while reporting the loss.
   */
  recordError(err: unknown): void {
    try {
      this.bumpCounter(COUNTER_KEYS.errors, 1);
      this.setCounter(COUNTER_KEYS.lastError, err instanceof Error ? err.message : String(err));
    } catch {
      /* the error is already the reason we are here */
    }
  }

  // ---------- reads ----------

  watermark(view: ViewName): Watermark {
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT view, last_seq, last_ledger, last_event_ms, updated_at_ms FROM analytics_watermarks WHERE view = ?")
        .get(view) as Record<string, unknown> | undefined;
      const rows = this.count(TABLES[view]);
      if (!row) {
        return { view, last_seq: 0, last_ledger: 0, last_event_ms: 0, updated_at_ms: this.now(), rows };
      }
      return {
        view,
        last_seq: Number(row.last_seq),
        last_ledger: Number(row.last_ledger),
        last_event_ms: Number(row.last_event_ms),
        updated_at_ms: Number(row.updated_at_ms),
        rows,
      };
    }).deferred();
  }

  staleness(view: ViewName): Staleness {
    return this.db.transaction(() => {
      const mark = this.watermark(view);
      const tip = this.journal.journalTip();
      const lagEvents = Math.max(0, tip.seq - mark.last_seq);
      const eventMs = mark.last_seq > 0 ? mark.last_event_ms : tip.seq > 0 ? this.lastJournalEventMs() : 0;
      const lagMs = eventMs > 0 ? Math.max(0, this.now() - eventMs) : 0;
      const dirty = this.isDirty;
      return {
        watermark_event_ms: mark.last_event_ms,
        watermark_ledger: mark.last_ledger,
        watermark_seq: mark.last_seq,
        journal_seq: tip.seq,
        lag_events: lagEvents,
        lag_ms: lagMs,
        slo_ms: this.config.sloMs,
        in_slo: !dirty && lagMs <= this.config.sloMs && lagEvents <= this.config.batchSize,
        dirty,
      };
    }).deferred();
  }

  /**
   * Read through a freshness gate: the caller names the ledger it will accept
   * (or a maximum journal lag) and how long it may wait. The reader never
   * refreshes — it blocks on the writer's progress, which is the point: a
   * dashboard must not render a portfolio that is mid-fold.
   */
  async readGated<T>(view: ViewName, gate: ReadGate, read: () => T): Promise<GateResult<T>> {
    this.assertHistoryReady();
    const waitMs = Math.max(0, Math.min(gate.waitMs ?? 0, this.config.maxWaitMs));
    const started = Date.now();
    for (;;) {
      const snapshot = this.db.transaction(() => {
        const staleness = this.staleness(view);
        const satisfied = this.gateSatisfied(staleness, gate);
        return { staleness, satisfied, data: satisfied ? read() : undefined };
      })();
      if (snapshot.satisfied) {
        return { ok: true, data: snapshot.data, staleness: snapshot.staleness, waited_ms: Date.now() - started };
      }
      if (Date.now() - started >= waitMs) {
        return { ok: false, staleness: snapshot.staleness, waited_ms: Date.now() - started, reason: "waited_out" };
      }
      const remaining = waitMs - (Date.now() - started);
      await this.sleep(Math.max(1, Math.min(this.config.waitPollMs, remaining)));
    }
  }

  private gateSatisfied(staleness: Staleness, gate: ReadGate): boolean {
    if (this.isDirty) return false;
    if (gate.minLedger !== undefined && staleness.watermark_ledger < gate.minLedger) return false;
    if (gate.maxLagEvents !== undefined && staleness.lag_events > gate.maxLagEvents) return false;
    return true;
  }

  readAddress(address: string, options: { role?: Role; token?: string } = {}): AddressTotalsRow[] {
    const clauses = ["address = @address"];
    const params: Record<string, unknown> = { address };
    if (options.role) {
      clauses.push("role = @role");
      params.role = options.role;
    }
    if (options.token) {
      clauses.push("token = @token");
      params.token = options.token;
    }
    const rows = this.db
      .prepare(`SELECT * FROM ${TABLES.address_totals} WHERE ${clauses.join(" AND ")} ORDER BY token ASC, role ASC`)
      .all(params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.toAddress(row));
  }

  readAsset(token?: string): Array<AssetTotalsRow & { escrow_remaining: bigint }> {
    const rows = (
      token
        ? this.db.prepare(`SELECT * FROM ${TABLES.asset_totals} WHERE token = ?`).all(token)
        : this.db.prepare(`SELECT * FROM ${TABLES.asset_totals} ORDER BY token ASC`).all()
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => this.toAsset(row));
  }

  readBuckets(options: { token?: string; fromMs?: number; toMs?: number; limit?: number } = {}): AccrualBucketRow[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: options.limit ?? 500 };
    if (options.token) {
      clauses.push("token = @token");
      params.token = options.token;
    }
    if (options.fromMs !== undefined) {
      clauses.push("bucket_start_ms >= @fromMs");
      params.fromMs = options.fromMs;
    }
    if (options.toMs !== undefined) {
      clauses.push("bucket_start_ms <= @toMs");
      params.toMs = options.toMs;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM ${TABLES.accrual_buckets} ${where} ORDER BY bucket_start_ms ASC, token ASC LIMIT @limit`)
      .all(params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      token: String(row.token),
      bucket_start_ms: Number(row.bucket_start_ms),
      funded: BigInt(String(row.funded)),
      claimed: BigInt(String(row.claimed)),
      settled: BigInt(String(row.settled)),
      refunded: BigInt(String(row.refunded)),
      streams_created: BigInt(String(row.streams_created)),
      cancellations: BigInt(String(row.cancellations)),
      withdrawals: BigInt(String(row.withdrawals)),
    }));
  }

  /**
   * Forecast from cumulative bucket state plus exact effective-time changes.
   * Historical work is one indexed lookup; only the current bucket and requested
   * horizon are scanned, and same-bucket changes are integrated as real spans.
   */
  forecast(options: { token: string; atMs: number; horizonMs: number }): ForecastView {
    this.assertHistoryReady();
    const { token, atMs, horizonMs } = options;
    const bucketMs = this.config.bucketMs;
    const startBucket = bucketStart(atMs, bucketMs);
    const history = this.db
      .prepare(
        `SELECT rate_scaled_through_bucket, active_through_bucket FROM ${TABLES.rate_ladder}
         WHERE token = ? AND bucket_start_ms < ? ORDER BY bucket_start_ms DESC LIMIT 1`
      )
      .get(token, startBucket) as { rate_scaled_through_bucket: string; active_through_bucket: string } | undefined;
    let rate = BigInt(history?.rate_scaled_through_bucket ?? "0");
    let active = BigInt(history?.active_through_bucket ?? "0");
    const current = this.db
      .prepare(
        `SELECT effective_ms, rate_scaled_delta, active_delta FROM ${RATE_EVENTS_TABLE}
         WHERE token = ? AND effective_ms >= ? AND effective_ms <= ? ORDER BY effective_ms ASC`
      )
      .all(token, startBucket, atMs) as Array<{ effective_ms: number; rate_scaled_delta: string; active_delta: string }>;
    for (const row of current) {
      rate += BigInt(row.rate_scaled_delta);
      active += BigInt(row.active_delta);
    }

    const endMs = atMs + horizonMs;
    const future = this.db
      .prepare(
        `SELECT effective_ms, rate_scaled_delta, active_delta FROM ${RATE_EVENTS_TABLE}
         WHERE token = ? AND effective_ms > ? AND effective_ms < ? ORDER BY effective_ms ASC`
      )
      .all(token, atMs, endMs) as Array<{ effective_ms: number; rate_scaled_delta: string; active_delta: string }>;
    const points: ForecastPoint[] = [];
    const magnitude = (value: bigint): bigint => value < 0n ? -value : value;
    let total = 0n;
    let maxError = 0n;
    let cursorMs = atMs;
    let index = 0;
    while (cursorMs < endMs) {
      while (index < future.length && future[index]!.effective_ms <= cursorMs) {
        rate += BigInt(future[index]!.rate_scaled_delta);
        active += BigInt(future[index]!.active_delta);
        index += 1;
      }
      const responseBucket = bucketStart(cursorMs, bucketMs);
      const bucketEnd = Math.min(responseBucket + bucketMs, endMs);
      const openingRate = rate > 0n ? rate : 0n;
      let projected = 0n;
      let bucketError = 0n;
      let spanCursor = cursorMs;
      while (spanCursor < bucketEnd) {
        while (index < future.length && future[index]!.effective_ms <= spanCursor) {
          rate += BigInt(future[index]!.rate_scaled_delta);
          active += BigInt(future[index]!.active_delta);
          index += 1;
        }
        const spanEnd = Math.min(future[index]?.effective_ms ?? bucketEnd, bucketEnd);
        const durationSeconds = BigInt(Math.floor(spanEnd / 1000) - Math.floor(spanCursor / 1000));
        const live = rate > 0n ? rate : 0n;
        const peak = magnitude(rate);
        const peakActive = active > 0n ? active : 0n;
        projected += (live * durationSeconds) / RATE_SCALE;
        bucketError += ceilDiv(peak * durationSeconds, RATE_SCALE)
          + peakActive * (1n + ceilDiv(durationSeconds, RATE_SCALE))
          + 1n;
        spanCursor = spanEnd;
      }
      if (bucketEnd > cursorMs) {
        points.push({
          bucket_start_ms: responseBucket,
          rate_per_second: formatScaledRate(openingRate),
          projected: String(projected),
        });
        total += projected;
      }
      if (bucketError > maxError) maxError = bucketError;
      cursorMs = bucketEnd;
    }

    return {
      token,
      at_ms: atMs,
      horizon_ms: horizonMs,
      bucket_ms: bucketMs,
      total_projected: String(total),
      points,
      max_error_per_bucket: String(maxError),
    };
  }

  stats(): RefreshStats {
    return this.db.transaction(() => {
      const mark = this.watermark("asset_totals");
      const tip = this.journal.journalTip();
      const last = this.lastBatch;
      const eventMs = mark.last_seq > 0 ? mark.last_event_ms : tip.seq > 0 ? this.lastJournalEventMs() : 0;
      return {
        batches: this.batches,
        events_applied: this.eventsApplied,
        events_counted_only: this.eventsCountedOnly,
        events_skipped_unknown: this.eventsUnknown,
        rebuilds: this.counter(COUNTER_KEYS.rebuilds),
        last_rebuild_reason: this.counterText(COUNTER_KEYS.lastRebuildReason),
        last_batch: last,
        watermark_seq: mark.last_seq,
        watermark_ledger: mark.last_ledger,
        journal_seq: tip.seq,
        lag_events: Math.max(0, tip.seq - mark.last_seq),
        lag_ms: eventMs > 0 ? Math.max(0, this.now() - eventMs) : 0,
        events_per_second: last !== null && last.duration_ms > 0 ? Math.round((last.events_read * 1000) / last.duration_ms) : 0,
        errors: this.counter(COUNTER_KEYS.errors),
        last_error: this.counterText(COUNTER_KEYS.lastError),
      };
    }).deferred();
  }

  /** Everything the exposition needs, from one committed SQLite snapshot. */
  snapshot(): AnalyticsSnapshot {
    return this.db.transaction(() => {
      const views = VIEW_NAMES.map((view) => ({ view, watermark: this.watermark(view), staleness: this.staleness(view) }));
      return {
        views,
        stats: this.stats(),
        journal_seq: this.journal.journalTip().seq,
        slo_ms: this.config.sloMs,
        budget_eps: this.config.throughputBudgetPerSecond,
        history_ready: this.historyReady,
        dirty: this.isDirty,
      };
    }).deferred();
  }

  appliedSeq(): number {
    const row = this.db.prepare("SELECT last_seq FROM analytics_watermarks WHERE view = 'asset_totals'").get() as
      | { last_seq: number }
      | undefined;
    return row?.last_seq ?? 0;
  }

  private count(table: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  }

  /** The dimension rows the fold carries, for parity assertions and debugging. */
  readDims(): StreamDim[] {
    const rows = this.db.prepare(`SELECT * FROM ${TABLES.streams} ORDER BY created_seq ASC`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.toDim(row));
  }

  // ---------- internals ----------

  private assertHistoryReady(): void {
    if (!this.historyReady) {
      throw new Error("Analytics history is not certified; configure START_LEDGER before the contract's first event and reindex a fresh database");
    }
  }

  private foldContext(): FoldContext {
    return { bucketMs: this.config.bucketMs, deltas: emptyDeltas() };
  }

  private lastJournalEventMs(): number {
    const row = this.journal.journalAfterSeq(this.journal.journalTip().seq - 1, 1)[0];
    return row ? Date.parse(row.ledger_closed_at) || 0 : 0;
  }

  private watermarkEventMs(deltas: FoldDeltas): number {
    if (deltas.last_event_ms > 0) return deltas.last_event_ms;
    return this.lastJournalEventMs();
  }

  /** Load the dimensions this batch reads. Streams already folded are left alone. */
  private loadDims(context: FoldContext, events: JournalEvent[]): void {
    if (events.length === 0) return;
    const ids = [...new Set(events.map((event) => event.stream_id).filter((id): id is string => id !== null))]
      .filter((id) => !context.deltas.dims.has(id));
    if (ids.length === 0) return;
    const params: Record<string, unknown> = {};
    const placeholders = ids.map((id, i) => {
      params[`id${i}`] = id;
      return `@id${i}`;
    });
    const rows = this.db
      .prepare(`SELECT * FROM ${TABLES.streams} WHERE stream_id IN (${placeholders.join(",")})`)
      .all(params) as Array<Record<string, unknown>>;
    for (const row of rows) context.deltas.dims.set(String(row.stream_id), this.toDim(row));
  }

  /** Write one batch's deltas; returns the number of row writes. */
  private writeDeltas(deltas: FoldDeltas): number {
    const groups: Array<[keyof typeof TABLES, Iterable<DeltaRow>]> = [
      ["address_totals", deltas.address.values()],
      ["asset_totals", deltas.asset.values()],
      ["accrual_buckets", deltas.bucket.values()],
      ["rate_ladder", deltas.ladder.values()],
    ];
    let writes = 0;
    for (const [view, rows] of groups) {
      for (const row of rows) {
        this.accumulate(view, row, deltas.last_seq);
        writes += 1;
      }
    }
    const affectedLadders = new Map<string, number>();
    const touchLadder = (token: string, bucket: number): void => {
      const previous = affectedLadders.get(token);
      if (previous === undefined || bucket < previous) affectedLadders.set(token, bucket);
    };
    for (const row of deltas.rateEvents.values()) {
      this.accumulateRateEvent(row, deltas.last_seq);
      touchLadder(row.token, bucketStart(row.effective_ms, this.config.bucketMs));
      writes += 1;
    }
    for (const row of deltas.ladder.values()) touchLadder(row.token, row.bucket_start_ms);
    for (const [token, fromBucket] of affectedLadders) {
      writes += this.recomputeLadderSuffix(token, fromBucket, deltas.last_seq);
    }
    for (const streamId of deltas.dimClosed) {
      this.db.prepare(`DELETE FROM ${TABLES.streams} WHERE stream_id = ?`).run(streamId);
      writes += 1;
    }
    for (const streamId of deltas.dimTouched) {
      if (deltas.dimClosed.has(streamId)) continue;
      const dim = deltas.dims.get(streamId);
      if (dim === undefined) continue;
      this.upsertDim(dim);
      writes += 1;
    }
    return writes;
  }

  private accumulateRateEvent(row: RateEventRow, seq: number): void {
    const current = this.db
      .prepare(`SELECT rate_delta, rate_scaled_delta, active_delta FROM ${RATE_EVENTS_TABLE} WHERE token = ? AND effective_ms = ?`)
      .get(row.token, row.effective_ms) as Record<string, unknown> | undefined;
    const next = {
      token: row.token,
      effective_ms: row.effective_ms,
      rate_delta: String(BigInt(String(current?.rate_delta ?? "0")) + row.rate_delta),
      rate_scaled_delta: String(BigInt(String(current?.rate_scaled_delta ?? "0")) + row.rate_scaled_delta),
      active_delta: String(BigInt(String(current?.active_delta ?? "0")) + row.active_delta),
      updated_seq: seq,
    };
    this.db
      .prepare(
        `INSERT INTO ${RATE_EVENTS_TABLE} (token, effective_ms, rate_delta, rate_scaled_delta, active_delta, updated_seq)
         VALUES (@token, @effective_ms, @rate_delta, @rate_scaled_delta, @active_delta, @updated_seq)
         ON CONFLICT(token, effective_ms) DO UPDATE SET rate_delta = @rate_delta,
           rate_scaled_delta = @rate_scaled_delta, active_delta = @active_delta, updated_seq = @updated_seq`
      )
      .run(next);
  }

  private recomputeLadderSuffix(token: string, fromBucket: number, seq: number): number {
    const previous = this.db
      .prepare(
        `SELECT rate_scaled_through_bucket, active_through_bucket FROM ${TABLES.rate_ladder}
         WHERE token = ? AND bucket_start_ms < ? ORDER BY bucket_start_ms DESC LIMIT 1`
      )
      .get(token, fromBucket) as Record<string, unknown> | undefined;
    let rate = BigInt(String(previous?.rate_scaled_through_bucket ?? "0"));
    let active = BigInt(String(previous?.active_through_bucket ?? "0"));
    const rows = this.db
      .prepare(
        `SELECT bucket_start_ms, rate_scaled_delta, active_delta FROM ${TABLES.rate_ladder}
         WHERE token = ? AND bucket_start_ms >= ? ORDER BY bucket_start_ms ASC`
      )
      .all(token, fromBucket) as Array<Record<string, unknown>>;
    const update = this.db.prepare(
      `UPDATE ${TABLES.rate_ladder} SET rate_scaled_through_bucket = ?, active_through_bucket = ?, updated_seq = ?
       WHERE token = ? AND bucket_start_ms = ?`
    );
    for (const row of rows) {
      rate += BigInt(String(row.rate_scaled_delta));
      active += BigInt(String(row.active_delta));
      update.run(String(rate), String(active), seq, token, Number(row.bucket_start_ms));
    }
    return rows.length;
  }

  /**
   * Add a delta to a materialized row. Amounts are decimal strings and the
   * addition happens in BigInt, not in SQLite: `TEXT + TEXT` coerces to a float
   * and silently drops the low digits of an i128, which is precisely the error
   * a payments dashboard must not make.
   */
  private accumulate(view: keyof typeof TABLES, row: DeltaRow, seq: number): void {
    const table = TABLES[view];
    const keys = KEYS[view];
    const measures = MEASURES[view];
    const where = keys.map((key) => `${key} = @${key}`).join(" AND ");
    const record = row as unknown as Record<string, unknown>;
    const current = this.db
      .prepare(`SELECT ${measures.join(", ")} FROM ${table} WHERE ${where}`)
      .get(record) as Record<string, unknown> | undefined;

    const next: Record<string, unknown> = {};
    for (const key of keys) next[key] = record[key];
    for (const measure of measures) {
      const before = BigInt(String(current?.[measure] ?? "0"));
      const delta = BigInt(String(record[measure] ?? "0"));
      next[measure] = String(before + delta);
    }
    next.updated_seq = seq;

    const columns = [...keys, ...measures, "updated_seq"];
    this.db
      .prepare(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((column) => `@${column}`).join(", ")})
         ON CONFLICT (${keys.join(", ")}) DO UPDATE SET ${[...measures, "updated_seq"].map((column) => `${column} = @${column}`).join(", ")}`
      )
      .run(next);
  }

  private upsertDim(dim: StreamDim): void {
    this.db
      .prepare(
        `INSERT INTO ${TABLES.streams}
         (stream_id, token, sender, recipient, deposit, claimed, start_ms, end_ms, rate_per_second, status, paused_at_ms, visible_from_ms, schedule_json, refund_target, created_seq)
         VALUES (@stream_id, @token, @sender, @recipient, @deposit, @claimed, @start_ms, @end_ms, @rate_per_second, @status, @paused_at_ms, @visible_from_ms, @schedule_json, @refund_target, @created_seq)
         ON CONFLICT(stream_id) DO UPDATE SET token = excluded.token, sender = excluded.sender, recipient = excluded.recipient,
           deposit = excluded.deposit, claimed = excluded.claimed, start_ms = excluded.start_ms, end_ms = excluded.end_ms,
           rate_per_second = excluded.rate_per_second, status = excluded.status, paused_at_ms = excluded.paused_at_ms,
           visible_from_ms = excluded.visible_from_ms,
           schedule_json = excluded.schedule_json, refund_target = excluded.refund_target`
      )
      .run({
        stream_id: dim.stream_id,
        token: dim.token,
        sender: dim.sender,
        recipient: dim.recipient,
        deposit: String(dim.deposit),
        claimed: String(dim.claimed),
        start_ms: dim.start_ms,
        end_ms: dim.end_ms,
        rate_per_second: String(dim.rate_per_second),
        status: dim.status,
        paused_at_ms: dim.paused_at_ms,
        visible_from_ms: dim.visible_from_ms,
        schedule_json: JSON.stringify(dim.segments.map((segment) => ({
          start_ms: segment.start_ms,
          end_ms: segment.end_ms,
          allocation: String(segment.allocation),
          basis_seconds: String(segment.basis_seconds),
        }))),
        refund_target: dim.refund_target,
        created_seq: dim.created_seq,
      });
  }

  private advanceWatermarks(deltas: { last_seq: number; last_ledger: number; last_event_ms: number }, eventMs: number): void {
    const at = this.now();
    for (const view of VIEW_NAMES) {
      this.db
        .prepare(
          `INSERT INTO analytics_watermarks (view, last_seq, last_ledger, last_event_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(view) DO UPDATE SET last_seq = excluded.last_seq, last_ledger = excluded.last_ledger,
             last_event_ms = excluded.last_event_ms, updated_at_ms = excluded.updated_at_ms`
        )
        .run(view, deltas.last_seq, deltas.last_ledger, eventMs, at);
    }
  }

  private bumpCounter(key: string, by: number): void {
    this.setCounter(key, String(this.counter(key) + by));
  }

  private setCounter(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO analytics_counters(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, value);
  }

  private counter(key: string): number {
    const row = this.db.prepare("SELECT value FROM analytics_counters WHERE key = ?").get(key) as { value: string } | undefined;
    return Number(row?.value ?? "0") || 0;
  }

  private counterText(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM analytics_counters WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private toAddress(row: Record<string, unknown>): AddressTotalsRow {
    return {
      address: String(row.address),
      role: String(row.role) as Role,
      token: String(row.token),
      streams_created: BigInt(String(row.streams_created)),
      streams_active: BigInt(String(row.streams_active)),
      funded: BigInt(String(row.funded)),
      claimed: BigInt(String(row.claimed)),
      settled: BigInt(String(row.settled)),
      refunded: BigInt(String(row.refunded)),
      rate_per_second: BigInt(String(row.rate_per_second)),
    };
  }

  private toAsset(row: Record<string, unknown>): AssetTotalsRow & { escrow_remaining: bigint } {
    const funded = BigInt(String(row.funded));
    const claimed = BigInt(String(row.claimed));
    const settled = BigInt(String(row.settled));
    const refunded = BigInt(String(row.refunded));
    return {
      token: String(row.token),
      streams_created: BigInt(String(row.streams_created)),
      streams_active: BigInt(String(row.streams_active)),
      funded,
      claimed,
      settled,
      refunded,
      rate_per_second: BigInt(String(row.rate_per_second)),
      escrow_remaining: funded - claimed - settled - refunded,
    };
  }

  private toDim(row: Record<string, unknown>): StreamDim {
    const segments = JSON.parse(String(row.schedule_json ?? "[]")) as Array<Record<string, unknown>>;
    return {
      stream_id: String(row.stream_id),
      token: String(row.token),
      sender: String(row.sender),
      recipient: String(row.recipient),
      deposit: BigInt(String(row.deposit)),
      claimed: BigInt(String(row.claimed)),
      start_ms: Number(row.start_ms),
      end_ms: Number(row.end_ms),
      rate_per_second: BigInt(String(row.rate_per_second)),
      status: String(row.status) as StreamDim["status"],
      paused_at_ms: row.paused_at_ms === null || row.paused_at_ms === undefined ? null : Number(row.paused_at_ms),
      visible_from_ms: Number(row.visible_from_ms ?? 0),
      segments: segments.map((segment) => ({
        start_ms: Number(segment.start_ms),
        end_ms: Number(segment.end_ms),
        allocation: BigInt(String(segment.allocation)),
        basis_seconds: BigInt(String(segment.basis_seconds)),
      })),
      refund_target: row.refund_target === null || row.refund_target === undefined ? null : String(row.refund_target),
      created_seq: Number(row.created_seq),
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
