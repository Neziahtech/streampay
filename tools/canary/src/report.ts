import { writeFileSync } from "node:fs";

import type { AlertPayload } from "./alert.ts";
import type { CanaryConfig } from "./config.ts";
import type { LifecycleOutcome } from "./lifecycle.ts";
import type {
  FailureDetail,
  GitInfo,
  RunContext,
  StepRecord,
  StreamRef,
} from "./types.ts";

export interface CanaryReport {
  schema: "streampay-canary/v1";
  status: "success" | "failure";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  network: string;
  rpcUrl: string;
  contractId: string;
  tokenId: string;
  run: RunContext;
  git: GitInfo;
  stream: StreamRef | null;
  steps: StepRecord[];
  failure: FailureDetail | null;
  forcedFailure: boolean;
  alert?: AlertPayload | null;
}

export interface BuildReportInput {
  startedAt: string;
  finishedAt: string;
  config: CanaryConfig;
  git: GitInfo;
  outcome: LifecycleOutcome;
}

export function buildReport(input: BuildReportInput): CanaryReport {
  const { config, outcome } = input;
  const durationMs = Math.max(
    0,
    new Date(input.finishedAt).getTime() - new Date(input.startedAt).getTime()
  );

  let stream: StreamRef | null = null;
  if (outcome.prepared !== null && outcome.streamId !== null) {
    const state = outcome.finalStream;
    stream = {
      id: outcome.streamId.toString(),
      sender: outcome.prepared.sender,
      recipient: outcome.prepared.recipient,
      deposit: config.deposit.toString(),
      windowSeconds: config.windowSeconds,
      startTime: state?.startTime.toString() ?? "unknown",
      endTime: state?.endTime.toString() ?? "unknown",
    };
  }

  return {
    schema: "streampay-canary/v1",
    status: outcome.failure === null ? "success" : "failure",
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs,
    network: config.network,
    rpcUrl: config.rpcUrl,
    contractId: config.contractId,
    tokenId: config.tokenId,
    run: config.run,
    git: input.git,
    stream,
    steps: outcome.steps,
    failure: outcome.failure,
    forcedFailure: outcome.failure?.forced === true,
  };
}

export function writeReport(path: string, report: CanaryReport): void {
  writeFileSync(path, JSON.stringify(report, jsonReplacer, 2) + "\n");
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
