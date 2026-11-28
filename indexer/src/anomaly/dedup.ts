/**
 * Alert de-duplication and flap suppression for anomaly alerts.
 *
 * Same policy as the reconciler's divergence deduper (issue #492), restated
 * here because the indexer cannot import the reconciler: the packages are
 * installed independently, so a shared module would be a cross-service build
 * dependency rather than a library. An incident that persists across sweeps is
 * one alert, not one per sweep; a key that flickers between active and clear is
 * noise until it has held one state for `flapWindowMs`.
 *
 * The table is serializable, so a restarted indexer resumes with the incidents
 * it already reported instead of re-paging on boot.
 */

export const INCIDENT_STATES = ["active", "resolved"] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];

export type AlertEvent =
  | { type: "raised"; key: string; at: number }
  | { type: "resolved"; key: string; at: number }
  | { type: "repeated"; key: string; at: number }
  | { type: "suppressed"; key: string; at: number; reason: "flap" };

export interface DedupOptions {
  /** How long a key must hold one state before a transition is reported. */
  flapWindowMs?: number;
  /** Re-raise a still-open incident after this long; 0 disables heartbeats. */
  renotifyAfterMs?: number;
}

interface KeyState {
  state: IncidentState;
  sinceMs: number;
  lastReportMs: number;
  flips: number;
  reported: boolean;
}

export interface SerializedIncidents {
  flap_window_ms: number;
  renotify_after_ms: number;
  keys: Record<string, KeyState>;
}

export class IncidentDeduper {
  private readonly flapWindowMs: number;
  private readonly renotifyAfterMs: number;
  private readonly keys = new Map<string, KeyState>();

  constructor(options: DedupOptions = {}) {
    this.flapWindowMs = options.flapWindowMs ?? 120_000;
    this.renotifyAfterMs = options.renotifyAfterMs ?? 0;
  }

  /**
   * Observes which incident keys are active this sweep. Keys absent from
   * `activeKeys` are observed clean.
   */
  observe(activeKeys: Iterable<string>, atMs: number): AlertEvent[] {
    const present = new Set(activeKeys);
    const events: AlertEvent[] = [];
    for (const key of present) events.push(...this.transition(key, "active", atMs));
    for (const key of this.keys.keys()) {
      if (!present.has(key)) events.push(...this.transition(key, "resolved", atMs));
    }
    return events;
  }

  private transition(key: string, next: IncidentState, atMs: number): AlertEvent[] {
    const current = this.keys.get(key);
    if (current === undefined) {
      // First sighting is always reported: silence about a fraud pattern is
      // worse than a duplicate page.
      this.keys.set(key, { state: next, sinceMs: atMs, lastReportMs: atMs, flips: 0, reported: next === "active" });
      return next === "active" ? [{ type: "raised", key, at: atMs }] : [];
    }

    if (current.state === next) {
      if (next === "active" && this.renotifyDue(current, atMs)) {
        current.lastReportMs = atMs;
        return [{ type: "raised", key, at: atMs }];
      }
      if (next === "resolved" && current.reported && atMs - current.sinceMs >= this.flapWindowMs) {
        current.reported = false;
        return [{ type: "resolved", key, at: atMs }];
      }
      return current.reported ? [{ type: "repeated", key, at: atMs }] : [];
    }

    if (atMs - current.sinceMs < this.flapWindowMs) {
      // Flickering: adopt the state, do not report the transition.
      current.flips += 1;
      current.state = next;
      current.sinceMs = atMs;
      return [{ type: "suppressed", key, at: atMs, reason: "flap" }];
    }

    current.state = next;
    current.sinceMs = atMs;
    current.flips = 0;
    if (next === "active") {
      current.reported = true;
      current.lastReportMs = atMs;
      return [{ type: "raised", key, at: atMs }];
    }
    const wasReported = current.reported;
    current.reported = false;
    return wasReported ? [{ type: "resolved", key, at: atMs }] : [];
  }

  private renotifyDue(state: KeyState, atMs: number): boolean {
    return this.renotifyAfterMs > 0 && atMs - state.lastReportMs >= this.renotifyAfterMs;
  }

  stateOf(key: string): IncidentState | undefined {
    return this.keys.get(key)?.state;
  }

  openIncidents(): string[] {
    return [...this.keys.entries()].filter(([, state]) => state.state === "active").map(([key]) => key);
  }

  serialize(): SerializedIncidents {
    const keys: Record<string, KeyState> = {};
    for (const [key, state] of this.keys.entries()) keys[key] = { ...state };
    return { flap_window_ms: this.flapWindowMs, renotify_after_ms: this.renotifyAfterMs, keys };
  }

  /** Current configuration wins over the persisted window, as in #492. */
  static restore(serialized: SerializedIncidents, overrides: DedupOptions = {}): IncidentDeduper {
    const dedup = new IncidentDeduper({
      flapWindowMs: overrides.flapWindowMs ?? serialized.flap_window_ms,
      renotifyAfterMs: overrides.renotifyAfterMs ?? serialized.renotify_after_ms,
    });
    for (const [key, state] of Object.entries(serialized.keys)) dedup.keys.set(key, { ...state });
    return dedup;
  }
}

/** Only the transitions an operator should be paged about. */
export function actionable(events: AlertEvent[]): Array<Extract<AlertEvent, { type: "raised" | "resolved" }>> {
  return events.filter((event): event is Extract<AlertEvent, { type: "raised" | "resolved" }> => event.type === "raised" || event.type === "resolved");
}

/** One incident per rule, tenant and subject. */
export function incidentKey(detection: { ruleId: string; tenantId: string; subjectKey: string }): string {
  return `${detection.ruleId}/${detection.tenantId}/${detection.subjectKey}`;
}

export function parseIncidentKey(key: string): { ruleId: string; tenantId: string; subjectKey: string } {
  const [ruleId = "", tenantId = "", ...rest] = key.split("/");
  return { ruleId, tenantId, subjectKey: rest.join("/") };
}
