import type { RuleMode, Severity } from "./types.js";

export const DETECTION_MODES: readonly RuleMode[] = ["shadow", "enforce"];
export const DETECTION_SEVERITIES: readonly Severity[] = ["info", "warning", "critical"];
export const REPLAY_OUTCOMES = ["verified", "mismatch", "unavailable"] as const;
export type ReplayOutcomeKind = (typeof REPLAY_OUTCOMES)[number];

interface RuleSeries {
  detections: Map<RuleMode, number>;
  bySeverity: Map<Severity, number>;
  alerts: Map<"raised" | "resolved", number>;
  suppressed: number;
  feedback: Map<"true_positive" | "false_positive", number>;
}

/**
 * Prometheus text exposition for the anomaly detector, in the same hand-rolled
 * style as the webhook and outbox surfaces (no client dependency).
 *
 * Shadow and enforce detections are counted on separate label values, because
 * the whole point of shadow mode is that a rule's numbers are visible while it
 * pages nobody. `streampay_anomaly_promotion_ready` is the operator's answer to
 * "is this rule safe to turn on?".
 */
export class AnomalyMetrics {
  private readonly rules = new Map<string, RuleSeries>();
  private readonly ready = new Map<string, 0 | 1>();
  private readonly replay: Partial<Record<ReplayOutcomeKind, number>> = {};
  private readonly incidentGauges = new Map<string, number>();

  private series(ruleId: string): RuleSeries {
    let series = this.rules.get(ruleId);
    if (series === undefined) {
      series = { detections: new Map(), bySeverity: new Map(), alerts: new Map(), suppressed: 0, feedback: new Map() };
      this.rules.set(ruleId, series);
    }
    return series;
  }

  recordDetection(ruleId: string, severity: Severity, mode: RuleMode, suppressed: boolean): void {
    const series = this.series(ruleId);
    series.detections.set(mode, (series.detections.get(mode) ?? 0) + 1);
    series.bySeverity.set(severity, (series.bySeverity.get(severity) ?? 0) + 1);
    if (suppressed) series.suppressed += 1;
  }

  recordAlert(ruleId: string, type: "raised" | "resolved"): void {
    const series = this.series(ruleId);
    series.alerts.set(type, (series.alerts.get(type) ?? 0) + 1);
  }

  recordFeedback(ruleId: string, label: "true_positive" | "false_positive"): void {
    const series = this.series(ruleId);
    series.feedback.set(label, (series.feedback.get(label) ?? 0) + 1);
  }

  /** Open incidents per rule, from the live window state. */
  recordIncidents(openByRule: Map<string, number>): void {
    this.incidentGauges.clear();
    for (const [ruleId, count] of openByRule) this.incidentGauges.set(ruleId, count);
  }

  /** Promotion verdict for one `<rule>|<tenant>` pair. */
  recordPromotionReady(ruleId: string, tenantId: string, ready: boolean): void {
    this.ready.set(`${ruleId}|${tenantId}`, ready ? 1 : 0);
  }

  recordReplay(outcome: ReplayOutcomeKind): void {
    this.replay[outcome] = (this.replay[outcome] ?? 0) + 1;
  }

  render(): string {
    const lines: string[] = [];
    const ruleIds = [...this.rules.keys()].sort();
    const push = (help: string, type: string, name: string, samples: Array<[string, number]>) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, value] of samples) lines.push(`${name}${labels ? `{${labels}}` : ""} ${value}`);
    };
    const label = (pairs: Record<string, string | number>): string =>
      Object.entries(pairs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(",");

    const detections: Array<[string, number]> = [];
    const severities: Array<[string, number]> = [];
    const alerts: Array<[string, number]> = [];
    const feedback: Array<[string, number]> = [];
    const suppressed: Array<[string, number]> = [];
    for (const ruleId of ruleIds) {
      const series = this.series(ruleId);
      for (const mode of DETECTION_MODES) {
        const count = series.detections.get(mode);
        if (count !== undefined) detections.push([label({ rule_id: ruleId, mode }), count]);
      }
      for (const severity of DETECTION_SEVERITIES) {
        const count = series.bySeverity.get(severity);
        if (count !== undefined) severities.push([label({ rule_id: ruleId, severity }), count]);
      }
      for (const [type, count] of [...series.alerts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        alerts.push([label({ rule_id: ruleId, type }), count]);
      }
      for (const [feedbackLabel, count] of [...series.feedback.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        feedback.push([label({ rule_id: ruleId, label: feedbackLabel }), count]);
      }
      if (series.suppressed > 0) suppressed.push([label({ rule_id: ruleId }), series.suppressed]);
    }

    push("Anomaly detections by rule and mode; shadow detections never paged an operator.", "counter", "streampay_anomaly_detections_total", detections);
    push("Anomaly detections by rule and severity.", "counter", "streampay_anomaly_detections_by_severity_total", severities);
    push("Anomaly detections skipped because the subject was suppressed after a false positive.", "counter", "streampay_anomaly_suppressed_total", suppressed);
    push("Anomaly alerts routed to operators by rule and transition.", "counter", "streampay_anomaly_alerts_total", alerts);
    push("Operator review of anomaly detections by rule and label.", "counter", "streampay_anomaly_feedback_total", feedback);
    push(
      "Open anomaly incidents per rule. 1 sustained means the pattern is still firing.",
      "gauge",
      "streampay_anomaly_incidents_open",
      [...this.incidentGauges.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ruleId, count]) => [label({ rule_id: ruleId }), count])
    );
    push(
      "1 when the rule's shadow review evidence clears its false-positive budget and may be promoted to enforce.",
      "gauge",
      "streampay_anomaly_promotion_ready",
      [...this.ready.entries()].sort().map(([pair, value]) => {
        const [ruleId, tenantId] = pair.split("|");
        return [label({ rule_id: ruleId as string, tenant_id: tenantId as string }), value] as [string, number];
      })
    );
    push(
      "Detection replay verifications by outcome. `mismatch` means a cited ledger range no longer reproduces the alert.",
      "counter",
      "streampay_anomaly_replay_total",
      REPLAY_OUTCOMES.filter((outcome) => this.replay[outcome] !== undefined).map((outcome) => [
        label({ outcome }),
        this.replay[outcome] as number,
      ])
    );
    return `${lines.join("\n")}\n`;
  }
}
