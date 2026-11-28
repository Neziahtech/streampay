//! Alert de-duplication and flap suppression for divergence alerts.
//!
//! A divergence that persists across cycles is one incident, not one alert
//! per cycle. A key that flickers between faulted and clean is noise until it
//! has been stable in one state for ` flapWindowMs`, at which point the
//! transition is reported once.
//!
//! The whole table is serializable, so a restarted auditor resumes with the
//! incident state it already reported instead of re-paging on boot.

export const ALERT_STATES = ["faulted", "cleared"] as const;
export type AlertState = (typeof ALERT_STATES)[number];

export type AlertEvent =
  | { type: "raised"; key: string; at: number }
  | { type: "resolved"; key: string; at: number }
  | { type: "repeated"; key: string; at: number }
  | { type: "suppressed"; key: string; at: number; reason: "flap" };

export interface DedupOptions {
  /** How long a key must hold one state before a transition is reported. */
  flapWindowMs?: number;
  /** Emit a heartbeat for a still-open incident after this long. */
  renotifyAfterMs?: number;
}

interface KeyState {
  state: AlertState;
  sinceMs: number;
  lastReportMs: number;
  /** Count of transitions observed inside the flap window. */
  flips: number;
  reported: boolean;
}

export interface SerializedDedup {
  flap_window_ms: number;
  renotify_after_ms: number;
  keys: Record<string, KeyState>;
}

export class DivergenceDeduper {
  private readonly flapWindowMs: number;
  private readonly renotifyAfterMs: number;
  private readonly keys = new Map<string, KeyState>();

  constructor(options: DedupOptions = {}) {
    this.flapWindowMs = options.flapWindowMs ?? 120_000;
    this.renotifyAfterMs = options.renotifyAfterMs ?? 0;
  }

  /**
   * Observes which keys are faulting this cycle and decides what to report.
   * `faultingKeys` is the set from one audit cycle; keys absent from it are
   * observed clean.
   */
  observe(faultingKeys: Iterable<string>, atMs: number): AlertEvent[] {
    const present = new Set(faultingKeys);
    const events: AlertEvent[] = [];

    for (const key of present) {
      events.push(...this.transition(key, "faulted", atMs));
    }
    for (const key of this.keys.keys()) {
      if (!present.has(key)) events.push(...this.transition(key, "cleared", atMs));
    }
    return events;
  }

  private transition(key: string, next: AlertState, atMs: number): AlertEvent[] {
    const current = this.keys.get(key);
    if (current === undefined) {
      // First sighting of an incident is always reported; silence about a
      // divergence is worse than a duplicate.
      this.keys.set(key, {
        state: next,
        sinceMs: atMs,
        lastReportMs: atMs,
        flips: 0,
        reported: next === "faulted",
      });
      return next === "faulted" ? [{ type: "raised", key, at: atMs }] : [];
    }

    if (current.state === next) {
      if (next === "faulted" && this.renotifyDue(current, atMs)) {
        current.lastReportMs = atMs;
        return [{ type: "raised", key, at: atMs }];
      }
      // A key that flapped clean and then stays clean has really resolved; the
      // suppression only hides the transition, not the outcome.
      if (next === "cleared" && current.reported && atMs - current.sinceMs >= this.flapWindowMs) {
        current.reported = false;
        return [{ type: "resolved", key, at: atMs }];
      }
      return current.reported ? [{ type: "repeated", key, at: atMs }] : [];
    }

    const heldLongEnough = atMs - current.sinceMs >= this.flapWindowMs;
    if (!heldLongEnough) {
      // Flickering: adopt the new state but do not report the transition.
      current.flips += 1;
      current.state = next;
      current.sinceMs = atMs;
      return [{ type: "suppressed", key, at: atMs, reason: "flap" }];
    }

    current.state = next;
    current.sinceMs = atMs;
    current.flips = 0;
    if (next === "faulted") {
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

  stateOf(key: string): AlertState | undefined {
    return this.keys.get(key)?.state;
  }

  openIncidents(): string[] {
    return [...this.keys.entries()]
      .filter(([, state]) => state.state === "faulted")
      .map(([key]) => key);
  }

  serialize(): SerializedDedup {
    const keys: Record<string, KeyState> = {};
    for (const [key, state] of this.keys.entries()) keys[key] = { ...state };
    return {
      flap_window_ms: this.flapWindowMs,
      renotify_after_ms: this.renotifyAfterMs,
      keys,
    };
  }

  /**
   * Rebuilds the table a previous process reported. `overrides` applies the
   * current configuration: an operator who changes the flap window should not
   * inherit the window that was persisted before the change.
   */
  static restore(serialized: SerializedDedup, overrides: DedupOptions = {}): DivergenceDeduper {
    const dedup = new DivergenceDeduper({
      flapWindowMs: overrides.flapWindowMs ?? serialized.flap_window_ms,
      renotifyAfterMs: overrides.renotifyAfterMs ?? serialized.renotify_after_ms,
    });
    for (const [key, state] of Object.entries(serialized.keys)) {
      dedup.keys.set(key, { ...state });
    }
    return dedup;
  }
}

/** Only the transitions an operator should be paged about. */
export function actionable(events: AlertEvent[]): AlertEvent[] {
  return events.filter((event) => event.type === "raised" || event.type === "resolved");
}
