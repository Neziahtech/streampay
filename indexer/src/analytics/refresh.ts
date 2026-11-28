import type { AnalyticsMetrics } from "./metrics.js";
import type { AnalyticsStore } from "./store.js";
import type { RefreshBatch } from "./types.js";

export interface AnalyticsRefresherOptions {
  /** Override the cadence in `store.config.refreshIntervalMs`. */
  tickMs?: number;
  /**
   * Journal rows one tick may fold. Defaults to the configured throughput
   * budget scaled to the tick, so a backfill cannot hold the write lock long
   * enough to starve ingestion.
   */
  budgetPerTick?: number;
}

export interface TickSummary {
  batches: number;
  events_read: number;
  /** The tick stopped because it spent its budget, not because the journal was empty. */
  capped: boolean;
  /** The tick folded a whole-journal rebuild after a reorg retraction. */
  rebuilt: boolean;
  duration_ms: number;
  last_batch: RefreshBatch | null;
}

/**
 * The refresh worker: turn outstanding journal rows into view rows on a
 * cadence, and nothing else.
 *
 * The tick is synchronous because `better-sqlite3` is: one process cannot fold
 * concurrently with itself, so there is no in-flight state to guard and no lock
 * to lose. A rebuild is deliberately outside the budget — reorg recovery must
 * be atomic, and half a rebuilt journal is worse than a slow one.
 */
export class AnalyticsRefresher {
  private timer: NodeJS.Timeout | null = null;
  private ticks = 0;
  private cappedTicks = 0;
  private eventsRead = 0;

  constructor(
    private readonly store: AnalyticsStore,
    private readonly metrics: AnalyticsMetrics,
    private readonly opts: AnalyticsRefresherOptions = {}
  ) {}

  start(): void {
    if (this.timer) return;
    const tickMs = this.tickMs();
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        console.error("Analytics refresh tick failed:", err);
      }
    }, tickMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Fold one tick's budget of journal rows. Failures are recorded durably and
   * rethrown, so the caller (the interval, or an operator hitting the refresh
   * route) decides what to say about them — a broken fold must never look like
   * an idle one.
   */
  tick(): TickSummary {
    const started = Date.now();
    const budget = this.opts.budgetPerTick ?? Math.ceil((this.store.config.throughputBudgetPerSecond * this.tickMs()) / 1000);
    try {
      const summary = this.fold(started, budget);
      this.record(summary);
      return summary;
    } catch (err) {
      this.store.recordError(err);
      throw err;
    }
  }

  private fold(started: number, budget: number): TickSummary {
    if (this.store.isDirty) {
      const batch = this.store.refreshOnce();
      if (batch === null) throw new Error("dirty analytics views produced no rebuild batch");
      return {
        batches: 1,
        events_read: batch.events_read,
        capped: false,
        rebuilt: true,
        duration_ms: Math.max(1, Date.now() - started),
        last_batch: batch,
      };
    }

    let batches = 0;
    let eventsRead = 0;
    let last: RefreshBatch | null = null;
    let capped = false;
    while (eventsRead < budget) {
      const batch = this.store.refreshOnce(Math.min(this.store.config.batchSize, budget - eventsRead));
      if (batch === null) break;
      batches += 1;
      eventsRead += batch.events_read;
      last = batch;
      if (eventsRead >= budget) capped = true;
    }
    // An empty tick is the common case; recording it keeps the rate honest.
    return {
      batches,
      events_read: eventsRead,
      capped: batches > 0 ? capped : false,
      rebuilt: false,
      duration_ms: Math.max(1, Date.now() - started),
      last_batch: last,
    };
  }

  stats(): { ticks: number; capped_ticks: number; events_read: number; running: boolean } {
    return { ticks: this.ticks, capped_ticks: this.cappedTicks, events_read: this.eventsRead, running: this.timer !== null };
  }

  private record(summary: TickSummary): void {
    this.ticks += 1;
    this.eventsRead += summary.events_read;
    if (summary.capped) this.cappedTicks += 1;
    this.metrics.observeTick(summary);
  }

  private tickMs(): number {
    return this.opts.tickMs ?? this.store.config.refreshIntervalMs;
  }
}
