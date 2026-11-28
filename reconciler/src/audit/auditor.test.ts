import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_POLICY, computePolicyDigest, recordKey, type AuditPolicy } from "./canonical.js";
import { record, side } from "./fixtures.js";
import { StateAuditor } from "./auditor.js";
import { emptyRoot, leafHashOf, verifyExclusionProof, verifyInclusionProof } from "./merkle.js";

function policy(epsilon: string): AuditPolicy {
  return { ...DEFAULT_POLICY, tolerance: { epsilon, comparison: "floor_div" } };
}

const IDS = [1, 2, 3, 4, 5];

function matching(): { onchain: ReturnType<typeof side>; projected: ReturnType<typeof side> } {
  const records = IDS.map((id) => record(id));
  return { onchain: side(100, records), projected: side(100, [...records].reverse()) };
}

describe("state auditor", () => {
  it("merkleizes both sides to one root when the state agrees", () => {
    const report = new StateAuditor().audit(matching());
    assert.equal(report.verdict, "clean");
    assert.equal(report.roots.onchain_raw, report.roots.projected_raw);
    assert.equal(report.roots.onchain_quantized, report.roots.projected_quantized);
    assert.deepEqual(report.witnesses, []);
    assert.equal(report.counts.onchain, 5);
    assert.equal(report.counts.union, 5);
    assert.equal(report.ledger.onchain, 100);
    assert.equal(report.policy_digest, computePolicyDigest(DEFAULT_POLICY));
    assert.equal(report.fingerprints.length, 5);
  });

  it("is independent of the order each reader returns records in", () => {
    const auditor = new StateAuditor();
    const a = auditor.audit({
      onchain: side(1, IDS.map((id) => record(id))),
      projected: side(1, IDS.map((id) => record(id))),
    });
    const b = auditor.audit({
      onchain: side(1, [4, 1, 5, 3, 2].map((id) => record(id))),
      projected: side(1, [2, 5, 1, 4, 3].map((id) => record(id))),
    });
    assert.equal(a.roots.onchain_raw, b.roots.onchain_raw);
  });

  it("pins an empty audit to the empty root", () => {
    const report = new StateAuditor().audit({ onchain: side(7, []), projected: side(7, []) });
    assert.equal(report.verdict, "clean");
    assert.equal(report.roots.onchain_raw, emptyRoot());
    assert.equal(report.counts.union, 0);
  });

  it("pinpoints the one record whose amount was tampered", () => {
    const { onchain, projected } = matching();
    const tampered = projected.records.map((r) => (r.streamId === "3" ? record(3, { deposit: "4444" }) : r));
    const report = new StateAuditor().audit({ onchain, projected: side(projected.ledger, tampered) });

    assert.equal(report.verdict, "fault");
    assert.equal(report.witnesses.length, 1);
    const [witness] = report.witnesses;
    assert.equal(witness?.kind, "value");
    assert.equal(witness?.stream_id, "3");
    assert.equal(witness?.key, recordKey(record(3)));
    assert.deepEqual(report.divergence_keys, [witness?.key]);
    assert.deepEqual(witness?.diffs.map((diff) => [diff.field, diff.class]), [["deposit", "divergent"]]);

    // The witness is evidence: each half proves membership in its own side.
    assert.equal(witness?.onchain?.record[0], "3");
    assert.ok(verifyInclusionProof(witness!.onchain!.proof, report.roots.onchain_raw, report.counts.onchain));
    assert.ok(verifyInclusionProof(witness!.projected!.proof, report.roots.projected_raw, report.counts.projected));
    assert.equal(witness?.projected?.record[4], "4444");
    assert.notEqual(leafHashOf(record(3)), leafHashOf(record(3, { deposit: "4444" })));
  });

  it("treats a non-amount change as a fault even with a wide tolerance", () => {
    const { onchain, projected } = matching();
    const tampered = projected.records.map((r) =>
      r.streamId === "2" ? record(2, { recipient: "SFRECIPIENT" }) : r
    );
    const report = new StateAuditor({ policy: policy("1000000") }).audit({
      onchain,
      projected: side(projected.ledger, tampered),
    });
    assert.equal(report.verdict, "fault");
    assert.deepEqual(report.witnesses.map((w) => w.kind), ["value"]);
    assert.deepEqual(report.witnesses[0]?.diffs.map((d) => [d.field, d.class]), [["recipient", "divergent"]]);
  });

  it("separates accrual noise from a real divergence", () => {
    const records = IDS.map((id) => record(id));
    // id 1 differs by 5 units on the 10-unit grid; id 4 crosses a grid line.
    const projected = records.map((r) =>
      r.streamId === "1"
        ? record(1, { withdrawn: "255" })
        : r.streamId === "4"
          ? record(4, { withdrawn: "260" })
          : r
    );
    const report = new StateAuditor({ policy: policy("10") }).audit({
      onchain: side(10, records),
      projected: side(10, projected),
    });

    assert.equal(report.verdict, "fault");
    assert.deepEqual(
      report.witnesses.map((w) => [w.stream_id, w.kind]),
      [
        ["1", "rounding"],
        ["4", "value"],
      ]
    );
    assert.deepEqual(report.rounding_keys, [recordKey(record(1))]);
    assert.deepEqual(report.divergence_keys, [recordKey(record(4))]);
    assert.notEqual(report.roots.onchain_raw, report.roots.projected_raw);
  });

  it("reports rounding_only when every difference is inside the tolerance", () => {
    const records = IDS.map((id) => record(id));
    const projected = records.map((r) =>
      r.streamId === "2" || r.streamId === "5" ? record(Number(r.streamId), { deposit: "1003" }) : r
    );
    const report = new StateAuditor({ policy: policy("10") }).audit({
      onchain: side(20, records),
      projected: side(20, projected),
    });

    assert.equal(report.verdict, "rounding_only");
    assert.notEqual(report.roots.onchain_raw, report.roots.projected_raw);
    assert.equal(report.roots.onchain_quantized, report.roots.projected_quantized);
    assert.deepEqual(report.divergence_keys, []);
    assert.equal(report.rounding_keys.length, 2);
    assert.deepEqual(report.witnesses.map((w) => w.kind), ["rounding", "rounding"]);
    for (const witness of report.witnesses) {
      assert.ok(verifyInclusionProof(witness.onchain!.proof, report.roots.onchain_raw));
      assert.ok(verifyInclusionProof(witness.projected!.proof, report.roots.projected_raw));
    }
  });

  it("does not need a tolerance to report a clean match as clean", () => {
    const report = new StateAuditor({ policy: policy("1000000") }).audit(matching());
    assert.equal(report.verdict, "clean");
    assert.deepEqual(report.rounding_keys, []);
  });

  it("proves a record is absent from one side with an exclusion witness", () => {
    const all = IDS.map((id) => record(id));
    const onchain = side(30, all);
    const projected = side(30, all.filter((r) => r.streamId !== "3"));
    const report = new StateAuditor().audit({ onchain, projected });

    assert.equal(report.verdict, "fault");
    const [witness] = report.witnesses;
    assert.equal(witness?.kind, "missing_projected");
    assert.equal(witness?.stream_id, "3");
    assert.ok(verifyInclusionProof(witness!.onchain!.proof, report.roots.onchain_raw));
    const exclusion = witness?.projected_exclusion;
    assert.ok(exclusion !== undefined && verifyExclusionProof(exclusion, report.roots.projected_raw));
    assert.equal(exclusion?.key, witness?.key);
    assert.equal(exclusion?.lower?.index, 1);
    assert.equal(exclusion?.upper?.index, 2);
    assert.equal(report.counts.union, 5);
  });

  it("labels a record missing on-chain as missing_onchain", () => {
    const all = IDS.map((id) => record(id));
    const report = new StateAuditor().audit({
      onchain: side(30, all.filter((r) => r.streamId !== "1")),
      projected: side(30, all),
    });
    const [witness] = report.witnesses;
    assert.equal(witness?.kind, "missing_onchain");
    assert.ok(witness?.onchain_exclusion !== undefined);
    assert.equal(witness?.onchain_exclusion?.upper?.index, 0, "the absent key precedes every leaf");
    assert.ok(verifyExclusionProof(witness!.onchain_exclusion!, report.roots.onchain_raw));
  });

  it("proves a record absent from an empty side", () => {
    const report = new StateAuditor().audit({
      onchain: side(1, IDS.map((id) => record(id))),
      projected: side(1, []),
    });
    assert.equal(report.verdict, "fault");
    assert.equal(report.witnesses.length, 5);
    assert.deepEqual(report.witnesses.map((w) => w.kind), Array(5).fill("missing_projected"));
    for (const witness of report.witnesses) {
      assert.ok(verifyExclusionProof(witness.projected_exclusion!, report.roots.projected_raw));
    }
  });

  it("rejects a side that reports a stream id twice", () => {
    const records = IDS.map((id) => record(id));
    assert.throws(
      () => new StateAuditor().audit({ onchain: side(1, records), projected: side(1, [...records, record(3)]) }),
      /duplicate stream id 3/
    );
  });

  it("publishes fingerprints for at most the configured number of records", () => {
    const report = new StateAuditor({ fingerprintLimit: 2 }).audit(matching());
    assert.equal(report.fingerprints.length, 2);
    assert.deepEqual(report.fingerprints.map((f) => f.stream_id), ["1", "2"]);
    assert.equal(report.fingerprints[0]?.onchain_raw_leaf, leafHashOf(record(1)));
    assert.notEqual(report.counts.union, 2, "the limit is on publication, not on the audit");
  });

  it("timestamps the report from the injected clock", () => {
    const stamp = "2026-11-20T00:00:00.000Z";
    const report = new StateAuditor().audit(matching(), () => stamp);
    assert.equal(report.generated_at, stamp);
    assert.equal(report.version, 1);
  });
});
