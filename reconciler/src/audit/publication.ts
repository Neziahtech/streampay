//! Root publication, cycle checkpointing and the rate-bounded continuous
//! audit loop.
//!
//! Each cycle publishes the four roots with the ledger sequence they describe,
//! and — when they diverge — the proof bundle that pinpoints why. Continuous
//! mode is checkpointed so a restart resumes where it stopped, and rate-bounded
//! so an audit can be run against a live RPC without outrunning it.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";

import { DEFAULT_POLICY, recordKey, type AuditPolicy } from "./canonical.js";
import type { AuditReport, SourceState, StateSource } from "./auditor.js";
import { StateAuditor } from "./auditor.js";
import { buildProofBundle, type ProofBundle } from "./proofs.js";
import { DivergenceDeduper, actionable, type AlertEvent } from "./dedup.js";

export const CHECKPOINT_VERSION = 1;

/** The audited record set published alongside a report for full recomputation. */
export interface AuditArtifact {
  version: number;
  policy: AuditPolicy;
  ledger: AuditReport["ledger"];
  onchain: string[][];
  projected: string[][];
}

export interface PublicationEnvelope {
  report: AuditReport;
  bundle?: ProofBundle;
  /** Present when the record set is small enough to publish in full. */
  artifact?: AuditArtifact;
  alerts: AlertEvent[];
  cycle: number;
}

export interface Checkpoint {
  version: number;
  cycle: number;
  last_audited_ledger: number;
  previous_roots: {
    onchain_raw: string;
    projected_raw: string;
    onchain_quantized: string;
    projected_quantized: string;
  };
  last_fault_at_ms: number | null;
  last_published_at_ms: number | null;
  audits_run: number;
  policy_digest: string;
  dedup: ReturnType<DivergenceDeduper["serialize"]>;
}

export interface AuditSink {
  publish(envelope: PublicationEnvelope): Promise<void>;
  loadCheckpoint(): Promise<Checkpoint | null>;
  saveCheckpoint(checkpoint: Checkpoint): Promise<void>;
}

/** Reads one side of the state at a ledger boundary. */
export interface StateReader {
  read(): Promise<StateSource>;
}

export interface ContinuousOptions {
  /** Minimum spacing between cycles; the loop sleeps the remainder. */
  intervalMs: number;
  /** Wall-clock budget per cycle before it is reported as overrun. */
  cycleBudgetMs?: number;
  /** Skip the read when no ledger has closed since the last audit. */
  requireLedgerAdvance?: boolean;
  /** Alert flap window handed to the de-duplicator; its default if omitted. */
  flapWindowMs?: number;
  /** Publish every record so a verifier can recompute the roots itself. */
  artifactRecordLimit?: number;
  policy?: AuditPolicy;
  maxCycles?: number;
  onError?: (error: unknown) => void;
}

export interface ContinuousDeps {
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class FileAuditSink implements AuditSink {
  constructor(
    private readonly directory: string,
    private readonly base = "audit"
  ) {}

  private path(name: string): string {
    return join(this.directory, `${this.base}-${name}`);
  }

  async publish(envelope: PublicationEnvelope): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeJsonAtomic(this.path("report.json"), envelope.report);
    if (envelope.bundle !== undefined) {
      await writeJsonAtomic(this.path("bundle.json"), envelope.bundle);
    }
    if (envelope.artifact !== undefined) {
      await writeJsonAtomic(this.path("artifact.json"), envelope.artifact);
    }
  }

  async loadCheckpoint(): Promise<Checkpoint | null> {
    try {
      return JSON.parse(await readFile(this.path("checkpoint.json"), "utf8")) as Checkpoint;
    } catch {
      return null;
    }
  }

  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeJsonAtomic(this.path("checkpoint.json"), checkpoint);
  }
}

/** Writes through a temp file so a crash mid-publish cannot corrupt it. */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

export interface CycleOutcome {
  cycle: number;
  report: AuditReport | null;
  alerts: AlertEvent[];
  skipped: "ledger_unchanged" | null;
  durationMs: number;
}

export class ContinuousAuditor {
  private readonly auditor: StateAuditor;
  private readonly sink: AuditSink;
  private dedup: DivergenceDeduper;
  private running = false;
  private stopRequested = false;
  private checkpoint: Checkpoint;

  constructor(
    private readonly sources: { onchain: StateReader; projected: StateReader },
    sink: AuditSink,
    private readonly options: ContinuousOptions,
    deps: ContinuousDeps = {}
  ) {
    const policy = options.policy ?? DEFAULT_POLICY;
    this.auditor = new StateAuditor({ policy });
    this.sink = sink;
    this.dedup = new DivergenceDeduper(
      this.options.flapWindowMs === undefined ? {} : { flapWindowMs: this.options.flapWindowMs }
    );
    this.checkpoint = emptyCheckpoint(this.auditor.digest, this.dedup);
  }

  private clock: () => number = () => Date.now();

  /** Restores the checkpoint so a restart resumes the incident table. */
  async resume(): Promise<Checkpoint> {
    const stored = await this.sink.loadCheckpoint();
    if (stored === null) return this.checkpoint;
    if (stored.policy_digest !== this.auditor.digest) {
      // A different policy means the roots are not comparable to the history.
      return this.checkpoint;
    }
    this.checkpoint = stored;
    this.dedup = DivergenceDeduper.restore(stored.dedup, { flapWindowMs: this.options.flapWindowMs });
    return stored;
  }

  get auditPolicy(): AuditPolicy {
    return this.auditor.auditPolicy;
  }

  currentCheckpoint(): Checkpoint {
    return this.checkpoint;
  }

  get roots(): Checkpoint["previous_roots"] {
    return this.checkpoint.previous_roots;
  }

  /**
   * Runs one audit cycle: read both sides, merkleize, classify, publish.
   * Returns the outcome; the continuous loop is `run()`.
   */
  async runCycle(atMs: number = this.clock()): Promise<CycleOutcome> {
    const startedAt = this.clock();
    const [onchain, projected] = await Promise.all([
      this.sources.onchain.read(),
      this.sources.projected.read(),
    ]);

    const skipped =
      this.options.requireLedgerAdvance === true &&
      this.checkpoint.cycle > 0 &&
      Math.max(onchain.ledger, projected.ledger) <= this.checkpoint.last_audited_ledger
        ? "ledger_unchanged"
        : null;

    if (skipped !== null) {
      return {
        cycle: this.checkpoint.cycle,
        report: null,
        alerts: [],
        skipped,
        durationMs: this.clock() - startedAt,
      };
    }

    const state: SourceState = { onchain, projected };
    const report = this.auditor.audit(state, () => new Date(atMs).toISOString());
    const faultingKeys = report.witnesses
      .filter((witness) => witness.kind !== "rounding")
      .map((witness) => witness.key);
    const events = this.dedup.observe(faultingKeys, atMs);
    const alerts = actionable(events);

    const artifact = this.buildArtifact(report, onchain, projected);
    const bundle =
      report.verdict === "clean" ? undefined : buildProofBundle(report, this.auditor.auditPolicy);

    await this.sink.publish({
      report,
      bundle,
      artifact,
      alerts,
      cycle: this.checkpoint.cycle + 1,
    });

    this.checkpoint = {
      version: CHECKPOINT_VERSION,
      cycle: this.checkpoint.cycle + 1,
      last_audited_ledger: Math.max(onchain.ledger, projected.ledger),
      previous_roots: report.roots,
      last_fault_at_ms: report.verdict === "fault" ? atMs : this.checkpoint.last_fault_at_ms,
      last_published_at_ms: atMs,
      audits_run: this.checkpoint.audits_run + 1,
      policy_digest: report.policy_digest,
      dedup: this.dedup.serialize(),
    };
    await this.sink.saveCheckpoint(this.checkpoint);

    const durationMs = this.clock() - startedAt;
    const budget = this.options.cycleBudgetMs;
    if (budget !== undefined && durationMs > budget) {
      this.options.onError?.(
        new Error(`audit cycle ${this.checkpoint.cycle} overran its budget: ${durationMs}ms > ${budget}ms`)
      );
    }

    return { cycle: this.checkpoint.cycle, report, alerts, skipped: null, durationMs };
  }

  private buildArtifact(
    report: AuditReport,
    onchain: StateSource,
    projected: StateSource
  ): AuditArtifact | undefined {
    const limit = this.options.artifactRecordLimit ?? 0;
    if (limit <= 0) return undefined;
    if (onchain.records.length > limit || projected.records.length > limit) return undefined;
    const encode = (records: StateSource["records"]): string[][] =>
      records
        .map((record) => ({
          key: recordKey(record),
          tuple: [
            record.streamId,
            record.sender,
            record.recipient,
            record.token,
            record.deposit,
            record.withdrawn,
            record.startTime,
            record.endTime,
            record.cancelable ? "true" : "false",
            record.status,
          ],
        }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((entry) => entry.tuple);
    return {
      version: CHECKPOINT_VERSION,
      policy: this.auditor.auditPolicy,
      ledger: report.ledger,
      onchain: encode(onchain.records),
      projected: encode(projected.records),
    };
  }

  /**
   * Rate-bounded continuous mode. Sleeps the remainder of `intervalMs` after
   * each cycle and persists a checkpoint before the next one starts, so the
   * loop can be killed at any point and resumed without re-alerting.
   */
  async run(deps: ContinuousDeps = {}): Promise<void> {
    if (this.running) throw new Error("continuous audit already running");
    this.running = true;
    this.stopRequested = false;
    if (deps.clock !== undefined) this.clock = deps.clock;
    const sleep = deps.sleep ?? defaultSleep;
    const maxConsecutiveErrors = 3;
    let consecutiveErrors = 0;

    try {
      await this.resume();
      while (!this.stopRequested) {
        const cycleStartedAt = this.clock();
        try {
          await this.runCycle(cycleStartedAt);
          consecutiveErrors = 0;
        } catch (error) {
          consecutiveErrors += 1;
          this.options.onError?.(error);
          if (consecutiveErrors >= maxConsecutiveErrors) throw error;
        }
        if (this.options.maxCycles !== undefined && this.checkpoint.cycle >= this.options.maxCycles) {
          break;
        }
        const elapsed = this.clock() - cycleStartedAt;
        const remaining = Math.max(0, this.options.intervalMs - elapsed);
        if (remaining > 0) await sleep(remaining);
      }
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    this.stopRequested = true;
  }

  get isRunning(): boolean {
    return this.running;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyCheckpoint(policyDigest: string, dedup: DivergenceDeduper): Checkpoint {
  return {
    version: CHECKPOINT_VERSION,
    cycle: 0,
    last_audited_ledger: 0,
    previous_roots: {
      onchain_raw: "",
      projected_raw: "",
      onchain_quantized: "",
      projected_quantized: "",
    },
    last_fault_at_ms: null,
    last_published_at_ms: null,
    audits_run: 0,
    policy_digest: policyDigest,
    dedup: dedup.serialize(),
  };
}
