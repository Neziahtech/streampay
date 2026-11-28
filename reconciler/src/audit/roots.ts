//! Recomputation of published roots from a published artifact.
//!
//! The point of this module is that nobody has to trust the reconciler's
//! roots: given the artifact (every audited record on both sides) anyone can
//! rebuild all four roots independently and check them against the report.
//! This is what the standalone verifier runs.

import {
  auditRecordFromTuple,
  canonicalRecordBytes,
  computePolicyDigest,
  recordKey,
  type AuditPolicy,
  type AuditRecord,
} from "./canonical.js";
import { buildTree, timingSafeEqualHex, type MerkleLeaf } from "./merkle.js";
import { quantizeRecord } from "./tolerance.js";
import type { AuditReport } from "./auditor.js";
import type { AuditArtifact } from "./publication.js";

export interface RecomputedRoots {
  onchain_raw: string;
  projected_raw: string;
  onchain_quantized: string;
  projected_quantized: string;
  counts: { onchain: number; projected: number; union: number };
}

export interface RootCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

function leavesFor(keys: string[], byKey: Map<string, AuditRecord>, transform: (r: AuditRecord) => AuditRecord): MerkleLeaf[] {
  return keys.map((key) => {
    const record = byKey.get(key);
    if (record === undefined) throw new RangeError(`missing record for key ${key}`);
    return { key, bytes: canonicalRecordBytes(transform(record)) };
  });
}

function sideRoots(records: AuditRecord[], policy: AuditPolicy): { raw: string; quantized: string } {
  const byKey = new Map<string, AuditRecord>();
  for (const record of records) {
    const key = recordKey(record);
    if (byKey.has(key)) throw new RangeError(`duplicate stream id ${record.streamId} in artifact`);
    byKey.set(key, record);
  }
  const keys = [...byKey.keys()].sort();
  const raw = buildTree(leavesFor(keys, byKey, (record) => record));
  const quantized = buildTree(leavesFor(keys, byKey, (record) => quantizeRecord(record, policy)));
  return { raw: raw.root, quantized: quantized.root };
}

/** Rebuilds every root from the artifact's record tuples. */
export function recomputeRoots(artifact: AuditArtifact): RecomputedRoots {
  const decode = (tuples: string[][]): AuditRecord[] => tuples.map((tuple) => auditRecordFromTuple(tuple));
  const onchain = sideRoots(decode(artifact.onchain), artifact.policy);
  const projected = sideRoots(decode(artifact.projected), artifact.policy);
  const union = new Set([
    ...artifact.onchain.map((tuple) => recordKey(auditRecordFromTuple(tuple))),
    ...artifact.projected.map((tuple) => recordKey(auditRecordFromTuple(tuple))),
  ]);
  return {
    onchain_raw: onchain.raw,
    projected_raw: projected.raw,
    onchain_quantized: onchain.quantized,
    projected_quantized: projected.quantized,
    counts: {
      onchain: artifact.onchain.length,
      projected: artifact.projected.length,
      union: union.size,
    },
  };
}

/**
 * Checks a published report against independently recomputed roots. Every
 * mismatch is reported rather than short-circuited, so an operator can see
 * the whole picture from one run.
 */
export function checkReportAgainstArtifact(
  report: AuditReport,
  artifact: AuditArtifact,
  policy: AuditPolicy = artifact.policy
): { ok: boolean; checks: RootCheck[]; recomputed: RecomputedRoots } {
  const checks: RootCheck[] = [];
  const add = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, detail });
  };

  const recomputed = recomputeRoots(artifact);

  add(
    "policy_digest",
    timingSafeEqualHex(computePolicyDigest(policy), report.policy_digest),
    `artifact=${computePolicyDigest(policy)} report=${report.policy_digest}`
  );
  add(
    "artifact_policy_matches_report",
    computePolicyDigest(artifact.policy) === computePolicyDigest(policy)
  );
  for (const field of [
    "onchain_raw",
    "projected_raw",
    "onchain_quantized",
    "projected_quantized",
  ] as const) {
    add(
      `root/${field}`,
      timingSafeEqualHex(report.roots[field], recomputed[field]),
      `published=${report.roots[field]} recomputed=${recomputed[field]}`
    );
  }
  add("counts/onchain", recomputed.counts.onchain === report.counts.onchain);
  add("counts/projected", recomputed.counts.projected === report.counts.projected);
  add("counts/union", recomputed.counts.union === report.counts.union);
  add(
    "ledger_binding",
    artifact.ledger.onchain === report.ledger.onchain &&
      artifact.ledger.projected === report.ledger.projected,
    `artifact=${artifact.ledger.onchain}/${artifact.ledger.projected} report=${report.ledger.onchain}/${report.ledger.projected}`
  );

  // The verdict is a function of the roots; recompute it rather than read it.
  const rawEqual = recomputed.onchain_raw === recomputed.projected_raw;
  const quantizedEqual = recomputed.onchain_quantized === recomputed.projected_quantized;
  const divergentKeys = report.witnesses
    .filter((witness) => witness.kind !== "rounding")
    .map((witness) => witness.key);
  const recomputedVerdict = rawEqual
    ? "clean"
    : quantizedEqual && divergentKeys.length === 0 && report.rounding_keys.length > 0
      ? "rounding_only"
      : "fault";
  add(
    "verdict",
    recomputedVerdict === report.verdict,
    `recomputed=${recomputedVerdict} published=${report.verdict}`
  );

  return { ok: checks.every((check) => check.ok), checks, recomputed };
}
