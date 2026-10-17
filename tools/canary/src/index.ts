#!/usr/bin/env node
/**
 * StreamPay testnet canary.
 *
 * Runs the full stream lifecycle with fresh funded wallets (self-healing),
 * writes a machine-readable report, and emits an actionable alert on failure.
 *
 *   npm run canary
 *   npm run dry-run
 *   npm run canary -- --force-fail-at=withdraw-partial
 */
import { fileURLToPath } from "node:url";

import { buildAlert, emitAlert } from "./alert.ts";
import { SorobanCanaryBackend } from "./backend.ts";
import {
  TESTNET_RPC_URL,
  collectRunContext,
  describeConfig,
  loadConfig,
  type CanaryConfig,
} from "./config.ts";
import { normalizeFailure } from "./errors.ts";
import { collectGitInfo } from "./git.ts";
import { runLifecycle } from "./lifecycle.ts";
import { buildReport, writeReport, type CanaryReport } from "./report.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

interface CliArgs {
  dryRun: boolean;
  forceFailAt?: string;
  reportPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  let dryRun = false;
  let forceFailAt = process.env.CANARY_FORCE_FAIL_AT || undefined;
  let reportPath = process.env.CANARY_REPORT_PATH ?? "canary-report.json";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: canary [--dry-run] [--force-fail-at=step] [--report=path]\n" +
          "env: CANARY_CONTRACT_ID (required), CANARY_TOKEN_ID, CANARY_SENDER_SECRET,\n" +
          "     CANARY_RECIPIENT_SECRET, CANARY_DEPOSIT, CANARY_STREAM_SECONDS,\n" +
          "     CANARY_ALERT_WEBHOOK, CANARY_RPC_URL, CANARY_REPORT_PATH"
      );
      process.exit(0);
    } else if (arg.startsWith("--force-fail-at=")) {
      forceFailAt = arg.slice("--force-fail-at=".length);
    } else if (arg === "--force-fail-at") {
      forceFailAt = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--report=")) {
      reportPath = arg.slice("--report=".length);
    } else if (arg === "--report") {
      reportPath = argv[index + 1] ?? reportPath;
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag ${arg}`);
    }
  }

  const args: CliArgs = { dryRun, reportPath };
  if (forceFailAt !== undefined && forceFailAt !== "") args.forceFailAt = forceFailAt;
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const git = collectGitInfo(REPO_ROOT);

  let config: CanaryConfig;
  try {
    config = loadConfig(args);
  } catch (error) {
    const failure = normalizeFailure("config", error);
    const finishedAt = new Date().toISOString();
    const report: CanaryReport = {
      schema: "streampay-canary/v1",
      status: "failure",
      startedAt,
      finishedAt,
      durationMs: Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime()),
      network: "testnet",
      rpcUrl: process.env.CANARY_RPC_URL ?? TESTNET_RPC_URL,
      contractId: process.env.CANARY_CONTRACT_ID ?? "(unset)",
      tokenId: process.env.CANARY_TOKEN_ID ?? "(default)",
      run: collectRunContext(),
      git,
      stream: null,
      steps: [],
      failure,
      forcedFailure: false,
    };
    writeReport(args.reportPath, report);
    await emitAlert(buildAlert(report)!);
    process.exitCode = 1;
    return;
  }

  if (config.dryRun) {
    const steps = [
      "prepare",
      "create-stream",
      "wait-accrual",
      "withdraw-partial",
      "wait-accrual-2",
      "withdraw-max",
      "cancel",
      "verify",
    ];
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          note: "no network calls; config validated",
          config: describeConfig(config),
          plannedSteps: steps,
        },
        null,
        2
      )
    );
    return;
  }

  const backend = new SorobanCanaryBackend({
    rpcUrl: config.rpcUrl,
    networkPassphrase: config.networkPassphrase,
    contractId: config.contractId,
    tokenId: config.tokenId,
    deposit: config.deposit,
    senderSecret: config.senderSecret,
    recipientSecret: config.recipientSecret,
    friendbotUrl: config.friendbotUrl,
    pollIntervalMs: config.pollIntervalMs,
  });

  console.log(
    `StreamPay canary: contract ${config.contractId} on ${config.network} ` +
      `(deposit ${config.deposit}, window ${config.windowSeconds}s)`
  );

  const outcome = await runLifecycle({
    backend,
    deposit: config.deposit,
    windowSeconds: config.windowSeconds,
    waitTimeoutMs: config.waitTimeoutMs,
    pollIntervalMs: config.pollIntervalMs,
    forceFailAt: config.forceFailAt,
  });

  const finishedAt = new Date().toISOString();
  const report = buildReport({ startedAt, finishedAt, config, git, outcome });

  if (report.status === "failure") {
    const alert = buildAlert(report);
    if (alert !== null) {
      report.alert = alert;
      writeReport(config.reportPath, report);
      await emitAlert(alert);
    } else {
      writeReport(config.reportPath, report);
    }
    console.error(`canary failed: report written to ${config.reportPath}`);
    process.exitCode = 1;
    return;
  }

  writeReport(config.reportPath, report);
  const stream = report.stream;
  console.log(
    `canary passed in ${report.durationMs}ms: stream #${stream?.id ?? "?"} went ` +
      `create -> partial -> max -> cancel; report at ${config.reportPath}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
