import { BackendError, hintFor } from "./errors.ts";
import type { RunContext } from "./types.ts";

/** Well-known testnet native XLM Stellar Asset Contract. */
export const TESTNET_NATIVE_SAC =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
export const DEFAULT_FRIENDBOT_URL = "https://friendbot.stellar.org";

export interface CanaryOptions {
  dryRun: boolean;
  forceFailAt?: string;
  reportPath: string;
}

export interface CanaryConfig extends CanaryOptions {
  network: "testnet";
  rpcUrl: string;
  networkPassphrase: string;
  friendbotUrl: string;
  contractId: string;
  tokenId: string;
  senderSecret?: string;
  recipientSecret?: string;
  alertWebhook?: string;
  deposit: bigint;
  windowSeconds: number;
  pollIntervalMs: number;
  waitTimeoutMs: number;
  run: RunContext;
}

const CONTRACT_ID = /^C[A-Z2-7]{55}$/;
const SECRET_KEY = /^S[A-Z2-7]{55}$/;

function envInt(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new BackendError(
      "config",
      `${name} must be an integer between ${minimum} and ${maximum}, got ${raw}`
    );
  }
  return value;
}

function envString(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function requiredContractId(): string {
  const contractId = envString("CANARY_CONTRACT_ID");
  if (contractId === undefined) {
    throw new BackendError(
      "config",
      "CANARY_CONTRACT_ID is not set (repository variable). Deploy with scripts/deploy_testnet.sh and set it.",
      { rpcExcerpt: hintFor("config") }
    );
  }
  if (!CONTRACT_ID.test(contractId)) {
    throw new BackendError(
      "config",
      `CANARY_CONTRACT_ID is not a contract strkey: ${contractId}`
    );
  }
  return contractId;
}

function optionalSecret(name: string): string | undefined {
  const value = envString(name);
  if (value !== undefined && !SECRET_KEY.test(value)) {
    throw new BackendError("config", `${name} is not a Stellar secret key`);
  }
  return value;
}

export function collectRunContext(): RunContext {
  return {
    workflow: process.env.GITHUB_WORKFLOW ?? "local",
    job: process.env.GITHUB_JOB ?? "canary",
    runId: process.env.GITHUB_RUN_ID ?? "0",
    runUrl:
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : "local",
    actor: process.env.GITHUB_ACTOR ?? "local",
    sha: process.env.GITHUB_SHA ?? "unknown",
    ref: process.env.GITHUB_REF ?? "local",
    repository: process.env.GITHUB_REPOSITORY ?? "local",
    eventName: process.env.GITHUB_EVENT_NAME ?? "local",
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
  };
}

export function loadConfig(options: CanaryOptions): CanaryConfig {
  const network = (envString("CANARY_NETWORK") ?? "testnet").toLowerCase();
  if (network !== "testnet") {
    // Guardrail: the canary must never point at mainnet.
    throw new BackendError(
      "config",
      `the canary is testnet-only; CANARY_NETWORK=${network} is refused`
    );
  }

  const tokenId = envString("CANARY_TOKEN_ID") ?? TESTNET_NATIVE_SAC;
  if (!CONTRACT_ID.test(tokenId)) {
    throw new BackendError("config", `CANARY_TOKEN_ID is not a contract strkey: ${tokenId}`);
  }

  const deposit = BigInt(envString("CANARY_DEPOSIT") ?? "1000000");
  if (deposit <= 0n) {
    throw new BackendError("config", "CANARY_DEPOSIT must be positive");
  }

  return {
    ...options,
    network: "testnet",
    rpcUrl: envString("CANARY_RPC_URL") ?? TESTNET_RPC_URL,
    networkPassphrase: TESTNET_PASSPHRASE,
    friendbotUrl: envString("CANARY_FRIENDBOT_URL") ?? DEFAULT_FRIENDBOT_URL,
    contractId: requiredContractId(),
    tokenId,
    senderSecret: optionalSecret("CANARY_SENDER_SECRET"),
    recipientSecret: optionalSecret("CANARY_RECIPIENT_SECRET"),
    alertWebhook: envString("CANARY_ALERT_WEBHOOK"),
    deposit,
    windowSeconds: envInt("CANARY_STREAM_SECONDS", 120, 30, 86_400),
    pollIntervalMs: envInt("CANARY_POLL_INTERVAL_MS", 1000, 100, 30_000),
    waitTimeoutMs: envInt("CANARY_WAIT_TIMEOUT_MS", 90_000, 5_000, 600_000),
    run: collectRunContext(),
  };
}

/** Redacted view for dry runs and logs: secrets are never printed. */
export function describeConfig(config: CanaryConfig): Record<string, unknown> {
  return {
    network: config.network,
    rpcUrl: config.rpcUrl,
    contractId: config.contractId,
    tokenId: config.tokenId,
    deposit: config.deposit.toString(),
    windowSeconds: config.windowSeconds,
    senderSecret: config.senderSecret === undefined ? "generated" : "provided",
    recipientSecret: config.recipientSecret === undefined ? "generated" : "provided",
    alertWebhook: config.alertWebhook === undefined ? "not configured" : "configured",
    forceFailAt: config.forceFailAt ?? null,
    reportPath: config.reportPath,
  };
}
