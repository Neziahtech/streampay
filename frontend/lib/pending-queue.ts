/**
 * Pending Transaction Queue ("The Dangerous Part")
 *
 * Signed Stellar/Soroban transactions are:
 * 1. Single-use: The sequence number is consumed on inclusion.
 * 2. Network-bound: Locked to the networkPassphrase (testnet / public).
 * 3. Time-bound: Expire when closeTime > maxTime (tx_too_late).
 * 4. Sequence-sensitive: Fail with tx_bad_seq if account sequence advances.
 *
 * SECURITY & CORRECTNESS GUARANTEES:
 * - NEVER silently resubmits queued transactions on reconnect.
 * - Refuses stale submissions: rigorously checks sequence drift and preconditions before sending.
 * - Provides clear, understandable UX explaining why a transaction is stale.
 * - Scoped persistence per network and address.
 */

import {
  Networks,
  rpc,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

export type QueuedTxStatus =
  | "pending"
  | "validating"
  | "ready"
  | "submitting"
  | "stale_sequence"
  | "expired_timebounds"
  | "expired_ledger"
  | "failed_submission"
  | "confirmed";

export interface QueuedTransaction {
  id: string;
  createdAt: number;
  address: string;
  network: string;
  contractId: string;
  operationType:
    | "create_stream"
    | "withdraw"
    | "withdraw_max"
    | "top_up"
    | "cancel_stream"
    | "custom";
  description: string;
  signedXdr: string;
  sourceSequence: string;
  minTime?: number;
  maxTime?: number;
  minLedger?: number;
  maxLedger?: number;
  status: QueuedTxStatus;
  staleReason?: string;
  submittedAt?: number;
  txHash?: string;
  error?: string;
}

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
  "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK === "PUBLIC"
    ? Networks.PUBLIC
    : Networks.TESTNET;
const NETWORK_LABEL =
  process.env.NEXT_PUBLIC_NETWORK === "PUBLIC" ? "public" : "testnet";
const CONTRACT_ID = process.env.NEXT_PUBLIC_STREAMING_CONTRACT_ID || "default";

function queueKey(address: string): string {
  return `streampay:${NETWORK_LABEL}:${CONTRACT_ID}:${address}:pendingTxQueue`;
}

/**
 * Extracts metadata (sequence, timebounds, ledgerbounds, hash) from signed XDR.
 */
export function parseSignedTransaction(
  signedXdr: string,
  passphrase = NETWORK_PASSPHRASE
): {
  sequence: string;
  source: string;
  timeBounds?: { minTime: number; maxTime: number };
  ledgerBounds?: { minLedger: number; maxLedger: number };
  txHash: string;
} {
  const parsed = TransactionBuilder.fromXDR(signedXdr, passphrase);
  const tx = (parsed instanceof Transaction ? parsed : (parsed as unknown as { innerTransaction: Transaction }).innerTransaction) as Transaction;
  const hash = Buffer.from(tx.hash()).toString("hex");
  const sequence = tx.sequence;
  const source = tx.source;

  let timeBounds: { minTime: number; maxTime: number } | undefined;
  if (tx.timeBounds) {
    timeBounds = {
      minTime: Number(tx.timeBounds.minTime),
      maxTime: Number(tx.timeBounds.maxTime),
    };
  }

  let ledgerBounds: { minLedger: number; maxLedger: number } | undefined;
  if (tx.ledgerBounds) {
    ledgerBounds = {
      minLedger: Number(tx.ledgerBounds.minLedger),
      maxLedger: Number(tx.ledgerBounds.maxLedger),
    };
  }

  return {
    sequence,
    source,
    timeBounds,
    ledgerBounds,
    txHash: hash,
  };
}

/**
 * Pure check of preconditions and sequence drift without network I/O.
 */
export function checkPreconditions(
  tx: Pick<QueuedTransaction, "sourceSequence" | "minTime" | "maxTime" | "minLedger" | "maxLedger">,
  onChainSequence: bigint,
  currentLedger?: number,
  currentTimeSec: number = Math.floor(Date.now() / 1000)
): { valid: boolean; status: QueuedTxStatus; reason?: string } {
  // 1. Timebounds expiration check
  if (tx.maxTime && tx.maxTime > 0 && currentTimeSec > tx.maxTime) {
    const expiredDate = new Date(tx.maxTime * 1000).toLocaleTimeString();
    return {
      valid: false,
      status: "expired_timebounds",
      reason: `Precondition expired: transaction timebounds expired at ${expiredDate}. Validators will reject this transaction (tx_too_late).`,
    };
  }

  if (tx.minTime && tx.minTime > 0 && currentTimeSec < tx.minTime) {
    return {
      valid: false,
      status: "expired_timebounds",
      reason: `Precondition not met: transaction cannot be submitted before ${new Date(tx.minTime * 1000).toLocaleTimeString()} (tx_too_early).`,
    };
  }

  // 2. Ledger bounds check
  if (currentLedger && tx.maxLedger && tx.maxLedger > 0 && currentLedger > tx.maxLedger) {
    return {
      valid: false,
      status: "expired_ledger",
      reason: `Precondition expired: ledger #${currentLedger} exceeded max ledger #${tx.maxLedger}.`,
    };
  }

  // 3. Sequence number drift check
  const txSeq = BigInt(tx.sourceSequence);
  if (txSeq <= onChainSequence) {
    return {
      valid: false,
      status: "stale_sequence",
      reason: `Sequence drift detected: source account is at sequence #${onChainSequence}, but this transaction was signed for #${txSeq}. The sequence was consumed by another transaction and will fail with tx_bad_seq.`,
    };
  }

  if (txSeq > onChainSequence + 1n) {
    return {
      valid: false,
      status: "stale_sequence",
      reason: `Sequence gap detected: source account is at sequence #${onChainSequence}, but this transaction expects #${txSeq}. Intermediate transactions must be submitted first.`,
    };
  }

  return {
    valid: true,
    status: "ready",
  };
}

/**
 * Loads all queued transactions for an address.
 */
export function getPendingQueue(address: string): QueuedTransaction[] {
  if (typeof window === "undefined" || !address) return [];
  try {
    const raw = window.localStorage.getItem(queueKey(address));
    return raw ? (JSON.parse(raw) as QueuedTransaction[]) : [];
  } catch {
    return [];
  }
}

/**
 * Persists the entire queue for an address.
 */
function saveQueue(address: string, queue: QueuedTransaction[]): void {
  if (typeof window === "undefined" || !address) return;
  try {
    window.localStorage.setItem(queueKey(address), JSON.stringify(queue));
  } catch {
    // Quota error
  }
}

/**
 * Enqueues a signed transaction for offline storage / deferred submission.
 */
export function enqueueTransaction(
  item: Omit<QueuedTransaction, "id" | "createdAt" | "status" | "sourceSequence"> & {
    sourceSequence?: string;
  }
): QueuedTransaction {
  const queue = getPendingQueue(item.address);
  const parsed = parseSignedTransaction(item.signedXdr, item.network as Networks);

  // Check for duplicate transaction in queue
  const existing = queue.find((q) => q.signedXdr === item.signedXdr || q.txHash === parsed.txHash);
  if (existing) {
    return existing;
  }

  const newTx: QueuedTransaction = {
    ...item,
    id: `qtx_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    createdAt: Date.now(),
    sourceSequence: item.sourceSequence || parsed.sequence,
    minTime: parsed.timeBounds?.minTime,
    maxTime: parsed.timeBounds?.maxTime,
    minLedger: parsed.ledgerBounds?.minLedger,
    maxLedger: parsed.ledgerBounds?.maxLedger,
    txHash: parsed.txHash,
    status: "pending",
  };

  queue.unshift(newTx);
  saveQueue(item.address, queue);
  return newTx;
}

/**
 * Updates a queued transaction's fields.
 */
export function updateQueuedTx(
  id: string,
  updates: Partial<QueuedTransaction>,
  address: string
): void {
  const queue = getPendingQueue(address);
  const index = queue.findIndex((t) => t.id === id);
  if (index === -1) return;

  queue[index] = { ...queue[index], ...updates };
  saveQueue(address, queue);
}

/**
 * Removes a transaction from the pending queue.
 */
export function removeQueuedTx(id: string, address: string): void {
  const queue = getPendingQueue(address);
  const filtered = queue.filter((t) => t.id !== id);
  saveQueue(address, filtered);
}

/**
 * Clears all confirmed transactions from the queue.
 */
export function clearConfirmedTx(address: string): void {
  const queue = getPendingQueue(address);
  const filtered = queue.filter((t) => t.status !== "confirmed");
  saveQueue(address, filtered);
}

/**
 * Validates a queued transaction against live on-chain sequence numbers and ledger time.
 */
export async function validateQueuedTx(
  tx: QueuedTransaction,
  serverUrl: string = RPC_URL
): Promise<{ valid: boolean; status: QueuedTxStatus; reason?: string }> {
  try {
    const server = new rpc.Server(serverUrl);
    const [account, latestLedger] = await Promise.all([
      server.getAccount(tx.address),
      server.getLatestLedger().catch(() => null),
    ]);

    const onChainSeq = BigInt(account.sequenceNumber());
    const currentLedger = latestLedger?.sequence;
    const result = checkPreconditions(tx, onChainSeq, currentLedger);

    updateQueuedTx(
      tx.id,
      {
        status: result.status,
        staleReason: result.reason,
      },
      tx.address
    );

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      status: "pending",
      reason: `Could not verify chain status: ${msg}`,
    };
  }
}

/**
 * Submits a valid queued transaction to Soroban RPC.
 * Refuses stale submissions (sequence drift or expired preconditions).
 */
export async function submitQueuedTx(
  tx: QueuedTransaction,
  serverUrl: string = RPC_URL
): Promise<{ success: boolean; hash?: string; error?: string }> {
  // Pre-flight check: Refuse stale submission!
  const validation = await validateQueuedTx(tx, serverUrl);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.reason || `Transaction refused: status is ${validation.status}`,
    };
  }

  const server = new rpc.Server(serverUrl);
  updateQueuedTx(tx.id, { status: "submitting" }, tx.address);

  try {
    const signed = TransactionBuilder.fromXDR(tx.signedXdr, tx.network as Networks);
    const sent = await server.sendTransaction(signed);

    if (sent.status === "ERROR") {
      const errorStr = JSON.stringify(sent.errorResult);
      updateQueuedTx(
        tx.id,
        {
          status: "failed_submission",
          error: errorStr,
          staleReason: "RPC submission rejected",
        },
        tx.address
      );
      return { success: false, error: errorStr };
    }

    // Poll for inclusion up to 30s
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const res = await server.getTransaction(sent.hash);
      if (res.status === rpc.Api.GetTransactionStatus.FAILED) {
        const failErr = JSON.stringify(res.resultXdr);
        updateQueuedTx(
          tx.id,
          {
            status: "failed_submission",
            error: failErr,
            staleReason: "Transaction failed during inclusion",
          },
          tx.address
        );
        return { success: false, error: failErr };
      }
      if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        updateQueuedTx(
          tx.id,
          {
            status: "confirmed",
            submittedAt: Date.now(),
            txHash: sent.hash,
          },
          tx.address
        );
        return { success: true, hash: sent.hash };
      }
    }

    updateQueuedTx(
      tx.id,
      {
        status: "failed_submission",
        error: "Timed out waiting for transaction inclusion",
      },
      tx.address
    );
    return { success: false, error: "Timed out waiting for transaction inclusion" };
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    updateQueuedTx(
      tx.id,
      {
        status: "failed_submission",
        error: errorMsg,
      },
      tx.address
    );
    return { success: false, error: errorMsg };
  }
}
