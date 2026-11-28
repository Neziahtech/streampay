import type { TickSummary } from "./refresh.js";
import type { AnalyticsSnapshot, ViewSnapshot } from "./types.js";

export type GateOutcome = "served" | "waited_out";

/**
 * Prometheus text-exposition metrics for the analytics views, in the hand
 * rolled style of the other indexer surfaces (no client dependency).
 *
 * The store's durable counters are snapshotted at scrape time; the worker-only
 * numbers (ticks, budget caps, gated reads) accumulate here. No label carries
 * an address, a token or an amount — see `AnalyticsSnapshot`.
 */
export class AnalyticsMetrics {
  private ticks = 0;
  private cappedTicks = 0;
  private rebuiltTicks = 0;
  private readonly gates: Partial<Record<GateOutcome, number>> = {};
  private gateWaitMs = 0;

  observeTick(summary: TickSummary): void {
    this.ticks += 1;
    if (summary.capped) this.cappedTicks += 1;
    if (summary.rebuilt) this.rebuiltTicks += 1;
  }

  observeGate(outcome: GateOutcome, waitedMs: number): void {
    this.gates[outcome] = (this.gates[outcome] ?? 0) + 1;
    this.gateWaitMs += waitedMs;
  }

  render(snapshot: AnalyticsSnapshot): string {
    const lines: string[] = [];
    const push = (help: string, type: string, name: string, samples: Array<[string, number]>) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, value] of samples) lines.push(`${name}${labels ? `{${labels}}` : ""} ${value}`);
    };
    const viewLabel = (view: ViewSnapshot["view"]): string => `view="${view}"`;

    push(
      "Highest journal sequence each view has folded.",
      "gauge",
      "streampay_analytics_watermark_seq",
      snapshot.views.map((v) => [viewLabel(v.view), v.watermark.last_seq])
    );
    push(
      "Ledger of the last event each view has folded — the staleness watermark.",
      "gauge",
      "streampay_analytics_watermark_ledger",
      snapshot.views.map((v) => [viewLabel(v.view), v.watermark.last_ledger])
    );
    push("Journal high-water mark, retractable rows excluded.", "gauge", "streampay_analytics_journal_seq", [
      ["", snapshot.journal_seq],
    ]);
    push(
      "Journal rows not yet folded into each view.",
      "gauge",
      "streampay_analytics_lag_events",
      snapshot.views.map((v) => [viewLabel(v.view), v.staleness.lag_events])
    );
    push(
      "Seconds since the event each view's watermark stopped on.",
      "gauge",
      "streampay_analytics_staleness_seconds",
      snapshot.views.map((v) => [viewLabel(v.view), v.staleness.lag_ms / 1000])
    );
    push(
      "1 when a view is outside its freshness SLO.",
      "gauge",
      "streampay_analytics_slo_breach",
      snapshot.views.map((v) => [viewLabel(v.view), v.staleness.in_slo ? 0 : 1])
    );
    push(
      "Seconds by which the worst view misses the freshness SLO (0 when all are in SLO).",
      "gauge",
      "streampay_analytics_slo_violation_seconds",
      [["", Math.max(0, ...snapshot.views.map((v) => (v.staleness.in_slo ? 0 : v.staleness.lag_ms - snapshot.slo_ms))) / 1000]]
    );
    push("Configured freshness SLO in seconds.", "gauge", "streampay_analytics_slo_seconds", [
      ["", snapshot.slo_ms / 1000],
    ]);
    push(
      "Materialized rows per view, so an unexplained empty panel is distinguishable from a slow one.",
      "gauge",
      "streampay_analytics_rows",
      snapshot.views.map((v) => [viewLabel(v.view), v.watermark.rows])
    );
    push("1 when a reorg retraction has marked the views dirty and a rebuild is pending.", "gauge", "streampay_analytics_dirty", [
      ["", snapshot.dirty ? 1 : 0],
    ]);

    push("Refresh batches folded by the worker.", "counter", "streampay_analytics_batches_total", [
      ["", snapshot.stats.batches],
    ]);
    push(
      "Journal rows handled by the fold, by whether they were priced, counted without amounts, or outside the views' scope.",
      "counter",
      "streampay_analytics_events_total",
      [
        ['kind="applied"', snapshot.stats.events_applied],
        ['kind="counted_only"', snapshot.stats.events_counted_only],
        ['kind="skipped_unknown"', snapshot.stats.events_skipped_unknown],
      ]
    );
    push("Refresh worker ticks.", "counter", "streampay_analytics_ticks_total", [["", this.ticks]]);
    push("Refresh ticks that stopped at the throughput budget instead of the journal head.", "counter", "streampay_analytics_ticks_capped_total", [
      ["", this.cappedTicks],
    ]);
    push("Refresh ticks that folded a whole-journal rebuild.", "counter", "streampay_analytics_ticks_rebuilt_total", [
      ["", this.rebuiltTicks],
    ]);
    push("Events per second the most recent refresh batch sustained.", "gauge", "streampay_analytics_refresh_events_per_second", [
      ["", snapshot.stats.events_per_second],
    ]);
    push("Configured refresh throughput budget in events per second.", "gauge", "streampay_analytics_budget_events_per_second", [
      ["", snapshot.budget_eps],
    ]);
    push("Whole-journal rebuilds.", "counter", "streampay_analytics_rebuilds_total", [["", snapshot.stats.rebuilds]]);
    push("Refresh errors the worker recorded.", "counter", "streampay_analytics_errors_total", [
      ["", snapshot.stats.errors],
    ]);
    push(
      "Freshness-gated analytics reads by outcome.",
      "counter",
      "streampay_analytics_read_gated_total",
      (["served", "waited_out"] as GateOutcome[]).map((outcome) => [`result="${outcome}"`, this.gates[outcome] ?? 0])
    );
    push("Milliseconds gated analytics reads spent blocking on the writer.", "counter", "streampay_analytics_read_wait_milliseconds_total", [
      ["", this.gateWaitMs],
    ]);
    return `${lines.join("\n")}\n`;
  }
}
