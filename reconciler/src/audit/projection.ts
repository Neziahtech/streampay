//! Builds the reconciler's own projection of stream state — the side the
//! merkleized audit compares against the on-chain read.
//!
//! A projection is a cache, not an oracle: it is only trustworthy until it
//! disagrees with the contract, which is why the audit treats it as the
//! accused party and demands a proof before reporting a fault.

import { recordKey, toAuditRecord, type AuditRecord } from "../audit/canonical.js";
import type { StateSource } from "../audit/auditor.js";
import type { StateReader } from "../audit/publication.js";

/** The minimal stream shape a projection is built from. */
export interface ProjectableStream {
  id: string | number | bigint;
  sender: string;
  recipient: string;
  token: string;
  deposit: string | number | bigint;
  withdrawn: string | number | bigint;
  start_time: string | number | bigint;
  end_time: string | number | bigint;
  cancelable: boolean;
  status: string;
}

export function projectRecord(stream: ProjectableStream): AuditRecord {
  return toAuditRecord({
    streamId: String(stream.id),
    sender: stream.sender,
    recipient: stream.recipient,
    token: stream.token,
    deposit: String(stream.deposit),
    withdrawn: String(stream.withdrawn),
    startTime: String(stream.start_time),
    endTime: String(stream.end_time),
    cancelable: stream.cancelable,
    status: stream.status as AuditRecord["status"],
  });
}

/** Sorts records the way the audit tree indexes them. */
export function sortedRecords(records: Iterable<AuditRecord>): AuditRecord[] {
  return [...records].sort((a, b) => {
    const ka = recordKey(a);
    const kb = recordKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export function projectionSource(ledger: number, streams: Iterable<ProjectableStream>): StateSource {
  return {
    ledger,
    records: sortedRecords([...streams].map(projectRecord)),
  };
}

/** Adapts a callback into the auditor's `StateReader`. */
export function projectionReader(
  load: () => Promise<{ ledger: number; streams: ProjectableStream[] }>
): StateReader {
  return {
    read: async () => {
      const { ledger, streams } = await load();
      return projectionSource(ledger, streams);
    },
  };
}
