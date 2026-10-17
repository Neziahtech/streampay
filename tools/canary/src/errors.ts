import type { FailureClass, FailureDetail } from "./types.ts";

/** RPC/contract failure raised by the backend; the lifecycle names the step. */
export class BackendError extends Error {
  constructor(
    readonly failureClass: FailureClass,
    message: string,
    readonly info: {
      rpcMethod?: string;
      rpcExcerpt?: string;
      transactionXdr?: string;
      resultXdr?: string;
    } = {}
  ) {
    super(message);
    this.name = "BackendError";
  }
}

/** An expected-state check failed (contract responded, but not as required). */
export class CheckError extends Error {
  constructor(
    message: string,
    readonly expected: unknown,
    readonly actual: unknown
  ) {
    super(`${message}: expected ${String(expected)}, got ${String(actual)}`);
    this.name = "CheckError";
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/** A classified failure carrying everything the alert needs. */
export class CanaryFailure extends Error {
  constructor(readonly detail: FailureDetail) {
    super(`${detail.step} failed (${detail.failureClass}): ${detail.message}`);
    this.name = "CanaryFailure";
  }
}

export function excerpt(value: unknown, limit = 1200): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}… (${text.length} chars)` : text;
}

export function hintFor(failureClass: FailureClass): string {
  switch (failureClass) {
    case "simulation":
      return "The call the frontend would build was rejected during simulation. Inspect the XDR and the contract state (expired stream, insufficient accrual, wrong caller) before re-running.";
    case "submission":
      return "The network rejected the transaction before inclusion. Check the bot wallet's sequence/funding and the RPC's fee settings; the XDR below is exactly what was sent.";
    case "inclusion":
      return "The transaction was included but failed. Decode resultXdr and the contract events for the ledger; this usually means state changed between simulation and submission.";
    case "assertion":
      return "The contract responded but returned unexpected state. Compare the deployed Wasm/digest with the release and re-check the stream after the run.";
    case "timeout":
      return "The testnet did not reach the expected state in time. Ledger close can lag; if this repeats, check testnet health and whether accrual stopped.";
    case "funding":
      return "Friendbot did not fund the bot wallet. Testnet faucet failures are usually transient or rate-limited; re-run and check https://status.stellar.org.";
    case "transport":
      return "The RPC endpoint was unreachable or returned an invalid response. Check CANARY_RPC_URL and Stellar testnet status.";
    case "config":
      return "The canary is misconfigured. Fix the named environment variable/repository setting; no transaction was sent.";
    default:
      return "Unexpected failure. Inspect the step, RPC excerpt, and XDR below.";
  }
}

export function normalizeFailure(step: string, error: unknown): FailureDetail {
  if (error instanceof CanaryFailure) {
    return { ...error.detail, step };
  }
  if (error instanceof BackendError) {
    return {
      step,
      failureClass: error.failureClass,
      message: error.message,
      hint: hintFor(error.failureClass),
      ...error.info,
    };
  }
  if (error instanceof CheckError) {
    return {
      step,
      failureClass: "assertion",
      message: error.message,
      hint: hintFor("assertion"),
    };
  }
  if (error instanceof TimeoutError) {
    return {
      step,
      failureClass: "timeout",
      message: error.message,
      hint: hintFor("timeout"),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "Error";
  const failureClass: FailureClass =
    name === "AssertionError" ? "assertion" : "unknown";
  return {
    step,
    failureClass,
    message: `${name}: ${message}`,
    hint: hintFor(failureClass),
  };
}
