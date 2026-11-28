/**
 * Shared shapes for the heuristic anomaly detector (issue #582).
 *
 * Detection is deliberately not consensus: every rule is a deterministic
 * function of the events in a ledger range, so a detection can be re-derived
 * and argued about instead of being a model's opinion.
 */

export type Severity = "info" | "warning" | "critical";
export const SEVERITIES: readonly Severity[] = ["info", "warning", "critical"];

export type RuleMode = "shadow" | "enforce";
export const RULE_MODES: readonly RuleMode[] = ["shadow", "enforce"];

/** What a rule scores a window of observations against. */
export type RuleScope = "sender" | "pair";

/** Wire name of the indexer-originated event that carries an anomaly alert. */
export const ANOMALY_EVENT_NAME = "anomaly_alert";

/** How many event ids one piece of evidence cites. */
export const MAX_CITED_EVENTS = 10;

export type ObservationRole = "create" | "cancel" | "withdraw" | "other";

/**
 * One ledger fact reduced to what the windowed rules need. `actor` is always
 * the address the event itself names — never an inferred projection owner —
 * because a replay over the cited range only has the events to work from.
 */
export interface Observation {
  eventId: string;
  ledger: number;
  /** Ledger close time. Windows are measured in event time so replay sees them identically. */
  atMs: number;
  name: string;
  role: ObservationRole;
  streamId: string | null;
  sender: string | null;
  recipient: string | null;
  actor: string | null;
  /** Canonical decimal string of the amount moved, or null when the event names none. */
  amount: string | null;
  /** Streams this event created: 1, N for a batch, 0 otherwise. */
  created: number;
}

/** The exact ledger range a detection was derived from. */
export interface WindowCitation {
  fromLedger: number;
  toLedger: number;
  firstEventId: string;
  lastEventId: string;
  startMs: number;
  endMs: number;
}

/**
 * Why a rule fired. `metrics` carries the numbers and thresholds so the alert
 * explains itself; `actors` carries raw identifiers that are redacted at the
 * alert boundary but hashed as-is, so redaction cannot change a verdict.
 */
export interface Evidence {
  metrics: Record<string, string | number>;
  actors: Record<string, string>;
  citedEventIds: string[];
}

export interface Detection {
  id: string;
  ruleId: string;
  ruleVersion: number;
  tenantId: string;
  severity: Severity;
  mode: RuleMode;
  subjectKey: string;
  citation: WindowCitation;
  /** sha256 over the canonical replay input; a verifier recomputes it. */
  fingerprint: string;
  evidence: Evidence;
  /**
   * The thresholds this detection was derived under, recorded rather than
   * looked up: replaying with live config would let a tuning change silently
   * invalidate every citation made before it.
   */
  params: Record<string, number>;
  createdAtMs: number;
}

export interface RuleConfig {
  id: string;
  version: number;
  mode: RuleMode;
  severity: Severity;
  params: Record<string, number>;
  /** Fraction of reviewed shadow detections allowed to be false positives. */
  falsePositiveBudget: number;
  /** Reviews required before the budget judgement means anything. */
  minReviews: number;
}

export interface TenantRuleOverride {
  mode?: RuleMode;
  severity?: Severity;
  params?: Record<string, number>;
  false_positive_budget?: number;
  min_reviews?: number;
}

export const FEEDBACK_LABELS = ["true_positive", "false_positive"] as const;
export type FeedbackLabel = (typeof FEEDBACK_LABELS)[number];

/** An alert as it leaves the process: redacted, cited, and self-describing. */
export interface AnomalyAlertView {
  alert_id: string;
  type: "raised" | "resolved";
  detection_id: string;
  tenant_id: string;
  rule_id: string;
  rule_version: number;
  severity: string;
  mode: RuleMode;
  summary: string;
  subject: string;
  window: {
    from_ledger: number;
    to_ledger: number;
    first_event_id: string;
    last_event_id: string;
    start_ms: number;
    end_ms: number;
  };
  explanation: Record<string, string | number | boolean>;
  cited_event_ids: string[];
  fingerprint: string;
  routed: boolean;
  at_ms: number;
}
