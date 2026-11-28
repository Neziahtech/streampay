import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_POLICY, recordKey, type AuditPolicy, type AuditRecord } from "./canonical.js";
import { record } from "./fixtures.js";
import {
  classifyDiff,
  diffAuditRecords,
  floorDiv,
  indexByStreamId,
  isAmountField,
  quantizeRecord,
  sortedKeys,
  toleranceQuantum,
} from "./tolerance.js";

function policy(epsilon: string): AuditPolicy {
  return { ...DEFAULT_POLICY, tolerance: { epsilon, comparison: "floor_div" } };
}

describe("tolerance", () => {
  it("floors toward negative infinity like the contract's accrual", () => {
    assert.equal(floorDiv(7n, 2n), 3n);
    assert.equal(floorDiv(-7n, 2n), -4n);
    assert.equal(floorDiv(6n, 2n), 3n);
    assert.equal(floorDiv(-1n, 10n), -1n);
    assert.throws(() => floorDiv(1n, 0n), /non-zero/);
  });

  it("requires a positive integer epsilon", () => {
    assert.equal(toleranceQuantum(policy("10")), 10n);
    assert.throws(() => toleranceQuantum(policy("0")), /positive integer/);
    assert.throws(() => toleranceQuantum(policy("-5")), /positive integer/);
    assert.throws(() => toleranceQuantum(policy("1.5")), /decimal integer/);
  });

  it("collapses amounts onto the tolerance grid", () => {
    const grid = policy("100");
    assert.equal(quantizeRecord(record(1, { deposit: "1050" }), grid).deposit, "10");
    assert.equal(quantizeRecord(record(1, { deposit: "1150" }), grid).deposit, "11");
    assert.equal(quantizeRecord(record(1, { deposit: "1150" }), DEFAULT_POLICY).deposit, "1150");
  });

  it("leaves non-amount fields untouched", () => {
    const quantized = quantizeRecord(record(1, { status: "Cancelled", cancelable: false }), policy("100"));
    assert.equal(quantized.status, "Cancelled");
    assert.equal(quantized.cancelable, false);
    assert.equal(quantized.streamId, "1");
  });

  it("calls a sub-quantum amount difference rounding", () => {
    const diffs = diffAuditRecords(
      record(1, { withdrawn: "1000" }),
      record(1, { withdrawn: "1049" }),
      policy("50")
    );
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].field, "withdrawn");
    assert.equal(diffs[0].class, "rounding");
    assert.equal(diffs[0].delta, "49");
    assert.equal(classifyDiff(diffs), "rounding");
  });

  it("calls a cross-grid amount difference divergent", () => {
    const diffs = diffAuditRecords(
      record(1, { withdrawn: "1049" }),
      record(1, { withdrawn: "1050" }),
      policy("50")
    );
    assert.equal(diffs[0].class, "divergent");
    assert.equal(classifyDiff(diffs), "divergent");
  });

  it("tolerates nothing under the default policy", () => {
    const diffs = diffAuditRecords(record(1, { deposit: "1000" }), record(1, { deposit: "1001" }), DEFAULT_POLICY);
    assert.equal(diffs[0].class, "divergent");
  });

  it("never treats a non-amount field as rounding", () => {
    const values: Record<string, string> = {
      sender: "OTHER",
      recipient: "OTHER",
      token: "OTHER",
      startTime: "9999",
      endTime: "9999",
      status: "Cancelled",
    };
    for (const field of Object.keys(values) as Array<keyof AuditRecord>) {
      const overrides: Partial<AuditRecord> = { [field]: values[field] };
      const diffs = diffAuditRecords(record(1), record(1, overrides), policy("1000000"));
      assert.equal(diffs.length, 1, field);
      assert.equal(diffs[0].class, "divergent", field);
    }
    const flipped = diffAuditRecords(record(1, { cancelable: true }), record(1, { cancelable: false }), policy("1000000"));
    assert.deepEqual(flipped.map((diff) => [diff.field, diff.class]), [["cancelable", "divergent"]]);
  });

  it("reports every field that differs and none that do not", () => {
    assert.deepEqual(diffAuditRecords(record(5), record(5), DEFAULT_POLICY), []);
    assert.equal(classifyDiff([]), "equal");
    const both = diffAuditRecords(
      record(5, { deposit: "1000", status: "Active" }),
      record(5, { deposit: "1001", status: "Cancelled" }),
      DEFAULT_POLICY
    );
    assert.deepEqual(both.map((diff) => diff.field), ["deposit", "status"]);
  });

  it("only classifies deposit and withdrawn as amounts", () => {
    assert.ok(isAmountField("deposit"));
    assert.ok(isAmountField("withdrawn"));
    for (const field of ["stream_id", "start_time", "end_time", "status", "cancelable", "token"]) {
      assert.ok(!isAmountField(field), field);
    }
  });

  it("rejects a duplicate stream id and non-decimal amounts", () => {
    assert.throws(
      () => indexByStreamId([record(7), record(7, { deposit: "1" })]),
      /duplicate stream id 7/
    );
    // The padded key normalizes the id, so a zero-padded duplicate is caught too.
    assert.equal(recordKey(record(7)), recordKey(record("0007")));
    assert.throws(() => indexByStreamId([record(7), record("0007")]), /duplicate/);
    assert.throws(() => record(1, { deposit: "1e3" }), /canonical decimal/);
    // A record that bypassed construction validation still cannot be diffed.
    const malformed: AuditRecord = { ...record(1), deposit: "1e3" };
    assert.throws(
      () => diffAuditRecords(record(1, { deposit: "10" }), malformed, policy("10")),
      /decimal integer/
    );
  });

  it("orders keys numerically rather than lexicographically", () => {
    const byKey = indexByStreamId([record(10), record(2), record(100)]);
    assert.deepEqual(sortedKeys(byKey), [recordKey(record(2)), recordKey(record(10)), recordKey(record(100))]);
  });
});
