import { createHash } from "node:crypto";
import { IncidentDeduper, actionable, incidentKey, parseIncidentKey, type AlertEvent, type DedupOptions } from "./dedup.js";
import type { AnomalyAlertSink } from "./alerts.js";
import { alertView } from "./alerts.js";
import type { AnomalyMetrics } from "./metrics.js";
import type { AnomalyStore } from "./store.js";
import type { EffectiveRule, RuleSource } from "./rules.js";
import { fingerprintOf } from "./rules.js";
import type { Detection, Observation, RuleScope, WindowCitation } from "./types.js";

interface OpenIncident {
  /** Until this event time the pattern counts as still firing. */
  expiresAtMs: number;
  lastDetection: Detection;
  lastRecordedAtMs: number;
}

export interface AnomalyEngineOptions {
  rules: RuleSource;
  /** Detections and alerts persist when a store is given; a replay engine has none. */
  store?: AnomalyStore | null;
  sinks?: readonly AnomalyAlertSink[];
  metrics?: AnomalyMetrics | null;
  /** `null` disables alerting entirely, which is what replay wants. Omit for a fresh deduper. */
  dedup?: IncidentDeduper | null;
  /** Tuning for the deduper this engine creates when none is injected. */
  dedupOptions?: DedupOptions;
  /** Persist the incident table after every sweep so a restart does not re-page. */
  persistIncidents?: boolean;
  /** Called for every alert as it is produced, routed or shadowed. */
  onAlert?: (alert: Parameters<AnomalyAlertSink["deliver"]>[0]) => void;
}

export interface FeedResult {
  detections: Detection[];
  alertsRouted: number;
}

function citationFor(observations: readonly Observation[], windowMs: number, trigger: Observation): WindowCitation {
  let fromLedger = trigger.ledger;
  let firstEventId = trigger.eventId;
  for (const observation of observations) {
    if (observation.ledger < fromLedger || (observation.ledger === fromLedger && observation.eventId < firstEventId)) {
      fromLedger = observation.ledger;
      firstEventId = observation.eventId;
    }
  }
  return {
    fromLedger,
    toLedger: trigger.ledger,
    firstEventId,
    lastEventId: trigger.eventId,
    startMs: trigger.atMs - windowMs,
    endMs: trigger.atMs,
  };
}

/** Deterministic so a re-swept transition names the same alert. */
function alertId(type: string, detectionId: string, atMs: number): string {
  return `ana_${createHash("sha256").update(`${type}|${detectionId}|${atMs}`).digest("hex").slice(0, 16)}`;
}

function restoreDedup(persisted: string): IncidentDeduper | null {
  try {
    return IncidentDeduper.restore(JSON.parse(persisted) as Parameters<typeof IncidentDeduper.restore>[0]);
  } catch {
    return null;
  }
}

/**
 * Sliding-window rule engine over the ingested event stream (issue #582).
 *
 * Two properties decide the design:
 *
 * Reproducibility. Windows are measured in ledger-close time, never wall time,
 * and every number a detection reports comes from the events it cites. A
 * verifier can therefore rebuild a detection from its citation alone and compare
 * fingerprints: an alert is a claim about a ledger range, not a claim about what
 * this process remembered.
 *
 * Bounded memory. Per subject, only the observations the widest configured
 * window can still reach are kept, and subjects idle past that horizon are
 * dropped at the next prune. A long-lived indexer does not accumulate a second
 * copy of the ledger.
 */
export class AnomalyEngine {
  private readonly windows = new Map<RuleScope, Map<string, Observation[]>>([
    ["sender", new Map()],
    ["pair", new Map()],
  ]);
  private readonly open = new Map<string, OpenIncident>();
  private readonly store: AnomalyStore | null;
  private readonly sinks: readonly AnomalyAlertSink[];
  private readonly dedup: IncidentDeduper | null;
  private lastPrunedAtMs = 0;
  private hydrating = false;

  constructor(private readonly options: AnomalyEngineOptions) {
    this.store = options.store ?? null;
    this.sinks = options.sinks ?? [];
    this.dedup = options.dedup === null ? null : (options.dedup ?? new IncidentDeduper(options.dedupOptions ?? {}));
    // An injected deduper is the caller's state; otherwise resume from the
    // persisted table so a boot does not re-page incidents already reported.
    if (options.dedup === undefined && this.dedup !== null && options.persistIncidents !== false && this.store !== null) {
      const persisted = this.store.loadIncidentState();
      const restored = persisted === undefined ? null : restoreDedup(persisted);
      if (restored !== null) this.dedup = restored;
    }
  }

  /**
   * Index one event, evaluate every tenant's rules over the subjects it
   * touched, then run one alerting cycle. Returns the newly recorded detections.
   */
  observe(observation: Observation | null): FeedResult {
    if (observation === null) return { detections: [], alertsRouted: 0 };
    const touched = this.index(observation);

    const detections: Detection[] = [];
    for (const tenantId of this.options.rules.tenants()) {
      for (const rule of this.options.rules.rulesFor(tenantId)) {
        const subjectKey = touched[rule.scope];
        if (subjectKey === null) continue;
        const observations = this.windows.get(rule.scope)?.get(subjectKey);
        if (observations === undefined) continue;
        const detection = this.evaluate(rule, tenantId, subjectKey, observations, observation);
        if (detection !== null) detections.push(detection);
      }
    }

    // Detections still accrue while hydrating; only the alerting cycle waits.
    if (this.hydrating) return { detections, alertsRouted: 0 };
    return { detections, alertsRouted: this.sweep(observation.atMs) };
  }

  /**
   * Rebuild the windows from a historical range after a restart.
   *
   * Sweeping is muted while the range is replayed: the incidents the persisted
   * deduper already reported are not in `open` yet, so an intermediate cycle
   * would read a half-restored process as "everything resolved" and page a
   * second time when the range re-trips. One cycle runs at the end instead.
   */
  hydrate(observations: Iterable<Observation>): void {
    let newestMs = 0;
    this.hydrating = true;
    try {
      for (const observation of observations) {
        this.observe(observation);
        newestMs = Math.max(newestMs, observation.atMs);
      }
    } finally {
      this.hydrating = false;
    }
    if (newestMs > 0) this.sweep(newestMs);
  }

  /**
   * One alerting cycle: expire incidents, then let the deduper decide what an
   * operator hears about. Runs after every event, so a pattern that stops
   * firing resolves without needing a timer.
   */
  sweep(atMs: number): number {
    for (const [key, incident] of this.open) {
      if (incident.expiresAtMs <= atMs) this.open.delete(key);
    }
    this.pruneWindows(atMs);
    if (this.dedup === null) return 0;

    const events = actionable(this.dedup.observe([...this.open.keys()], atMs));
    let routed = 0;
    for (const event of events) {
      const alert = this.buildAlert(event);
      if (alert === null) continue;
      this.options.metrics?.recordAlert(alert.rule_id, event.type);
      this.options.onAlert?.(alert);
      if (!alert.routed) continue;
      for (const sink of this.sinks) {
        const outcome = sink.deliver(alert);
        if (outcome instanceof Promise) outcome.catch(() => undefined);
      }
      routed += 1;
    }

    if (this.options.persistIncidents !== false && this.store !== null && this.dedup !== null) {
      this.store.saveIncidentState(JSON.stringify(this.dedup.serialize()));
    }
    this.options.metrics?.recordIncidents(this.openIncidentsByRule());
    return routed;
  }

  /** Open incident counts per rule, for the gauge an operator alerts on. */
  openIncidentsByRule(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const incident of this.open.values()) {
      counts.set(incident.lastDetection.ruleId, (counts.get(incident.lastDetection.ruleId) ?? 0) + 1);
    }
    return counts;
  }

  openIncidentKeys(): string[] {
    return [...this.open.keys()].sort();
  }

  /** Subjects still held in a window. Exposed for the health surface. */
  trackedSubjects(scope: RuleScope): string[] {
    return [...(this.windows.get(scope)?.keys() ?? [])].sort();
  }

  private index(observation: Observation): Record<RuleScope, string | null> {
    const touched: Record<RuleScope, string | null> = { sender: null, pair: null };
    const horizon = this.horizonMs();
    if (observation.actor !== null) {
      touched.sender = observation.actor;
      this.append("sender", observation.actor, observation, horizon);
    }
    if (observation.role === "create" && observation.sender !== null && observation.recipient !== null) {
      const key = observation.sender <= observation.recipient
        ? `${observation.sender}|${observation.recipient}`
        : `${observation.recipient}|${observation.sender}`;
      touched.pair = key;
      this.append("pair", key, observation, horizon);
    }
    return touched;
  }

  private append(scope: RuleScope, key: string, observation: Observation, horizonMs: number): void {
    const subjects = this.windows.get(scope) as Map<string, Observation[]>;
    const kept = (subjects.get(key) ?? []).filter((existing) => existing.atMs > observation.atMs - horizonMs);
    kept.push(observation);
    subjects.set(key, kept);
  }

  /**
   * Drop subjects nobody has written to for a full horizon. Amortized: a pass
   * costs O(subjects) and runs at most once per horizon of event time.
   */
  private pruneWindows(atMs: number): void {
    const horizon = this.horizonMs();
    if (this.lastPrunedAtMs !== 0 && atMs - this.lastPrunedAtMs < horizon) return;
    this.lastPrunedAtMs = atMs;
    for (const subjects of this.windows.values()) {
      for (const [key, list] of subjects) {
        const newest = list[list.length - 1];
        if (newest === undefined || atMs - newest.atMs > horizon) subjects.delete(key);
      }
    }
  }

  /** Widest window any configured rule can still reach. */
  private horizonMs(): number {
    let horizon = 0;
    for (const tenantId of this.options.rules.tenants()) {
      for (const rule of this.options.rules.rulesFor(tenantId)) {
        horizon = Math.max(horizon, rule.config.params["window_ms"] ?? 0);
      }
    }
    return horizon === 0 ? 60_000 : horizon;
  }

  private evaluate(
    rule: EffectiveRule,
    tenantId: string,
    subjectKey: string,
    observations: readonly Observation[],
    trigger: Observation
  ): Detection | null {
    const windowMs = rule.config.params["window_ms"] ?? 0;
    const key = incidentKey({ ruleId: rule.id, tenantId, subjectKey });

    // A subject an operator already called a false positive is skipped before
    // it is evaluated, so the suppression removes the work as well as the page.
    if (this.options.rules.isSuppressed(tenantId, rule.id, subjectKey, trigger.atMs)) {
      this.options.metrics?.recordDetection(rule.id, rule.config.severity, rule.config.mode, true);
      return null;
    }

    const inWindow = observations.filter((o) => o.atMs > trigger.atMs - windowMs && o.atMs <= trigger.atMs);
    if (inWindow.length === 0) return null;

    const result = rule.evaluate({ subjectKey, observations: inWindow, params: rule.config.params });
    if (result === null) return null;

    const citation = citationFor(inWindow, windowMs, trigger);
    const identity = fingerprintOf({
      ruleId: rule.id,
      ruleVersion: rule.version,
      tenantId,
      subjectKey,
      citation,
      metrics: result.metrics,
      params: rule.config.params,
    });
    const existing = this.open.get(key);

    // One detection per subject per window: without the throttle a sustained
    // pattern writes a row per event, which turns the review queue into a
    // second copy of the ledger.
    if (existing !== undefined && trigger.atMs - existing.lastRecordedAtMs < windowMs) {
      existing.expiresAtMs = trigger.atMs + windowMs;
      return null;
    }

    const detection: Detection = {
      id: identity.id,
      ruleId: rule.id,
      ruleVersion: rule.version,
      tenantId,
      severity: rule.config.severity,
      mode: rule.config.mode,
      subjectKey,
      citation,
      fingerprint: identity.fingerprint,
      evidence: result,
      params: { ...rule.config.params },
      createdAtMs: trigger.atMs,
    };

    // A false insert means this exact citation is already on record — the same
    // range re-ingested after a restart or a reorg.
    const fresh = this.store === null || this.store.recordDetection(detection);
    this.options.metrics?.recordDetection(rule.id, rule.config.severity, rule.config.mode, false);

    const incident: OpenIncident = {
      expiresAtMs: trigger.atMs + windowMs,
      lastDetection: detection,
      lastRecordedAtMs: trigger.atMs,
    };
    this.open.set(key, incident);

    return fresh ? detection : null;
  }

  private buildAlert(event: Extract<AlertEvent, { type: "raised" | "resolved" }>): ReturnType<typeof alertView> | null {
    const { ruleId, tenantId, subjectKey } = parseIncidentKey(event.key);
    const detection = this.open.get(event.key)?.lastDetection ?? this.lastKnownDetection(event.key);
    if (detection === undefined) return null;
    const rule = this.options.rules.rulesFor(tenantId).find((candidate) => candidate.id === ruleId);
    if (rule === undefined) return null;

    // Shadow rules record what they would have said and page nobody. A
    // resolution of an incident that was paged does route: closing a page is
    // the other half of raising one.
    const routed = detection.mode === "enforce";
    const id = alertId(event.type, detection.id, event.at);
    this.store?.recordAlert({
      id,
      detectionId: detection.id,
      incidentKey: event.key,
      tenantId,
      ruleId,
      type: event.type,
      severity: detection.severity,
      mode: detection.mode,
      routed,
      reason: detection.mode === "shadow" ? "shadow_mode" : event.type === "resolved" ? "resolved" : null,
      atMs: event.at,
    });
    return alertView({
      alertId: id,
      type: event.type,
      detection,
      ruleId,
      summary: rule.summary,
      severity: detection.severity,
      mode: detection.mode,
      evidence: detection.evidence,
      citation: detection.citation,
      tenantId,
      subjectKey,
      routed,
      atMs: event.at,
    });
  }

  /**
   * An incident that expired before the sweep that resolves it has no live
   * state left, so the resolved alert cites the detection the store kept.
   */
  private lastKnownDetection(key: string): Detection | undefined {
    if (this.store === null) return undefined;
    const { ruleId, tenantId, subjectKey } = parseIncidentKey(key);
    return this.store
      .listDetections({ tenantId, ruleId, limit: 50 })
      .find((detection) => detection.subjectKey === subjectKey);
  }
}
