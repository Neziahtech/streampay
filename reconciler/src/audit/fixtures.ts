//! Shared fixtures for the merkleized audit tests.

import { toAuditRecord, type AuditRecord } from "./canonical.js";
import type { AuditArtifact, Checkpoint, PublicationEnvelope } from "./publication.js";
import type { AuditReport } from "./auditor.js";
import type { StateSource } from "./auditor.js";
import type { AlertEvent } from "./dedup.js";
import type { StateReader } from "./publication.js";

export function record(streamId: string | number, overrides: Partial<AuditRecord> = {}): AuditRecord {
  return toAuditRecord({
    streamId: String(streamId),
    sender: `SA${String(streamId).padStart(10, "0")}`,
    recipient: `SB${String(streamId).padStart(10, "0")}`,
    token: "CT77",
    deposit: "1000",
    withdrawn: "250",
    startTime: "1000",
    endTime: "2000",
    cancelable: true,
    status: "Active",
    ...overrides,
  });
}

export function recordsFor(ids: number[], overrides: Partial<AuditRecord> = {}): AuditRecord[] {
  return ids.map((id) => record(id, overrides));
}

export function side(ledger: number, records: AuditRecord[]): StateSource {
  return { ledger, records };
}

export function readerFor(source: StateSource): StateReader {
  return { read: async () => source };
}

export function mutableReader(initial: StateSource): StateReader & {
  set(next: StateSource): void;
  readonly records: AuditRecord[];
} {
  let current = initial;
  return {
    read: async () => current,
    set: (next) => {
      current = next;
    },
    get records(): AuditRecord[] {
      return current.records;
    },
  };
}

/** In-memory audit sink, so a test can assert on what was published. */
export class MemorySink {
  published: PublicationEnvelope[] = [];
  checkpoints: Checkpoint[] = [];
  failNextPublish = false;

  async publish(envelope: PublicationEnvelope): Promise<void> {
    if (this.failNextPublish) {
      this.failNextPublish = false;
      throw new Error("sink unavailable");
    }
    this.published.push(envelope);
  }

  async loadCheckpoint(): Promise<Checkpoint | null> {
    return this.checkpoints.length > 0 ? this.checkpoints[this.checkpoints.length - 1] : null;
  }

  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    this.checkpoints.push(structuredClone(checkpoint));
  }

  get lastReport(): AuditReport | undefined {
    return this.published[this.published.length - 1]?.report;
  }

  get allAlerts(): AlertEvent[] {
    return this.published.flatMap((envelope) => envelope.alerts);
  }

  artifact(): AuditArtifact | undefined {
    return this.published[this.published.length - 1]?.artifact;
  }
}

/** Deterministic clock + instant sleep for the continuous loop tests. */
export function fakeClock(startMs = 1_000_000, stepMs = 5): {
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  slept: number[];
} {
  let now = startMs;
  const slept: number[] = [];
  return {
    clock: () => {
      now += stepMs;
      return now;
    },
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
    slept,
  };
}
