//! Sorted Merkle tree over canonical audit records, with inclusion and
//! exclusion proofs.
//!
//! Three properties make these proofs usable as *public* evidence rather than
//! as a hint the verifier has to take on trust:
//!
//!   * leaves are ordered by the canonical record key, so absence is a
//!     statement about ordering between two named neighbours, which a
//!     verifier can re-check without holding the whole record set;
//!   * every node hash commits to its children's keys and to the position it
//!     sits at, so a leaf or subtree cannot be replayed elsewhere — a
//!     concatenation-only tree allows exactly that;
//!   * every proof step carries its level's node count, the sibling's index
//!     and key, and a `promoted` flag, so the verifier re-derives the shape
//!     of each level from `leafCount` alone and cannot be talked into a
//!     shorter path.
//!
//! Odd nodes are promoted, never duplicated, so the tree is not vulnerable to
//! the CVE-2012-2459 second-preimage on a duplicated last leaf. A promoted
//! node is recorded as such instead of being omitted from the path.

import { canonicalRecordBytes, recordKey, sha256Hex, type AuditRecord } from "./canonical.js";

export const LEAF_DOMAIN = "STREAMPAY_AUDIT_LEAF_V1";
export const NODE_DOMAIN = "STREAMPAY_AUDIT_NODE_V1";
export const EMPTY_DOMAIN = "STREAMPAY_AUDIT_EMPTY_V1";

const HEX64 = /^[0-9a-f]{64}$/;

/** A tree input: the ordering key and the canonical bytes that hash into it. */
export interface MerkleLeaf {
  key: string;
  bytes: Buffer;
}

export interface MerkleProofStep {
  /** 0 is the leaf level; steps are contiguous from 0 to depth-1. */
  level: number;
  /** Where the sibling sits relative to the node being folded. */
  position: "left" | "right";
  siblingIndex: number;
  siblingKey: string;
  /** Node count at this level. */
  levelCount: number;
  /** True when this level had an odd tail and the node was carried up. */
  promoted: boolean;
  /** Sibling digest, or the node's own digest when `promoted`. */
  hash: string;
}

export interface InclusionProof {
  kind: "inclusion";
  key: string;
  index: number;
  leafHash: string;
  leafCount: number;
  steps: MerkleProofStep[];
}

export interface NeighborWitness {
  key: string;
  index: number;
  leafHash: string;
  proof: MerkleProofStep[];
}

export interface ExclusionProof {
  kind: "exclusion";
  key: string;
  leafCount: number;
  lower: NeighborWitness | null;
  upper: NeighborWitness | null;
}

interface PositionedNode {
  index: number;
  key: string;
  hash: string;
}

export function emptyRoot(): string {
  return sha256Hex([EMPTY_DOMAIN]);
}

/** The one leaf-hash definition both the auditor and the verifier share. */
export function leafHashOf(record: AuditRecord): string {
  return hashLeaf(recordKey(record), canonicalRecordBytes(record));
}

export function hashLeaf(key: string, bytes: Buffer): string {
  return sha256Hex([LEAF_DOMAIN, key, bytes]);
}

/**
 * Internal node hash. The left child's index and both children's keys are
 * folded in, so a subtree cannot be moved to another position and a promoted
 * node can never collide with a paired one.
 */
export function hashNode(left: PositionedNode, right: PositionedNode): string {
  return sha256Hex([NODE_DOMAIN, String(left.index), left.key, left.hash, right.key, right.hash]);
}

export interface AuditTree {
  root: string;
  leafCount: number;
  keys: string[];
  indexOf(key: string): number;
  leafHashAt(index: number): string;
  proveInclusion(key: string): InclusionProof;
  proveExclusion(key: string): ExclusionProof;
}

export function buildTree(sortedLeaves: MerkleLeaf[]): AuditTree {
  const leafCount = sortedLeaves.length;
  let previous = "";
  for (const leaf of sortedLeaves) {
    if (leaf.key <= previous) {
      throw new RangeError(`leaves must be strictly key-sorted; '${leaf.key}' follows '${previous}'`);
    }
    previous = leaf.key;
  }

  const levels: PositionedNode[][] = [
    sortedLeaves.map((leaf, index) => ({
      index,
      key: leaf.key,
      hash: hashLeaf(leaf.key, leaf.bytes),
    })),
  ];

  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1];
    const next: PositionedNode[] = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        next.push({
          index: i >> 1,
          key: `${current[i].key}|${current[i + 1].key}`,
          hash: hashNode(current[i], current[i + 1]),
        });
      } else {
        // Promoted: the digest carries upward, but the node keeps a leaf
        // shaped key so it cannot be confused with a paired node.
        next.push({ index: i >> 1, key: `single(${current[i].key})`, hash: current[i].hash });
      }
    }
    levels.push(next);
  }

  const root = leafCount === 0 ? emptyRoot() : levels[levels.length - 1][0].hash;
  const keys = sortedLeaves.map((leaf) => leaf.key);
  const positions = new Map<string, number>();
  keys.forEach((key, index) => positions.set(key, index));

  const pathFor = (index: number): MerkleProofStep[] => {
    const steps: MerkleProofStep[] = [];
    let idx = index;
    for (let level = 0; level < levels.length - 1; level++) {
      const nodes = levels[level];
      const isRightChild = idx % 2 === 1;
      const siblingIdx = isRightChild ? idx - 1 : idx + 1;
      if (siblingIdx < nodes.length) {
        steps.push({
          level,
          position: isRightChild ? "left" : "right",
          siblingIndex: siblingIdx,
          siblingKey: nodes[siblingIdx].key,
          levelCount: nodes.length,
          promoted: false,
          hash: nodes[siblingIdx].hash,
        });
      } else {
        steps.push({
          level,
          position: "right",
          siblingIndex: idx,
          siblingKey: `single(${nodes[idx].key})`,
          levelCount: nodes.length,
          promoted: true,
          hash: nodes[idx].hash,
        });
      }
      idx = Math.floor(idx / 2);
    }
    return steps;
  };

  return {
    root,
    leafCount,
    keys,
    indexOf: (key) => positions.get(key) ?? -1,
    leafHashAt: (index) => {
      if (index < 0 || index >= leafCount) throw new RangeError(`leaf index ${index} out of bounds`);
      return levels[0][index].hash;
    },
    proveInclusion: (key) => {
      const index = positions.get(key);
      if (index === undefined) throw new RangeError(`key '${key}' is not in the tree`);
      return {
        kind: "inclusion",
        key,
        index,
        leafHash: levels[0][index].hash,
        leafCount,
        steps: pathFor(index),
      };
    },
    proveExclusion: (key) => {
      if (positions.has(key)) throw new RangeError(`key '${key}' is present; nothing to exclude`);
      let lowerIndex = -1;
      for (let i = 0; i < keys.length; i++) {
        if (keys[i] < key) lowerIndex = i;
        else break;
      }
      const upperIndex = lowerIndex + 1 < keys.length ? lowerIndex + 1 : -1;
      const witness = (index: number): NeighborWitness => ({
        key: keys[index],
        index,
        leafHash: levels[0][index].hash,
        proof: pathFor(index),
      });
      return {
        kind: "exclusion",
        key,
        leafCount,
        lower: lowerIndex >= 0 ? witness(lowerIndex) : null,
        upper: upperIndex >= 0 ? witness(upperIndex) : null,
      };
    },
  };
}

/**
 * Folds a path back to the root. Every level must be represented exactly once
 * and the level sizes must be the ones `leafCount` implies; anything else
 * returns null rather than a digest that could be made to match.
 */
export function foldPath(
  leaf: { index: number; key: string; hash: string },
  leafCount: number,
  steps: MerkleProofStep[]
): string | null {
  if (leafCount <= 0) return null;
  const depth = treeDepth(leafCount);
  if (steps.length !== depth) return null;

  let current = leaf;
  let count = leafCount;
  for (let level = 0; level < depth; level++) {
    const step = steps[level];
    if (step.level !== level) return null;
    if (step.levelCount !== count) return null;
    if (current.index < 0 || current.index >= count) return null;
    const idx = current.index;

    if (step.promoted) {
      // Only the odd tail node is promoted: it carries its digest upward under
      // a `single(...)` key, so it can never be re-parsed as a paired node.
      if (count % 2 === 0 || idx !== count - 1) return null;
      if (step.siblingIndex !== idx) return null;
      if (step.siblingKey !== `single(${current.key})`) return null;
      if (!step.hash || step.hash !== current.hash) return null;
      current = { index: idx >> 1, key: `single(${current.key})`, hash: current.hash };
    } else if (step.position === "right") {
      if (idx % 2 === 1 || step.siblingIndex !== idx + 1) return null;
      current = {
        index: idx >> 1,
        key: `${current.key}|${step.siblingKey}`,
        hash: hashNode(current, { index: step.siblingIndex, key: step.siblingKey, hash: step.hash }),
      };
    } else {
      if (idx % 2 === 0 || step.siblingIndex !== idx - 1) return null;
      current = {
        index: idx >> 1,
        key: `${step.siblingKey}|${current.key}`,
        hash: hashNode({ index: step.siblingIndex, key: step.siblingKey, hash: step.hash }, current),
      };
    }
    count = Math.ceil(count / 2);
  }
  return count === 1 ? current.hash : null;
}

export function treeDepth(leafCount: number): number {
  let count = leafCount;
  let depth = 0;
  while (count > 1) {
    count = Math.ceil(count / 2);
    depth += 1;
  }
  return depth;
}

export function verifyInclusionProof(
  proof: InclusionProof,
  expectedRoot: string,
  leafCount?: number
): boolean {
  if (leafCount !== undefined && leafCount !== proof.leafCount) return false;
  if (proof.leafCount === 0) return false;
  if (proof.index < 0 || proof.index >= proof.leafCount) return false;
  if (!HEX64.test(proof.leafHash)) return false;
  const folded = foldPath(
    { index: proof.index, key: proof.key, hash: proof.leafHash },
    proof.leafCount,
    proof.steps
  );
  return folded !== null && timingSafeEqualHex(folded, expectedRoot);
}

export function verifyNeighborWitness(
  witness: NeighborWitness,
  leafCount: number,
  expectedRoot: string
): boolean {
  if (witness.index < 0 || witness.index >= leafCount) return false;
  if (!HEX64.test(witness.leafHash)) return false;
  const folded = foldPath(
    { index: witness.index, key: witness.key, hash: witness.leafHash },
    leafCount,
    witness.proof
  );
  return folded !== null && timingSafeEqualHex(folded, expectedRoot);
}

/**
 * Verifies that `key` is absent from the tree whose root is `expectedRoot`:
 * both neighbours must bind to that root, be adjacent in the leaf order, and
 * straddle the absent key.
 */
export function verifyExclusionProof(proof: ExclusionProof, expectedRoot: string): boolean {
  if (proof.leafCount === 0) return timingSafeEqualHex(expectedRoot, emptyRoot());
  const check = (witness: NeighborWitness | null): boolean =>
    witness === null || verifyNeighborWitness(witness, proof.leafCount, expectedRoot);
  if (!check(proof.lower) || !check(proof.upper)) return false;

  if (proof.lower === null && proof.upper === null) return false;
  if (proof.lower === null) {
    // The absent key precedes everything, so the upper neighbour is index 0.
    return proof.upper !== null && proof.upper.index === 0 && proof.key < proof.upper.key;
  }
  if (proof.upper === null) {
    return proof.key > proof.lower.key && proof.lower.index === proof.leafCount - 1;
  }
  return (
    proof.upper.index === proof.lower.index + 1 &&
    proof.lower.key < proof.key &&
    proof.key < proof.upper.key
  );
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}
