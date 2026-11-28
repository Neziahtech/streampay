//! Canonical audit-record serialization.
//!
//! Both sides of the audit — the on-chain read and the reconciler's own
//! projection — are merkleized through this module, so a root only diverges
//! when the state itself diverges. The field set and field order mirror
//! `StreamEntry` in `tools/streampay-state/src/model.rs` and `STATE_KEYS` in
//! `tools/streampay-cli/src/state.ts`; a third encoding would make the roots
//! incomparable.

import { createHash } from "node:crypto";

export const RECORD_DOMAIN = "STREAMPAY_AUDIT_RECORD_V1";
export const POLICY_DOMAIN = "STREAMPAY_AUDIT_POLICY_V1";

/** Statuses the contract can report for a stream. */
export type AuditStatus = "Active" | "Cancelled" | "Depleted";

const AUDIT_STATUSES: readonly string[] = ["Active", "Cancelled", "Depleted"];

/**
 * A stream state reduced to the audited fields. Amounts and timestamps are
 * carried as strings because the contract stores `i128` / `u64` values that
 * do not survive a JavaScript `number` round trip.
 */
export interface AuditRecord {
  streamId: string;
  sender: string;
  recipient: string;
  token: string;
  deposit: string;
  withdrawn: string;
  startTime: string;
  endTime: string;
  cancelable: boolean;
  status: AuditStatus;
}

/** Anything that still has to be quantized before it can be hashed. */
export interface RawAuditRecord {
  streamId: string | number | bigint;
  sender: string;
  recipient: string;
  token: string;
  deposit: string | number | bigint;
  withdrawn: string | number | bigint;
  startTime: string | number | bigint;
  endTime: string | number | bigint;
  cancelable: boolean;
  status: AuditStatus;
}

const DECIMAL_RE = /^-?(0|[1-9][0-9]*)$/;

/** Fixed field order of the canonical encoding — mirrors `StreamEntry`. */
export const CANONICAL_FIELDS = [
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
] as const;

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

function decimalString(value: string | number | bigint, field: string): string {
  let text: string;
  if (typeof value === "bigint") {
    text = value.toString();
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalizationError(`${field}: ${value} is not an exact integer`);
    }
    text = String(value);
  } else {
    text = value.trim();
    if (text.startsWith("+")) text = text.slice(1);
    // A canonical decimal has no leading zeros, except zero itself.
    const negative = text.startsWith("-");
    const digits = negative ? text.slice(1) : text;
    if (digits.length > 1 && digits.startsWith("0")) {
      text = (negative ? "-" : "") + digits.replace(/^0+/, "") || "0";
      if (text === "-") text = "0";
    }
  }
  if (!DECIMAL_RE.test(text)) {
    throw new CanonicalizationError(`${field}: '${text}' is not a canonical decimal`);
  }
  return text;
}

function addressString(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CanonicalizationError(`${field}: must be a non-empty string`);
  }
  return value;
}

export function statusString(value: string, field = "status"): AuditStatus {
  if (!AUDIT_STATUSES.includes(value)) {
    throw new CanonicalizationError(`${field}: '${value}' is not one of ${AUDIT_STATUSES.join("|")}`);
  }
  return value as AuditStatus;
}

/** Reduces a read result to the audited field set, quantizing numbers. */
export function toAuditRecord(raw: RawAuditRecord): AuditRecord {
  return {
    streamId: decimalString(raw.streamId, "streamId"),
    sender: addressString(raw.sender, "sender"),
    recipient: addressString(raw.recipient, "recipient"),
    token: addressString(raw.token, "token"),
    deposit: decimalString(raw.deposit, "deposit"),
    withdrawn: decimalString(raw.withdrawn, "withdrawn"),
    startTime: decimalString(raw.startTime, "start_time"),
    endTime: decimalString(raw.endTime, "end_time"),
    cancelable: raw.cancelable,
    status: statusString(raw.status),
  };
}

/**
 * Stable sort key: the decimal stream id zero-padded to a fixed width so
 * byte order equals numeric order, independent of how many digits an id has.
 */
export const KEY_WIDTH = 20;

export function recordKey(record: Pick<AuditRecord, "streamId">): string {
  const digits = decimalString(record.streamId, "streamId").replace(/^-/, "");
  if (digits.length > KEY_WIDTH) {
    throw new CanonicalizationError(`streamId ${record.streamId} exceeds ${KEY_WIDTH} digits`);
  }
  return digits.padStart(KEY_WIDTH, "0");
}

export function compareRecordKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The bytes that are hashed. Field order is fixed; nothing else is encoded. */
export function canonicalRecordBytes(record: AuditRecord): Buffer {
  const canonical = toAuditRecord(record);
  const parts = [
    RECORD_DOMAIN,
    canonical.streamId,
    canonical.sender,
    canonical.recipient,
    canonical.token,
    canonical.deposit,
    canonical.withdrawn,
    canonical.startTime,
    canonical.endTime,
    canonical.cancelable ? "true" : "false",
    canonical.status,
  ];
  // Length-prefix every field: a separator could otherwise appear inside an
  // address or status and let two different records hash identically.
  const encoded = parts.map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`);
  return Buffer.from(encoded.join(""), "utf8");
}

export function canonicalRecordJson(record: AuditRecord): string {
  return JSON.stringify(auditRecordTuple(toAuditRecord(record)));
}

/**
 * The audited field set as a fixed-order tuple. This is the form embedded in
 * published witnesses, so a verifier can re-derive the leaf hash from the
 * artifact without the full record set.
 */
export function auditRecordTuple(record: AuditRecord): string[] {
  const canonical = toAuditRecord(record);
  return [
    canonical.streamId,
    canonical.sender,
    canonical.recipient,
    canonical.token,
    canonical.deposit,
    canonical.withdrawn,
    canonical.startTime,
    canonical.endTime,
    canonical.cancelable ? "true" : "false",
    canonical.status,
  ];
}

/** Inverse of `auditRecordTuple`; every element is re-validated. */
export function auditRecordFromTuple(tuple: readonly string[]): AuditRecord {
  if (!Array.isArray(tuple) || tuple.length !== 10) {
    throw new CanonicalizationError("witness record must be a 10-field tuple");
  }
  return toAuditRecord({
    streamId: tuple[0],
    sender: tuple[1],
    recipient: tuple[2],
    token: tuple[3],
    deposit: tuple[4],
    withdrawn: tuple[5],
    startTime: tuple[6],
    endTime: tuple[7],
    cancelable: tuple[8] === "true",
    status: statusString(tuple[9]),
  });
}

export function sha256Hex(parts: Array<string | Buffer>): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(typeof part === "string" ? Buffer.from(part, "utf8") : part);
  }
  return hash.digest("hex");
}

export interface AuditPolicy {
  version: 1;
  record_domain: string;
  key_width: number;
  fields: readonly string[];
  tolerance: {
    epsilon: string;
    comparison: "floor_div";
  };
}

export const DEFAULT_POLICY: AuditPolicy = {
  version: 1,
  record_domain: RECORD_DOMAIN,
  key_width: KEY_WIDTH,
  fields: CANONICAL_FIELDS,
  tolerance: { epsilon: "1", comparison: "floor_div" },
};

/**
 * Digest a policy the same way a verifier will: keys sorted, array order kept.
 * Two audits only agree if their policy digests agree.
 */
export function computePolicyDigest(policy: AuditPolicy = DEFAULT_POLICY): string {
  return sha256Hex([POLICY_DOMAIN, canonicalJson(policy)]);
}

/** Recursively sorted-key JSON, so object insertion order cannot leak in. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
