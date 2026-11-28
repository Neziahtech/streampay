import { toObservation } from "./observations.js";
import type { Detection, Observation, RuleScope, WindowCitation } from "./types.js";
import type { StreamStore } from "../store.js";
import { RuleConfigError, effectiveRule, fingerprintOf, getRuleDefinition, pairKey, splitPairKey, type EffectiveRule } from "./rules.js";

export type ReplayReason =
  | "verified"
  | "rule_unavailable"
  | "rule_version_unavailable"
  | "rule_config_invalid"
  | "citation_incomplete"
  | "range_too_large"
  | "not_reproduced";

export interface ReplayOutcome {
  verified: boolean;
  reason: ReplayReason;
  detail: string;
  detection_id: string;
  rule_id: string;
  rule_version: number;
  /** What the alert claimed. */
  expected_fingerprint: string;
  /** What the cited range yields today, or null when it could not be derived. */
  replayed_fingerprint: string | null;
  cited: WindowCitation;
  events_read: number;
  /** The numbers the re-derivation produced, so a mismatch is legible. */
  replayed_metrics: Record<string, string | number> | null;
}

export interface ReplayOptions {
  /** Refuse to read more than this many events, so a huge citation cannot be a DoS. */
  maxEvents?: number;
}

export const DEFAULT_REPLAY_MAX_EVENTS = 50_000;

function ruleWithParams(ruleId: string, ruleVersion: number, params: Record<string, number>): EffectiveRule {
  const definition = getRuleDefinition(ruleId);
  if (definition === undefined) throw new RuleConfigError("unknown_rule", `unknown rule '${ruleId}'`);
  if (definition.version !== ruleVersion) {
    throw new RuleConfigError("invalid_param", `rule '${ruleId}' is at version ${definition.version}, the detection cites ${ruleVersion}`);
  }
  return effectiveRule(ruleId, { params });
}

/**
 * Does this observation belong to the subject the detection was about? Mirrors
 * the engine's per-subject windows: `sender` keys on the acting address,
 * `pair` on either direction between the two halves of the pair key.
 */
function inScope(scope: RuleScope, subjectKey: string, observation: Observation): boolean {
  if (scope === "sender") return observation.actor === subjectKey;
  return pairKey(observation.sender ?? "", observation.recipient ?? "") === splitPairKey(subjectKey).join("|");
}

/**
 * Verify a detection by re-deriving it from the ledger range it cites.
 *
 * This is not a re-run of the whole engine: the engine's incident state, the
 * recording throttle and the alert routing all depend on what the process had
 * already seen, which a verifier cannot reproduce and a consumer should not
 * have to trust. What is checkable is the claim the alert makes — that inside
 * `start_ms..end_ms` of `from_ledger..to_ledger` the cited events contain the
 * pattern the rule reports. Re-deriving exactly that, from the journal rows,
 * is what makes an alert explainable.
 */
export function replayDetection(
  store: StreamStore,
  detection: Detection,
  options: ReplayOptions = {}
): ReplayOutcome {
  const maxEvents = options.maxEvents ?? DEFAULT_REPLAY_MAX_EVENTS;
  const base = {
    detection_id: detection.id,
    rule_id: detection.ruleId,
    rule_version: detection.ruleVersion,
    expected_fingerprint: detection.fingerprint,
    cited: detection.citation,
    events_read: 0,
    replayed_fingerprint: null,
    replayed_metrics: null,
  };

  const definition = getRuleDefinition(detection.ruleId);
  if (definition === undefined) {
    return { ...base, verified: false, reason: "rule_unavailable", detail: `no rule '${detection.ruleId}' is installed` };
  }
  if (definition.version !== detection.ruleVersion) {
    return {
      ...base,
      verified: false,
      reason: "rule_version_unavailable",
      detail: `the detection cites ${detection.ruleId}@${detection.ruleVersion}; this build evaluates ${definition.version}`,
    };
  }

  let rule: EffectiveRule;
  try {
    rule = ruleWithParams(detection.ruleId, detection.ruleVersion, detection.params);
  } catch (error) {
    if (error instanceof RuleConfigError) {
      return { ...base, verified: false, reason: "rule_config_invalid", detail: error.message };
    }
    throw error;
  }

  const page = store.eventsForAnomaly(detection.citation.fromLedger, detection.citation.toLedger, maxEvents + 1);
  if (page.truncated) {
    return {
      ...base,
      verified: false,
      reason: "range_too_large",
      detail: `the cited range holds more than ${maxEvents} events; refusing to read it whole`,
    };
  }

  const observations = page.events
    .map(toObservation)
    .filter((observation): observation is NonNullable<typeof observation> => observation !== null);
  const read = { ...base, events_read: page.events.length };

  const trigger = observations.find((observation) => observation.eventId === detection.citation.lastEventId);
  if (trigger === undefined) {
    return {
      ...read,
      verified: false,
      reason: "citation_incomplete",
      detail: `event '${detection.citation.lastEventId}' is not in ledger range ${detection.citation.fromLedger}..${detection.citation.toLedger}`,
    };
  }

  const windowMs = rule.config.params["window_ms"] ?? 0;
  // The engine evaluates a subject's own window, so a verifier must narrow the
  // range to the same subject. Reading the whole ledger instead would count
  // every other account's traffic into this one's numbers and reject a
  // detection that was correct when it fired.
  const inWindow = observations.filter(
    (observation) => observation.atMs > detection.citation.endMs - windowMs && observation.atMs <= detection.citation.endMs
  );
  const mine = inWindow.filter((observation) => inScope(rule.scope, detection.subjectKey, observation));
  const evidence = rule.evaluate({
    subjectKey: detection.subjectKey,
    observations: mine,
    params: rule.config.params,
  });
  if (evidence === null) {
    return {
      ...read,
      replayed_metrics: null,
      verified: false,
      reason: "not_reproduced",
      detail: `the rule no longer fires on ${mine.length} observations in the cited window`,
    };
  }

  const identity = fingerprintOf({
    ruleId: rule.id,
    ruleVersion: rule.version,
    tenantId: detection.tenantId,
    subjectKey: detection.subjectKey,
    citation: detection.citation,
    metrics: evidence.metrics,
    params: rule.config.params,
  });

  if (identity.fingerprint !== detection.fingerprint) {
    return {
      ...read,
      replayed_fingerprint: identity.fingerprint,
      replayed_metrics: evidence.metrics,
      verified: false,
      reason: "not_reproduced",
      detail: `re-derived metrics ${JSON.stringify(evidence.metrics)} do not match the ${JSON.stringify(detection.evidence.metrics)} the alert claimed`,
    };
  }

  return {
    ...read,
    replayed_fingerprint: identity.fingerprint,
    replayed_metrics: evidence.metrics,
    verified: true,
    reason: "verified",
    detail: `${mine.length} observations in the cited window reproduce the reported numbers`,
  };
}
