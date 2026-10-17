"use client";

import { useState, useEffect, useCallback } from "react";
import {
  getPendingQueue,
  removeQueuedTx,
  clearConfirmedTx,
  validateQueuedTx,
  submitQueuedTx,
  type QueuedTransaction,
} from "@/lib/pending-queue";
import { useToast } from "@/components/toast";

export default function PendingQueueDrawer({
  address,
  onTxConfirmed,
}: {
  address: string | null;
  onTxConfirmed?: () => void;
}) {
  const toast = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [prevAddress, setPrevAddress] = useState(address);
  const [queue, setQueue] = useState<QueuedTransaction[]>(() =>
    address ? getPendingQueue(address) : []
  );
  const [validatingId, setValidatingId] = useState<string | null>(null);
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  if (address !== prevAddress) {
    setPrevAddress(address);
    setQueue(address ? getPendingQueue(address) : []);
  }

  const refreshQueue = useCallback(() => {
    if (!address) {
      setQueue([]);
      return;
    }
    const items = getPendingQueue(address);
    setQueue(items);
  }, [address]);

  useEffect(() => {
    // Listen to storage events from other tabs
    const handleStorage = (e: StorageEvent) => {
      if (e.key && e.key.includes("pendingTxQueue")) {
        refreshQueue();
      }
    };

    // When connection returns, refresh and auto-validate items
    const handleOnline = async () => {
      if (!address) return;
      const items = getPendingQueue(address);
      setQueue(items);
      toast.info("Connection restored. Verifying preconditions for pending transactions...");
      for (const item of items) {
        if (item.status !== "confirmed") {
          await validateQueuedTx(item);
        }
      }
      refreshQueue();
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("online", handleOnline);
    };
  }, [address, refreshQueue, toast]);

  if (!address) return null;

  const pendingCount = queue.filter((t) => t.status !== "confirmed").length;

  async function handleValidate(tx: QueuedTransaction) {
    setValidatingId(tx.id);
    try {
      const res = await validateQueuedTx(tx);
      refreshQueue();
      if (res.valid) {
        toast.success(`Transaction sequence #${tx.sourceSequence} is valid and ready to submit.`);
      } else {
        toast.error(res.reason || "Preconditions failed.");
      }
    } finally {
      setValidatingId(null);
    }
  }

  async function handleSubmit(tx: QueuedTransaction) {
    setSubmittingId(tx.id);
    try {
      const res = await submitQueuedTx(tx);
      refreshQueue();
      if (res.success) {
        toast.success(`Transaction confirmed on-chain! Hash: ${res.hash?.slice(0, 8)}…`);
        if (onTxConfirmed) onTxConfirmed();
      } else {
        toast.error(`Submission refused or failed: ${res.error}`);
      }
    } finally {
      setSubmittingId(null);
    }
  }

  function handleDiscard(id: string) {
    if (!address) return;
    removeQueuedTx(id, address);
    refreshQueue();
    toast.info("Queued transaction discarded.");
  }

  function handleClearConfirmed() {
    if (!address) return;
    clearConfirmedTx(address);
    refreshQueue();
  }

  return (
    <section className="card pending-queue-card" aria-labelledby="pending-queue-title">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 id="pending-queue-title" style={{ margin: "0 0 4px" }}>
            Pending Transaction Queue
          </h2>
          <p className="muted" style={{ margin: 0, fontSize: "13px" }}>
            Signed-but-unsent transactions saved for submission.
            {pendingCount > 0 ? (
              <strong style={{ color: "var(--accent2)", marginLeft: "6px" }}>
                {pendingCount} action{pendingCount === 1 ? "" : "s"} waiting
              </strong>
            ) : (
              <span style={{ marginLeft: "6px" }}>Queue is empty.</span>
            )}
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          {pendingCount > 0 && (
            <button
              type="button"
              onClick={() => setIsOpen((prev) => !prev)}
              aria-expanded={isOpen}
              aria-controls="pending-queue-details"
            >
              {isOpen ? "Hide Queue" : `View Queue (${pendingCount})`}
            </button>
          )}
          {queue.some((t) => t.status === "confirmed") && (
            <button
              type="button"
              onClick={handleClearConfirmed}
              style={{ background: "transparent", border: "1px solid var(--line)" }}
            >
              Clear Confirmed
            </button>
          )}
        </div>
      </div>

      {isOpen && (
        <div id="pending-queue-details" style={{ marginTop: "16px" }}>
          {queue.length === 0 ? (
            <p className="muted">No transactions in queue.</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "12px" }}>
              {queue.map((tx) => {
                const isSubmitting = submittingId === tx.id || tx.status === "submitting";
                const isValidating = validatingId === tx.id || tx.status === "validating";
                const isStale = tx.status === "stale_sequence";
                const isExpired = tx.status === "expired_timebounds" || tx.status === "expired_ledger";
                const isConfirmed = tx.status === "confirmed";
                const isFailed = tx.status === "failed_submission";
                const isReady = tx.status === "ready";

                return (
                  <li
                    key={tx.id}
                    style={{
                      background: "var(--bg)",
                      border: "1px solid var(--line)",
                      borderRadius: "8px",
                      padding: "14px",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "10px" }}>
                      <div>
                        <strong style={{ fontSize: "15px" }}>{tx.description}</strong>
                        <div style={{ fontSize: "12px", color: "var(--muted)", marginTop: "4px" }}>
                          Created: {new Date(tx.createdAt).toLocaleTimeString()} · Source Sequence: <code className="mono">#{tx.sourceSequence}</code>
                          {tx.maxTime ? ` · Expires: ${new Date(tx.maxTime * 1000).toLocaleTimeString()}` : ""}
                        </div>
                      </div>

                      {/* Status Badges */}
                      <div>
                        {isConfirmed && (
                          <span className="status-badge" style={{ background: "rgba(61, 220, 132, 0.15)", color: "var(--green)", border: "1px solid var(--green)" }}>
                            Confirmed
                          </span>
                        )}
                        {isReady && (
                          <span className="status-badge" style={{ background: "rgba(61, 220, 132, 0.15)", color: "var(--green)", border: "1px solid var(--green)" }}>
                            Ready to Submit
                          </span>
                        )}
                        {tx.status === "pending" && (
                          <span className="status-badge" style={{ background: "rgba(57, 197, 255, 0.15)", color: "var(--accent2)", border: "1px solid var(--accent2)" }}>
                            Pending
                          </span>
                        )}
                        {isSubmitting && (
                          <span className="status-badge" style={{ background: "rgba(139, 124, 255, 0.15)", color: "var(--accent)", border: "1px solid var(--accent)" }}>
                            Submitting…
                          </span>
                        )}
                        {isStale && (
                          <span className="status-badge" style={{ background: "rgba(255, 107, 107, 0.15)", color: "var(--red)", border: "1px solid var(--red)" }}>
                            Stale (Sequence Drift)
                          </span>
                        )}
                        {isExpired && (
                          <span className="status-badge" style={{ background: "rgba(245, 158, 11, 0.15)", color: "var(--amber)", border: "1px solid var(--amber)" }}>
                            Expired Preconditions
                          </span>
                        )}
                        {isFailed && (
                          <span className="status-badge" style={{ background: "rgba(255, 107, 107, 0.15)", color: "var(--red)", border: "1px solid var(--red)" }}>
                            Failed
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Stale / Expired Explanation Box (Never Silent Resubmit) */}
                    {(isStale || isExpired || tx.staleReason) && !isConfirmed && (
                      <div
                        role="alert"
                        style={{
                          marginTop: "10px",
                          padding: "10px 12px",
                          borderRadius: "6px",
                          fontSize: "13px",
                          background: isStale ? "rgba(255, 107, 107, 0.1)" : "rgba(245, 158, 11, 0.1)",
                          borderLeft: `4px solid ${isStale ? "var(--red)" : "var(--amber)"}`,
                          color: "var(--text)",
                        }}
                      >
                        <strong>Refused stale submission: </strong>
                        {tx.staleReason || "The conditions under which this transaction was signed are no longer valid."}
                        <div style={{ marginTop: "4px", fontSize: "12px", color: "var(--muted)" }}>
                          Signed XDR is single-use and bound to exact account sequence numbers. Discard this entry and re-sign with fresh account sequence.
                        </div>
                      </div>
                    )}

                    {/* Actions */}
                    {!isConfirmed && (
                      <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
                        <button
                          type="button"
                          onClick={() => handleSubmit(tx)}
                          disabled={isSubmitting || isValidating || isStale || isExpired}
                          title={isStale || isExpired ? "Cannot submit: preconditions failed" : "Submit signed XDR to network"}
                          style={{
                            background: isStale || isExpired ? "#22304a" : "var(--accent)",
                            cursor: isStale || isExpired ? "not-allowed" : "pointer",
                            opacity: isStale || isExpired ? 0.6 : 1,
                          }}
                        >
                          {isSubmitting ? "Submitting…" : "Review & Submit"}
                        </button>

                        <button
                          type="button"
                          onClick={() => handleValidate(tx)}
                          disabled={isSubmitting || isValidating}
                          style={{ background: "transparent", border: "1px solid var(--line)" }}
                        >
                          {isValidating ? "Validating…" : "Validate"}
                        </button>

                        <button
                          type="button"
                          onClick={() => handleDiscard(tx.id)}
                          style={{ background: "transparent", border: "1px solid var(--line)", color: "var(--red)" }}
                        >
                          Discard
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
