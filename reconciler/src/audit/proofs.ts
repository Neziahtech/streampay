//! Proof bundles: the artifact a third party needs to re-derive a
//! divergence verdict without trusting either reader.
//!
//! A bundle carries the policy itself (bound by `policy_digest`), the four
//! published roots, and one witness per divergent record. Verification
//! recomputes every leaf hash from the witness tuple, folds each Merkle
//! path, and re-runs the tolerance classification — so the verdict is
//! reproducible from the published artifact alone.

import {
  DEFAULT_POLICY,
  auditRecordFromTuple,
  auditRecordTuple,
  canonicalRecordBytes,
  computePolicyDigest,
  recordKey,
  statusString,
  toAuditRecord,
  type AuditPolicy,
  type AuditRecord,
} from "./canonical.js";
import { hashLeaf } from "./merkle.js";
import {
  emptyRoot,
  timingSafeEqualHex,
  verifyExclusionProof,
  verifyInclusionProof,
} from "./merkle.js";
import { classifyDiff, diffAuditRecords, quantizeRecord, type FieldDiff } from "./tolerance.js";
import type { AuditReport, DivergenceWitness } from "./auditor.js";

export const BUNDLE_VERSION = 1;

export interface ProofBundle {
  version: number;
  policy: AuditPolicy;
  policy_digest: string;
  ledger: AuditReport["ledger"];
  counts: AuditReport["counts"];
  roots: AuditReport["roots"];
  verdict: AuditReport["verdict"];
  divergence_keys: string[];
  rounding_keys: string[];
  witnesses: DivergenceWitness[];
  generated_at: string;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface CheckSummary {
  ok: boolean;
  verdict: AuditReport["verdict"];
  checks: CheckResult[];
}

export function buildProofBundle(
  report: AuditReport,
  policy: AuditPolicy = DEFAULT_POLICY
): ProofBundle {
  return {
    version: BUNDLE_VERSION,
    policy,
    policy_digest: report.policy_digest,
    ledger: report.ledger,
    counts: report.counts,
    roots: report.roots,
    verdict: report.verdict,
    divergence_keys: report.divergence_keys,
    rounding_keys: report.rounding_keys,
    witnesses: report.witnesses,
    generated_at: report.generated_at,
  };
}

/** Re-derives a leaf hash from the tuple embedded in a published witness. */
export function leafHashFromTuple(tuple: readonly string[]): string {
  return leafHashFromRecord(auditRecordFromTuple(tuple));
}

export function leafHashFromRecord(record: AuditRecord): string {
  return hashLeaf(recordKey(record), canonicalRecordBytes(record));
}

function recordFromSide(side: { record: string[] } | undefined): AuditRecord {
  if (side === undefined) throw new TypeError("witness is missing its record half");
  return auditRecordFromTuple(side.record);
}

/** Verifies one witness against the published roots. */
export function verifyWitness(witness: DivergenceWitness, bundle: ProofBundle): CheckResult[] {
  const checks: CheckResult[] = [];
  const add = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name: `${witness.kind}/${witness.stream_id}/${name}`, ok, detail });
  };

  add("policy_digest", timingSafeEqualHex(computePolicyDigest(bundle.policy), bundle.policy_digest));

  if (witness.kind === "missing_onchain" || witness.kind === "missing_projected") {
    const onchainSide = witness.kind === "missing_onchain";
    const presentSide = onchainSide ? witness.projected : witness.onchain;
    const absentProof = onchainSide ? witness.onchain_exclusion : witness.projected_exclusion;
    const presentRoot = onchainSide ? bundle.roots.projected_raw : bundle.roots.onchain_raw;
    const absentRoot = onchainSide ? bundle.roots.onchain_raw : bundle.roots.projected_raw;
    if (presentSide === undefined || absentProof === undefined) {
      add("shape", false, "a set divergence needs an inclusion half and an exclusion half");
      return checks;
    }
    const record = recordFromSide(presentSide);
    add("record_key", recordKey(record) === witness.key);
    add("leaf_hash", timingSafeEqualHex(leafHashFromTuple(presentSide.record), presentSide.proof.leafHash));
    add("inclusion_root", verifyInclusionProof(presentSide.proof, presentRoot), presentRoot);
    add("exclusion_root", verifyExclusionProof(absentProof, absentRoot), absentRoot);
    add(
      "absent_key_matches",
      absentProof.key === witness.key,
      `exclusion key ${absentProof.key}`
    );
    return checks;
  }

  if (witness.onchain === undefined || witness.projected === undefined) {
    add("shape", false, "a value witness needs both record halves");
    return checks;
  }

  const left = recordFromSide(witness.onchain);
  const right = recordFromSide(witness.projected);
  add("record_key", recordKey(left) === witness.key && recordKey(right) === witness.key);
  add("same_stream", left.streamId === right.streamId);

  if (witness.kind === "rounding") {
    // Both halves must be bound to their *raw* roots (so the published
    // counts are pinned too), and the policy must collapse them onto one
    // quantized leaf — that is what makes it rounding and not a fault.
    const leftQuantum = leafHashFromTuple(tupleOf(quantizeRecord(left, bundle.policy)));
    const rightQuantum = leafHashFromTuple(tupleOf(quantizeRecord(right, bundle.policy)));
    add("quantized_leaves_agree", timingSafeEqualHex(leftQuantum, rightQuantum));
    add(
      "onchain_inclusion_root",
      verifyInclusionProof(witness.onchain.proof, bundle.roots.onchain_raw, bundle.counts.onchain)
    );
    add(
      "projected_inclusion_root",
      verifyInclusionProof(witness.projected.proof, bundle.roots.projected_raw, bundle.counts.projected)
    );
  } else {
    add(
      "leaves_differ",
      !timingSafeEqualHex(leafHashFromTuple(witness.onchain.record), leafHashFromTuple(witness.projected.record))
    );
    add(
      "onchain_inclusion_root",
      verifyInclusionProof(witness.onchain.proof, bundle.roots.onchain_raw, bundle.counts.onchain)
    );
    add(
      "projected_inclusion_root",
      verifyInclusionProof(witness.projected.proof, bundle.roots.projected_raw, bundle.counts.projected)
    );
  }

  const derived = diffAuditRecords(left, right, bundle.policy);
  const derivedClass = classifyDiff(derived);
  add(
    "classification_matches_policy",
    (derivedClass === "rounding" && witness.kind === "rounding") ||
      (derivedClass === "divergent" && witness.kind === "value"),
    `derived=${derivedClass} published=${witness.kind}`
  );
  add("diffs_match", sameDiffs(derived, witness.diffs));
  return checks;
}

function tupleOf(record: AuditRecord): string[] {
  return auditRecordTuple(record);
}

function sameDiffs(derived: FieldDiff[], claimed: FieldDiff[]): boolean {
  if (derived.length !== claimed.length) return false;
  return derived.every((diff, index) => {
    const other = claimed[index];
    return (
      other !== undefined &&
      other.field === diff.field &&
      other.left === diff.left &&
      other.right === diff.right &&
      other.class === diff.class
    );
  });
}

/**
 * Verifies a whole bundle: structure, policy binding, every witness proof, and
 * that the recomputed verdict matches the published one.
 */
export function verifyBundle(bundle: ProofBundle): CheckSummary {
  const checks: CheckResult[] = [];
  const add = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, detail });
  };

  add("bundle_version", bundle.version === BUNDLE_VERSION, String(bundle.version));
  add("policy_digest", timingSafeEqualHex(computePolicyDigest(bundle.policy), bundle.policy_digest));

  const roots = bundle.roots;
  add(
    "empty_root_consistency",
    (bundle.counts.onchain === 0 ? roots.onchain_raw === emptyRoot() : roots.onchain_raw !== emptyRoot()) &&
      (bundle.counts.projected === 0 ? roots.projected_raw === emptyRoot() : roots.projected_raw !== emptyRoot())
  );

  for (const witness of bundle.witnesses) {
    checks.push(...verifyWitness(witness, bundle));
  }

  const divergent = bundle.witnesses
    .filter((witness) => witness.kind !== "rounding")
    .map((witness) => witness.key);
  const rounding = bundle.witnesses
    .filter((witness) => witness.kind === "rounding")
    .map((witness) => witness.key);
  add("divergence_keys", sameSet(divergent, bundle.divergence_keys));
  add("rounding_keys", sameSet(rounding, bundle.rounding_keys));

  const recomputed = recomputeVerdict(bundle);
  add("verdict", recomputed === bundle.verdict, `recomputed=${recomputed} published=${bundle.verdict}`);
  add("clean_has_no_witnesses", roots.onchain_raw !== roots.projected_raw || bundle.witnesses.length === 0);

  return { ok: checks.every((check) => check.ok), verdict: bundle.verdict, checks };
}

export function recomputeVerdict(bundle: ProofBundle): AuditReport["verdict"] {
  const rawEqual = bundle.roots.onchain_raw === bundle.roots.projected_raw;
  const quantizedEqual = bundle.roots.onchain_quantized === bundle.roots.projected_quantized;
  if (rawEqual) return "clean";
  const divergent = bundle.witnesses.some((witness) => witness.kind !== "rounding");
  if (quantizedEqual && !divergent && bundle.rounding_keys.length > 0) return "rounding_only";
  return "fault";
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedLeft = [...a].sort();
  const sortedRight = [...b].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
