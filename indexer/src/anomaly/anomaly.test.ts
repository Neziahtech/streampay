import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import Database from "better-sqlite3";

import { StreamStore } from "../store.js";
import { WebhookStore } from "../webhooks/store.js";
import { TenantDirectory } from "../webhooks/tenants.js";
import { createApp, type AnomalyApiConfig } from "../index.js";
import { IncidentDeduper } from "./dedup.js";
import { AnomalyEngine } from "./engine.js";
import { MemoryAlertSink, WebhookAlertSink, redactEvidence, redactSubject } from "./alerts.js";
import { AnomalyMetrics } from "./metrics.js";
import { RULE_IDS, effectiveRule, fingerprintOf, parseRuleOverrides, type RuleSource } from "./rules.js";
import { replayDetection } from "./replay.js";
import { toObservation } from "./observations.js";
import {
  RULE_MODE_ENV,
  RULE_OVERRIDES_ENV,
  TenantRuleSource,
  defaultModeFromEnv,
  promotionReport,
  ruleOverridesFromEnv,
} from "./config.js";
import type { TenantRuleOverride, Detection, Observation } from "./types.js";
import type { DecodedEvent } from "../types.js";

const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const TOKEN = "CCUSD:CDAUATVXQD6VJH7QXVGDNVEXD3RHVLKFNA2Y7BQQQBBY6WPL4HSHVVAD";

/** A distinct, structurally valid Stellar address per label. */
function addr(label: string): string {
  const digest = createHash("sha256").update(label).digest();
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let out = "G";
  for (let i = 0; i < 55; i++) out += alphabet[digest[i % digest.length] % 32];
  return out;
}

const SENDER = addr("sender-one");
const PEER = addr("peer-two");
const OUTSIDER = addr("outsider-three");

/** Advance ledger and close time together, the way a poller walks the chain. */
class Chain {
  ledger = 1_000;
  offsetMs = 0;

  step(ms = 5_000): { ledger: number; atMs: number } {
    this.ledger += 1;
    this.offsetMs += ms;
    return { ledger: this.ledger, atMs: T0 + this.offsetMs };
  }
}

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function decoded(
  name: string,
  streamId: string | null,
  ledger: number,
  offsetMs: number,
  data: Record<string, unknown>,
  id: string
): DecodedEvent {
  return {
    id,
    pagingToken: `${ledger}-${id}`,
    ledger,
    ledgerClosedAt: at(offsetMs),
    contractId: "CCONTRACT",
    name,
    streamId,
    data: data as DecodedEvent["data"],
  };
}

interface CreateArgs {
  id: string;
  ledger: number;
  offsetMs: number;
  sender: string;
  recipient: string;
  deposit?: string;
  streamId?: string;
}

function created(args: CreateArgs): DecodedEvent {
  return decoded(
    "stream_created",
    args.streamId ?? args.id,
    args.ledger,
    args.offsetMs,
    {
      stream_id: args.streamId ?? args.id,
      sender: args.sender,
      recipient: args.recipient,
      token: TOKEN,
      deposit: args.deposit ?? "5000000",
      start_time: "1730000000",
      end_time: "1730003600",
      cancelable: true,
    },
    args.id
  );
}

function cancelled(args: { id: string; ledger: number; offsetMs: number; streamId: string; by: string }): DecodedEvent {
  return decoded(
    "stream_cancelled",
    args.streamId,
    args.ledger,
    args.offsetMs,
    { stream_id: args.streamId, cancelled_by: args.by, recipient_amount: "0", sender_amount: "5000000" },
    args.id
  );
}

function batchCreated(args: { id: string; ledger: number; offsetMs: number; sender: string; count: number }): DecodedEvent {
  const stream_ids = Array.from({ length: args.count }, (_, i) => `${900 + i}`);
  return decoded("streams_created", null, args.ledger, args.offsetMs, { sender: args.sender, stream_ids }, args.id);
}

/**
 * Rule configuration the engine reads. Tests hold overrides in memory so a
 * threshold change is one assignment, and the store-backed version is
 * exercised separately through the HTTP surface.
 */
class TestRules implements RuleSource {
  tenantIds: string[] = ["acme"];
  private readonly overrides = new Map<string, Record<string, TenantRuleOverride>>();
  private readonly suppressions = new Set<string>();

  constructor(tenantOverrides: Record<string, Record<string, TenantRuleOverride>> = {}) {
    for (const [tenantId, rules] of Object.entries(tenantOverrides)) this.set(tenantId, rules);
  }

  set(tenantId: string, rules: Record<string, TenantRuleOverride>): void {
    this.overrides.set(tenantId, rules);
    if (!this.tenantIds.includes(tenantId)) this.tenantIds.push(tenantId);
  }

  suppress(tenantId: string, ruleId: string, subjectKey: string): void {
    this.suppressions.add(`${tenantId}/${ruleId}/${subjectKey}`);
  }

  tenants(): string[] {
    return this.tenantIds;
  }

  rulesFor(tenantId: string) {
    const tenant = this.overrides.get(tenantId) ?? {};
    return RULE_IDS.map((ruleId) => effectiveRule(ruleId, tenant[ruleId] ?? {}));
  }

  isSuppressed(tenantId: string, ruleId: string, subjectKey: string): boolean {
    return this.suppressions.has(`${tenantId}/${ruleId}/${subjectKey}`);
  }
}

interface HarnessOptions {
  tenants?: string[];
  rules?: Record<string, Record<string, TenantRuleOverride>>;
  flapWindowMs?: number;
  renotifyAfterMs?: number;
  dedup?: IncidentDeduper | null;
}

interface Harness {
  store: StreamStore;
  engine: AnomalyEngine;
  rules: TestRules;
  sink: MemoryAlertSink;
  metrics: AnomalyMetrics;
  chain: Chain;
  /** Ingest through the store so the journal, and therefore replay, sees it. */
  apply: (events: DecodedEvent[]) => void;
  /** One create per step for `count` events, spaced `everyMs`. */
  burst: (args: { sender: string; recipient?: string; count: number; deposit?: string; everyMs?: number; prefix?: string }) => void;
  detections: (tenantId?: string) => Detection[];
  observations: () => Observation[];
}

function harness(options: HarnessOptions = {}): Harness {
  const store = new StreamStore(":memory:");
  const rules = new TestRules(options.rules ?? {});
  if (options.tenants) rules.tenantIds = options.tenants;
  const sink = new MemoryAlertSink();
  const metrics = new AnomalyMetrics();
  const chain = new Chain();
  const engine = new AnomalyEngine({
    rules,
    store: store.anomaly,
    sinks: [sink],
    metrics,
    dedup:
      options.dedup === undefined
        ? new IncidentDeduper({ flapWindowMs: options.flapWindowMs ?? 120_000, renotifyAfterMs: options.renotifyAfterMs ?? 0 })
        : options.dedup,
  });

  store.on("event", (event: DecodedEvent) => {
    engine.observe(
      toObservation({
        id: event.id,
        name: event.name,
        ledger: event.ledger,
        ledgerClosedAt: event.ledgerClosedAt,
        streamId: event.streamId,
        data: event.data as Record<string, unknown>,
      })
    );
  });

  const applied: DecodedEvent[] = [];

  return {
    store,
    engine,
    rules,
    sink,
    metrics,
    chain,
    apply(events) {
      applied.push(...events);
      const latest = events[events.length - 1];
      store.ingestPage(events, undefined, latest?.ledger ?? chain.ledger);
    },
    burst(args) {
      const events = Array.from({ length: args.count }, (_, index) => {
        const step = chain.step(args.everyMs ?? 5_000);
        const recipient = args.recipient ?? addr(`payee-${args.prefix ?? "r"}-${index}`);
        return created({
          id: `${args.prefix ?? "evt"}-${index}`,
          ledger: step.ledger,
          offsetMs: step.atMs - T0,
          sender: args.sender,
          recipient,
          deposit: args.deposit,
        });
      });
      this.apply(events);
    },
    detections(tenantId = "acme") {
      return store.anomaly.listDetections({ tenantId, limit: 200 });
    },
    observations() {
      return applied
        .map((event) => toObservation({ ...event, data: event.data as Record<string, unknown> }))
        .filter((observation): observation is Observation => observation !== null);
    },
  };
}

describe("anomaly rule catalog", () => {
  it("declares versioned, threshold-tunable rules with no unknown knobs", () => {
    assert.deepEqual([...RULE_IDS].sort(), ["burst_creation", "circular_flow", "create_cancel_churn", "dust_spam"]);
    const burst = effectiveRule("burst_creation");
    assert.strictEqual(burst.version, 1);
    // Conservative by default: a rule nobody has reviewed pages nobody.
    assert.strictEqual(burst.config.mode, "shadow");
    assert.throws(() => effectiveRule("burst_creation", { params: { threshold: 1_000_000 } }), /between 2 and 100000/);
    assert.throws(() => effectiveRule("burst_creation", { params: { windows: 1 } }), /no param 'windows'/);
    assert.throws(() => effectiveRule("not_a_rule"), /unknown rule/);
    assert.throws(() => effectiveRule("dust_spam", { mode: "yolo" as unknown as "shadow" }), /mode must be/);
  });

  it("reads the declarative override file and refuses to guess about a typo", () => {
    assert.deepEqual(ruleOverridesFromEnv({ [RULE_OVERRIDES_ENV]: '{"burst_creation":{"mode":"enforce","params":{"threshold":3}}}' }), {
      burst_creation: { mode: "enforce", params: { threshold: 3 } },
    });
    assert.deepEqual(ruleOverridesFromEnv({}), {});
    assert.throws(() => ruleOverridesFromEnv({ [RULE_OVERRIDES_ENV]: "not json" }), /not valid JSON/);
    assert.throws(
      () => ruleOverridesFromEnv({ [RULE_OVERRIDES_ENV]: '{"burst_creation":{"params":{"treshold":3}}}' }),
      /no param 'treshold'/
    );

    const rules = new TestRules({ acme: { burst_creation: { mode: "enforce", params: { threshold: 3 } } } });
    const resolved = rules.rulesFor("acme").find((rule) => rule.id === "burst_creation");
    assert.equal(resolved?.config.mode, "enforce");
    assert.equal(resolved?.config.params["threshold"], 3);
  });
});

describe("burst creation", () => {
  it("fires once a sender crosses the threshold and cites its window", () => {
    const h = harness({ rules: { acme: { burst_creation: { mode: "enforce", params: { threshold: 5, window_ms: 60_000 } } } } });
    h.burst({ sender: SENDER, count: 6 });

    const detections = h.detections();
    assert.equal(detections.length, 1, "one detection per subject per window");
    const detection = detections[0] as Detection;
    assert.equal(detection.ruleId, "burst_creation");
    assert.equal(detection.severity, "warning");
    assert.equal(detection.subjectKey, SENDER);
    assert.equal(detection.evidence.metrics["created"], 5);
    assert.equal(detection.evidence.metrics["threshold"], 5);
    assert.ok(detection.citation.toLedger > detection.citation.fromLedger);
    assert.equal(detection.evidence.citedEventIds.length, 5);
    assert.deepEqual(detection.evidence.citedEventIds, ["evt-0", "evt-1", "evt-2", "evt-3", "evt-4"]);

    assert.equal(h.sink.delivered.length, 1);
    assert.equal(h.sink.delivered[0]?.type, "raised");
    assert.equal(h.sink.delivered[0]?.routed, true);
  });

  it("stays silent below the threshold and after the window rolls past", () => {
    const h = harness({ rules: { acme: { burst_creation: { mode: "enforce", params: { threshold: 5, window_ms: 60_000 } } } } });
    h.burst({ sender: SENDER, count: 4 });
    assert.deepEqual(h.detections(), []);

    // The four earlier creates are outside the window by the time the fifth
    // lands, so the sliding window — not the running total — decides.
    h.burst({ sender: SENDER, count: 4, everyMs: 61_000, prefix: "late" });
    assert.deepEqual(h.detections(), []);
    assert.equal(h.sink.delivered.length, 0);
  });

  it("counts a batch create once, not once per stream it summarises", () => {
    const h = harness({ rules: { acme: { burst_creation: { mode: "enforce", params: { threshold: 5, window_ms: 60_000 } } } } });
    const step = h.chain.step();
    h.apply([batchCreated({ id: "batch-1", ledger: step.ledger, offsetMs: step.atMs - T0, sender: SENDER, count: 12 })]);

    const detection = h.detections()[0] as Detection;
    assert.equal(detection.evidence.metrics["created"], 12);
    assert.deepEqual(detection.evidence.citedEventIds, ["batch-1"]);
  });

  it("tracks each sender separately", () => {
    const h = harness({ rules: { acme: { burst_creation: { mode: "enforce", params: { threshold: 4, window_ms: 60_000 } } } } });
    h.burst({ sender: SENDER, count: 3, prefix: "a" });
    h.burst({ sender: PEER, count: 3, prefix: "b" });
    assert.deepEqual(h.detections(), []);
    assert.equal(h.engine.trackedSubjects("sender").length, 2);
  });
});

describe("dust spam", () => {
  const RULES = {
    acme: { dust_spam: { mode: "enforce" as const, params: { threshold: 3, min_payees: 2, dust_ceiling: 100, window_ms: 300_000 } } },
  };

  it("fires on many minimum streams spread across payees", () => {
    const h = harness({ rules: RULES });
    h.burst({ sender: SENDER, count: 4, deposit: "10" });

    const detection = h.detections()[0] as Detection;
    assert.equal(detection.ruleId, "dust_spam");
    // It trips on the third dust creation: two payees were enough, the count
    // reached the threshold, and the fourth event is inside the same window.
    assert.equal(detection.evidence.metrics["dust_creations"], 3);
    assert.equal(detection.evidence.metrics["distinct_payees"], 3);
  });

  it("ignores full-size streams", () => {
    const h = harness({ rules: RULES });
    h.burst({ sender: SENDER, count: 8, deposit: "9_999_999".replace(/_/g, "") });
    assert.deepEqual(h.detections(), []);
  });

  it("ignores dust aimed at a single payee", () => {
    const h = harness({ rules: RULES });
    h.burst({ sender: SENDER, count: 8, deposit: "1", recipient: PEER });
    assert.deepEqual(h.detections(), []);
  });

  it("reports the ceiling it used so the alert explains itself", () => {
    const h = harness({ rules: RULES });
    h.burst({ sender: SENDER, count: 3, deposit: "1" });
    const alert = h.sink.delivered[0];
    assert.equal(alert?.explanation["dust_ceiling"], 100);
    assert.equal(alert?.explanation["min_payees"], 2);
  });
});

describe("circular flow", () => {
  const RULES = {
    acme: { circular_flow: { mode: "enforce" as const, params: { min_flows: 2, window_ms: 3_600_000 } } },
  };

  function roundTrip(h: Harness, forward: number, backward: number, backwardFirst = false): void {
    const legs: Array<[string, string]> = [
      ...Array.from({ length: forward }, (): [string, string] => [SENDER, PEER]),
      ...Array.from({ length: backward }, (): [string, string] => [PEER, SENDER]),
    ];
    if (backwardFirst) legs.reverse();
    const events: DecodedEvent[] = [];
    for (let i = 0; i < legs.length; i++) {
      const [sender, recipient] = legs[i] as [string, string];
      const step = h.chain.step();
      const id = sender === SENDER ? `fwd-${i}` : `bwd-${i}`;
      events.push(created({ id, ledger: step.ledger, offsetMs: step.atMs - T0, sender, recipient }));
    }
    h.apply(events);
  }

  it("fires when both directions carry streams", () => {
    const h = harness({ rules: RULES });
    roundTrip(h, 2, 2);

    const detection = h.detections()[0] as Detection;
    assert.equal(detection.ruleId, "circular_flow");
    assert.equal(detection.severity, "critical");
    assert.equal(detection.subjectKey, [SENDER, PEER].sort().join("|"));
    assert.equal(detection.evidence.metrics["forward_flows"], 2);
    assert.equal(detection.evidence.metrics["backward_flows"], 2);
  });

  it("stays silent on one-directional volume", () => {
    const h = harness({ rules: RULES });
    roundTrip(h, 5, 0);
    assert.deepEqual(h.detections(), []);
    assert.deepEqual(h.sink.delivered, []);
  });

  it("orders the pair key so either direction is the same subject", () => {
    const forwardFirst = harness({ rules: RULES });
    roundTrip(forwardFirst, 2, 2);
    const backwardFirst = harness({ rules: RULES });
    roundTrip(backwardFirst, 2, 2, true);

    const a = forwardFirst.detections()[0] as Detection;
    const b = backwardFirst.detections()[0] as Detection;
    assert.equal(a.subjectKey, [SENDER, PEER].sort().join("|"));
    assert.equal(b.subjectKey, a.subjectKey, "whoever spoke first is the same pair");
    assert.deepEqual(a.evidence.citedEventIds, ["fwd-0", "fwd-1", "bwd-2", "bwd-3"]);
  });
});

describe("create/cancel churn", () => {
  const RULES = {
    acme: { create_cancel_churn: { mode: "enforce" as const, params: { min_creations: 3, cancel_ratio: 0.5, window_ms: 3_600_000 } } },
  };

  it("fires when a sender cancels most of what it created", () => {
    const h = harness({ rules: RULES });
    const events: DecodedEvent[] = [];
    for (let i = 0; i < 4; i++) {
      const step = h.chain.step();
      events.push(created({ id: `c-${i}`, ledger: step.ledger, offsetMs: step.atMs - T0, sender: SENDER, recipient: addr(`payee-${i}`) }));
    }
    for (let i = 0; i < 2; i++) {
      const step = h.chain.step();
      events.push(cancelled({ id: `x-${i}`, ledger: step.ledger, offsetMs: step.atMs - T0, streamId: `c-${i}`, by: SENDER }));
    }
    h.apply(events);

    const detection = h.detections().find((candidate) => candidate.ruleId === "create_cancel_churn") as Detection;
    assert.equal(detection.evidence.metrics["created"], 4);
    assert.equal(detection.evidence.metrics["cancelled"], 2);
    assert.equal(detection.evidence.metrics["ratio"], 0.5);
  });

  it("stays silent below the ratio", () => {
    const h = harness({ rules: RULES });
    const events: DecodedEvent[] = [];
    for (let i = 0; i < 4; i++) {
      const step = h.chain.step();
      events.push(created({ id: `c-${i}`, ledger: step.ledger, offsetMs: step.atMs - T0, sender: SENDER, recipient: addr(`payee-${i}`) }));
    }
    const step = h.chain.step();
    events.push(cancelled({ id: "x-0", ledger: step.ledger, offsetMs: step.atMs - T0, streamId: "c-0", by: SENDER }));
    h.apply(events);
    assert.deepEqual(h.detections(), []);
  });

  it("attributes a cancel to the address the event names, never to a projection it cannot re-read", () => {
    const h = harness({ rules: RULES });
    const events: DecodedEvent[] = [];
    for (let i = 0; i < 4; i++) {
      const step = h.chain.step();
      events.push(created({ id: `c-${i}`, ledger: step.ledger, offsetMs: step.atMs - T0, sender: SENDER, recipient: addr(`payee-${i}`) }));
    }
    // A counterparty cancels: churn belongs to the canceller, who created nothing.
    for (let i = 0; i < 3; i++) {
      const step = h.chain.step();
      events.push(cancelled({ id: `x-${i}`, ledger: step.ledger, offsetMs: step.atMs - T0, streamId: `c-${i}`, by: OUTSIDER }));
    }
    h.apply(events);
    assert.deepEqual(h.detections(), []);
  });

  it("needs enough creations before it judges a ratio", () => {
    const h = harness({ rules: RULES });
    const first = h.chain.step();
    h.apply([created({ id: "c-0", ledger: first.ledger, offsetMs: first.atMs - T0, sender: SENDER, recipient: PEER })]);
    const second = h.chain.step();
    h.apply([cancelled({ id: "x-0", ledger: second.ledger, offsetMs: second.atMs - T0, streamId: "c-0", by: SENDER })]);
    assert.deepEqual(h.detections(), []);
  });
});
describe("replay from the cited ledger range", () => {
  interface Case {
    name: string;
    rule: string;
    build: () => Harness;
  }

  const BURST_RULES = { acme: { burst_creation: { mode: "enforce" as const, params: { threshold: 5, window_ms: 60_000 } } } };
  const DUST_RULES = {
    acme: { dust_spam: { mode: "enforce" as const, params: { threshold: 3, min_payees: 2, dust_ceiling: 100, window_ms: 300_000 } } },
  };
  const CIRCLE_RULES = { acme: { circular_flow: { mode: "enforce" as const, params: { min_flows: 2, window_ms: 3_600_000 } } } };
  const CHURN_RULES = {
    acme: { create_cancel_churn: { mode: "enforce" as const, params: { min_creations: 3, cancel_ratio: 0.5, window_ms: 3_600_000 } } },
  };

  function churnHarness(): Harness {
    const h = harness({ rules: CHURN_RULES });
    const events: DecodedEvent[] = [];
    for (let i = 0; i < 4; i++) {
      const step = h.chain.step();
      events.push(created({ id: `c-${i}`, ledger: step.ledger, offsetMs: step.atMs - T0, sender: SENDER, recipient: addr(`payee-${i}`) }));
    }
    for (let i = 0; i < 2; i++) {
      const step = h.chain.step();
      events.push(cancelled({ id: `x-${i}`, ledger: step.ledger, offsetMs: step.atMs - T0, streamId: `c-${i}`, by: SENDER }));
    }
    h.apply(events);
    return h;
  }

  function circleHarness(): Harness {
    const h = harness({ rules: CIRCLE_RULES });
    const legs: Array<[string, string]> = [
      [SENDER, PEER],
      [SENDER, PEER],
      [PEER, SENDER],
      [PEER, SENDER],
    ];
    const events: DecodedEvent[] = legs.map(([sender, recipient], index) => {
      const step = h.chain.step();
      return created({ id: `p-${index}`, ledger: step.ledger, offsetMs: step.atMs - T0, sender, recipient });
    });
    h.apply(events);
    return h;
  }

  const CASES: Case[] = [
    { name: "burst", rule: "burst_creation", build: () => { const h = harness({ rules: BURST_RULES }); h.burst({ sender: SENDER, count: 6 }); return h; } },
    { name: "dust", rule: "dust_spam", build: () => { const h = harness({ rules: DUST_RULES }); h.burst({ sender: SENDER, count: 4, deposit: "7" }); return h; } },
    { name: "circle", rule: "circular_flow", build: circleHarness },
    { name: "churn", rule: "create_cancel_churn", build: churnHarness },
  ];

  for (const testCase of CASES) {
    it(`re-derives ${testCase.name} from the range its alert cites`, () => {
      const h = testCase.build();
      const detection = h.detections().find((candidate) => candidate.ruleId === testCase.rule) as Detection;
      const outcome = replayDetection(h.store, detection);
      assert.equal(outcome.reason, "verified", outcome.detail);
      assert.equal(outcome.verified, true);
      assert.equal(outcome.replayed_fingerprint, detection.fingerprint);
      assert.deepEqual(outcome.replayed_metrics, detection.evidence.metrics);
      assert.ok(outcome.events_read > 0);
    });
  }

  it("replays with the thresholds the detection recorded, not today's config", () => {
    const h = harness({ rules: BURST_RULES });
    h.burst({ sender: SENDER, count: 6 });
    const detection = h.detections()[0] as Detection;

    // The operator retunes the rule sharply upward after the alert.
    h.rules.set("acme", { burst_creation: { mode: "enforce", params: { threshold: 500, window_ms: 60_000 } } });
    const outcome = replayDetection(h.store, detection);
    assert.equal(outcome.verified, true, "a citation is a claim about the past, not about current config");
  });

  it("refuses to certify a detection whose numbers the range does not support", () => {
    const h = harness({ rules: BURST_RULES });
    h.burst({ sender: SENDER, count: 6 });
    const detection = h.detections()[0] as Detection;
    const tampered: Detection = { ...detection, params: { ...detection.params, threshold: 2 } };
    const outcome = replayDetection(h.store, tampered);
    assert.equal(outcome.verified, false);
    assert.equal(outcome.reason, "not_reproduced");
    assert.notEqual(outcome.replayed_fingerprint, tampered.fingerprint);
  });

  it("names the rule version it cannot evaluate instead of guessing", () => {
    const h = harness({ rules: BURST_RULES });
    h.burst({ sender: SENDER, count: 6 });
    const detection = h.detections()[0] as Detection;
    const outcome = replayDetection(h.store, { ...detection, ruleVersion: 2 });
    assert.equal(outcome.reason, "rule_version_unavailable");
    assert.match(outcome.detail, /this build evaluates 1/);
  });

  it("reports a citation the journal can no longer honour", () => {
    const h = harness({ rules: BURST_RULES });
    h.burst({ sender: SENDER, count: 6 });
    const detection = h.detections()[0] as Detection;
    h.store.db.prepare("DELETE FROM events WHERE id = ?").run(detection.citation.lastEventId);

    const outcome = replayDetection(h.store, detection);
    assert.equal(outcome.reason, "citation_incomplete");
    assert.match(outcome.detail, /is not in ledger range/);
  });

  it("refuses a range too large to read, so a citation cannot be a denial of service", () => {
    const h = harness({ rules: BURST_RULES });
    h.burst({ sender: SENDER, count: 6 });
    const detection = h.detections()[0] as Detection;
    const outcome = replayDetection(h.store, detection, { maxEvents: 1 });
    assert.equal(outcome.reason, "range_too_large");
    assert.equal(outcome.verified, false);
  });

  it("counts only the subject's traffic when the cited range holds other accounts too", () => {
    const h = harness({ rules: BURST_RULES });
    // Alternating senders put unrelated creates inside the very ledger range
    // the subject's detection will cite. A verifier that read the range as-is
    // would count six other streams into this sender's total and reject a true
    // alert.
    const events: DecodedEvent[] = [];
    for (let i = 0; i < 6; i++) {
      const subject = h.chain.step();
      events.push(
        created({ id: `s-${i}`, ledger: subject.ledger, offsetMs: subject.atMs - T0, sender: SENDER, recipient: addr(`payee-s-${i}`) })
      );
      const noise = h.chain.step();
      events.push(
        created({ id: `n-${i}`, ledger: noise.ledger, offsetMs: noise.atMs - T0, sender: PEER, recipient: addr(`payee-n-${i}`) })
      );
    }
    h.apply(events);

    const detection = h.detections().find((candidate) => candidate.subjectKey === SENDER) as Detection;
    assert.equal(detection.evidence.metrics["created"], 5);
    const outcome = replayDetection(h.store, detection);
    assert.equal(outcome.reason, "verified", outcome.detail);
    assert.ok(outcome.events_read > 5, "the range it reads holds the other sender's events as well");
  });

  it("binds the fingerprint to the citation, so a widened claim is a different claim", () => {
    const h = harness({ rules: BURST_RULES });
    h.burst({ sender: SENDER, count: 6 });
    const detection = h.detections()[0] as Detection;
    const widened = { ...detection, citation: { ...detection.citation, fromLedger: 1 } };
    assert.notEqual(
      fingerprintOf({
        ruleId: widened.ruleId,
        ruleVersion: widened.ruleVersion,
        tenantId: widened.tenantId,
        subjectKey: widened.subjectKey,
        citation: widened.citation,
        metrics: widened.evidence.metrics,
        params: widened.params,
      }).fingerprint,
      detection.fingerprint
    );
  });
});

describe("alert deduplication and flap suppression", () => {
  it("pages once for a pattern that keeps firing", () => {
    const h = harness({ rules: { acme: { burst_creation: { mode: "enforce", params: { threshold: 3, window_ms: 60_000 } } } } });
    h.burst({ sender: SENDER, count: 4 });
    h.burst({ sender: SENDER, count: 4, everyMs: 1_000, prefix: "more" });
    h.engine.sweep(T0 + h.chain.offsetMs);

    assert.equal(h.sink.delivered.length, 1, "one incident, not one alert per event");
    assert.equal(h.sink.delivered[0]?.type, "raised");
    assert.equal(h.engine.openIncidentKeys().length, 1);
  });

  it("hides a flickering transition and pages no second time", () => {
    const h = harness({
      rules: { acme: { burst_creation: { mode: "enforce", params: { threshold: 3, window_ms: 60_000 } } } },
      flapWindowMs: 120_000,
    });
    h.burst({ sender: SENDER, count: 4 });
    assert.equal(h.sink.delivered.length, 1);

    // Quiet long enough for the window to expire, short enough to count as flicker.
    h.engine.sweep(T0 + h.chain.offsetMs + 61_000);
    assert.deepEqual(h.sink.delivered.slice(1), [], "a 61s silence inside a 120s flap window is not a resolution");

    h.burst({ sender: SENDER, count: 4, everyMs: 1_000, prefix: "again" });
    assert.equal(h.sink.delivered.length, 1, "re-ignition inside the flap window is not a new page");
  });

  it("reports a resolution once the subject has been stable past the flap window", () => {
    const h = harness({
      rules: { acme: { burst_creation: { mode: "enforce", params: { threshold: 3, window_ms: 60_000 } } } },
      flapWindowMs: 120_000,
    });
    h.burst({ sender: SENDER, count: 4 });
    h.engine.sweep(T0 + h.chain.offsetMs + 61_000);
    h.engine.sweep(T0 + h.chain.offsetMs + 200_000);

    assert.deepEqual(
      h.sink.delivered.map((alert) => alert.type),
      ["raised", "resolved"]
    );
    assert.equal(h.sink.delivered[1]?.routed, true);
  });

  it("re-pages a still-open incident only when asked to heartbeat", () => {
    const h = harness({
      rules: { acme: { burst_creation: { mode: "enforce", params: { threshold: 3, window_ms: 600_000 } } } },
      renotifyAfterMs: 90_000,
    });
    h.burst({ sender: SENDER, count: 4 });
    h.engine.sweep(T0 + h.chain.offsetMs + 45_000);
    assert.equal(h.sink.delivered.length, 1);

    h.engine.sweep(T0 + h.chain.offsetMs + 95_000);
    assert.equal(h.sink.delivered.length, 2, "the heartbeat re-raises a still-open incident");
    assert.equal(h.sink.delivered[1]?.type, "raised");
  });

  it("resumes a restart without re-paging, because the incident table is durable", () => {
    const h = harness({ rules: { acme: { burst_creation: { mode: "enforce", params: { threshold: 3, window_ms: 60_000 } } } } });
    h.burst({ sender: SENDER, count: 4 });
    assert.equal(h.sink.delivered.length, 1);

    const restartedSink = new MemoryAlertSink();
    const restarted = new AnomalyEngine({ rules: h.rules, store: h.store.anomaly, sinks: [restartedSink], metrics: new AnomalyMetrics() });
    const page = h.store.eventsForAnomaly(0, 1_000_000, 10_000);
    restarted.hydrate(page.events.map(toObservation).filter((observation): observation is Observation => observation !== null));

    assert.equal(restartedSink.delivered.length, 0, "hydration must not re-page an incident already reported");
    assert.equal(h.detections().length, 1, "and re-ingesting a range must not duplicate the detection");
    assert.ok(restarted.openIncidentKeys().length > 0, "the incident is open again in the rebuilt windows");
  });

  it("skips the work as well as the page for a suppressed subject", () => {
    const h = harness({ rules: { acme: { burst_creation: { mode: "enforce", params: { threshold: 3, window_ms: 60_000 } } } } });
    h.burst({ sender: SENDER, count: 4 });
    assert.equal(h.detections().length, 1);

    h.rules.suppress("acme", "burst_creation", SENDER);
    h.burst({ sender: SENDER, count: 10, everyMs: 1_000, prefix: "after" });
    assert.equal(h.detections().length, 1, "a suppressed subject produces no new detection");
    // One skip counted per event, not one page: suppression removes the work as
    // well as the noise, so the counter says how much was skipped.
    assert.match(h.metrics.render(), /streampay_anomaly_suppressed_total\{rule_id="burst_creation"\} 10/);
  });
});

describe("shadow mode and the false-positive budget", () => {
  function shadowHarness(): { store: StreamStore; rules: TenantRuleSource; engine: AnomalyEngine; sink: MemoryAlertSink; chain: Chain } {
    const store = new StreamStore(":memory:");
    const rules = new TenantRuleSource({
      store: store.anomaly,
      base: { burst_creation: { mode: "shadow", params: { threshold: 3, window_ms: 60_000 }, min_reviews: 1 } },
      defaultTenantId: "acme",
      now: () => T0,
    });
    const sink = new MemoryAlertSink();
    const engine = new AnomalyEngine({ rules, store: store.anomaly, sinks: [sink], metrics: new AnomalyMetrics() });
    const chain = new Chain();
    store.on("event", (event: DecodedEvent) => {
      engine.observe(
        toObservation({
          id: event.id,
          name: event.name,
          ledger: event.ledger,
          ledgerClosedAt: event.ledgerClosedAt,
          streamId: event.streamId,
          data: event.data as Record<string, unknown>,
        })
      );
    });
    return { store, rules, engine, sink, chain };
  }

  function fireBurst(h: { store: StreamStore; chain: Chain }, count: number, prefix: string, sender = SENDER): void {
    const events: DecodedEvent[] = [];
    for (let i = 0; i < count; i++) {
      const step = h.chain.step(1_000);
      events.push(
        created({
          id: `${prefix}-${i}`,
          ledger: step.ledger,
          offsetMs: step.atMs - T0,
          sender,
          recipient: addr(`payee-${prefix}-${i}`),
        })
      );
    }
    h.store.ingestPage(events, undefined, events[events.length - 1]?.ledger ?? 0);
  }

  it("records what a shadow rule would have said and pages nobody", () => {
    const h = shadowHarness();
    fireBurst(h, 4, "shadow");

    const detection = h.store.anomaly.listDetections({ tenantId: "acme", limit: 10 })[0] as Detection;
    assert.equal(detection.mode, "shadow");
    assert.equal(h.sink.delivered.length, 0, "a shadow rule does not page an operator");

    const alerts = h.store.anomaly.listAlerts({ tenantId: "acme", limit: 10 });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.routed, false);
    assert.equal(alerts[0]?.reason, "shadow_mode");
  });

  it("will not promote a rule that has never been reviewed", () => {
    const h = shadowHarness();
    fireBurst(h, 4, "review");
    const detection = h.store.anomaly.listDetections({ tenantId: "acme", limit: 10 })[0] as Detection;

    const before = promotionReport(h.store.anomaly, h.rules, "acme", "burst_creation", T0);
    assert.equal(before.ready, false);
    assert.match(before.reasons.join(" "), /more reviewed detections/);

    h.store.anomaly.recordFeedback({
      id: `fbr_${detection.id}`,
      detectionId: detection.id,
      tenantId: "acme",
      label: "true_positive",
      note: "confirmed by the fraud queue",
      createdAtMs: T0,
    });

    const after = promotionReport(h.store.anomaly, h.rules, "acme", "burst_creation", T0);
    assert.equal(after.ready, true, after.reasons.join(", "));
    assert.equal(after.reviewed, 1);

    // Promoting is exactly the override the report licenses, and then the rule pages.
    h.store.anomaly.setOverride("acme", "burst_creation", { mode: "enforce", params: { threshold: 3, window_ms: 60_000 }, min_reviews: 1 }, T0);
    h.rules.invalidate("acme");
    // A fresh subject: the shadow incident for the first sender is still open,
    // and an open incident is throttled to one detection per window.
    fireBurst(h, 4, "enforced", addr("enforced-sender"));
    assert.equal(h.sink.delivered.length, 1);
    assert.equal(h.sink.delivered[0]?.mode, "enforce");
    assert.equal(h.sink.delivered[0]?.routed, true);
  });

  it("keeps a rule in shadow while its reviews are mostly false positives", () => {
    const h = shadowHarness();
    fireBurst(h, 4, "fp");
    const detection = h.store.anomaly.listDetections({ tenantId: "acme", limit: 10 })[0] as Detection;
    h.store.anomaly.recordFeedback({
      id: `fbr_${detection.id}`,
      detectionId: detection.id,
      tenantId: "acme",
      label: "false_positive",
      note: "a legitimate bulk onboarding",
      createdAtMs: T0,
    });

    const report = promotionReport(h.store.anomaly, h.rules, "acme", "burst_creation", T0);
    assert.equal(report.ready, false);
    assert.match(report.reasons.join(" "), /false-positive rate/);
    assert.equal(report.false_positives, 1);
  });

  it("refuses to promote a rule that has never fired at all", () => {
    const h = shadowHarness();
    const report = promotionReport(h.store.anomaly, h.rules, "acme", "dust_spam", T0);
    assert.equal(report.ready, false);
    assert.match(report.reasons.join(" "), /has never fired/);
  });
});

describe("tenant isolation of rules and alerts", () => {
  it("applies each tenant's thresholds to the same traffic", () => {
    const h = harness({
      tenants: ["acme", "globex"],
      rules: {
        acme: { burst_creation: { mode: "enforce", params: { threshold: 3, window_ms: 60_000 } } },
        globex: { burst_creation: { mode: "enforce", params: { threshold: 100, window_ms: 60_000 } } },
      },
    });
    h.burst({ sender: SENDER, count: 5 });

    assert.equal(h.detections("acme").length, 1);
    assert.deepEqual(h.detections("globex"), []);
    assert.equal(h.sink.delivered.length, 1);
    assert.equal(h.sink.delivered[0]?.tenant_id, "acme");
  });

  it("routes an alert only to the tenant that owns it", () => {
    const webhooks = new WebhookStore(new Database(":memory:"));
    const acmeEndpoint = webhooks.createEndpoint({ url: "https://93.184.216.34/acme", events: ["anomaly_alert"], tenantId: "acme" });
    const broadcastEndpoint = webhooks.createEndpoint({ url: "https://93.184.216.34/globex", events: ["*"], tenantId: "globex" });
    const deafEndpoint = webhooks.createEndpoint({ url: "https://93.184.216.34/other", events: ["stream_created"], tenantId: "acme" });

    const sink = new WebhookAlertSink(webhooks);
    const h = harness({ rules: { acme: { burst_creation: { mode: "enforce", params: { threshold: 3, window_ms: 60_000 } } } } });
    h.burst({ sender: SENDER, count: 5 });
    const alert = h.sink.delivered[0];
    assert.ok(alert !== undefined);
    sink.deliver(alert);

    const deliveries = webhooks.listDeliveries(50);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.endpoint_id, acmeEndpoint.id);
    assert.equal(deliveries[0]?.event_type, "anomaly_alert");
    assert.ok(!deliveries.some((delivery) => delivery.endpoint_id === broadcastEndpoint.id), "another tenant's wildcard must not hear this");
    assert.ok(!deliveries.some((delivery) => delivery.endpoint_id === deafEndpoint.id));

    const payload = deliveries[0]?.payload as Record<string, unknown>;
    assert.equal(payload["fingerprint"], alert.fingerprint);
    assert.ok(!JSON.stringify(payload).includes(SENDER), "the delivered alert carries redacted actors");
  });
});

describe("privacy of alert evidence", () => {
  it("keeps identifiers at their prefix and drops anything the privacy line calls financial", () => {
    const redacted = redactEvidence({
      metrics: { created: 6, deposit_total: "5000000", withdrawn_amount: "12" },
      actors: { sender: SENDER },
      citedEventIds: ["evt-1"],
    });
    assert.equal(redacted["created"], 6);
    assert.ok(!("deposit_total" in redacted));
    assert.ok(!("withdrawn_amount" in redacted));
    assert.equal(redacted["sender"], `${SENDER.slice(0, 8)}...`);
  });

  it("redacts both halves of a pair subject", () => {
    const subject = redactSubject([SENDER, PEER].sort().join("|"));
    assert.equal(subject, `${[SENDER, PEER].sort()[0]?.slice(0, 8)}...|${[SENDER, PEER].sort()[1]?.slice(0, 8)}...`);
    assert.ok(!subject.includes(SENDER));
  });

  it("leaves no full address in a routed alert", () => {
    const h = harness({
      rules: {
        acme: {
          circular_flow: { mode: "enforce", params: { min_flows: 2, window_ms: 3_600_000 } },
        },
      },
    });
    const events: DecodedEvent[] = [];
    for (let i = 0; i < 4; i++) {
      const step = h.chain.step();
      events.push(
        created({
          id: `r-${i}`,
          ledger: step.ledger,
          offsetMs: step.atMs - T0,
          sender: i % 2 === 0 ? SENDER : PEER,
          recipient: i % 2 === 0 ? PEER : SENDER,
        })
      );
    }
    h.apply(events);
    assert.equal(h.sink.delivered.length, 1);
    const wire = JSON.stringify(h.sink.delivered[0]);
    assert.ok(!wire.includes(SENDER), wire);
    assert.ok(!wire.includes(PEER), wire);
    assert.match(String(h.sink.delivered[0]?.subject), /^\w{8}\.\.\.\|\w{8}\.\.\.$/);
  });
});

describe("anomaly metrics exposition", () => {
  it("separates shadow from enforce counts and reports replay outcomes", () => {
    const metrics = new AnomalyMetrics();
    metrics.recordDetection("burst_creation", "warning", "shadow", false);
    metrics.recordDetection("burst_creation", "warning", "enforce", false);
    metrics.recordDetection("dust_spam", "warning", "enforce", true);
    metrics.recordAlert("burst_creation", "raised");
    metrics.recordFeedback("burst_creation", "false_positive");
    metrics.recordIncidents(new Map([["burst_creation", 2]]));
    metrics.recordPromotionReady("dust_spam", "acme", true);
    metrics.recordReplay("verified");

    const rendered = metrics.render();
    assert.match(rendered, /streampay_anomaly_detections_total\{rule_id="burst_creation",mode="shadow"\} 1/);
    assert.match(rendered, /streampay_anomaly_detections_total\{rule_id="burst_creation",mode="enforce"\} 1/);
    assert.match(rendered, /streampay_anomaly_suppressed_total\{rule_id="dust_spam"\} 1/);
    assert.match(rendered, /streampay_anomaly_alerts_total\{rule_id="burst_creation",type="raised"\} 1/);
    assert.match(rendered, /streampay_anomaly_feedback_total\{rule_id="burst_creation",label="false_positive"\} 1/);
    assert.match(rendered, /streampay_anomaly_incidents_open\{rule_id="burst_creation"\} 2/);
    assert.match(rendered, /streampay_anomaly_promotion_ready\{rule_id="dust_spam",tenant_id="acme"\} 1/);
    assert.match(rendered, /streampay_anomaly_replay_total\{outcome="verified"\} 1/);
    // Every series the operator alerts on has to be self-describing.
    assert.match(rendered, /# TYPE streampay_anomaly_promotion_ready gauge/);
  });
});

describe("environment configuration", () => {
  it("fails loudly on a rule file it cannot interpret", () => {
    assert.throws(() => ruleOverridesFromEnv({ [RULE_OVERRIDES_ENV]: "[]" }), /must be a JSON object/);
    assert.throws(() => ruleOverridesFromEnv({ [RULE_OVERRIDES_ENV]: '{"ghost":{"mode":"enforce"}}' }), /unknown rule/);
    assert.throws(() => ruleOverridesFromEnv({ [RULE_OVERRIDES_ENV]: '{"burst_creation":{"mode":"loud"}}' }), /mode must be/);
  });

  it("keeps shadow as the default paging mode and rejects a nonsense value", () => {
    assert.equal(defaultModeFromEnv({}), "shadow");
    assert.equal(defaultModeFromEnv({ [RULE_MODE_ENV]: "enforce" }), "enforce");
    assert.throws(() => defaultModeFromEnv({ [RULE_MODE_ENV]: "sometimes" }), /must be 'shadow' or 'enforce'/);
  });

  it("parses the override file through the same validator the API uses", () => {
    const parsed = parseRuleOverrides({ dust_spam: { params: { dust_ceiling: 250 } } });
    assert.deepEqual(parsed, { dust_spam: { params: { dust_ceiling: 250 } } });
    assert.throws(() => parseRuleOverrides({ dust_spam: "enforce" }), /must be an object/);
  });

  it("merges deployment defaults and tenant overrides without dropping either", () => {
    const store = new StreamStore(":memory:");
    const rules = new TenantRuleSource({
      store: store.anomaly,
      base: { burst_creation: { params: { threshold: 10, window_ms: 30_000 } }, dust_spam: { mode: "enforce" } },
      defaultMode: "shadow",
      defaultTenantId: "acme",
      now: () => T0,
    });
    store.anomaly.setOverride(
      "acme",
      "burst_creation",
      { params: { threshold: 2 } },
      T0
    );
    const burst = rules.rulesFor("acme").find((rule) => rule.id === "burst_creation");
    assert.equal(burst?.config.params["threshold"], 2, "the tenant's number wins");
    assert.equal(burst?.config.params["window_ms"], 30_000, "and the deployment's other thresholds survive");
    assert.equal(burst?.config.mode, "shadow", "with no mode named, the deployment default applies");
    assert.equal(rules.rulesFor("acme").find((rule) => rule.id === "dust_spam")?.config.mode, "enforce");
    assert.deepEqual(rules.tenants(), ["acme"]);
  });

  it("caches resolved rules until something changes them", () => {
    const store = new StreamStore(":memory:");
    const rules = new TenantRuleSource({ store: store.anomaly, defaultTenantId: "acme", now: () => T0 });
    const first = rules.rulesFor("acme");
    assert.equal(rules.rulesFor("acme"), first, "same array identity while cached");
    rules.invalidate("acme");
    assert.notEqual(rules.rulesFor("acme"), first);
  });
});
describe("anomaly HTTP surface", () => {
  interface Session {
    baseUrl: string;
    acmeKey: string;
    globexKey: string;
    store: StreamStore;
    engine: AnomalyEngine;
    metrics: AnomalyMetrics;
    sink: MemoryAlertSink;
    /** One sender creating `count` streams through the live ingest path. */
    fire: (args: { count: number; prefix: string; sender?: string; everyMs?: number }) => void;
  }

  async function withApi(
    fn: (session: Session) => Promise<void>,
    options: { base?: Record<string, TenantRuleOverride>; configured?: boolean } = {}
  ): Promise<void> {
    const store = new StreamStore(":memory:");
    const directory = new TenantDirectory();
    directory.upsert({ tenantId: "acme" });
    directory.upsert({ tenantId: "globex" });
    const acmeKey = directory.registerKey("acme", "k1").key;
    const globexKey = directory.registerKey("globex", "k1").key;

    const metrics = new AnomalyMetrics();
    const rules = new TenantRuleSource({
      store: store.anomaly,
      directory,
      base: options.base ?? {},
      defaultTenantId: "acme",
      // A fixed clock for the cache: writes invalidate, so a test that tunes a
      // rule sees it immediately without waiting out 30s of real time.
      now: () => T0,
    });
    const sink = new MemoryAlertSink();
    const engine = new AnomalyEngine({ rules, store: store.anomaly, sinks: [sink], metrics });
    const chain = new Chain();
    store.on("event", (event: DecodedEvent) => {
      engine.observe(
        toObservation({
          id: event.id,
          name: event.name,
          ledger: event.ledger,
          ledgerClosedAt: event.ledgerClosedAt,
          streamId: event.streamId,
          data: event.data as Record<string, unknown>,
        })
      );
    });

    const anomalyApi: AnomalyApiConfig = {
      engine,
      store: store.anomaly,
      rules,
      directory,
      metrics,
      defaultTenantId: "acme",
      suppressionTtlMs: 60_000,
      replayMaxEvents: 10_000,
    };
    const app = options.configured === false
      ? createApp(store)
      : createApp(store, undefined, undefined, undefined, undefined, undefined, undefined, undefined, anomalyApi);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      await fn({
        baseUrl: `http://127.0.0.1:${port}`,
        acmeKey,
        globexKey,
        store,
        engine,
        metrics,
        sink,
        fire: ({ count, prefix, sender = addr("http-sender"), everyMs = 5_000 }) => {
          const events = Array.from({ length: count }, (_, index) => {
            const step = chain.step(everyMs);
            return created({
              id: `${prefix}-${index}`,
              ledger: step.ledger,
              offsetMs: step.atMs - T0,
              sender,
              recipient: addr(`payee-${prefix}-${index}`),
            });
          });
          store.ingestPage(events, undefined, events[events.length - 1]?.ledger ?? chain.ledger);
        },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  }

  async function call(
    baseUrl: string,
    method: string,
    route: string,
    options: { key?: string; body?: unknown } = {}
  ): Promise<{ status: number; text: string; json: Record<string, any> }> {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(options.key === undefined ? {} : { "x-streampay-webhook-key": options.key }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let json: Record<string, any> = {};
    try {
      json = text === "" ? {} : (JSON.parse(text) as Record<string, any>);
    } catch {}
    return { status: response.status, text, json };
  }

  /** acme enforces a low burst threshold; globex keeps the catalog defaults. */
  const ACME_ENFORCED: Record<string, TenantRuleOverride> = {
    burst_creation: { mode: "enforce", params: { threshold: 3, window_ms: 60_000 }, min_reviews: 1 },
  };

  it("refuses every anomaly route without a tenant key", async () => {
    await withApi(async (session) => {
      const routes: Array<[string, string, unknown]> = [
        ["GET", "/api/anomaly/rules", undefined],
        ["GET", "/api/anomaly/detections", undefined],
        ["POST", "/api/anomaly/rules/burst_creation/override", { mode: "enforce" }],
        ["DELETE", "/api/anomaly/rules/burst_creation/override", undefined],
        ["POST", "/api/anomaly/detections/anm_0/replay", undefined],
        ["POST", "/api/anomaly/detections/anm_0/feedback", { label: "true_positive" }],
        ["POST", "/api/anomaly/rules/burst_creation/promote", undefined],
        ["GET", "/api/anomaly/promotion", undefined],
        ["GET", "/api/anomaly/incidents", undefined],
      ];
      for (const [method, route, body] of routes) {
        const response = await call(session.baseUrl, method, route, { body });
        assert.equal(response.status, 401, `${method} ${route}`);
        assert.equal(response.json.code, "unauthenticated");
      }
    });
  });

  it("serves the rule catalog with the knobs an operator may turn", async () => {
    await withApi(async (session) => {
      const response = await call(session.baseUrl, "GET", "/api/anomaly/rules", { key: session.acmeKey });
      assert.equal(response.status, 200, response.text);
      assert.equal(response.json.tenant_id, "acme");
      const rules = response.json.rules as Array<Record<string, any>>;
      assert.equal(rules.length, 4);
      const burst = rules.find((rule) => rule.id === "burst_creation");
      // Conservative by default: nothing pages until an operator opts in.
      assert.equal(burst?.mode, "shadow");
      assert.equal(burst?.version, 1);
      const threshold = (burst?.params as Array<Record<string, any>>).find((param) => param.name === "threshold");
      assert.equal(threshold?.value, 20);
      assert.equal(threshold?.min, 2);
      assert.ok(String(threshold?.description).length > 0, "a knob the API exposes explains itself");
    });
  });

  it("rejects a tuning it cannot interpret instead of running defaults", async () => {
    await withApi(async (session) => {
      const typo = await call(session.baseUrl, "POST", "/api/anomaly/rules/burst_creation/override", {
        key: session.acmeKey,
        body: { params: { treshold: 3 } },
      });
      assert.equal(typo.status, 400, typo.text);
      assert.equal(typo.json.code, "unknown_param");

      const ghost = await call(session.baseUrl, "POST", "/api/anomaly/rules/naughty_rule/override", {
        key: session.acmeKey,
        body: { mode: "enforce" },
      });
      assert.equal(ghost.status, 404, ghost.text);
      assert.equal(ghost.json.code, "unknown_rule");

      const loud = await call(session.baseUrl, "POST", "/api/anomaly/rules/burst_creation/override", {
        key: session.acmeKey,
        body: { mode: "loud" },
      });
      assert.equal(loud.status, 400, loud.text);
      assert.equal(loud.json.code, "invalid_mode");
    }, { base: ACME_ENFORCED });
  });

  it("reports a detection redacted, and replays it over the wire", async () => {
    await withApi(async (session) => {
      session.fire({ count: 5, prefix: "wire" });
      const list = await call(session.baseUrl, "GET", "/api/anomaly/detections", { key: session.acmeKey });
      assert.equal(list.status, 200, list.text);
      assert.equal(list.json.detections.length, 1);
      const detection = list.json.detections[0] as Record<string, any>;
      assert.equal(detection.rule_id, "burst_creation");
      assert.equal(detection.mode, "enforce");
      assert.match(String(detection.subject), /^[\w+/=]{8}\.\.\.$/);
      assert.ok(!list.text.includes(addr("http-sender")), "the wire never carries a full address");

      const replay = await call(session.baseUrl, "POST", `/api/anomaly/detections/${detection.id}/replay`, {
        key: session.acmeKey,
      });
      assert.equal(replay.status, 200, replay.text);
      assert.equal(replay.json.verified, true, replay.json.detail);
      assert.equal(replay.json.reason, "verified");
      assert.equal(replay.json.replayed_fingerprint, detection.fingerprint);
      // The cited range is the subject's own window: three creates crossed the
      // threshold, and the two that followed are outside the citation.
      assert.equal(replay.json.events_read, 3);

      const missing = await call(session.baseUrl, "POST", "/api/anomaly/detections/anm_nosuch/replay", {
        key: session.acmeKey,
      });
      assert.equal(missing.status, 404);
      assert.equal(missing.json.code, "not_found");
    }, { base: ACME_ENFORCED });
  });

  it("keeps one tenant's detections invisible to another", async () => {
    await withApi(async (session) => {
      // Only acme tunes the rule; globex keeps the catalog defaults, so the
      // same traffic is not yet anomalous for it.
      const tune = await call(session.baseUrl, "POST", "/api/anomaly/rules/burst_creation/override", {
        key: session.acmeKey,
        body: { mode: "enforce", params: { threshold: 3, window_ms: 60_000 } },
      });
      assert.equal(tune.status, 200, tune.text);

      session.fire({ count: 5, prefix: "mine" });
      const acme = await call(session.baseUrl, "GET", "/api/anomaly/detections", { key: session.acmeKey });
      const id = (acme.json.detections as Array<Record<string, any>>)[0]?.id as string;
      assert.ok(id, acme.text);

      const foreignList = await call(session.baseUrl, "GET", "/api/anomaly/detections", { key: session.globexKey });
      assert.equal((foreignList.json.detections as unknown[]).length, 0, "globex runs the catalog defaults and saw nothing");

      const foreignRead = await call(session.baseUrl, "GET", `/api/anomaly/detections/${id}`, { key: session.globexKey });
      assert.equal(foreignRead.status, 404, foreignRead.text);
      assert.equal(foreignRead.json.code, "not_found");

      const foreignFeedback = await call(session.baseUrl, "POST", `/api/anomaly/detections/${id}/feedback`, {
        key: session.globexKey,
        body: { label: "false_positive" },
      });
      assert.equal(foreignFeedback.status, 404, foreignFeedback.text);
    });
  });

  it("turns a false-positive review into a suppression, and will not take it back twice", async () => {
    await withApi(async (session) => {
      session.fire({ count: 5, prefix: "fp" });
      const list = await call(session.baseUrl, "GET", "/api/anomaly/detections", { key: session.acmeKey });
      const id = (list.json.detections as Array<Record<string, any>>)[0]?.id as string;

      const bad = await call(session.baseUrl, "POST", `/api/anomaly/detections/${id}/feedback`, {
        key: session.acmeKey,
        body: { label: "maybe" },
      });
      assert.equal(bad.status, 400, bad.text);
      assert.equal(bad.json.code, "invalid_label");

      const wrong = await call(session.baseUrl, "POST", `/api/anomaly/detections/${id}/feedback`, {
        key: session.acmeKey,
        body: { label: "false_positive", note: "legitimate bulk onboarding" },
      });
      assert.equal(wrong.status, 200, wrong.text);
      assert.ok(Number(wrong.json.suppressed_until_ms) > Date.now());

      // The same review again is the operator repeating themselves, not new evidence.
      const repeat = await call(session.baseUrl, "POST", `/api/anomaly/detections/${id}/feedback`, {
        key: session.acmeKey,
        body: { label: "false_positive" },
      });
      assert.equal(repeat.status, 200, repeat.text);
      const contradiction = await call(session.baseUrl, "POST", `/api/anomaly/detections/${id}/feedback`, {
        key: session.acmeKey,
        body: { label: "true_positive" },
      });
      assert.equal(contradiction.status, 409, contradiction.text);
      assert.equal(contradiction.json.code, "already_reviewed");

      const detail = await call(session.baseUrl, "GET", `/api/anomaly/detections/${id}`, { key: session.acmeKey });
      assert.equal((detail.json.feedback as Array<Record<string, any>>).length, 1, "one review, not one per retry");

      const before = session.store.anomaly.listDetections({ tenantId: "acme", limit: 50 }).length;
      session.fire({ count: 8, prefix: "ignored", everyMs: 1_000 });
      assert.equal(
        session.store.anomaly.listDetections({ tenantId: "acme", limit: 50 }).length,
        before,
        "a suppressed subject produces no new detection"
      );

      const incidents = await call(session.baseUrl, "GET", "/api/anomaly/incidents", { key: session.acmeKey });
      assert.equal(incidents.status, 200, incidents.text);
      const suppressions = incidents.json.suppressions as Array<Record<string, any>>;
      assert.equal(suppressions.length, 1);
      assert.equal(suppressions[0]?.rule_id, "burst_creation");
      assert.ok(!JSON.stringify(suppressions).includes(addr("http-sender")));
    }, { base: ACME_ENFORCED });
  });

  it("will not let an unreviewed rule page, then promotes it once the report is ready", async () => {
    await withApi(async (session) => {
      // Shadow: the rule records, but nothing reaches an operator.
      session.fire({ count: 5, prefix: "promo" });
      assert.equal(session.sink.delivered.length, 0, "a shadow rule pages nobody");
      const list = await call(session.baseUrl, "GET", "/api/anomaly/detections", { key: session.acmeKey });
      const shadowDetections = list.json.detections as Array<Record<string, any>>;
      assert.equal(shadowDetections.length, 1);
      const id = shadowDetections[0]?.id as string;
      assert.equal(shadowDetections[0]?.mode, "shadow");

      const early = await call(session.baseUrl, "POST", "/api/anomaly/rules/burst_creation/promote", { key: session.acmeKey });
      assert.equal(early.status, 409, early.text);
      assert.equal(early.json.code, "promotion_not_ready");
      assert.ok((early.json.reasons as string[]).join(" ").includes("reviewed"));

      const review = await call(session.baseUrl, "POST", `/api/anomaly/detections/${id}/feedback`, {
        key: session.acmeKey,
        body: { label: "true_positive" },
      });
      assert.equal(review.status, 200, review.text);

      const promoted = await call(session.baseUrl, "POST", "/api/anomaly/rules/burst_creation/promote", { key: session.acmeKey });
      assert.equal(promoted.status, 200, promoted.text);
      assert.equal((promoted.json.rule as Record<string, any>).mode, "enforce");

      session.fire({ count: 5, prefix: "paged", sender: addr("paged-sender") });
      assert.equal(session.sink.delivered.length, 1, "the promoted rule pages");
      assert.equal(session.sink.delivered[0]?.mode, "enforce");

      const reports = await call(session.baseUrl, "GET", "/api/anomaly/promotion", { key: session.acmeKey });
      assert.equal(reports.status, 200, reports.text);
      const burst = (reports.json.reports as Array<Record<string, any>>).find((report) => report.rule_id === "burst_creation");
      assert.equal(burst?.ready, true);
      assert.equal(burst?.mode, "enforce");

      // Dropping the tenant's override falls back to the deployment default.
      const dropped = await call(session.baseUrl, "DELETE", "/api/anomaly/rules/burst_creation/override", { key: session.acmeKey });
      assert.equal(dropped.status, 200, dropped.text);
      assert.equal((dropped.json.rule as Record<string, any>).mode, "shadow");
    }, { base: { burst_creation: { params: { threshold: 3, window_ms: 60_000 }, min_reviews: 1 } } });
  });

  it("exports the anomaly series from /metrics", async () => {
    await withApi(async (session) => {
      const tune = await call(session.baseUrl, "POST", "/api/anomaly/rules/burst_creation/override", {
        key: session.acmeKey,
        body: { mode: "enforce", params: { threshold: 3, window_ms: 60_000 } },
      });
      assert.equal(tune.status, 200, tune.text);

      session.fire({ count: 5, prefix: "metrics" });
      const reports = await call(session.baseUrl, "GET", "/api/anomaly/promotion", { key: session.acmeKey });
      assert.equal(reports.status, 200, reports.text);

      const response = await fetch(`${session.baseUrl}/metrics`);
      const body = await response.text();
      assert.equal(response.status, 200);
      assert.match(body, /streampay_anomaly_detections_total\{rule_id="burst_creation",mode="enforce"\} 1/);
      assert.match(body, /streampay_anomaly_alerts_total\{rule_id="burst_creation",type="raised"\} 1/);
      assert.match(body, /streampay_anomaly_incidents_open\{rule_id="burst_creation"\} 1/);
      assert.match(body, /# TYPE streampay_anomaly_promotion_ready gauge/);
      // Ready is measured, not assumed: nothing has been reviewed yet.
      assert.match(body, /streampay_anomaly_promotion_ready\{rule_id="burst_creation",tenant_id="acme"\} 0/);
    });
  });

  it("is absent when the deployment has not configured a detector", async () => {
    await withApi(async (session) => {
      const response = await call(session.baseUrl, "GET", "/api/anomaly/rules", { key: session.acmeKey });
      assert.equal(response.status, 404, response.text);
    }, { configured: false });
  });
});
