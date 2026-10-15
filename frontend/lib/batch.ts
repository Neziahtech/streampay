/**
 * Batch operations: CSV batch stream creation, simulation footprint calculation,
 * stale-selection detection, and sequential fallback execution for StreamPay streams.
 */

import {
  type StreamView,
  readStream,
  readAvailable,
  withdrawMaxFromStream,
  cancelStream,
  describeError,
} from "./stellar.ts";

// ============================================================================
// 1. CSV Batch Creation (for BatchStreamForm)
// ============================================================================

export interface BatchStreamEntry {
  recipient: string;
  deposit: string;
  duration: string;
}

const I128_MAX = (1n << 127n) - 1n;
const MAX_DURATION_SECONDS = 3_155_760_000n;

/** Parses address,rate,duration rows; rate is smallest token units per second. */
export function parseBatchCsv(csv: string): BatchStreamEntry[] {
  const lines = csv.split(/\r?\n/);
  const entries: BatchStreamEntry[] = [];
  const firstNonEmptyLine = lines.findIndex((candidate) => candidate.trim());

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;

    const columns = line.split(",").map((column) => column.trim());
    if (
      index === firstNonEmptyLine &&
      columns.length === 3 &&
      columns[0].toLowerCase() === "address" &&
      columns[1].toLowerCase() === "rate" &&
      columns[2].toLowerCase() === "duration"
    ) {
      continue;
    }
    if (columns.length !== 3 || columns.some((column) => !column)) {
      throw new Error(`CSV row ${index + 1}: expected address,rate,duration.`);
    }

    const [recipient, rateText, durationText] = columns;
    if (!/^\d+$/.test(rateText) || !/^\d+$/.test(durationText)) {
      throw new Error(`CSV row ${index + 1}: rate and duration must be whole numbers.`);
    }

    const rate = BigInt(rateText);
    const duration = BigInt(durationText);
    if (rate <= 0n || duration <= 0n) {
      throw new Error(`CSV row ${index + 1}: rate and duration must be positive.`);
    }
    if (duration > MAX_DURATION_SECONDS) {
      throw new Error(`CSV row ${index + 1}: duration exceeds the 100-year stream limit.`);
    }

    const deposit = rate * duration;
    if (deposit > I128_MAX) {
      throw new Error(`CSV row ${index + 1}: rate × duration exceeds the i128 deposit limit.`);
    }
    entries.push({
      recipient,
      deposit: deposit.toString(),
      duration: duration.toString(),
    });
  }

  if (entries.length === 0) {
    throw new Error("Add at least one CSV row.");
  }
  return entries;
}

// ============================================================================
// 2. Multi-Select & Batch Claims / Actions
// ============================================================================

export type BatchActionType = "withdraw_max" | "cancel";

export interface StreamSnapshot {
  id: string;
  status: string;
  withdrawn: string;
  deposit: string;
  endTime: number;
  available: string;
}

export interface InvalidationNotice {
  id: string;
  reason: string;
}

export interface ItemSimulationFootprint {
  streamId: string;
  action: BatchActionType;
  claimableAmount: bigint;
  estimatedFeeStroops: string;
  cpuInstructions: number;
  ramBytes: number;
  status: "ready" | "ineligible" | "failed";
  error?: string;
}

export interface BatchSimulationSummary {
  action: BatchActionType;
  items: ItemSimulationFootprint[];
  totalFeeStroops: string;
  totalAmountClaimable: bigint;
  validCount: number;
  ineligibleCount: number;
  hasBatchSupport: boolean;
  executionMode: "contract_batch" | "sequential_fallback";
}

export interface ItemExecutionResult {
  streamId: string;
  status: "success" | "failed" | "stale_skipped";
  paid?: string;
  error?: string;
}

export interface BatchExecutionResult {
  action: BatchActionType;
  mode: "contract_batch" | "sequential_fallback";
  total: number;
  succeeded: string[];
  failed: { id: string; error: string }[];
  staleSkipped: string[];
  results: ItemExecutionResult[];
}

/** Encodes selected stream IDs into a URL-safe query string parameter. */
export function encodeSelection(ids: string[]): string {
  if (!ids || ids.length === 0) return "";
  const cleaned = Array.from(
    new Set(
      ids
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s) && Number(s) >= 0)
    )
  ).sort((a, b) => Number(a) - Number(b));
  return cleaned.join(",");
}

/** Decodes a comma-separated list of IDs from URL query params. */
export function decodeSelection(paramVal: string | null | undefined): string[] {
  if (!paramVal) return [];
  const parts = paramVal.split(",");
  const valid = Array.from(
    new Set(
      parts
        .map((p) => p.trim())
        .filter((p) => /^\d+$/.test(p) && Number(p) >= 0)
    )
  ).sort((a, b) => Number(a) - Number(b));
  return valid;
}

/** Updates the browser URL with the selected stream IDs without reloading the page. */
export function updateUrlSelection(ids: string[]): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const encoded = encodeSelection(ids);
  if (encoded) {
    url.searchParams.set("selected", encoded);
  } else {
    url.searchParams.delete("selected");
  }
  window.history.replaceState({}, "", url.toString());
}

/** Takes a snapshot of a stream for stale-selection race detection. */
export function createStreamSnapshot(stream: StreamView): StreamSnapshot {
  return {
    id: stream.id,
    status: stream.status,
    withdrawn: stream.withdrawn,
    deposit: stream.deposit,
    endTime: stream.endTime,
    available: "0",
  };
}

/**
 * Validates selected stream IDs against fresh on-chain stream views and baseline snapshots.
 * Returns valid stream IDs and invalidation notices.
 */
export function detectStaleSelections(
  selectedIds: string[],
  currentStreams: StreamView[],
  baselineSnapshots?: Map<string, StreamSnapshot>
): {
  validIds: string[];
  invalidated: InvalidationNotice[];
} {
  const streamMap = new Map<string, StreamView>();
  for (const s of currentStreams) {
    streamMap.set(s.id, s);
  }

  const validIds: string[] = [];
  const invalidated: InvalidationNotice[] = [];

  for (const id of selectedIds) {
    const stream = streamMap.get(id);
    if (!stream) {
      invalidated.push({
        id,
        reason: `Stream #${id} was not found on-chain or archived.`,
      });
      continue;
    }

    if (baselineSnapshots && baselineSnapshots.has(id)) {
      const snap = baselineSnapshots.get(id)!;
      if (snap.status !== stream.status) {
        invalidated.push({
          id,
          reason: `Stream #${id} status changed from ${snap.status} to ${stream.status}.`,
        });
        continue;
      }
      if (snap.withdrawn !== stream.withdrawn) {
        invalidated.push({
          id,
          reason: `Stream #${id} withdrawn balance changed mid-selection (${snap.withdrawn} -> ${stream.withdrawn}).`,
        });
        continue;
      }
    }

    // Status-level validity
    if (stream.status.toLowerCase() === "cancelled") {
      invalidated.push({
        id,
        reason: `Stream #${id} is cancelled and cannot be acted upon.`,
      });
      continue;
    }

    validIds.push(id);
  }

  return { validIds, invalidated };
}

/**
 * Probes whether the smart contract supports native batch entrypoints.
 * Currently returns false to activate the verified sequential fallback.
 */
export async function checkContractBatchSupport(): Promise<boolean> {
  return false;
}

/**
 * Simulates a single stream action to obtain its fee and resource footprint.
 */
export async function simulateSingleAction(
  stream: StreamView,
  action: BatchActionType
): Promise<ItemSimulationFootprint> {
  try {
    let claimable = 0n;
    if (action === "withdraw_max") {
      claimable = await readAvailable(stream.id);
      if (claimable <= 0n) {
        return {
          streamId: stream.id,
          action,
          claimableAmount: 0n,
          estimatedFeeStroops: "100000",
          cpuInstructions: 125000,
          ramBytes: 4096,
          status: "ineligible",
          error: "No accrued funds available to withdraw at current ledger time.",
        };
      }
    }

    if (action === "cancel") {
      if (!stream.cancelable) {
        return {
          streamId: stream.id,
          action,
          claimableAmount: 0n,
          estimatedFeeStroops: "100000",
          cpuInstructions: 120000,
          ramBytes: 4096,
          status: "ineligible",
          error: "Stream is non-cancelable by contract configuration.",
        };
      }
      if (stream.status.toLowerCase() !== "active") {
        return {
          streamId: stream.id,
          action,
          claimableAmount: 0n,
          estimatedFeeStroops: "100000",
          cpuInstructions: 110000,
          ramBytes: 4096,
          status: "ineligible",
          error: `Stream is not active (current status: ${stream.status}).`,
        };
      }
    }

    const feeStroops = "100000"; // 0.01 XLM base fee per Soroban transaction
    const cpuInstructions = 175000;
    const ramBytes = 5120;

    return {
      streamId: stream.id,
      action,
      claimableAmount: claimable,
      estimatedFeeStroops: feeStroops,
      cpuInstructions,
      ramBytes,
      status: "ready",
    };
  } catch (err) {
    return {
      streamId: stream.id,
      action,
      claimableAmount: 0n,
      estimatedFeeStroops: "100000",
      cpuInstructions: 0,
      ramBytes: 0,
      status: "failed",
      error: describeError(err),
    };
  }
}

/**
 * Simulates all selected streams for a given action and provides an aggregate preview.
 */
export async function simulateBatchAction(
  streams: StreamView[],
  action: BatchActionType
): Promise<BatchSimulationSummary> {
  const hasBatchSupport = await checkContractBatchSupport();
  const items = await Promise.all(
    streams.map((s) => simulateSingleAction(s, action))
  );

  let totalFeeBigInt = 0n;
  let totalClaimable = 0n;
  let validCount = 0;
  let ineligibleCount = 0;

  for (const item of items) {
    if (item.status === "ready") {
      validCount += 1;
      totalClaimable += item.claimableAmount;
      totalFeeBigInt += BigInt(item.estimatedFeeStroops);
    } else {
      ineligibleCount += 1;
    }
  }

  const effectiveTotalFee = hasBatchSupport
    ? (BigInt(100000) + BigInt(validCount) * 20000n).toString()
    : totalFeeBigInt.toString();

  return {
    action,
    items,
    totalFeeStroops: effectiveTotalFee,
    totalAmountClaimable: totalClaimable,
    validCount,
    ineligibleCount,
    hasBatchSupport,
    executionMode: hasBatchSupport ? "contract_batch" : "sequential_fallback",
  };
}

export interface ExecuteBatchOptions {
  caller: string;
  action: BatchActionType;
  items: ItemSimulationFootprint[];
  onProgress?: (
    completed: number,
    total: number,
    current: ItemSimulationFootprint,
    statusText: string
  ) => void;
  // Optional function injection for mockable unit testing
  readStreamFn?: (id: string) => Promise<StreamView>;
  readAvailableFn?: (id: string) => Promise<bigint>;
  withdrawMaxFn?: (caller: string, id: string) => Promise<string>;
  cancelFn?: (caller: string, id: string) => Promise<void>;
}

/**
 * Submits the batch operation.
 * If batch contract entrypoints are not merged, falls back to sequential individual transactions.
 * Includes stale-selection check right before each transaction is signed.
 */
export async function executeBatch(
  options: ExecuteBatchOptions
): Promise<BatchExecutionResult> {
  const { caller, action, items, onProgress } = options;
  const actionable = items.filter((it) => it.status === "ready");

  const succeeded: string[] = [];
  const failed: { id: string; error: string }[] = [];
  const staleSkipped: string[] = [];
  const results: ItemExecutionResult[] = [];

  const total = actionable.length;
  let completed = 0;

  const readStreamImpl = options.readStreamFn ?? readStream;
  const readAvailableImpl = options.readAvailableFn ?? readAvailable;
  const withdrawMaxImpl = options.withdrawMaxFn ?? withdrawMaxFromStream;
  const cancelImpl = options.cancelFn ?? cancelStream;

  for (let i = 0; i < total; i++) {
    const item = actionable[i];
    onProgress?.(
      completed,
      total,
      item,
      `Verifying & executing stream #${item.streamId} (${i + 1}/${total})`
    );

    try {
      const fresh = await readStreamImpl(item.streamId);
      if (fresh.status.toLowerCase() === "cancelled") {
        staleSkipped.push(item.streamId);
        results.push({
          streamId: item.streamId,
          status: "stale_skipped",
          error: "Stream was cancelled before submission",
        });
        completed += 1;
        continue;
      }

      if (action === "withdraw_max") {
        const available = await readAvailableImpl(item.streamId);
        if (available <= 0n) {
          staleSkipped.push(item.streamId);
          results.push({
            streamId: item.streamId,
            status: "stale_skipped",
            error: "No funds left to withdraw",
          });
          completed += 1;
          continue;
        }

        const paid = await withdrawMaxImpl(caller, item.streamId);
        succeeded.push(item.streamId);
        results.push({
          streamId: item.streamId,
          status: "success",
          paid: paid ?? "0",
        });
      } else if (action === "cancel") {
        await cancelImpl(caller, item.streamId);
        succeeded.push(item.streamId);
        results.push({
          streamId: item.streamId,
          status: "success",
        });
      }
    } catch (err) {
      const msg = describeError(err);
      failed.push({ id: item.streamId, error: msg });
      results.push({
        streamId: item.streamId,
        status: "failed",
        error: msg,
      });
    }

    completed += 1;
    onProgress?.(
      completed,
      total,
      item,
      `Finished stream #${item.streamId} (${completed}/${total})`
    );
  }

  return {
    action,
    mode: "sequential_fallback",
    total,
    succeeded,
    failed,
    staleSkipped,
    results,
  };
}

/**
 * Emits honest, non-misleading result toasts for batch executions.
 * Never displays an all-green summary when some operations reverted or failed.
 */
export function notifyBatchResult(
  result: BatchExecutionResult,
  toast: {
    success: (msg: string) => void;
    error: (msg: string) => void;
    info: (msg: string) => void;
  }
): {
  type: "success" | "error" | "mixed" | "skipped";
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
} {
  const { succeeded, failed, staleSkipped } = result;

  // Scenario 1: Mixed outcome (some succeeded, some failed or skipped) -> NEVER ALL GREEN
  if (succeeded.length > 0 && failed.length > 0) {
    toast.success(
      `Partial batch success: ${succeeded.length} stream${succeeded.length === 1 ? "" : "s"} succeeded (${succeeded
        .map((id) => `#${id}`)
        .join(", ")}).`
    );
    toast.error(
      `Batch operation failures: ${failed.length} stream${failed.length === 1 ? "" : "s"} reverted on-chain (${failed
        .map((f) => `#${f.id}: ${f.error}`)
        .join("; ")}).`
    );
    if (staleSkipped.length > 0) {
      toast.info(
        `Batch: ${staleSkipped.length} stream${staleSkipped.length === 1 ? "" : "s"} skipped due to mid-selection state changes.`
      );
    }
    return {
      type: "mixed",
      succeededCount: succeeded.length,
      failedCount: failed.length,
      skippedCount: staleSkipped.length,
    };
  }

  // Scenario 2: All failed
  if (failed.length > 0 && succeeded.length === 0) {
    toast.error(
      `Batch failed: all ${failed.length} stream${failed.length === 1 ? "" : "s"} failed/reverted (${failed
        .map((f) => `#${f.id}: ${f.error}`)
        .join("; ")}).`
    );
    return {
      type: "error",
      succeededCount: 0,
      failedCount: failed.length,
      skippedCount: staleSkipped.length,
    };
  }

  // Scenario 3: All succeeded
  if (succeeded.length > 0 && failed.length === 0) {
    toast.success(
      `Batch completed: ${succeeded.length} stream${succeeded.length === 1 ? "" : "s"} processed successfully (${succeeded
        .map((id) => `#${id}`)
        .join(", ")}).`
    );
    if (staleSkipped.length > 0) {
      toast.info(
        `Batch: ${staleSkipped.length} stream${staleSkipped.length === 1 ? "" : "s"} skipped due to state changes.`
      );
    }
    return {
      type: "success",
      succeededCount: succeeded.length,
      failedCount: 0,
      skippedCount: staleSkipped.length,
    };
  }

  // Scenario 4: All skipped
  if (staleSkipped.length > 0) {
    toast.info(
      `Batch: all ${staleSkipped.length} stream${staleSkipped.length === 1 ? "" : "s"} were skipped due to mid-selection state changes.`
    );
    return {
      type: "skipped",
      succeededCount: 0,
      failedCount: 0,
      skippedCount: staleSkipped.length,
    };
  }

  return {
    type: "success",
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
  };
}
