import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DivergenceDeduper, actionable } from "./dedup.js";

const KEY = "00000000000000000007";
const OTHER = "00000000000000000008";
const THIRD = "00000000000000000009";

describe("divergence alert de-duplication", () => {
  it("pages a divergence the first time it is seen", () => {
    const dedup = new DivergenceDeduper();
    const events = dedup.observe([KEY], 1_000);
    assert.deepEqual(events, [{ type: "raised", key: KEY, at: 1_000 }]);
    assert.deepEqual(actionable(events), events);
    assert.deepEqual(dedup.openIncidents(), [KEY]);
    assert.equal(dedup.stateOf(KEY), "faulted");
  });

  it("treats a persisting divergence as one incident", () => {
    const dedup = new DivergenceDeduper();
    dedup.observe([KEY], 1_000);
    for (const at of [2_000, 3_000, 4_000]) {
      const events = dedup.observe([KEY], at);
      assert.deepEqual(events, [{ type: "repeated", key: KEY, at }]);
      assert.deepEqual(actionable(events), [], `cycle at ${at}`);
    }
    assert.deepEqual(dedup.openIncidents(), [KEY]);
  });

  it("stays silent about a key that was never faulting", () => {
    const dedup = new DivergenceDeduper();
    assert.deepEqual(dedup.observe([], 1_000), []);
    assert.equal(dedup.stateOf(KEY), undefined);
  });

  it("reports a stable resolution once", () => {
    const dedup = new DivergenceDeduper({ flapWindowMs: 1_000 });
    dedup.observe([KEY], 0);
    dedup.observe([KEY], 2_000);
    assert.deepEqual(dedup.observe([], 3_000), [{ type: "resolved", key: KEY, at: 3_000 }]);
    assert.deepEqual(dedup.observe([], 9_000), []);
    assert.deepEqual(dedup.openIncidents(), []);
  });

  it("suppresses a fault/clear flicker inside the flap window", () => {
    const dedup = new DivergenceDeduper({ flapWindowMs: 10_000 });
    dedup.observe([KEY], 0);
    const events = dedup.observe([], 1_000);
    assert.deepEqual(events, [{ type: "suppressed", key: KEY, at: 1_000, reason: "flap" }]);
    assert.deepEqual(actionable(events), [], "a flicker must not page anyone");
    assert.equal(dedup.stateOf(KEY), "cleared");

    // It flickered back on just as fast: still not worth a page.
    assert.deepEqual(dedup.observe([KEY], 2_000), [
      { type: "suppressed", key: KEY, at: 2_000, reason: "flap" },
    ]);
    assert.equal(dedup.stateOf(KEY), "faulted");
  });

  it("reports a key that starts faulting again after holding clean", () => {
    const dedup = new DivergenceDeduper({ flapWindowMs: 5_000 });
    assert.deepEqual(dedup.observe([KEY], 0), [{ type: "raised", key: KEY, at: 0 }]);
    assert.deepEqual(dedup.observe([], 10_000), [{ type: "resolved", key: KEY, at: 10_000 }]);
    assert.deepEqual(dedup.observe([KEY], 20_000), [{ type: "raised", key: KEY, at: 20_000 }]);
  });

  it("resolves a flapped-clean incident once it has stayed clean", () => {
    const dedup = new DivergenceDeduper({ flapWindowMs: 10_000 });
    dedup.observe([KEY], 0);
    dedup.observe([], 1_000); // suppressed flicker to clean
    assert.deepEqual(dedup.observe([], 5_000), [{ type: "repeated", key: KEY, at: 5_000 }]);
    assert.deepEqual(dedup.observe([], 11_000), [{ type: "resolved", key: KEY, at: 11_000 }]);
    assert.deepEqual(dedup.observe([], 20_000), []);
  });

  it("re-pages a still-open incident on the renotify interval", () => {
    const dedup = new DivergenceDeduper({ renotifyAfterMs: 60_000 });
    dedup.observe([KEY], 0);
    assert.deepEqual(dedup.observe([KEY], 30_000), [{ type: "repeated", key: KEY, at: 30_000 }]);
    assert.deepEqual(dedup.observe([KEY], 60_000), [{ type: "raised", key: KEY, at: 60_000 }]);
    assert.deepEqual(dedup.observe([KEY], 90_000), [{ type: "repeated", key: KEY, at: 90_000 }]);
  });

  it("tracks keys independently", () => {
    const dedup = new DivergenceDeduper({ flapWindowMs: 1_000 });
    assert.deepEqual(dedup.observe([KEY, OTHER], 0), [
      { type: "raised", key: KEY, at: 0 },
      { type: "raised", key: OTHER, at: 0 },
    ]);
    assert.deepEqual(dedup.observe([KEY], 2_000), [
      { type: "repeated", key: KEY, at: 2_000 },
      { type: "resolved", key: OTHER, at: 2_000 },
    ]);
    assert.deepEqual(dedup.openIncidents(), [KEY]);
  });

  it("resumes an incident table across a restart", () => {
    const dedup = new DivergenceDeduper({ flapWindowMs: 10_000 });
    dedup.observe([KEY, OTHER], 0);

    const restored = DivergenceDeduper.restore(JSON.parse(JSON.stringify(dedup.serialize())));
    assert.deepEqual(restored.openIncidents().sort(), [KEY, OTHER].sort());

    // The whole point: a restarted auditor does not re-page what it already
    // told the operator about.
    const resumed = restored.observe([KEY, OTHER], 1_000);
    assert.deepEqual(resumed, [
      { type: "repeated", key: KEY, at: 1_000 },
      { type: "repeated", key: OTHER, at: 1_000 },
    ]);
    assert.deepEqual(actionable(resumed), []);

    assert.deepEqual(restored.observe([KEY, OTHER, THIRD], 2_000), [
      { type: "repeated", key: KEY, at: 2_000 },
      { type: "repeated", key: OTHER, at: 2_000 },
      { type: "raised", key: THIRD, at: 2_000 },
    ]);
  });

  it("applies the configured window to a restored table", () => {
    const dedup = new DivergenceDeduper({ flapWindowMs: 60_000 });
    dedup.observe([KEY], 0);
    const serialized = dedup.serialize();
    assert.equal(serialized.flap_window_ms, 60_000);

    // The operator tightened the window while the process was down.
    const restored = DivergenceDeduper.restore(serialized, { flapWindowMs: 1_000 });
    assert.deepEqual(restored.observe([], 5_000), [{ type: "resolved", key: KEY, at: 5_000 }]);
    assert.deepEqual(DivergenceDeduper.restore(serialized).observe([], 5_000), [
      { type: "suppressed", key: KEY, at: 5_000, reason: "flap" },
    ]);
  });

  it("carries the configured windows through serialization", () => {
    const dedup = new DivergenceDeduper({ flapWindowMs: 7_000, renotifyAfterMs: 3_000 });
    const serialized = dedup.serialize();
    assert.equal(serialized.flap_window_ms, 7_000);
    assert.equal(serialized.renotify_after_ms, 3_000);
    const restored = DivergenceDeduper.restore(serialized);
    assert.deepEqual(restored.serialize(), serialized);
  });
});
