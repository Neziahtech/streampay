import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canonicalRecordBytes, recordKey, type AuditRecord } from "./canonical.js";
import { record } from "./fixtures.js";
import {
  buildTree,
  emptyRoot,
  foldPath,
  hashNode,
  leafHashOf,
  treeDepth,
  verifyExclusionProof,
  verifyInclusionProof,
  verifyNeighborWitness,
  type MerkleLeaf,
} from "./merkle.js";

function key(id: number): string {
  return recordKey(record(id));
}

function leaves(ids: number[]): MerkleLeaf[] {
  return [...ids]
    .sort((a, b) => a - b)
    .map((id) => ({ key: key(id), bytes: canonicalRecordBytes(record(id)) }));
}

function leavesWithOverride(id: number, overrides: Partial<AuditRecord>): MerkleLeaf[] {
  return leaves([1, 2, 3, 4]).map((leaf) =>
    leaf.key === key(id) ? { key: leaf.key, bytes: canonicalRecordBytes(record(id, overrides)) } : leaf
  );
}

describe("merkle tree", () => {
  it("has a distinct empty root", () => {
    assert.equal(buildTree([]).root, emptyRoot());
    assert.notEqual(buildTree([]).root, buildTree(leaves([1])).root);
  });

  it("is insertion-order independent once sorted", () => {
    assert.equal(buildTree(leaves([1, 2, 3, 4, 5])).root, buildTree(leaves([5, 3, 1, 4, 2])).root);
  });

  it("rejects unsorted or duplicated leaves", () => {
    const bytes = (text: string): Buffer => Buffer.from(text, "utf8");
    assert.throws(
      () => buildTree([{ key: "b", bytes: bytes("1") }, { key: "a", bytes: bytes("2") }]),
      /strictly key-sorted/
    );
    assert.throws(
      () => buildTree([{ key: "a", bytes: bytes("1") }, { key: "a", bytes: bytes("2") }]),
      /strictly key-sorted/
    );
  });

  it("produces provable roots for every leaf size 1..64", () => {
    for (let n = 1; n <= 64; n++) {
      const ids = Array.from({ length: n }, (_, i) => i + 1);
      const tree = buildTree(leaves(ids));
      assert.equal(tree.leafCount, n);
      for (const id of ids) {
        const proof = tree.proveInclusion(key(id));
        assert.equal(proof.steps.length, treeDepth(n), `n=${n}`);
        assert.ok(verifyInclusionProof(proof, tree.root), `n=${n} id=${id}`);
      }
    }
  });

  it("changes the root when one leaf changes", () => {
    const base = buildTree(leaves([1, 2, 3, 4]));
    const tampered = buildTree(leavesWithOverride(3, { deposit: "9999" }));
    assert.notEqual(base.root, tampered.root);
    assert.ok(!verifyInclusionProof(base.proveInclusion(key(3)), tampered.root));
  });

  it("does not duplicate the odd tail leaf", () => {
    // A duplicated-last-leaf tree gives 3 leaves the same root as 2 leaves
    // (CVE-2012-2459). Promotion must not.
    const three = buildTree(leaves([1, 2, 3]));
    const two = buildTree(leaves([1, 2]));
    assert.notEqual(three.root, two.root);
    assert.ok(verifyInclusionProof(three.proveInclusion(key(3)), three.root));
    assert.ok(verifyInclusionProof(three.proveInclusion(key(1)), three.root));
  });

  it("records promoted steps explicitly", () => {
    const tree = buildTree(leaves([1, 2, 3]));
    const proof = tree.proveInclusion(key(3));
    assert.equal(proof.steps.filter((step) => step.promoted).length, 1);
    assert.ok(proof.steps.every((step, index) => step.level === index));
    const demoted = proof.steps.map((step) => (step.promoted ? { ...step, promoted: false } : step));
    assert.ok(!verifyInclusionProof({ ...proof, steps: demoted }, tree.root));
  });

  it("rejects a truncated or reshaped path", () => {
    const tree = buildTree(leaves([1, 2, 3, 4, 5, 6, 7, 8]));
    const proof = tree.proveInclusion(key(5));
    assert.ok(verifyInclusionProof(proof, tree.root));
    assert.ok(!verifyInclusionProof({ ...proof, steps: proof.steps.slice(0, -1) }, tree.root));
    assert.ok(!verifyInclusionProof({ ...proof, steps: proof.steps.slice(1) }, tree.root));
    assert.ok(!verifyInclusionProof({ ...proof, leafCount: 4 }, tree.root));
    assert.ok(
      !verifyInclusionProof(
        {
          ...proof,
          steps: proof.steps.map((step, i) => (i === 0 ? { ...step, position: step.position === "left" ? "right" : "left" } : step)),
        },
        tree.root
      )
    );
    assert.ok(!verifyInclusionProof({ ...proof, steps: [...proof.steps, ...proof.steps] }, tree.root));
  });

  it("binds a leaf hash to its index and key", () => {
    const tree = buildTree(leaves([1, 2, 3, 4]));
    const real = tree.proveInclusion(key(2));
    const other = tree.proveInclusion(key(1));
    assert.ok(!verifyInclusionProof({ ...real, leafHash: other.leafHash }, tree.root));
    assert.ok(!verifyInclusionProof({ ...real, key: key(9) }, tree.root));
    assert.ok(!verifyInclusionProof({ ...real, index: 0 }, tree.root));
    assert.ok(!verifyInclusionProof({ ...real, leafHash: leafHashOf(record(99)) }, tree.root));
    assert.ok(foldPath({ index: 1, key: key(2), hash: real.leafHash }, 4, real.steps) !== null);
  });

  it("proves exclusion between two neighbours", () => {
    const tree = buildTree(leaves([1, 2, 4, 8]));
    const proof = tree.proveExclusion(key(5));
    assert.equal(proof.lower?.key, key(4));
    assert.equal(proof.upper?.key, key(8));
    assert.ok(verifyExclusionProof(proof, tree.root));
  });

  it("proves exclusion below the first and above the last leaf", () => {
    const tree = buildTree(leaves([10, 20, 30]));
    const low = tree.proveExclusion(key(1));
    assert.equal(low.lower, null);
    assert.equal(low.upper?.index, 0);
    assert.ok(verifyExclusionProof(low, tree.root));

    const high = tree.proveExclusion(key(99));
    assert.equal(high.upper, null);
    assert.equal(high.lower?.index, 2);
    assert.ok(verifyExclusionProof(high, tree.root));
  });

  it("refuses an exclusion proof for a present key", () => {
    assert.throws(() => buildTree(leaves([1, 2, 3])).proveExclusion(key(2)), /is present/);
  });

  it("rejects tampered exclusion proofs", () => {
    const tree = buildTree(leaves([1, 2, 4, 8]));
    const proof = tree.proveExclusion(key(5));
    assert.ok(!verifyExclusionProof({ ...proof, key: key(9) }, tree.root));
    assert.ok(!verifyExclusionProof({ ...proof, key: key(3) }, tree.root));
    assert.ok(
      !verifyExclusionProof({ ...proof, lower: proof.upper, upper: proof.lower }, tree.root),
      "neighbours must stay adjacent and ascending around the key"
    );

    const otherTree = buildTree(leaves([1, 2, 4, 9]));
    assert.ok(!verifyExclusionProof(proof, otherTree.root));
    assert.ok(!verifyNeighborWitness(proof.lower!, tree.leafCount, otherTree.root));

    const nonAdjacent = { ...proof, upper: { ...proof.upper!, index: proof.upper!.index + 1 } };
    assert.ok(!verifyExclusionProof(nonAdjacent, tree.root));
  });

  it("accepts the empty-tree exclusion only against the empty root", () => {
    const proof = buildTree([]).proveExclusion(key(1));
    assert.ok(verifyExclusionProof(proof, emptyRoot()));
    assert.ok(!verifyExclusionProof(proof, buildTree(leaves([7])).root));
  });

  it("folds nodes with keys and positions bound in", () => {
    const tree = buildTree(leaves([1, 2]));
    assert.equal(
      tree.root,
      hashNode(
        { index: 0, key: key(1), hash: leafHashOf(record(1)) },
        { index: 1, key: key(2), hash: leafHashOf(record(2)) }
      )
    );
  });
});
