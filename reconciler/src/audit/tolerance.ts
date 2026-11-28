//! Rounding tolerance for audited amounts.
//!
//! The contract accrues per ledger close and both readers can report the same
//! stream at slightly different points of that accrual, so sub-quantum
//! differences on an `i128` amount are arithmetic noise, not a fault. The
//! policy's `epsilon` is the tolerance grid: an amount is compared after
//! flooring onto that grid, and only amounts landing in the same cell are
//! noise. A difference in a non-amount field, a missing record, or amounts on
//! different cells is a fault.
//!
//! `epsilon` of `1` (the default) makes the grid the integer line itself, so
//! nothing is tolerated until an operator opts in.
//!
//! Classification is total: every field pair is either `equal` or `rounding`
//! or `divergent`, and `rounding` is only reachable when the tolerance policy
//! says so. A verifier re-runs `diffAuditRecords` from the published policy
//! and reaches the same verdict.

import {
  compareRecordKeys,
  recordKey,
  type AuditPolicy,
  type AuditRecord,
} from "./canonical.js";

export type FieldClass = "equal" | "rounding" | "divergent";

export interface FieldDiff {
  field: string;
  left: string;
  right: string;
  class: FieldClass;
  delta?: string;
}

const AMOUNT_FIELDS = ["deposit", "withdrawn"] as const;
const QUANTIZED_FIELDS = new Set<string>(AMOUNT_FIELDS);

export function isAmountField(field: string): boolean {
  return QUANTIZED_FIELDS.has(field);
}

function parseSignedDecimal(text: string): bigint {
  const negative = text.startsWith("-");
  const digits = negative ? text.slice(1) : text;
  if (!/^(0|[1-9][0-9]*)$/.test(digits)) {
    throw new TypeError(`'${text}' is not a decimal integer`);
  }
  const value = BigInt(digits);
  return negative ? -value : value;
}

/** floored integer division, matching the contract's accrual rounding. */
export function floorDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError("tolerance quantum must be non-zero");
  const q = numerator / denominator;
  if ((numerator % denominator !== 0n) && (numerator < 0n !== denominator < 0n)) {
    return q - 1n;
  }
  return q;
}

export function toleranceQuantum(policy: AuditPolicy): bigint {
  const quantum = parseSignedDecimal(policy.tolerance.epsilon);
  if (quantum <= 0n) throw new RangeError("tolerance epsilon must be a positive integer");
  return quantum;
}

/** Collapses amounts the policy treats as noise onto one grid point. */
export function quantizeRecord(record: AuditRecord, policy: AuditPolicy): AuditRecord {
  const quantum = toleranceQuantum(policy);
  return {
    ...record,
    deposit: floorDiv(parseSignedDecimal(record.deposit), quantum).toString(),
    withdrawn: floorDiv(parseSignedDecimal(record.withdrawn), quantum).toString(),
  };
}

function amountGap(left: string, right: string): bigint {
  const a = parseSignedDecimal(left);
  const b = parseSignedDecimal(right);
  const gap = a > b ? a - b : b - a;
  return gap;
}

/**
 * Field-level comparison under the policy. Amounts are `rounding` when they
 * fall on the same tolerance grid point (the same test that makes the
 * quantized roots agree, so a witness can never be called rounding while the
 * published quantized roots still differ); everything else that differs is
 * `divergent`.
 */
export function diffAuditRecords(
  left: AuditRecord,
  right: AuditRecord,
  policy: AuditPolicy
): FieldDiff[] {
  const quantum = toleranceQuantum(policy);
  const diffs: FieldDiff[] = [];
  for (const field of Object.keys(left) as Array<keyof AuditRecord>) {
    const name = field === "streamId" ? "stream_id" : field;
    const leftValue = String(left[field]);
    const rightValue = String(right[field]);
    if (leftValue === rightValue) continue;
    if (isAmountField(name)) {
      const gap = amountGap(leftValue, rightValue);
      const sameGrid =
        floorDiv(parseSignedDecimal(leftValue), quantum) ===
        floorDiv(parseSignedDecimal(rightValue), quantum);
      diffs.push({
        field: name,
        left: leftValue,
        right: rightValue,
        class: sameGrid ? "rounding" : "divergent",
        delta: gap.toString(),
      });
    } else {
      diffs.push({ field: name, left: leftValue, right: rightValue, class: "divergent" });
    }
  }
  return diffs;
}

export function classifyDiff(diffs: FieldDiff[]): "equal" | "rounding" | "divergent" {
  if (diffs.length === 0) return "equal";
  return diffs.some((diff) => diff.class === "divergent") ? "divergent" : "rounding";
}

/** Indexes records by canonical key, rejecting duplicate stream ids. */
export function indexByStreamId(
  records: Iterable<AuditRecord>
): Map<string, AuditRecord> {
  const byKey = new Map<string, AuditRecord>();
  for (const record of records) {
    const key = recordKey(record);
    if (byKey.has(key)) throw new RangeError(`duplicate stream id ${record.streamId}`);
    byKey.set(key, record);
  }
  return byKey;
}

export function sortedKeys(byKey: Map<string, AuditRecord>): string[] {
  return [...byKey.keys()].sort(compareRecordKeys);
}
