import { createHash } from "node:crypto";
import type { Evidence, Observation, RuleMode, RuleScope, Severity, TenantRuleOverride } from "./types.js";
import { MAX_CITED_EVENTS, RULE_MODES, SEVERITIES } from "./types.js";

/** A tunable threshold, with the range an operator is allowed to ask for. */
export interface ParamSpec {
  default: number;
  min: number;
  max: number;
  description: string;
}

export interface RuleInput {
  /** Address, or `address|address` for pair-scoped rules. */
  subjectKey: string;
  observations: Observation[];
  params: Record<string, number>;
}

/**
 * One declarative rule: what it looks at, which knobs exist, and a pure
 * evaluation over the observations in the window. `version` is part of every
 * detection because changing an evaluation changes what a citation proves.
 */
export interface RuleDefinition {
  id: string;
  version: number;
  summary: string;
  scope: RuleScope;
  severity: Severity;
  params: Record<string, ParamSpec>;
  evaluate(input: RuleInput): Evidence | null;
}

/** Reviews required before a false-positive budget judgement means anything. */
export const DEFAULT_MIN_REVIEWS = 10;
/** Fraction of reviewed shadow detections allowed to be false positives. */
export const DEFAULT_FALSE_POSITIVE_BUDGET = 0.05;

function cite(observations: Observation[]): string[] {
  const sorted = [...observations].sort((a, b) => a.ledger - b.ledger || a.eventId.localeCompare(b.eventId));
  return sorted.slice(-MAX_CITED_EVENTS).map((observation) => observation.eventId);
}

function creations(observations: Observation[]): Observation[] {
  return observations.filter((observation) => observation.role === "create");
}

function evidence(
  metrics: Record<string, string | number>,
  actors: Record<string, string>,
  observations: Observation[]
): Evidence {
  return { metrics, actors, citedEventIds: cite(observations) };
}

/** Order a pair so `a|b` and `b|a` are one subject. */
export function pairKey(a: string, b: string): string {
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

export function splitPairKey(key: string): [string, string] {
  const [a = "", b = ""] = key.split("|");
  return [a, b];
}

const burstCreation: RuleDefinition = {
  id: "burst_creation",
  version: 1,
  summary: "One sender creates more streams inside the window than the threshold.",
  scope: "sender",
  severity: "warning",
  params: {
    window_ms: { default: 60_000, min: 1_000, max: 86_400_000, description: "Sliding window length in ms." },
    threshold: { default: 20, min: 2, max: 100_000, description: "Streams created inside the window that trips the rule." },
  },
  evaluate({ subjectKey, observations, params }) {
    const events = creations(observations);
    const created = events.reduce((total, observation) => total + observation.created, 0);
    if (created < params["threshold"]) return null;
    return evidence({ created, threshold: params["threshold"], window_ms: params["window_ms"] }, { sender: subjectKey }, events);
  },
};

const dustSpam: RuleDefinition = {
  id: "dust_spam",
  version: 1,
  summary: "A sender creates many minimum-size streams across many distinct payees.",
  scope: "sender",
  severity: "warning",
  params: {
    window_ms: { default: 300_000, min: 1_000, max: 86_400_000, description: "Sliding window length in ms." },
    // Named `ceiling`, not `amount`: the telemetry privacy line drops any
    // attribute whose key reads as a financial amount, and a rule's threshold
    // has to survive into the alert for the alert to explain itself.
    dust_ceiling: { default: 1_000, min: 0, max: 1_000_000_000_000, description: "At most this many base units counts as dust." },
    threshold: { default: 10, min: 2, max: 100_000, description: "Dust creations inside the window that trips the rule." },
    min_payees: { default: 5, min: 2, max: 100_000, description: "Distinct payees the dust must be spread over." },
  },
  evaluate({ subjectKey, observations, params }) {
    const dust = creations(observations).filter(
      (observation) => observation.amount !== null && BigInt(observation.amount) <= BigInt(params["dust_ceiling"])
    );
    const payees = new Set(dust.map((observation) => observation.recipient).filter((r): r is string => r !== null));
    if (dust.length < params["threshold"] || payees.size < params["min_payees"]) return null;
    return evidence(
      {
        dust_creations: dust.length,
        threshold: params["threshold"],
        dust_ceiling: params["dust_ceiling"],
        distinct_payees: payees.size,
        min_payees: params["min_payees"],
        window_ms: params["window_ms"],
      },
      { sender: subjectKey },
      dust
    );
  },
};

const circularFlow: RuleDefinition = {
  id: "circular_flow",
  version: 1,
  summary: "Streams are created in both directions between the same two addresses.",
  scope: "pair",
  severity: "critical",
  params: {
    window_ms: { default: 3_600_000, min: 1_000, max: 86_400_000, description: "Sliding window length in ms." },
    min_flows: { default: 2, min: 1, max: 100_000, description: "Streams required in each direction inside the window." },
  },
  evaluate({ subjectKey, observations, params }) {
    const [a, b] = splitPairKey(subjectKey);
    const events = creations(observations);
    const forward = events.filter((o) => o.sender === a && o.recipient === b);
    const backward = events.filter((o) => o.sender === b && o.recipient === a);
    if (forward.length < params["min_flows"] || backward.length < params["min_flows"]) return null;
    return evidence(
      {
        forward_flows: forward.length,
        backward_flows: backward.length,
        min_flows: params["min_flows"],
        window_ms: params["window_ms"],
      },
      { address_a: a, address_b: b },
      events
    );
  },
};

const createCancelChurn: RuleDefinition = {
  id: "create_cancel_churn",
  version: 1,
  summary: "A sender creates streams and cancels a large share of them before payout.",
  scope: "sender",
  severity: "warning",
  params: {
    window_ms: { default: 3_600_000, min: 1_000, max: 86_400_000, description: "Sliding window length in ms." },
    min_creations: { default: 5, min: 2, max: 100_000, description: "Creations required before the ratio is judged." },
    cancel_ratio: { default: 0.5, min: 0, max: 1, description: "Cancellations per creation that trips the rule." },
  },
  evaluate({ subjectKey, observations, params }) {
    const created = creations(observations).reduce((total, observation) => total + observation.created, 0);
    const cancelled = observations.filter((observation) => observation.role === "cancel").length;
    if (created < params["min_creations"]) return null;
    const ratio = cancelled / created;
    if (cancelled === 0 || ratio < params["cancel_ratio"]) return null;
    return evidence(
      {
        created,
        cancelled,
        ratio: Number(ratio.toFixed(6)),
        min_creations: params["min_creations"],
        cancel_ratio: params["cancel_ratio"],
        window_ms: params["window_ms"],
      },
      { sender: subjectKey },
      observations
    );
  },
};

export const RULE_CATALOG: readonly RuleDefinition[] = [
  burstCreation,
  circularFlow,
  createCancelChurn,
  dustSpam,
];

export const RULE_IDS: readonly string[] = RULE_CATALOG.map((rule) => rule.id);

/**
 * What the engine needs to know: which tenants are evaluated, the rules each
 * one runs with, and which subjects an operator has suppressed. Implemented
 * against the store in `config.ts`; replay hands it a single-tenant,
 * single-rule view pinned to a detection's recorded thresholds.
 */
export interface RuleSource {
  tenants(): string[];
  rulesFor(tenantId: string): readonly EffectiveRule[];
  isSuppressed(tenantId: string, ruleId: string, subjectKey: string, atMs: number): boolean;
}

export function getRuleDefinition(ruleId: string): RuleDefinition | undefined {
  return RULE_CATALOG.find((rule) => rule.id === ruleId);
}

export type RuleErrorCode =
  | "unknown_rule"
  | "unknown_param"
  | "invalid_param"
  | "invalid_mode"
  | "invalid_severity"
  | "invalid_json"
  | "promotion_not_ready";

export class RuleConfigError extends Error {
  constructor(
    readonly code: RuleErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "RuleConfigError";
  }
}

/** A rule with the thresholds one tenant actually runs with. */
export interface EffectiveRule extends RuleDefinition {
  config: {
    mode: RuleMode;
    severity: Severity;
    params: Record<string, number>;
    falsePositiveBudget: number;
    minReviews: number;
  };
}

/**
 * Merge a declarative override onto the catalog defaults, rejecting anything
 * the rule does not declare. Silent typos in a threshold file would otherwise
 * read as "the rule is tuned" while it runs on defaults.
 */
export function effectiveRule(
  ruleId: string,
  override: TenantRuleOverride = {},
  fallback: { mode?: RuleMode } = {}
): EffectiveRule {
  const definition = getRuleDefinition(ruleId);
  if (definition === undefined) throw new RuleConfigError("unknown_rule", `unknown rule '${ruleId}'`, { rule: ruleId, known: RULE_IDS });

  const params: Record<string, number> = {};
  for (const [name, spec] of Object.entries(definition.params)) params[name] = spec.default;

  for (const [name, value] of Object.entries(override.params ?? {})) {
    const spec = definition.params[name];
    if (spec === undefined) {
      throw new RuleConfigError("unknown_param", `rule '${ruleId}' has no param '${name}'`, {
        rule: ruleId,
        param: name,
        known: Object.keys(definition.params),
      });
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new RuleConfigError("invalid_param", `param '${name}' must be a finite number`, { rule: ruleId, param: name, value });
    }
    if (value < spec.min || value > spec.max) {
      throw new RuleConfigError("invalid_param", `param '${name}' must be between ${spec.min} and ${spec.max}`, {
        rule: ruleId,
        param: name,
        value,
        min: spec.min,
        max: spec.max,
      });
    }
    params[name] = value;
  }

  const mode = override.mode ?? fallback.mode;
  if (mode !== undefined && !RULE_MODES.includes(mode)) {
    throw new RuleConfigError("invalid_mode", `mode must be one of ${RULE_MODES.join(", ")}`, { mode });
  }
  const severity = override.severity;
  if (severity !== undefined && !SEVERITIES.includes(severity)) {
    throw new RuleConfigError("invalid_severity", `severity must be one of ${SEVERITIES.join(", ")}`, { severity });
  }

  const budget = override.false_positive_budget;
  if (budget !== undefined && (!Number.isFinite(budget) || budget < 0 || budget > 1)) {
    throw new RuleConfigError("invalid_param", "false_positive_budget must be between 0 and 1", { value: budget });
  }
  const minReviews = override.min_reviews;
  if (minReviews !== undefined && (!Number.isInteger(minReviews) || minReviews < 1)) {
    throw new RuleConfigError("invalid_param", "min_reviews must be a positive integer", { value: minReviews });
  }

  return {
    ...definition,
    config: {
      mode: mode ?? "shadow",
      severity: severity ?? definition.severity,
      params,
      falsePositiveBudget: budget ?? DEFAULT_FALSE_POSITIVE_BUDGET,
      minReviews: minReviews ?? DEFAULT_MIN_REVIEWS,
    },
  };
}

/** Parse the declarative rule file: `{ "<rule_id>": { mode, severity, params } }`. */
export function parseRuleOverrides(raw: unknown): Record<string, TenantRuleOverride> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RuleConfigError("invalid_json", "rule overrides must be a JSON object keyed by rule id");
  }
  const parsed: Record<string, TenantRuleOverride> = {};
  for (const [ruleId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new RuleConfigError("invalid_json", `override for rule '${ruleId}' must be an object`, { rule: ruleId });
    }
    // Validates the rule id, the params and their ranges as it converts.
    effectiveRule(ruleId, value as TenantRuleOverride);
    parsed[ruleId] = value as TenantRuleOverride;
  }
  return parsed;
}

/**
 * The bytes a detection's fingerprint commits to. Citation bounds are included
 * but not the cited ids, so a rule that trips on the same window content
 * fingerprints the same no matter how many events the window happened to hold.
 */
export function replayInput(
  detection: {
    ruleId: string;
    ruleVersion: number;
    tenantId: string;
    subjectKey: string;
    citation: { fromLedger: number; toLedger: number; startMs: number; endMs: number };
    metrics: Record<string, string | number>;
    params: Record<string, number>;
  }
): string {
  const canonical = (record: Record<string, string | number>): string =>
    JSON.stringify(Object.keys(record).sort().map((key) => [key, record[key]]));
  return JSON.stringify({
    rule: `${detection.ruleId}@${detection.ruleVersion}`,
    tenant: detection.tenantId,
    subject: detection.subjectKey,
    citation: {
      from_ledger: detection.citation.fromLedger,
      to_ledger: detection.citation.toLedger,
      start_ms: detection.citation.startMs,
      end_ms: detection.citation.endMs,
    },
    metrics: canonical(detection.metrics),
    params: canonical(detection.params),
  });
}

export function fingerprintOf(input: Parameters<typeof replayInput>[0]): { fingerprint: string; id: string } {
  const digest = createHash("sha256").update(replayInput(input)).digest("hex");
  return { fingerprint: `sha256:${digest}`, id: `anm_${digest.slice(0, 16)}` };
}
