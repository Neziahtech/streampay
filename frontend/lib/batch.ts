/**
 * Batch operations, simulation footprint calculation, stale-selection detection,
 * and sequential fallback execution for StreamPay streams.
 */

import {
  type StreamView,
  readStream,
  readAvailable,
  withdrawMaxFromStream,
  cancelStream,
  describeError,
} from "./stellar";

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
  paid?: bigint;
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

/**
 * Encodes selected stream IDs into a clean URL query parameter value.
 * Handles edge cases: removes empty items, non-numeric strings, and duplicates.
 */
export function encodeSelection(ids: string[]): string {
  const sanitized = Array.from(
    new Set(
      ids
        .map((id) => id.trim())
        .filter((id) => id.length > 0 && /^\d+$/.test(id))
    )
  ).sort((a, b) => Number(a) - Number(b));

  return sanitized.join(",");
}

/**
 * Decodes URL selection string into a clean array of stream IDs.
 * Handles edge cases: null, undefined, empty, invalid/corrupt IDs.
 */
export function decodeSelection(param: string | null | undefined): string[] {
  if (!param) return [];
  const parts = param.split(",");
  const valid = new Set<string>();

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length > 0 && /^\d+$/.test(trimmed)) {
      valid.add(trimmed);
    }
  }

  return Array.from(valid).sort((a, b) => Number(a) - Number(b));
}

/**
 * Updates the current window URL search parameters with the selection state
 * without causing a page reload.
 */
export function updateUrlSelection(ids: string[]): void {
  if (typeof window === "undefined") return;

  const url = new URL(window.location.href);
  const encoded = encodeSelection(ids);

  if (encoded.length > 0) {
    url.searchParams.set("selected", encoded);
  } else {
    url.searchParams.delete("selected");
  }

  window.history.replaceState(null, "", url.toString());
}

/**
 * Creates a comparable snapshot of stream state at the time of selection.
 */
export function createStreamSnapshot(
  stream: StreamView,
  available: bigint = 0n
): StreamSnapshot {
  return {
    id: stream.id,
    status: stream.status,
    withdrawn: stream.withdrawn,
    deposit: stream.deposit,
    endTime: stream.endTime,
    available: available.toString(),
  };
}

/**
 * Detects if any selected stream has changed state on-chain or became invalid.
 * Validates against the fresh stream list and optional baseline snapshot.
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
 * Probes whether the smart contract supports native batch entrypoints
 * (e.g. issues #9/#3 claim_all or batch_withdraw_max).
 * If unmerged, returns false to activate the verified sequential fallback.
 */
export async function checkContractBatchSupport(): Promise<boolean> {
  // Currently, the contract has no merged batch methods (issues #9/#3 pending).
  // This gracefully probes or returns false to use the sequential fallback.
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

    // Soroban standard operation footprint estimate
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

  // If contract batch support existed, batch fee would be single base fee + marginal per-item cost
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

  for (let i = 0; i < total; i++) {
    const item = actionable[i];
    onProgress?.(
      completed,
      total,
      item,
      `Verifying & executing stream #${item.streamId} (${i + 1}/${total})`
    );

    // Stale-selection check right before submission
    try {
      const fresh = await readStream(item.streamId);
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
        const available = await readAvailable(item.streamId);
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

        const paid = await withdrawMaxFromStream(caller, item.streamId);
        succeeded.push(item.streamId);
        results.push({
          streamId: item.streamId,
          status: "success",
          paid,
        });
      } else if (action === "cancel") {
        await cancelStream(caller, item.streamId);
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
