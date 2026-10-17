/**
 * The full StreamPay lifecycle against one stream:
 *
 *   prepare -> create -> wait for accrual -> withdraw partial -> wait ->
 *   withdraw_max -> cancel -> verify
 *
 * Every step records its transaction hash and XDR; the first failure stops the
 * run with a classified detail the alert turns into an actionable payload.
 */
import {
  CanaryFailure,
  CheckError,
  TimeoutError,
  hintFor,
  normalizeFailure,
} from "./errors.ts";
import type {
  CanaryBackend,
  FailureDetail,
  PrepareResult,
  StepRecord,
  StreamState,
} from "./types.ts";

export interface LifecycleOptions {
  backend: CanaryBackend;
  deposit: bigint;
  windowSeconds: number;
  waitTimeoutMs: number;
  pollIntervalMs: number;
  /** Injectable clock, in seconds since the epoch. */
  nowSeconds?: () => number;
  sleep?: (ms: number) => Promise<void>;
  forceFailAt?: string;
}

export interface LifecycleOutcome {
  steps: StepRecord[];
  prepared: PrepareResult | null;
  streamId: bigint | null;
  finalStream: StreamState | null;
  failure: FailureDetail | null;
}

export async function runLifecycle(
  options: LifecycleOptions
): Promise<LifecycleOutcome> {
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const steps: StepRecord[] = [];
  let prepared: PrepareResult | null = null;
  let streamId: bigint | null = null;
  let finalStream: StreamState | null = null;
  let failure: FailureDetail | null = null;

  const lastStep = (): StepRecord => {
    const record = steps[steps.length - 1];
    if (record === undefined) throw new Error("no step recorded");
    return record;
  };

  async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (options.forceFailAt === name) {
      const detail: FailureDetail = {
        step: name,
        failureClass: "simulation",
        message:
          "forced failure injected by --force-fail-at (alert-path verification)",
        hint: hintFor("simulation"),
        rpcMethod: "simulateTransaction",
        rpcExcerpt:
          "HostError: Error(Contract, #5) — forced by --force-fail-at for alert verification",
        transactionXdr: "AAAA...FORCED-TRANSACTION-XDR...",
        resultXdr: "AAAA...FORCED-RESULT-XDR...",
        forced: true,
      };
      steps.push({
        name,
        status: "failed",
        durationMs: 0,
        detail,
      });
      throw new CanaryFailure(detail);
    }

    const started = Date.now();
    try {
      const value = await fn();
      steps.push({ name, status: "passed", durationMs: Date.now() - started });
      return value;
    } catch (error) {
      const detail = normalizeFailure(name, error);
      steps.push({
        name,
        status: "failed",
        durationMs: Date.now() - started,
        detail,
      });
      throw new CanaryFailure(detail);
    }
  }

  try {
    prepared = await step("prepare", () => options.backend.prepare());
    check(prepared.sender.startsWith("G"), "sender is a Stellar account", "G…", prepared.sender);
    check(
      prepared.recipient.startsWith("G"),
      "recipient is a Stellar account",
      "G…",
      prepared.recipient
    );
    lastStep().txHash = prepared.approval.hash;
    lastStep().envelopeXdr = prepared.approval.envelopeXdr;

    const start = nowSeconds() + 2;
    const end = start + options.windowSeconds;

    const created = await step("create-stream", async () => {
      const receipt = await options.backend.createStream({
        sender: prepared!.sender,
        recipient: prepared!.recipient,
        token: prepared!.token,
        deposit: options.deposit,
        startTime: start,
        endTime: end,
        cancelable: true,
      });
      check(receipt.streamId > 0n, "created stream id is positive", "> 0", receipt.streamId);

      const state = await options.backend.getStream(receipt.streamId);
      check(state.sender === prepared!.sender, "stream sender", prepared!.sender, state.sender);
      check(
        state.recipient === prepared!.recipient,
        "stream recipient",
        prepared!.recipient,
        state.recipient
      );
      check(state.deposit === options.deposit, "stream deposit", options.deposit, state.deposit);
      check(state.cancelable, "stream is cancelable", true, state.cancelable);
      check(state.status === "Active", "new stream is Active", "Active", state.status);
      return receipt;
    });
    streamId = created.streamId;
    lastStep().txHash = created.hash;
    lastStep().envelopeXdr = created.envelopeXdr;

    await step("wait-accrual", async () => {
      const available = await waitForAvailable(
        options.backend,
        streamId!,
        1n,
        options.waitTimeoutMs,
        options.pollIntervalMs,
        sleep
      );
      check(available > 0n, "accrual started", "> 0", available);
      return available;
    });

    const partial = await step("withdraw-partial", async () => {
      const available = await options.backend.available(streamId!);
      check(available > 1n, "enough accrued for a partial claim", "> 1", available);
      const amount = available / 2n;
      check(amount > 0n, "partial amount is positive", "> 0", amount);

      const receipt = await options.backend.withdraw(streamId!, amount);
      const state = await options.backend.getStream(streamId!);
      check(
        state.withdrawn >= amount,
        "withdrawn reflects the partial claim",
        `>= ${amount}`,
        state.withdrawn
      );
      check(
        state.status === "Active",
        "stream stays Active after a partial claim",
        "Active",
        state.status
      );
      return { amount, receipt, state };
    });
    lastStep().txHash = partial.receipt.hash;
    lastStep().envelopeXdr = partial.receipt.envelopeXdr;

    await step("wait-accrual-2", async () => {
      const available = await waitForAvailable(
        options.backend,
        streamId!,
        1n,
        options.waitTimeoutMs,
        options.pollIntervalMs,
        sleep
      );
      return available;
    });

    const maximal = await step("withdraw-max", async () => {
      const receipt = await options.backend.withdrawMax(streamId!);
      check(receipt.amount > 0n, "withdraw_max paid a positive amount", "> 0", receipt.amount);

      const state = await options.backend.getStream(streamId!);
      check(
        state.withdrawn === partial.state.withdrawn + receipt.amount,
        "withdrawn total equals partial + max",
        partial.state.withdrawn + receipt.amount,
        state.withdrawn
      );
      check(
        state.status === "Active",
        "stream stays Active because unaccrued funds remain",
        "Active",
        state.status
      );
      return { receipt, state };
    });
    lastStep().txHash = maximal.receipt.hash;
    lastStep().envelopeXdr = maximal.receipt.envelopeXdr;

    const cancelled = await step("cancel", async () => {
      const receipt = await options.backend.cancel(streamId!, "sender");
      const state = await options.backend.getStream(streamId!);
      check(state.status === "Cancelled", "stream is Cancelled", "Cancelled", state.status);
      const remaining = await options.backend.available(streamId!);
      check(remaining === 0n, "cancelled stream has nothing available", 0n, remaining);
      return { receipt, state };
    });
    lastStep().txHash = cancelled.receipt.hash;
    lastStep().envelopeXdr = cancelled.receipt.envelopeXdr;

    finalStream = await step("verify", async () => {
      const state = await options.backend.getStream(streamId!);
      check(state.status === "Cancelled", "final status", "Cancelled", state.status);
      check(state.sender === prepared!.sender, "final sender", prepared!.sender, state.sender);
      check(
        state.recipient === prepared!.recipient,
        "final recipient",
        prepared!.recipient,
        state.recipient
      );
      check(state.withdrawn > 0n, "recipient was paid", "> 0", state.withdrawn);
      return state;
    });
  } catch (error) {
    if (error instanceof CanaryFailure) {
      failure = error.detail;
    } else {
      failure = normalizeFailure(steps[steps.length - 1]?.name ?? "run", error);
    }
  }

  return { steps, prepared, streamId, finalStream, failure };
}

function check(
  condition: boolean,
  message: string,
  expected: unknown,
  actual: unknown
): void {
  if (!condition) throw new CheckError(message, expected, actual);
}

async function waitForAvailable(
  backend: CanaryBackend,
  streamId: bigint,
  minimum: bigint,
  timeoutMs: number,
  intervalMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  let last = 0n;
  for (;;) {
    last = await backend.available(streamId);
    if (last >= minimum) return last;
    if (Date.now() >= deadline) {
      throw new TimeoutError(
        `available(${streamId}) stayed below ${minimum} for ${timeoutMs}ms (last ${last})`
      );
    }
    await sleep(intervalMs);
  }
}
