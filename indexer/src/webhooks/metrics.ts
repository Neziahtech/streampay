import { createHash } from "node:crypto";

/** Outcomes the dispatcher reports, one label value each. */
export type WebhookDeliveryOutcome = "delivered" | "retry" | "dead_letter" | "blocked_ssrf" | "inactive";

export const WEBHOOK_OUTCOMES: readonly WebhookDeliveryOutcome[] = [
  "delivered",
  "retry",
  "dead_letter",
  "blocked_ssrf",
  "inactive",
];

/** Latency histogram buckets, in milliseconds. */
export const DEFAULT_BUCKETS_MS = [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000] as const;

/** A delivery has to finish inside this to count as on time. */
export const DEFAULT_SLA_MS = 5_000;

export interface WebhookMetricsOptions {
  /** Commitment a single delivery attempt must fit inside. */
  slaMs?: number;
  /** Fraction of the sliding window allowed to miss `slaMs` before alarming. */
  breachBudget?: number;
  /** Attempts kept in the sliding window. */
  windowSize?: number;
  /** Window fill required before the alarm may engage. */
  minSamples?: number;
  bucketsMs?: readonly number[];
}

export interface WebhookSlaSnapshot {
  slaMs: number;
  samples: number;
  breaches: number;
  breachRate: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  breached: boolean;
}

interface TenantSeries {
  samples: number[];
  breaches: number;
  byOutcome: Partial<Record<WebhookDeliveryOutcome, number>>;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.min(low + 1, sorted.length - 1);
  const weight = position - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

/**
 * Prometheus text-exposition metrics for webhook delivery, in the hand-rolled
 * style of the outbox surface (no client dependency).
 *
 * The SLA is measured per delivery *attempt*, which is the unit an operator can
 * act on: an endpoint that answers in 20s on its fifth retry is not meeting a
 * 5s commitment, and averaging over whole deliveries would hide it. A sliding
 * window of the most recent attempts carries the breach budget, so a brief
 * blip cannot flip the alarm and a sustained one cannot stay hidden.
 */
export class WebhookMetrics {
  private readonly slaMs: number;
  private readonly breachBudget: number;
  private readonly windowSize: number;
  private readonly minSamples: number;
  private readonly bucketsMs: readonly number[];

  private readonly window: number[] = [];
  private readonly bucketCounts: number[];
  private sumMs = 0;
  private total = 0;
  private breaches = 0;
  private readonly globalByOutcome: Partial<Record<WebhookDeliveryOutcome, number>> = {};
  private readonly tenants = new Map<string, TenantSeries>();
  /** Registry-side totals, so `subscriptions` reflects deletes too. */
  private readonly subscriptionCounts = { active: 0, disabled: 0 };

  constructor(options: WebhookMetricsOptions = {}) {
    this.slaMs = options.slaMs ?? DEFAULT_SLA_MS;
    this.breachBudget = options.breachBudget ?? 0.01;
    this.windowSize = options.windowSize ?? 1_000;
    this.minSamples = options.minSamples ?? 20;
    this.bucketsMs = options.bucketsMs ?? DEFAULT_BUCKETS_MS;
    this.bucketCounts = new Array(this.bucketsMs.length + 1).fill(0);
  }

  get configuredSlaMs(): number {
    return this.slaMs;
  }

  observeDelivery(observation: {
    outcome: WebhookDeliveryOutcome;
    latencyMs: number;
    tenantId?: string;
    attempts?: number;
  }): { breached: boolean } {
    const latency = Math.max(0, observation.latencyMs);
    const breached = latency > this.slaMs;

    this.globalByOutcome[observation.outcome] = (this.globalByOutcome[observation.outcome] ?? 0) + 1;
    this.total += 1;
    this.sumMs += latency;
    if (breached) this.breaches += 1;
    for (let i = 0; i < this.bucketsMs.length; i++) {
      if (latency <= this.bucketsMs[i]) {
        this.bucketCounts[i] += 1;
        break;
      }
      if (i === this.bucketsMs.length - 1) this.bucketCounts[this.bucketsMs.length] += 1;
    }

    this.window.push(latency);
    if (this.window.length > this.windowSize) this.window.shift();

    if (observation.tenantId !== undefined) {
      const series = this.tenant(observation.tenantId);
      series.samples.push(latency);
      if (series.samples.length > this.windowSize) series.samples.shift();
      if (breached) series.breaches += 1;
      series.byOutcome[observation.outcome] = (series.byOutcome[observation.outcome] ?? 0) + 1;
    }
    return { breached };
  }

  /** Track a subscription's existence without touching secret material. */
  observeSubscription(state: "active" | "disabled", delta: number): void {
    this.subscriptionCounts[state] = Math.max(0, this.subscriptionCounts[state] + delta);
  }

  snapshot(tenantId?: string): WebhookSlaSnapshot {
    const samples = tenantId === undefined ? this.window : (this.tenants.get(tenantId)?.samples ?? []);
    const sorted = [...samples].sort((a, b) => a - b);
    const late = sorted.filter((ms) => ms > this.slaMs).length;
    const breachRate = sorted.length === 0 ? 0 : late / sorted.length;
    return {
      slaMs: this.slaMs,
      samples: sorted.length,
      breaches: late,
      breachRate,
      p50Ms: quantile(sorted, 0.5),
      p95Ms: quantile(sorted, 0.95),
      p99Ms: quantile(sorted, 0.99),
      maxMs: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
      breached: sorted.length >= this.minSamples && breachRate > this.breachBudget,
    };
  }

  isAlarmActive(tenantId?: string): boolean {
    return this.snapshot(tenantId).breached;
  }

  /** SLA state per tenant, for the registry's own reporting surface. */
  tenantsSnapshot(): Array<{ tenantId: string; snapshot: WebhookSlaSnapshot }> {
    return [...this.tenants.keys()].sort().map((tenantId) => ({ tenantId, snapshot: this.snapshot(tenantId) }));
  }

  /**
   * Render the exposition. `stats` is whatever the store reports at scrape time
   * so backlog depth and age stay honest numbers rather than in-process guesses.
   */
  render(stats: {
    byState: Record<string, number>;
    oldestPendingAgeMs: number;
    subscriptions?: { active: number; disabled: number };
  } = { byState: {}, oldestPendingAgeMs: 0 }): string {
    const lines: string[] = [];
    const push = (help: string, type: string, name: string, samples: Array<[string, number]>) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, value] of samples) lines.push(`${name}${labels ? `{${labels}}` : ""} ${value}`);
    };
    const label = (pairs: Record<string, string | number>): string =>
      Object.entries(pairs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(",");

    push(
      "Webhook delivery attempts by outcome.",
      "counter",
      "streampay_webhook_dispatch_total",
      WEBHOOK_OUTCOMES.filter((o) => this.globalByOutcome[o] !== undefined).map((o) => [
        label({ outcome: o }),
        this.globalByOutcome[o] as number,
      ])
    );
    const latency = "streampay_webhook_delivery_latency_seconds";
    lines.push(
      `# HELP ${latency}_bucket Webhook delivery attempt latency in seconds.`,
      `# TYPE ${latency}_bucket histogram`
    );
    this.bucketsMs.forEach((upper, i) => {
      const cumulative = this.bucketCounts.slice(0, i + 1).reduce((a, b) => a + b, 0);
      lines.push(`${latency}_bucket{${label({ le: String(upper / 1000) })}} ${cumulative}`);
    });
    lines.push(`${latency}_bucket{${label({ le: "+Inf" })}} ${this.total}`);
    lines.push(`${latency}_sum ${this.sumMs / 1000}`, `${latency}_count ${this.total}`);
    push(
      "Webhook deliveries that missed the latency SLA.",
      "counter",
      "streampay_webhook_sla_breaches_total",
      [["", this.breaches]]
    );
    push(
      "Configured webhook delivery SLA in seconds.",
      "gauge",
      "streampay_webhook_sla_objective_seconds",
      [["", this.slaMs / 1000]]
    );
    const snapshot = this.snapshot();
    push(
      "Observed webhook delivery latency quantiles in seconds, from the sliding window.",
      "gauge",
      "streampay_webhook_delivery_latency_quantile_seconds",
      [
        [label({ quantile: "0.5" }), snapshot.p50Ms / 1000],
        [label({ quantile: "0.95" }), snapshot.p95Ms / 1000],
        [label({ quantile: "0.99" }), snapshot.p99Ms / 1000],
      ]
    );
    push(
      `1 when the webhook SLA breach rate exceeds ${this.breachBudget} of the sliding window.`,
      "gauge",
      "streampay_webhook_sla_breach_alarm",
      [["", snapshot.breached ? 1 : 0]]
    );
    push(
      "SLA breach fraction of the current sliding window.",
      "gauge",
      "streampay_webhook_sla_breach_ratio",
      [["", snapshot.breachRate]]
    );
    push(
      "Webhook deliveries by state.",
      "gauge",
      "streampay_webhook_deliveries",
      Object.entries(stats.byState).map(([state, value]) => [label({ state }), value])
    );
    push(
      "Age of the oldest pending webhook delivery in seconds.",
      "gauge",
      "streampay_webhook_oldest_pending_seconds",
      [["", stats.oldestPendingAgeMs / 1000]]
    );
    const subscriptions = stats.subscriptions ?? this.subscriptionCounts;
    push(
      "Webhook subscriptions by status.",
      "gauge",
      "streampay_webhook_subscriptions",
      [
        [label({ status: "active" }), subscriptions.active],
        [label({ status: "disabled" }), subscriptions.disabled],
      ]
    );
    push(
      "SLA breach state per tenant, 1 when that tenant is out of budget.",
      "gauge",
      "streampay_webhook_sla_breached_by_tenant",
      this.tenantsSnapshot().map((t) => [label({ tenant_id: t.tenantId }), t.snapshot.breached ? 1 : 0])
    );
    return `${lines.join("\n")}\n`;
  }

  private tenant(tenantId: string): TenantSeries {
    let series = this.tenants.get(tenantId);
    if (!series) {
      series = { samples: [], breaches: 0, byOutcome: {} };
      this.tenants.set(tenantId, series);
    }
    return series;
  }
}

/**
 * Names one SLA incident so a consumer can deduplicate alerts about the same
 * tenant/endpoint breaching inside the same window.
 */
export function slaIncidentId(tenantId: string, endpointId: string, windowStartedAtMs: number): string {
  const digest = createHash("sha256")
    .update(`${tenantId}|${endpointId}|${Math.floor(windowStartedAtMs)}`)
    .digest("hex")
    .slice(0, 16);
  return `sla_${digest}`;
}
