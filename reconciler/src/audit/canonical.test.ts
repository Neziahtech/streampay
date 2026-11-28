import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CANONICAL_FIELDS,
  DEFAULT_POLICY,
  RECORD_DOMAIN,
  auditRecordFromTuple,
  auditRecordTuple,
  canonicalRecordBytes,
  canonicalRecordJson,
  compareRecordKeys,
  computePolicyDigest,
  recordKey,
  statusString,
  toAuditRecord,
  type AuditRecord,
} from "./canonical.js";
import { record } from "./fixtures.js";
import { leafHashOf } from "./merkle.js";

describe("canonical audit records", () => {
  it("mirrors the StreamEntry field set of tools/streampay-state", () => {
    // Changing this list changes every published root, so it is a wire
    // format decision, not an implementation detail.
    assert.deepEqual(CANONICAL_FIELDS, [
      "stream_id",
      "sender",
      "recipient",
      "token",
      "deposit",
      "withdrawn",
      "start_time",
      "end_time",
      "cancelable",
      "status",
    ]);
  });

  it("is byte-identical for a fixed record", () => {
    const bytes = canonicalRecordBytes(record(7));
    assert.equal(
      bytes.toString("hex"),
      canonicalRecordBytes(record("0007")).toString("hex"),
      "leading zeros canonicalize away"
    );
    assert.ok(bytes.toString("utf8").startsWith(`${RECORD_DOMAIN.length}:`));
  });

  it("changes when any audited field changes", () => {
    const base = leafHashOf(record(1));
    const mutations: Array<Partial<AuditRecord>> = [
      { sender: "SAOTHER" },
      { recipient: "SBOTHER" },
      { token: "CT99" },
      { deposit: "1001" },
      { withdrawn: "251" },
      { startTime: "1001" },
      { endTime: "2001" },
      { cancelable: false },
      { status: "Cancelled" },
    ];
    for (const mutation of mutations) {
      assert.notEqual(leafHashOf(record(1, mutation)), base, JSON.stringify(mutation));
    }
  });

  it("does not depend on the stream id of a different record", () => {
    assert.notEqual(leafHashOf(record(1)), leafHashOf(record(2)));
  });

  it("rejects non-integer amounts and unknown statuses", () => {
    assert.throws(() => toAuditRecord({ ...record(1), deposit: "10.5" }), /canonical decimal/);
    assert.throws(() => toAuditRecord({ ...record(1), deposit: "1e3" }), /canonical decimal/);
    assert.throws(() => statusString("Paused"), /not one of/);
  });

  it("orders keys numerically, not lexicographically", () => {
    const keys = [10, 2, 100, 1].map((id) => recordKey(record(id))).sort(compareRecordKeys);
    assert.deepEqual(keys, ["00000000000000000001", "00000000000000000002", "00000000000000000010", "00000000000000000100"]);
    assert.throws(() => recordKey(record("9".repeat(21))), /exceeds 20 digits/);
  });

  it("round-trips through the witness tuple", () => {
    const original = record(42, { withdrawn: "0", status: "Depleted", cancelable: false });
    const tuple = auditRecordTuple(original);
    assert.equal(tuple.length, 10);
    const restored = auditRecordFromTuple(tuple);
    assert.deepEqual(restored, original);
    assert.equal(leafHashOf(restored), leafHashOf(original));
    assert.equal(canonicalRecordJson(restored), canonicalRecordJson(original));
  });

  it("refuses a witness tuple that is not canonical", () => {
    const tuple = auditRecordTuple(record(1));
    assert.throws(() => auditRecordFromTuple([...tuple.slice(0, 9), "Paused"]), /not one of/);
    assert.throws(() => auditRecordFromTuple(tuple.slice(0, 9) as string[]), /10-field tuple/);
    const injected: string[] = [...tuple];
    injected[4] = "1; DROP";
    assert.throws(() => auditRecordFromTuple(injected), /canonical decimal/);
  });

  it("normalizes numeric and bigint inputs into canonical strings", () => {
    const fromNumbers = toAuditRecord({
      streamId: 3,
      sender: "SA",
      recipient: "SB",
      token: "CT",
      deposit: 1_000n,
      withdrawn: 0,
      startTime: "001000",
      endTime: "+2000",
      cancelable: true,
      status: "Active",
    });
    assert.equal(fromNumbers.deposit, "1000");
    assert.equal(fromNumbers.startTime, "1000");
    assert.equal(fromNumbers.endTime, "2000");
    assert.equal(fromNumbers.withdrawn, "0");
  });

  it("keeps a stable policy digest that changes with the tolerance", () => {
    assert.equal(computePolicyDigest(DEFAULT_POLICY), computePolicyDigest(DEFAULT_POLICY));
    assert.notEqual(
      computePolicyDigest({ ...DEFAULT_POLICY, tolerance: { epsilon: "2", comparison: "floor_div" } }),
      computePolicyDigest(DEFAULT_POLICY)
    );
    assert.notEqual(
      computePolicyDigest({ ...DEFAULT_POLICY, key_width: 21 }),
      computePolicyDigest(DEFAULT_POLICY)
    );
  });

  it("is insensitive to object insertion order in the policy", () => {
    const reordered = JSON.parse(
      JSON.stringify({
        tolerance: DEFAULT_POLICY.tolerance,
        fields: DEFAULT_POLICY.fields,
        key_width: DEFAULT_POLICY.key_width,
        record_domain: DEFAULT_POLICY.record_domain,
        version: DEFAULT_POLICY.version,
      })
    ) as typeof DEFAULT_POLICY;
    assert.equal(computePolicyDigest(reordered), computePolicyDigest(DEFAULT_POLICY));
  });

  it("carries i128-magnitude amounts exactly", () => {
    const max = "340282366920938463463374607431768211455"; // i128::MAX
    assert.equal(leafHashOf(record(1, { deposit: max })), leafHashOf(record(1, { deposit: max })));
    assert.notEqual(leafHashOf(record(1, { deposit: max })), leafHashOf(record(1, { deposit: `${max}1` })));
    assert.notEqual(leafHashOf(record(1, { deposit: max })), leafHashOf(record(1, { deposit: "0" })));
  });
});
