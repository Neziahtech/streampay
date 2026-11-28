import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_POLICY, computePolicyDigest, recordKey, type AuditPolicy } from "./canonical.js";
import { MemorySink, fakeClock, mutableReader, record, side } from "./fixtures.js";
import { ContinuousAuditor, CHECKPOINT_VERSION, type AuditSink, type PublicationEnvelope } from "./publication.js";
import { verifyBundle } from "./proofs.js";

function policy(epsilon: string): AuditPolicy {
  return { ...DEFAULT_POLICY, tolerance: { epsilon, comparison: "floor_div" } };
}

const IDS = [1, 2, 3];

function cleanReaders(): { onchain: ReturnType<typeof mutableReader>; projected: ReturnType<typeof mutableReader> } {
  const records = IDS.map((id) => record(id));
  return {
    onchain: mutableReader(side(50, records)),
    projected: mutableReader(side(50, records)),
  };
}

function divergent(readers: ReturnType<typeof cleanReaders>): void {
  readers.projected.set(side(51, [record(1), record(2, { deposit: "999999" }), record(3)]));
}

describe("continuous audit", () => {
  it("publishes one report and checkpoint per cycle", async () => {
    const sink = new MemorySink();
    const auditor = new ContinuousAuditor(cleanReaders(), sink, {
      intervalMs: 1_000,
      artifactRecordLimit: 64,
    });

    const outcome = await auditor.runCycle(10_000);
    assert.equal(outcome.cycle, 1);
    assert.equal(outcome.report?.verdict, "clean");
    assert.equal(outcome.skipped, null);
    assert.equal(sink.published.length, 1);
    assert.equal(sink.published[0]?.bundle, undefined, "a clean cycle has nothing to prove");
    assert.ok(sink.published[0]?.artifact !== undefined, "artifactRecordLimit publishes the record set");
    assert.equal(sink.checkpoints.length, 1);
    assert.equal(sink.checkpoints[0]?.cycle, 1);
    assert.equal(sink.checkpoints[0]?.version, CHECKPOINT_VERSION);
    assert.equal(sink.checkpoints[0]?.audits_run, 1);
    assert.equal(sink.checkpoints[0]?.last_audited_ledger, 50);
    assert.equal(sink.checkpoints[0]?.policy_digest, computePolicyDigest(DEFAULT_POLICY));
    assert.deepEqual(sink.checkpoints[0]?.previous_roots, outcome.report?.roots);
  });

  it("bundles proofs and raises one alert when the roots diverge", async () => {
    const readers = cleanReaders();
    divergent(readers);
    const sink = new MemorySink();
    const auditor = new ContinuousAuditor(readers, sink, { intervalMs: 1_000 });

    const first = await auditor.runCycle(1_000);
    assert.equal(first.report?.verdict, "fault");
    assert.deepEqual(first.alerts.map((alert) => alert.type), ["raised"]);
    const bundle = sink.published[0]?.bundle;
    assert.ok(bundle !== undefined);
    assert.equal(verifyBundle(bundle).ok, true, "the published bundle reproduces");

    // The same divergence next cycle is the same incident, not a new page.
    const second = await auditor.runCycle(2_000);
    assert.deepEqual(second.alerts, []);
    assert.equal(sink.published.length, 2);
  });

  it("keeps rounding noise out of the alert stream", async () => {
    const readers = cleanReaders();
    readers.projected.set(side(50, [record(1, { withdrawn: "255" }), record(2), record(3)]));
    const sink = new MemorySink();
    const auditor = new ContinuousAuditor(readers, sink, { intervalMs: 1_000, policy: policy("10") });

    const outcome = await auditor.runCycle(5_000);
    assert.equal(outcome.report?.verdict, "rounding_only");
    assert.deepEqual(outcome.alerts, [], "accual noise must not page anyone");
    assert.deepEqual(outcome.report?.rounding_keys, [recordKey(record(1))]);
  });

  it("skips a cycle when no ledger has closed", async () => {
    const readers = cleanReaders();
    const sink = new MemorySink();
    const auditor = new ContinuousAuditor(readers, sink, {
      intervalMs: 1_000,
      requireLedgerAdvance: true,
    });

    await auditor.runCycle(1_000);
    const skipped = await auditor.runCycle(2_000);
    assert.equal(skipped.skipped, "ledger_unchanged");
    assert.equal(skipped.report, null);
    assert.equal(skipped.cycle, 1, "a skipped cycle is not a cycle");
    assert.equal(sink.published.length, 1);
    assert.equal(sink.checkpoints.length, 1);

    readers.onchain.set(side(51, readers.onchain.records));
    readers.projected.set(side(51, readers.projected.records));
    const advanced = await auditor.runCycle(3_000);
    assert.equal(advanced.skipped, null);
    assert.equal(advanced.cycle, 2);
    assert.equal(advanced.report?.ledger.onchain, 51);
  });

  it("audits every cycle when ledger advance is not required", async () => {
    const sink = new MemorySink();
    const auditor = new ContinuousAuditor(cleanReaders(), sink, { intervalMs: 1_000 });
    await auditor.runCycle(1_000);
    assert.equal((await auditor.runCycle(2_000)).skipped, null);
    assert.equal(sink.published.length, 2);
  });

  it("rate-bounds the loop and stops at maxCycles", async () => {
    const sink = new MemorySink();
    const { clock, sleep, slept } = fakeClock(1_000_000, 5);
    const auditor = new ContinuousAuditor(cleanReaders(), sink, {
      intervalMs: 10_000,
      maxCycles: 3,
    });

    await auditor.run({ clock, sleep });
    assert.equal(sink.published.length, 3);
    assert.equal(sink.checkpoints.length, 3);
    assert.equal(slept.length, 2, "no sleep after the final cycle");
    for (const ms of slept) assert.ok(ms > 9_000 && ms < 10_000, `slept ${ms}`);
    assert.equal(auditor.isRunning, false);
  });

  it("does not sleep when a cycle already used the interval", async () => {
    const sink = new MemorySink();
    const readers = cleanReaders();
    // 100ms per clock reading against a 10ms interval: the budget is spent.
    const { clock, sleep, slept } = fakeClock(0, 100);
    const auditor = new ContinuousAuditor(readers, sink, { intervalMs: 10, maxCycles: 2 });
    await auditor.run({ clock, sleep });
    assert.deepEqual(slept, []);
    assert.equal(sink.published.length, 2);
  });

  it("resumes from the checkpoint instead of re-alerting on boot", async () => {
    const readers = cleanReaders();
    divergent(readers);
    const sink = new MemorySink();
    const first = new ContinuousAuditor(readers, sink, { intervalMs: 1_000 });
    await first.runCycle(1_000);
    assert.deepEqual(sink.published[0]?.alerts.map((a) => a.type), ["raised"]);

    // Simulate a process restart: fresh instance, same sink and readers.
    const restarted = new ContinuousAuditor(readers, sink, { intervalMs: 1_000 });
    const restored = await restarted.resume();
    assert.equal(restored.cycle, 1);
    assert.deepEqual(restored.previous_roots, sink.checkpoints[0]?.previous_roots);

    const outcome = await restarted.runCycle(2_000);
    assert.equal(outcome.cycle, 2);
    assert.deepEqual(outcome.alerts, [], "the incident was already reported");
    assert.equal(restarted.currentCheckpoint().audits_run, 2);
  });

  it("persists the configured flap window with the incident table", async () => {
    const readers = cleanReaders();
    divergent(readers);
    const sink = new MemorySink();
    const auditor = new ContinuousAuditor(readers, sink, { intervalMs: 1_000, flapWindowMs: 1_000 });
    await auditor.runCycle(1_000);
    assert.equal(sink.checkpoints[0]?.dedup.flap_window_ms, 1_000);
  });

  it("ignores a checkpoint written under a different policy", async () => {
    const sink = new MemorySink();
    const readers = cleanReaders();
    await new ContinuousAuditor(readers, sink, { intervalMs: 1_000 }).runCycle(1_000);
    const stored = sink.checkpoints[0];
    assert.ok(stored !== undefined);
    stored.policy_digest = "0".repeat(64);
    sink.checkpoints.push(stored);

    const restarted = new ContinuousAuditor(readers, sink, { intervalMs: 1_000 });
    const checkpoint = await restarted.resume();
    assert.equal(checkpoint.cycle, 0, "a foreign policy history is not comparable");
  });

  it("gives up after three consecutive failures and reports each one", async () => {
    const failures: unknown[] = [];
    const broken: AuditSink = {
      publish: async () => {
        throw new Error("sink unavailable");
      },
      loadCheckpoint: async () => null,
      saveCheckpoint: async () => {},
    };
    const { clock, sleep, slept } = fakeClock(0, 0);
    const auditor = new ContinuousAuditor(cleanReaders(), broken, {
      intervalMs: 100,
      onError: (error) => failures.push(error),
    });

    await assert.rejects(() => auditor.run({ clock, sleep }), /sink unavailable/);
    assert.equal(failures.length, 3);
    assert.equal(auditor.isRunning, false);
    assert.ok(slept.length >= 2);
  });

  it("honors stop() between cycles", async () => {
    const sink = new MemorySink();
    const { clock, sleep } = fakeClock(0, 0);
    let cycles = 0;
    let stoppable: ContinuousAuditor;
    const counted: AuditSink = {
      publish: async (envelope: PublicationEnvelope) => {
        cycles += 1;
        await sink.publish(envelope);
        if (cycles === 2) stoppable.stop();
      },
      loadCheckpoint: () => sink.loadCheckpoint(),
      saveCheckpoint: (checkpoint) => sink.saveCheckpoint(checkpoint),
    };

    stoppable = new ContinuousAuditor(cleanReaders(), counted, { intervalMs: 1 });
    await stoppable.run({ clock, sleep });
    assert.equal(cycles, 2);
    assert.equal(stoppable.isRunning, false);
    assert.equal(sink.published.length, 2);
  });

  it("refuses to run twice at once", async () => {
    const auditor = new ContinuousAuditor(cleanReaders(), new MemorySink(), { intervalMs: 5 });
    const running = auditor.run({ clock: () => 0, sleep: async () => {} });
    assert.equal(auditor.isRunning, true);
    await assert.rejects(() => auditor.run(), /already running/);
    auditor.stop();
    await running;
    assert.equal(auditor.isRunning, false);
  });
});
