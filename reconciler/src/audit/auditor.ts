//! The continuous state auditor: merkleize both sides of the read each
//! cycle, publish the roots with the ledger sequence, and emit a proof
//! bundle that pinpoints every divergent record.

import {
  DEFAULT_POLICY,
  auditRecordTuple,
  canonicalRecordBytes,
  computePolicyDigest,
  recordKey,
  type AuditPolicy,
  type AuditRecord,
} from "./canonical.js";
import {
  buildTree,
  type AuditTree,
  type ExclusionProof,
  type InclusionProof,
  type MerkleLeaf,
} from "./merkle.js";
import {
  classifyDiff,
  diffAuditRecords,
  indexByStreamId,
  quantizeRecord,
  sortedKeys,
  type FieldDiff,
} from "./tolerance.js";

export const REPORT_VERSION = 1;

export type DivergenceKind = "rounding" | "value" | "missing_onchain" | "missing_projected";

export type Verdict = "clean" | "rounding_only" | "fault";

/** One side of the audit. `ledger` is published so a root is time-bound. */
export interface StateSource {
  ledger: number;
  records: AuditRecord[];
}

export interface SourceState {
  onchain: StateSource;
  projected: StateSource;
}

export interface WitnessSide {
  /** Canonical tuple; the verifier re-derives the leaf hash from these. */
  record: string[];
  proof: InclusionProof;
}

export interface DivergenceWitness {
  kind: DivergenceKind;
  stream_id: string;
  key: string;
  diffs: FieldDiff[];
  onchain?: WitnessSide;
  projected?: WitnessSide;
  onchain_exclusion?: ExclusionProof;
  projected_exclusion?: ExclusionProof;
}

export interface RecordFingerprint {
  stream_id: string;
  key: string;
  onchain_raw_leaf: string;
  projected_raw_leaf: string;
}

export interface AuditReport {
  version: number;
  policy_digest: string;
  ledger: { onchain: number; projected: number };
  counts: { onchain: number; projected: number; union: number };
  roots: {
    onchain_raw: string;
    projected_raw: string;
    onchain_quantized: string;
    projected_quantized: string;
  };
  verdict: Verdict;
  divergence_keys: string[];
  rounding_keys: string[];
  witnesses: DivergenceWitness[];
  fingerprints: RecordFingerprint[];
  generated_at: string;
}

export interface AuditorOptions {
  policy?: AuditPolicy;
  /** Cap on per-record fingerprints published with the report. */
  fingerprintLimit?: number;
}

interface SideTrees {
  raw: AuditTree;
  quantized: AuditTree;
  byKey: Map<string, AuditRecord>;
}

function leafFor(key: string, record: AuditRecord): MerkleLeaf {
  return { key, bytes: canonicalRecordBytes(record) };
}


function leavesFor(keys: string[], byKey: Map<string, AuditRecord>, transform: (r: AuditRecord) => AuditRecord): MerkleLeaf[] {
  return keys.map((key) => {
    const record = byKey.get(key);
    if (record === undefined) throw new RangeError(`missing record for key ${key}`);
    return leafFor(key, transform(record));
  });
}

function buildSideTrees(records: AuditRecord[], policy: AuditPolicy): SideTrees {
  const byKey = indexByStreamId(records);
  const present = sortedKeys(byKey);
  return {
    raw: buildTree(leavesFor(present, byKey, (record) => record)),
    quantized: buildTree(leavesFor(present, byKey, (record) => quantizeRecord(record, policy))),
    byKey,
  };
}

function witnessSide(side: SideTrees, key: string): WitnessSide {
  const record = side.byKey.get(key);
  if (record === undefined) throw new RangeError(`key '${key}' is not in this side`);
  return { record: auditRecordTuple(record), proof: side.raw.proveInclusion(key) };
}

export class StateAuditor {
  private readonly policy: AuditPolicy;
  private readonly policyDigest: string;
  private readonly fingerprintLimit: number;

  constructor(options: AuditorOptions = {}) {
    this.policy = options.policy ?? DEFAULT_POLICY;
    this.policyDigest = computePolicyDigest(this.policy);
    this.fingerprintLimit = options.fingerprintLimit ?? 512;
  }

  get auditPolicy(): AuditPolicy {
    return this.policy;
  }

  get digest(): string {
    return this.policyDigest;
  }

  audit(state: SourceState, now: () => string = () => new Date().toISOString()): AuditReport {
    const onchain = buildSideTrees(state.onchain.records, this.policy);
    const projected = buildSideTrees(state.projected.records, this.policy);

    const unionKeys = [
      ...new Set([...onchain.byKey.keys(), ...projected.byKey.keys()]),
    ].sort();

    const roots = {
      onchain_raw: onchain.raw.root,
      projected_raw: projected.raw.root,
      onchain_quantized: onchain.quantized.root,
      projected_quantized: projected.quantized.root,
    };

    const witnesses: DivergenceWitness[] = [];
    const divergenceKeys: string[] = [];
    const roundingKeys: string[] = [];

    for (const key of unionKeys) {
      const a = onchain.byKey.get(key);
      const b = projected.byKey.get(key);

      if (a !== undefined && b !== undefined) {
        const diffs = diffAuditRecords(a, b, this.policy);
        const classification = classifyDiff(diffs);
        if (classification === "equal") continue;
        if (classification === "rounding") {
          roundingKeys.push(key);
          witnesses.push({
            kind: "rounding",
            stream_id: a.streamId,
            key,
            diffs,
            onchain: witnessSide(onchain, key),
            projected: witnessSide(projected, key),
          });
        } else {
          divergenceKeys.push(key);
          witnesses.push({
            kind: "value",
            stream_id: a.streamId,
            key,
            diffs,
            onchain: witnessSide(onchain, key),
            projected: witnessSide(projected, key),
          });
        }
      } else if (a !== undefined) {
        divergenceKeys.push(key);
        witnesses.push({
          kind: "missing_projected",
          stream_id: a.streamId,
          key,
          diffs: [],
          onchain: witnessSide(onchain, key),
          projected_exclusion: projected.raw.proveExclusion(key),
        });
      } else if (b !== undefined) {
        divergenceKeys.push(key);
        witnesses.push({
          kind: "missing_onchain",
          stream_id: b.streamId,
          key,
          diffs: [],
          projected: witnessSide(projected, key),
          onchain_exclusion: onchain.raw.proveExclusion(key),
        });
      }
    }

    const rawEqual = roots.onchain_raw === roots.projected_raw;
    const quantizedEqual = roots.onchain_quantized === roots.projected_quantized;
    const verdict: Verdict = rawEqual
      ? "clean"
      : quantizedEqual && divergenceKeys.length === 0 && roundingKeys.length > 0
        ? "rounding_only"
        : "fault";

    return {
      version: REPORT_VERSION,
      policy_digest: this.policyDigest,
      ledger: { onchain: state.onchain.ledger, projected: state.projected.ledger },
      counts: {
        onchain: state.onchain.records.length,
        projected: state.projected.records.length,
        union: unionKeys.length,
      },
      roots,
      verdict,
      divergence_keys: divergenceKeys,
      rounding_keys: roundingKeys,
      witnesses,
      fingerprints: this.fingerprints(unionKeys, onchain, projected),
      generated_at: now(),
    };
  }

  private fingerprints(unionKeys: string[], onchain: SideTrees, projected: SideTrees): RecordFingerprint[] {
    const published: RecordFingerprint[] = [];
    for (const key of unionKeys.slice(0, this.fingerprintLimit)) {
      const index = onchain.raw.indexOf(key);
      const other = projected.raw.indexOf(key);
      const source = onchain.byKey.get(key) ?? projected.byKey.get(key);
      if (source === undefined) continue;
      published.push({
        stream_id: source.streamId,
        key,
        onchain_raw_leaf: index >= 0 ? onchain.raw.leafHashAt(index) : "",
        projected_raw_leaf: other >= 0 ? projected.raw.leafHashAt(other) : "",
      });
    }
    return published;
  }

  keyFor(record: AuditRecord): string {
    return recordKey(record);
  }
}
