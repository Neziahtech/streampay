import { sanitizeAddress, sanitizeAttributes } from "../privacy.js";
import type { AnomalyAlertView, Detection, Evidence, RuleMode, Severity, WindowCitation } from "./types.js";
import { ANOMALY_EVENT_NAME } from "./types.js";
import type { WebhookStore } from "../webhooks/store.js";

/**
 * Privacy line for alert evidence (docs/PRIVACY.md): counts and thresholds
 * travel, identifiers travel only as their 8-character prefix, and anything the
 * telemetry policy calls financial is dropped rather than masked. Applied at
 * the alert boundary only — the stored detection keeps its raw citation so a
 * replay can still re-derive it.
 */
export function redactEvidence(evidence: Evidence): Record<string, string | number | boolean> {
  return sanitizeAttributes({ ...evidence.metrics, ...evidence.actors });
}

/** One address, or the two halves of a pair key, each redacted on its own. */
export function redactSubject(subjectKey: string): string {
  return subjectKey
    .split("|")
    .map((part) => sanitizeAddress(part))
    .join("|");
}

export function alertView(args: {
  alertId: string;
  type: "raised" | "resolved";
  detection: Detection;
  ruleId: string;
  summary: string;
  severity: Severity;
  mode: RuleMode;
  evidence: Evidence;
  citation: WindowCitation;
  tenantId: string;
  subjectKey: string;
  routed: boolean;
  atMs: number;
}): AnomalyAlertView {
  return {
    alert_id: args.alertId,
    type: args.type,
    detection_id: args.detection.id,
    tenant_id: args.tenantId,
    rule_id: args.ruleId,
    rule_version: args.detection.ruleVersion,
    severity: args.severity,
    mode: args.mode,
    summary: args.summary,
    subject: redactSubject(args.subjectKey),
    window: {
      from_ledger: args.citation.fromLedger,
      to_ledger: args.citation.toLedger,
      first_event_id: args.citation.firstEventId,
      last_event_id: args.citation.lastEventId,
      start_ms: args.citation.startMs,
      end_ms: args.citation.endMs,
    },
    explanation: redactEvidence(args.evidence),
    cited_event_ids: args.evidence.citedEventIds,
    fingerprint: args.detection.fingerprint,
    routed: args.routed,
    at_ms: args.atMs,
  };
}

/** Where an anomaly alert goes. Sinks must never take the detector down. */
export interface AnomalyAlertSink {
  readonly name: string;
  deliver(alert: AnomalyAlertView): void | Promise<void>;
}

/** Structured JSON line for the log aggregator, already redacted. */
export class LogAlertSink implements AnomalyAlertSink {
  readonly name = "log";

  constructor(private readonly log: (line: string) => void = (line) => console.log(line)) {}

  deliver(alert: AnomalyAlertView): void {
    this.log(JSON.stringify({ service: "streampay-indexer", component: "anomaly", ...alert }));
  }
}

/** Tests and the HTTP surface read this back instead of asserting on stdout. */
export class MemoryAlertSink implements AnomalyAlertSink {
  readonly name = "memory";
  readonly delivered: AnomalyAlertView[] = [];

  deliver(alert: AnomalyAlertView): void {
    this.delivered.push(alert);
  }
}

/**
 * Fan the alert out through the tenant's own webhook subscriptions (#215). The
 * queue is the same one the dispatcher drains, so alert delivery inherits the
 * retries, dead-letter queue and per-tenant isolation of every other event.
 */
export class WebhookAlertSink implements AnomalyAlertSink {
  readonly name = "webhook";

  constructor(
    private readonly webhooks: WebhookStore,
    private readonly onFailure: (error: unknown) => void = (error) =>
      console.error("[anomaly] webhook alert routing failed:", error)
  ) {}

  deliver(alert: AnomalyAlertView): void {
    try {
      this.webhooks.queueDeliveriesForEvent(
        {
          id: alert.alert_id,
          name: ANOMALY_EVENT_NAME,
          streamId: null,
          ledgerClosedAt: new Date(alert.at_ms).toISOString(),
          data: { ...alert },
        },
        { tenantId: alert.tenant_id }
      );
    } catch (error) {
      this.onFailure(error);
    }
  }
}

/** Deliver to every sink, isolating a broken one from the rest. */
export class FanOutAlertSink implements AnomalyAlertSink {
  readonly name = "fanout";

  constructor(
    private readonly sinks: readonly AnomalyAlertSink[],
    private readonly onFailure: (sink: string, error: unknown) => void = (sink, error) =>
      console.error(`[anomaly] alert sink '${sink}' failed:`, error)
  ) {}

  deliver(alert: AnomalyAlertView): void {
    for (const sink of this.sinks) {
      try {
        const outcome = sink.deliver(alert);
        if (outcome instanceof Promise) outcome.catch((error) => this.onFailure(sink.name, error));
      } catch (error) {
        this.onFailure(sink.name, error);
      }
    }
  }
}
