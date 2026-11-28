//! Service entrypoint for the reconciliation daemon.
//! Runs pinned three-way reconciliation, the legacy dual read, and a
//! continuous merkleized state audit, and can emit governance-gated heals.

import { ReconciliationEngine } from "./engine/diff.js";
import { ThreeWayReconciler } from "./engine/threeway.js";
import { DivergenceSuppressor } from "./engine/suppression.js";
import { HorizonReader } from "./readers/horizon.js";
import { SorobanRpcReader } from "./readers/soroban.js";
import { ProjectionReader } from "./readers/projection.js";
import { AlertingService } from "./alerting.js";
import {
  collectPinnedSnapshots,
  horizonAdapter,
  projectionAdapter,
  rpcAdapter,
} from "./sources/pinned.js";
import { ProposalStore, proposeHeals } from "./heal/proposals.js";
import type { StreamState, ReconciliationResult } from "./types.js";
import { DEFAULT_POLICY, type AuditPolicy } from "./audit/canonical.js";
import { FileAuditSink, ContinuousAuditor, type AuditSink, type StateReader } from "./audit/publication.js";
import { projectionReader as auditProjectionReader, type ProjectableStream } from "./audit/projection.js";
import { buildProofBundle, verifyBundle } from "./audit/proofs.js";
import { verify, type VerifyOptions } from "./audit/verifier.js";

const SERVICE_NAME = "streampay-reconciler";

export interface ReconcilerServiceConfig {
  horizonUrl: string;
  sorobanRpcUrl: string;
  indexerUrl?: string;
  webhookUrl?: string;
  consistencyWindowMs: number;
  pollIntervalMs: number;
  logLevel: "DEBUG" | "INFO" | "WARN" | "ERROR";
  contractId?: string;
  environment: string;
  reconcilerId: string;
  asOfMaxLagLedgers: number;
  tolerance: { absolute: number; relativePpm: number };
  suppressionCooldownMs: number;
  flapThreshold: number;
  alertConfirmPasses: number;
  alertResolvePasses: number;
  alertReminderMs: number;
  healEnabled: boolean;
  healTimelockMs: number;
  healTtlMs: number;
  healRequiredSignatures: number;
  healSigners: Record<string, string> | string[] | null;
  healMaxScope: number;
  healMaxLedgerRange: number;
}

export interface RuntimeConfig extends ReconcilerServiceConfig {
  audit: {
    directory: string;
    intervalMs: number;
    artifactRecordLimit: number;
    toleranceEpsilon: string;
    flapWindowMs: number;
  };
}

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function integerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got '${raw}'`);
  }
  return parsed;
}

function parseSigners(raw: string | undefined): Record<string, string> | string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
    if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
  } catch {
    throw new Error("HEAL_SIGNERS must be a JSON array or object");
  }
  throw new Error("HEAL_SIGNERS must be a JSON array or object");
}

/** Parse and validate configuration from the environment. */
export function loadConfig(): RuntimeConfig {
  const logLevel = (process.env.LOG_LEVEL || "INFO") as RuntimeConfig["logLevel"];
  if (!["DEBUG", "INFO", "WARN", "ERROR"].includes(logLevel)) {
    throw new Error(`LOG_LEVEL must be DEBUG|INFO|WARN|ERROR, got '${logLevel}'`);
  }

  return {
    horizonUrl: process.env.HORIZON_URL || "https://horizon-testnet.stellar.org",
    sorobanRpcUrl: process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org/rpc",
    indexerUrl: process.env.INDEXER_URL || undefined,
    webhookUrl: process.env.WEBHOOK_URL || undefined,
    consistencyWindowMs: integerFromEnv("CONSISTENCY_WINDOW_MS", 30_000),
    pollIntervalMs: integerFromEnv("POLL_INTERVAL_MS", 5_000),
    logLevel,
    contractId: process.env.CONTRACT_ID,
    environment: process.env.ENVIRONMENT || "testnet",
    reconcilerId: process.env.RECONCILER_ID || "primary-001",
    asOfMaxLagLedgers: parseInteger(process.env.AS_OF_MAX_LAG_LEDGERS, 5),
    tolerance: {
      absolute: parseInteger(process.env.ROUNDING_TOLERANCE_ABSOLUTE, 0),
      relativePpm: parseInteger(process.env.ROUNDING_TOLERANCE_PPM, 0),
    },
    suppressionCooldownMs: parseInteger(process.env.SUPPRESSION_COOLDOWN_MS, 300_000),
    flapThreshold: parseInteger(process.env.FLAP_THRESHOLD, 3),
    alertConfirmPasses: parseInteger(process.env.ALERT_CONFIRM_PASSES, 2),
    alertResolvePasses: parseInteger(process.env.ALERT_RESOLVE_PASSES, 2),
    alertReminderMs: parseInteger(process.env.ALERT_REMINDER_MS, 1_800_000),
    healEnabled: process.env.HEAL_PROPOSALS_ENABLED === "true",
    healTimelockMs: parseInteger(process.env.HEAL_TIMELOCK_MS, 86_400_000),
    healTtlMs: parseInteger(process.env.HEAL_TTL_MS, 172_800_000),
    healRequiredSignatures: parseInteger(process.env.HEAL_REQUIRED_SIGNATURES, 2),
    healSigners: parseSigners(process.env.HEAL_SIGNERS),
    healMaxScope: parseInteger(process.env.HEAL_MAX_SCOPE, 25),
    healMaxLedgerRange: parseInteger(process.env.HEAL_MAX_LEDGER_RANGE, 1_000),
    audit: {
      directory: process.env.AUDIT_DIR || "audit-out",
      intervalMs: integerFromEnv("AUDIT_INTERVAL_MS", 60_000),
      artifactRecordLimit: integerFromEnv("AUDIT_ARTIFACT_LIMIT", 2_000),
      toleranceEpsilon: process.env.AUDIT_TOLERANCE_EPSILON || DEFAULT_POLICY.tolerance.epsilon,
      flapWindowMs: integerFromEnv("AUDIT_FLAP_WINDOW_MS", 120_000),
    },
  };
}

/** Stream ids to monitor; empty means the caller supplies its own list. */
export function getMonitoredStreamIds(): string[] {
  const ids = process.env.STREAM_IDS;
  if (ids === undefined) return [];
  return ids
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export function auditPolicyFromConfig(config: RuntimeConfig): AuditPolicy {
  return {
    ...DEFAULT_POLICY,
    tolerance: { ...DEFAULT_POLICY.tolerance, epsilon: config.audit.toleranceEpsilon },
  };
}

export interface ReconcilerService {
  horizonReader: HorizonReader;
  sorobanReader: SorobanRpcReader;
  projectionReader: ProjectionReader;
  engine: ReconciliationEngine;
  threeWay: ThreeWayReconciler;
  proposalStore: ProposalStore;
  suppressor: DivergenceSuppressor;
  alerting: AlertingService;
  auditor: ContinuousAuditor;
  sink: AuditSink;
  config: RuntimeConfig;
}

export function createReaders(config: ReconcilerServiceConfig): {
  horizonReader: HorizonReader;
  sorobanReader: SorobanRpcReader;
} {
  if (!config.horizonUrl) throw new Error("HORIZON_URL is required");
  if (!config.sorobanRpcUrl) throw new Error("SOROBAN_RPC_URL is required");

  const pollIntervalMs = config.pollIntervalMs;
  return {
    horizonReader: new HorizonReader({
      url: config.horizonUrl,
      token: process.env.HORIZON_API_TOKEN || undefined,
      pollIntervalMs,
    }),
    sorobanReader: new SorobanRpcReader({
      url: config.sorobanRpcUrl,
      token: process.env.SOROBAN_RPC_TOKEN || undefined,
      pollIntervalMs,
      contractId: config.contractId || "unknown",
    }),
  };
}

/**
 * Assemble the service. Audit sources are injectable because the audited
 * projection needs the full canonical field set, not only the dual-read
 * balance fields. Without an injected pair, both record sets are empty rather
 * than fabricated placeholders.
 */
export async function createReconcilerService(
  config: RuntimeConfig = loadConfig(),
  sources?: { onchain: StateReader; projected: StateReader }
): Promise<ReconcilerService> {
  const { horizonReader, sorobanReader } = createReaders(config);
  const streamIds = getMonitoredStreamIds();

  const alerting = new AlertingService({
    webhookUrl: config.webhookUrl,
    consistencyWindowMs: config.consistencyWindowMs,
    logLevel: config.logLevel,
    serviceName: SERVICE_NAME,
    environment: config.environment,
    reconcilerId: config.reconcilerId,
    dedupe: {
      confirmPasses: config.alertConfirmPasses,
      resolvePasses: config.alertResolvePasses,
      reminderCadenceMs: config.alertReminderMs,
    },
  });

  const projection = new ProjectionReader({
    url: config.indexerUrl,
    token: process.env.INDEXER_API_TOKEN || undefined,
  });

  const suppressor = new DivergenceSuppressor({
    cooldownMs: config.suppressionCooldownMs,
    flapThreshold: config.flapThreshold,
  });

  const threeWay = new ThreeWayReconciler({
    tolerance: config.tolerance,
    maxLagLedgers: config.asOfMaxLagLedgers,
    suppressor,
  });

  const proposalStore = new ProposalStore({
    timelockMs: config.healTimelockMs,
    ttlMs: config.healTtlMs,
    requiredSignatures: config.healRequiredSignatures,
    governanceSigners: config.healSigners,
    maxScope: config.healMaxScope,
    maxLedgerRange: config.healMaxLedgerRange,
    onEvent: (event: string, proposal: { id?: string; status?: string; dryRun?: { beforeRoot?: string; afterRoot?: string }; execution?: unknown }) => {
      alerting.log("INFO", `Heal proposal ${event}`, {
        proposalId: proposal.id,
        status: proposal.status,
        beforeRoot: proposal.dryRun?.beforeRoot,
        afterRoot: proposal.dryRun?.afterRoot,
        execution: proposal.execution ?? null,
      });
    },
  });

  const engine = new ReconciliationEngine({
    consistencyWindowMs: config.consistencyWindowMs,
    alertingService: alerting,
  });

  const sink = new FileAuditSink(config.audit.directory, config.reconcilerId);
  const resolvedSources = sources ?? {
    onchain: {
      read: async () => ({ ledger: await sorobanReader.getLatestLedger(), records: [] }),
    },
    projected: auditProjectionReader(async () => ({
      ledger: 0,
      streams: [] as ProjectableStream[],
    })),
  };

  const auditor = new ContinuousAuditor(resolvedSources, sink, {
    intervalMs: config.audit.intervalMs,
    policy: auditPolicyFromConfig(config),
    artifactRecordLimit: config.audit.artifactRecordLimit,
    requireLedgerAdvance: true,
    flapWindowMs: config.audit.flapWindowMs,
    onError: (error: unknown) => {
      alerting.log("ERROR", "Continuous audit failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  const [horizonHealth, sorobanHealth] = await Promise.all([
    horizonReader.healthCheck(),
    sorobanReader.healthCheck(),
  ]);

  alerting.log("INFO", "Reconciler service starting", {
    horizonHealthy: horizonHealth.healthy,
    horizonError: horizonHealth.error,
    sorobanHealthy: sorobanHealth.healthy,
    sorobanError: sorobanHealth.error,
    projectionConfigured: projection.available,
    consistencyWindowMs: config.consistencyWindowMs,
    pollIntervalMs: config.pollIntervalMs,
    asOfMaxLagLedgers: config.asOfMaxLagLedgers,
    healProposalsEnabled: config.healEnabled,
    auditDirectory: config.audit.directory,
    auditIntervalMs: config.audit.intervalMs,
    toleranceEpsilon: config.audit.toleranceEpsilon,
    environment: config.environment,
    reconcilerId: config.reconcilerId,
    monitoredStreams: streamIds.length,
  });

  return {
    horizonReader,
    sorobanReader,
    projectionReader: projection,
    engine,
    threeWay,
    proposalStore,
    suppressor,
    alerting,
    auditor,
    sink,
    config,
  };
}

/** Run one dual-read reconciliation cycle. */
export async function runCycle(
  horizonReader: HorizonReader,
  sorobanReader: SorobanRpcReader,
  engine: ReconciliationEngine,
  alerting: AlertingService,
  streamIds: string[]
): Promise<ReconciliationResult> {
  const [horizonStates, sorobanStates] = await Promise.all([
    horizonReader.pollStreams(streamIds),
    sorobanReader.pollStreams(streamIds),
  ]);

  const result = await engine.reconcile(horizonStates, sorobanStates);

  alerting.log("INFO", "Reconciliation cycle complete", {
    totalChecked: result.totalChecked,
    inSync: result.inSync,
    withinLagWindow: result.withinLagWindow,
    divergences: result.divergences.length,
    roundingWithinTolerance: result.roundingWithinTolerance,
    realDivergences: result.realDivergences,
    ledgerGap: result.ledgerGap,
    timestamp: result.timestamp,
  });

  return result;
}

/** Run one pinned three-way cycle, including diagnosis alerts and heal proposals. */
export async function runThreeWayCycle(
  service: ReconcilerService,
  streamIds: string[]
): Promise<{ report: any; proposals: any[]; skipped: any[] }> {
  const adapters: any[] = [
    rpcAdapter(service.sorobanReader),
    horizonAdapter(service.horizonReader),
  ];
  if (service.projectionReader.available) {
    adapters.push(projectionAdapter(service.projectionReader));
  }

  const { asOfLedger, snapshots } = await collectPinnedSnapshots({
    adapters,
    streamIds,
    asOfLedger: null,
  });

  const report = service.threeWay.reconcile({ snapshots, streamIds });

  service.alerting.beginPass();
  try {
    for (const diagnosis of report.diagnoses) {
      await service.alerting.dispatchDiagnosis(diagnosis, report);
    }
  } finally {
    service.alerting.endPass();
  }

  let proposals: any[] = [];
  let skipped: any[] = [];
  if (service.config.healEnabled && report.mode === "three_way") {
    const projectionSnapshot = snapshots.find(
      (snapshot: { source?: string }) => snapshot.source === "projection"
    );
    const records = projectionSnapshot?.available ? projectionSnapshot.states : [];
    const result = proposeHeals({
      report,
      records,
      store: service.proposalStore,
      contractId: service.config.contractId ?? "",
      maxLedgerRange: service.config.healMaxLedgerRange,
    });
    proposals = result.proposals;
    skipped = result.skipped;
  }

  service.alerting.log(
    report.verdict === "divergent" ? "ERROR" : "INFO",
    "Three-way reconciliation complete",
    {
      verdict: report.verdict,
      mode: report.mode,
      asOfLedger: report.asOfLedger ?? asOfLedger,
      checked: report.summary.checked,
      inSync: report.summary.inSync,
      tolerated: report.summary.tolerated,
      withinLag: report.summary.withinLag,
      divergent: report.summary.divergent,
      suppressed: report.summary.suppressed,
      byLayer: report.summary.byLayer,
      caveats: report.caveats,
      proposals: proposals.map((proposal) => proposal.id),
      skipped,
    }
  );

  return { report, proposals, skipped };
}

export async function runContinuousThreeWay(
  service: ReconcilerService,
  streamIds: string[],
  options: { shouldStop?: () => boolean } = {}
): Promise<void> {
  const interval = service.config.pollIntervalMs;
  const shouldStop = options.shouldStop ?? (() => false);
  while (!shouldStop()) {
    const started = Date.now();
    try {
      await runThreeWayCycle(service, streamIds);
    } catch (error) {
      service.alerting.log("ERROR", "Three-way reconciliation cycle failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (shouldStop()) return;
    const elapsed = Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, interval - elapsed)));
  }
}

const CLI_USAGE = `usage: node dist/index.js [command]

  audit --once        run a single merkleized audit cycle and write artifacts
  verify [options]    re-derive published roots and proofs (see --help below)
  (no command)        continuous dual-read, three-way reconciliation and audit

Environment: see .env.example. The audit writes report/bundle/artifact/checkpoint
files under AUDIT_DIR, named by RECONCILER_ID.`;

/** Reuse the verifier's flag grammar without spawning it. */
function parseVerifyArgs(argv: string[]): VerifyOptions {
  const options: VerifyOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      i += 1;
      return next;
    };
    if (flag === "--bundle") options.bundlePath = value();
    else if (flag === "--report") options.reportPath = value();
    else if (flag === "--artifact") options.artifactPath = value();
    else if (flag === "--json") options.json = true;
    else throw new Error(`unknown verifier flag '${flag}'`);
  }
  return options;
}

export async function runCli(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === undefined) return -1;

  if (command === "--help" || command === "help") {
    process.stdout.write(`${CLI_USAGE}\n`);
    return 0;
  }
  if (command === "verify") {
    const result = await verify(parseVerifyArgs(argv.slice(1)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }
  if (command === "audit") {
    const once = argv.includes("--once");
    const config = loadConfig();
    const service = await createReconcilerService(config);
    const outcome = await service.auditor.runCycle();
    if (outcome.report === null) {
      process.stdout.write(`skipped: ${outcome.skipped}\n`);
      return 0;
    }
    const bundle =
      outcome.report.verdict === "clean"
        ? undefined
        : buildProofBundle(outcome.report, service.auditor.auditPolicy);
    const summary = bundle === undefined ? null : verifyBundle(bundle);
    process.stdout.write(
      `${JSON.stringify(
        {
          cycle: outcome.cycle,
          verdict: outcome.report.verdict,
          roots: outcome.report.roots,
          alerts: outcome.alerts,
          self_check_ok: summary === null ? true : summary.ok,
        },
        null,
        2
      )}\n`
    );
    if (!once) await service.auditor.run();
    return outcome.report.verdict === "fault" ? 1 : 0;
  }
  throw new Error(`unknown command '${command}'\n\n${CLI_USAGE}`);
}

async function mainLoop(): Promise<void> {
  const config = loadConfig();
  const service = await createReconcilerService(config);
  const streamIds = getMonitoredStreamIds();
  let stopping = false;

  service.alerting.log("INFO", "Reconciler service ready", { monitoredStreams: streamIds.length });

  const dualRead = setInterval(() => {
    void runCycle(
      service.horizonReader,
      service.sorobanReader,
      service.engine,
      service.alerting,
      streamIds
    ).catch((error: unknown) => {
      service.alerting.log("ERROR", "Reconciliation cycle failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, config.consistencyWindowMs);

  const threeWay = runContinuousThreeWay(service, streamIds, { shouldStop: () => stopping });
  try {
    await service.auditor.run();
  } finally {
    stopping = true;
    clearInterval(dualRead);
    service.auditor.stop();
    await threeWay.catch((error: unknown) => {
      service.alerting.log("ERROR", "Three-way reconciliation stopped", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

if (process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("index.ts")) {
  const code = await runCli(process.argv.slice(2));
  if (code === -1) {
    await mainLoop();
  } else {
    process.exitCode = code;
  }
}

export type { StreamState, ReconciliationResult };
