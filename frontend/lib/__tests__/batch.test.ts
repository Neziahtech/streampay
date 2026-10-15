import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeSelection,
  decodeSelection,
  createStreamSnapshot,
  detectStaleSelections,
  simulateBatchAction,
  executeBatch,
  type StreamSnapshot,
  type ItemSimulationFootprint,
} from "../batch";
import type { StreamView } from "../stellar";

test("URL Selection Encoding & Decoding handles all edge cases", () => {
  // Empty array
  assert.strictEqual(encodeSelection([]), "");
  assert.deepStrictEqual(decodeSelection(""), []);
  assert.deepStrictEqual(decodeSelection(null), []);
  assert.deepStrictEqual(decodeSelection(undefined), []);

  // Standard IDs
  assert.strictEqual(encodeSelection(["1", "2", "3"]), "1,2,3");
  assert.deepStrictEqual(decodeSelection("1,2,3"), ["1", "2", "3"]);

  // Deduplication & sorting
  assert.strictEqual(encodeSelection(["5", "2", "5", "1"]), "1,2,5");
  assert.deepStrictEqual(decodeSelection("5,2,5,1"), ["1", "2", "5"]);

  // Edge cases: whitespace, non-numeric, empty strings
  assert.strictEqual(encodeSelection([" 4 ", "abc", "", "-1", "7"]), "4,7");
  assert.deepStrictEqual(decodeSelection(" 4 , abc, , 7, -5, !! "), ["4", "7"]);
});

test("Stale-selection race detection invalidates modified or cancelled streams", () => {
  const baseStreams: StreamView[] = [
    {
      id: "1",
      sender: "GAAA",
      recipient: "GBBB",
      token: "T1",
      deposit: "1000",
      withdrawn: "0",
      startTime: 100,
      endTime: 200,
      cancelable: true,
      status: "Active",
    },
    {
      id: "2",
      sender: "GAAA",
      recipient: "GCCC",
      token: "T1",
      deposit: "500",
      withdrawn: "0",
      startTime: 100,
      endTime: 200,
      cancelable: true,
      status: "Active",
    },
    {
      id: "3",
      sender: "GAAA",
      recipient: "GDDD",
      token: "T1",
      deposit: "800",
      withdrawn: "0",
      startTime: 100,
      endTime: 200,
      cancelable: false,
      status: "Active",
    },
  ];

  // User selects stream 1, 2, and 3, taking snapshots
  const snapshots = new Map<string, StreamSnapshot>();
  for (const s of baseStreams) {
    snapshots.set(s.id, createStreamSnapshot(s));
  }

  // Scenario 1: No changes on-chain
  const check1 = detectStaleSelections(["1", "2", "3"], baseStreams, snapshots);
  assert.deepStrictEqual(check1.validIds, ["1", "2", "3"]);
  assert.strictEqual(check1.invalidated.length, 0);

  // Scenario 2: Live race — Stream #2 gets cancelled by sender mid-selection
  // Stream #3 gets withdrawn by recipient mid-selection
  const updatedStreams: StreamView[] = [
    baseStreams[0], // unchanged
    { ...baseStreams[1], status: "Cancelled" }, // cancelled on-chain!
    { ...baseStreams[2], withdrawn: "400" }, // withdrawn on-chain!
  ];

  const check2 = detectStaleSelections(
    ["1", "2", "3"],
    updatedStreams,
    snapshots
  );
  assert.deepStrictEqual(check2.validIds, ["1"]);
  assert.strictEqual(check2.invalidated.length, 2);

  const reasons = check2.invalidated.map((n) => n.reason);
  assert.ok(reasons.some((r) => r.includes("Stream #2 status changed")));
  assert.ok(reasons.some((r) => r.includes("Stream #3 withdrawn balance changed")));

  // Scenario 3: Stream removed / missing from current stream index
  const check3 = detectStaleSelections(["1", "99"], baseStreams, snapshots);
  assert.deepStrictEqual(check3.validIds, ["1"]);
  assert.strictEqual(check3.invalidated.length, 1);
  assert.ok(check3.invalidated[0].reason.includes("Stream #99 was not found"));
});

test("Sequential fallback execution handles pre-submit stale state and succeeds", async () => {
  const items: ItemSimulationFootprint[] = [
    {
      streamId: "101",
      action: "withdraw_max",
      claimableAmount: 100n,
      estimatedFeeStroops: "100000",
      cpuInstructions: 150000,
      ramBytes: 4096,
      status: "ready",
    },
    {
      streamId: "102",
      action: "withdraw_max",
      claimableAmount: 0n,
      estimatedFeeStroops: "100000",
      cpuInstructions: 120000,
      ramBytes: 4096,
      status: "ineligible",
      error: "No accrued funds",
    },
  ];

  const progressLog: string[] = [];
  const result = await executeBatch({
    caller: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    action: "withdraw_max",
    items,
    onProgress: (_comp, _tot, _curr, text) => {
      progressLog.push(text);
    },
  });

  // Verify execution mode is sequential fallback
  assert.strictEqual(result.mode, "sequential_fallback");
  assert.strictEqual(result.total, 1); // only 1 was ready
  assert.strictEqual(progressLog.length > 0, true);
});
