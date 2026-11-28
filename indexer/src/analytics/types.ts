/**
 * Materialized analytics views (issue #581).
 *
 * The fold in `fold.ts` is the only place that turns journal events into view
 * deltas; everything else (incremental refresh, rebuild-from-scratch, reads)
 * consumes that one implementation, so the two refresh paths cannot disagree.
 */

/** Every view is a projection of the same fold, watermarked independently. */
export const VIEW_NAMES = ["address_totals", "asset_totals", "accrual_buckets", "rate_ladder"] as const;
export type ViewName = (typeof VIEW_NAMES)[number];

export const VIEW_HELP: Record<ViewName, string> = {
  address_totals: "Per (address, role, token) portfolio totals: funded, claimed, settled, refunded, active streams, nominal scheduled rate. Roles are sender, recipient and refund target.",
  asset_totals: "Per token aggregates of the same measures, plus the summed nominal scheduled rate.",
  accrual_buckets: "Token x bucket realized flows and event counts, in event time — the stacked-timeseries feed.",
  rate_ladder: "Token x bucket changes to the summed live rate, which is what a forecast integrates.",
};

export const ANALYTICS_DIRTY_LEDGER_KEY = "dirty_from_ledger";
export const ANALYTICS_DIRTY_REASON_KEY = "dirty_reason";
export const ANALYTICS_HISTORY_KEY = "complete_event_history";
export const ANALYTICS_HISTORY_VERSION = "1";
export const ANALYTICS_HISTORY_START_LEDGER_KEY = "complete_event_history_start_ledger";

/** Roles an address can hold on a stream. */
export const ROLES = ["sender", "recipient", "refund"] as const;
export type Role = (typeof ROLES)[number];

export interface AddressTotalsRow {
  address: string;
  role: Role;
  token: string;
  streams_created: bigint;
  streams_active: bigint;
  funded: bigint;
  claimed: bigint;
  settled: bigint;
  refunded: bigint;
  /** Nominal floor rate of nonterminal streams, not an as-of clock rate. */
  rate_per_second: bigint;
}

export interface AssetTotalsRow {
  token: string;
  streams_created: bigint;
  streams_active: bigint;
  funded: bigint;
  claimed: bigint;
  settled: bigint;
  refunded: bigint;
  /** Nominal floor rate of nonterminal streams, not an as-of clock rate. */
  rate_per_second: bigint;
}

export interface AccrualBucketRow {
  token: string;
  bucket_start_ms: number;
  funded: bigint;
  claimed: bigint;
  settled: bigint;
  refunded: bigint;
  streams_created: bigint;
  cancellations: bigint;
  withdrawals: bigint;
}

export interface RateLadderRow {
  token: string;
  bucket_start_ms: number;
  /** Change to the summed floor per-second rate from this bucket onward. */
  rate_delta: bigint;
  /** Fixed-point rate used by forecasts so fractional accrual is not lost. */
  rate_scaled_delta: bigint;
  /** Change to the number of scheduled spans, used to bound rounding error. */
  active_delta: bigint;
}

/** Exact effective-time change retained internally for forecasts. */
export interface RateEventRow {
  token: string;
  effective_ms: number;
  rate_delta: bigint;
  rate_scaled_delta: bigint;
  active_delta: bigint;
}

export const RATE_SCALE = 1_000_000_000_000n;

/** One journal row as the fold sees it. `seq` is the fold position. */
export interface JournalEvent {
  seq: number;
  event_id: string;
  name: string;
  stream_id: string | null;
  ledger: number;
  ledger_cursor: string;
  ledger_closed_at: string;
  payload: Record<string, unknown>;
}

/**
 * What the analytics fold reads. `OutboxStore` satisfies it structurally: the
 * outbox journal *is* the durable, ordered, retractable event feed, so a
 * materialized view refreshes from the same rows a push consumer is delivered
 * from instead of inventing a second one.
 */
export interface JournalSource {
  journalAfterSeq(afterSeq: number, limit: number): JournalEvent[];
  journalTip(): { seq: number; ledger: number };
}

/** Where a view's fold stopped. `seq` is authoritative; the ledger is the staleness key. */
export interface Watermark {
  view: ViewName;
  last_seq: number;
  last_ledger: number;
  /** Event time of the last applied journal row, so lag is measurable in seconds too. */
  last_event_ms: number;
  updated_at_ms: number;
  rows: number;
}

export interface RefreshBatch {
  events_read: number;
  applied: number;
  /** Events the fold recognized but deliberately did not price (batch summaries). */
  counted_only: number;
  /** Journal rows outside the views' scope, skipped without being an error. */
  unknown: number;
  from_seq: number;
  to_seq: number;
  duration_ms: number;
  /** Rows written across all views. */
  writes: number;
}

export interface RefreshStats {
  batches: number;
  events_applied: number;
  events_counted_only: number;
  events_skipped_unknown: number;
  rebuilds: number;
  last_rebuild_reason: string | null;
  last_batch: RefreshBatch | null;
  /** Summed `seq` applied, so an operator can diff two stats reads. */
  watermark_seq: number;
  watermark_ledger: number;
  journal_seq: number;
  lag_events: number;
  lag_ms: number;
  /** Events/second of the most recent batch — the refresh throughput budget. */
  events_per_second: number;
  errors: number;
  last_error: string | null;
}

/** One priced window in the contract's piecewise rate schedule. */
export interface RateSegment {
  start_ms: number;
  end_ms: number;
  allocation: bigint;
  basis_seconds: bigint;
}

/** Stream facts the fold carries forward; the dimension table it reads and writes. */
export interface StreamDim {
  stream_id: string;
  token: string;
  sender: string;
  recipient: string;
  /** Escrow deposited so far (create + top-ups + rate-change reserve). */
  deposit: bigint;
  claimed: bigint;
  start_ms: number;
  end_ms: number;
  rate_per_second: bigint;
  status: "active" | "paused" | "cancelled" | "depleted";
  /** When paused, the accrual time the stream froze at. */
  paused_at_ms: number | null;
  /** Earliest real event time at which this schedule is visible to the ladder. */
  visible_from_ms: number;
  /** Empty means the original single-window formula; otherwise the stored schedule. */
  segments: RateSegment[];
  /** Destination of the unstreamed remainder on cancellation; null means the sender. */
  refund_target: string | null;
  created_seq: number;
}

export interface AnalyticsConfig {
  /** Bucket width for `accrual_buckets` and `rate_ladder`. */
  bucketMs: number;
  /** Refresh cadence for the worker. */
  refreshIntervalMs: number;
  /** Journal rows folded per transaction. */
  batchSize: number;
  /** A view is in SLO breach when its watermark is older than this. */
  sloMs: number;
  /** Upper bound a freshness-gated read will block for. */
  maxWaitMs: number;
  /** Poll interval while a gated read blocks. */
  waitPollMs: number;
  /** Events/second the refresh must sustain (documented budget, asserted in tests). */
  throughputBudgetPerSecond: number;
}

export const DEFAULT_ANALYTICS_CONFIG: AnalyticsConfig = {
  bucketMs: 3_600_000,
  refreshIntervalMs: 1_000,
  batchSize: 500,
  sloMs: 30_000,
  maxWaitMs: 5_000,
  waitPollMs: 50,
  throughputBudgetPerSecond: 500,
};

export const ANALYTICS_ENV = {
  enabled: "ANALYTICS_ENABLED",
  bucketMs: "ANALYTICS_BUCKET_MS",
  refreshMs: "ANALYTICS_REFRESH_MS",
  batchSize: "ANALYTICS_BATCH_SIZE",
  sloMs: "ANALYTICS_SLO_MS",
  maxWaitMs: "ANALYTICS_MAX_WAIT_MS",
  waitPollMs: "ANALYTICS_WAIT_POLL_MS",
  budgetEps: "ANALYTICS_THROUGHPUT_BUDGET_EPS",
  apiToken: "ANALYTICS_API_TOKEN",
  mutationRate: "ANALYTICS_MUTATION_RATE_PER_SEC",
} as const;

/**
 * Events the fold prices. Everything else in the journal is ignored on purpose:
 * an unknown event name is not an error, it is a fact that analytics does not
 * claim to cover. `counted_only` events must never be priced because the
 * per-stream events that make them up are folded too.
 */
export const PRICED_EVENTS = [
  "stream_created",
  "stream_topped_up",
  "withdrawn",
  "stream_cancelled",
  "stream_paused",
  "stream_resumed",
  "rate_change_accepted",
  "ownership_accepted",
  "sender_transferred",
  "stream_refund_target_changed",
] as const;

export const COUNTED_ONLY_EVENTS = ["batch_withdraw_summary", "streams_created"] as const;

/** Why a gated read could not answer fresh. */
export type StalenessReason = "fresh" | "waited_out" | "unknown_view" | "disabled";

export interface Staleness {
  /** `last_event_ms` of the watermark, so lag is comparable to wall time. */
  watermark_event_ms: number;
  watermark_ledger: number;
  watermark_seq: number;
  /** Journal tip at read time. */
  journal_seq: number;
  lag_events: number;
  lag_ms: number;
  slo_ms: number;
  in_slo: boolean;
  /** A retraction invalidated the rows; reads wait for the rebuild instead of serving them. */
  dirty: boolean;
}

export interface ReadGate {
  /** Minimum ledger the caller will accept as answerable. */
  minLedger?: number;
  /** Maximum events of journal lag the caller will accept. */
  maxLagEvents?: number;
  /** How long the read may block waiting for the watermark to catch up. */
  waitMs?: number;
}

export interface GateResult<T> {
  ok: boolean;
  data?: T;
  staleness: Staleness;
  waited_ms: number;
  reason?: StalenessReason;
}

/** One view as the scrape sees it. */
export interface ViewSnapshot {
  view: ViewName;
  watermark: Watermark;
  staleness: Staleness;
}

/**
 * The analytics surface for the `/metrics` exposition. Deliberately carries no
 * addresses, no tokens and no amounts: a metric label set is a broadcast, and
 * portfolio sizes are not something a scrape should publish.
 */
export interface AnalyticsSnapshot {
  views: ViewSnapshot[];
  stats: RefreshStats;
  journal_seq: number;
  slo_ms: number;
  budget_eps: number;
  history_ready: boolean;
  dirty: boolean;
}
