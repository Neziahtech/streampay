"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { isNativeXlm, type StreamView } from "@/lib/stellar";
/** The contract's batch-claim cap (`stream::MAX_WITHDRAW_BATCH`), mirrored. */
const MAX_WITHDRAW_BATCH = 20;
import {
  encodeSelection,
  decodeSelection,
  updateUrlSelection,
} from "@/lib/batch";

export { encodeSelection, decodeSelection, updateUrlSelection };

export interface StreamListProps {
  streams: StreamView[];
  selectedIds?: string[];
  onToggleSelect?: (id: string) => void;
  onSelectAll?: () => void;
  onDeselectAll?: () => void;
  onWithdraw: (id: string, amount: string) => Promise<void>;
  onWithdrawMax: (id: string) => Promise<void>;
  /**
   * Claims the selected streams in one `withdraw_many` transaction. Omitted
   * while the feature flag is off, and then the list offers no selection UI —
   * every row keeps its single-stream claims.
   */
  onClaimBatch?: (ids: string[]) => Promise<void>;
  onTopUp: (id: string, amount: string) => Promise<void>;
  onCancel: (id: string) => Promise<void>;
  onRefresh: (id: string) => void | Promise<void>;
}

export default function StreamList({
  streams,
  selectedIds,
  onToggleSelect,
  onSelectAll,
  onDeselectAll,
  onWithdraw,
  onWithdrawMax,
  onClaimBatch,
  onTopUp,
  onCancel,
  onRefresh,
}: StreamListProps) {
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [internalSelected, setInternalSelected] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const param = new URLSearchParams(window.location.search).get("selected");
      return decodeSelection(param);
    } catch {
      return [];
    }
  });

  const isControlled = selectedIds !== undefined;
  const selected = isControlled ? selectedIds : internalSelected;

  useEffect(() => {
    updateUrlSelection(selected);
  }, [selected]);

  if (streams.length === 0) {
    return (
      <p className="muted">
        No streams loaded yet. Create one above, fetch one by id, or use
        &ldquo;Discover on-chain&rdquo; to scan the contract&apos;s address indexes.
      </p>
    );
  }

  const batching = Boolean(onClaimBatch || onToggleSelect);
  const atCap = selected.length >= MAX_WITHDRAW_BATCH;

  function toggle(id: string) {
    if (onToggleSelect) {
      onToggleSelect(id);
    } else {
      setInternalSelected((previous) => {
        const next = previous.includes(id)
          ? previous.filter((item) => item !== id)
          : [...previous, id];
        updateUrlSelection(next);
        return next;
      });
    }
  }

  function handleSelectAll(checked: boolean) {
    if (checked) {
      if (onSelectAll) {
        onSelectAll();
      } else {
        const next = streams
          .map((stream) => stream.id)
          .slice(0, MAX_WITHDRAW_BATCH);
        setInternalSelected(next);
        updateUrlSelection(next);
      }
    } else {
      if (onDeselectAll) {
        onDeselectAll();
      } else {
        setInternalSelected([]);
        updateUrlSelection([]);
      }
    }
  }

  return (
    <>
      {onClaimBatch && (
        <div className="row">
          <button
            type="button"
            disabled={selected.length === 0}
            onClick={async () => {
              if (!onClaimBatch || selected.length === 0) return;
              const ids = [...selected];
              if (!isControlled) {
                setInternalSelected([]);
                updateUrlSelection([]);
              }
              await onClaimBatch(ids);
            }}
            aria-label={`Claim the ${selected.length} selected stream(s) in one transaction`}
          >
            Claim selected ({selected.length})
          </button>
          <span className="muted">
            Up to {MAX_WITHDRAW_BATCH} streams settle in one claim.
          </span>
        </div>
      )}
      <table>
        {/* Caption provides an accessible table summary (WCAG 1.3.1) */}
        <caption className="sr-only">Your payment streams</caption>
        <thead>
          <tr>
            {batching && (
              <th scope="col">
                <label className="sr-only" htmlFor="stream-select-all">
                  Select all streams for a batch claim
                </label>
                <input
                  id="stream-select-all"
                  type="checkbox"
                  checked={
                    selected.length > 0 && selected.length === streams.length
                  }
                  onChange={(e) => handleSelectAll(e.target.checked)}
                />
              </th>
            )}
            <th scope="col">#</th>
            <th scope="col">Token</th>
            <th scope="col">Recipient</th>
            <th scope="col">Deposit</th>
            <th scope="col">Withdrawn</th>
            <th scope="col">Status</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {streams.map((s) => {
            // Stable ID for the per-row amount input so label can reference it
            const amountInputId = `stream-amount-${s.id}`;
            const isSelected = selected.includes(s.id);

            return (
              <tr key={s.id} className={isSelected ? "selected-row" : undefined}>
                {batching && (
                  <td>
                    <label
                      className="sr-only"
                      htmlFor={`stream-select-${s.id}`}
                    >
                      Select stream #{s.id} for a batch claim
                    </label>
                    <input
                      id={`stream-select-${s.id}`}
                      type="checkbox"
                      checked={isSelected}
                      // The contract refuses a batch over its cap before reading
                      // anything, so the list refuses to build one.
                      disabled={!isSelected && atCap}
                      onChange={() => toggle(s.id)}
                    />
                  </td>
                )}
                <td className="mono">
                  <Link href={`/stream/${s.id}`}>#{s.id}</Link>
                </td>
                <td className="mono" title={s.token}>
                  {isNativeXlm(s.token) ? "XLM" : `${s.token.slice(0, 10)}…`}
                </td>
                <td className="mono">{s.recipient.slice(0, 8)}…</td>
                <td className="mono">{s.deposit}</td>
                <td className="mono">{s.withdrawn}</td>
                <td>
                  {/* Status badge uses colour + text — WCAG 1.4.1 */}
                  <span
                    className={`status-badge status-${s.status.toLowerCase()}`}
                  >
                    {s.status}
                  </span>
                </td>
                <td>
                  {/*
                   * role="group" with a label provides context for all the
                   * per-row buttons, satisfying WCAG 1.3.1 and 4.1.2.
                   * Each button has a unique aria-label incorporating the
                   * stream ID so AT can distinguish "Withdraw #1" from
                   * "Withdraw #2" (WCAG 2.4.6 Headings and Labels).
                   */}
                  <div
                    className="row"
                    role="group"
                    aria-label={`Actions for stream #${s.id}`}
                  >
                    {/* Visible label is sr-only; the stream ID in aria-label
                        above gives context; placeholder text gives visual hint */}
                    <label htmlFor={amountInputId} className="sr-only">
                      Amount for stream #{s.id} operations
                    </label>
                    <input
                      id={amountInputId}
                      type="number"
                      min="1"
                      placeholder="amount"
                      value={amounts[s.id] ?? ""}
                      onChange={(e) =>
                        setAmounts((prev) => ({
                          ...prev,
                          [s.id]: e.target.value,
                        }))
                      }
                      aria-label={`Amount for stream #${s.id}`}
                    />
                    <button
                      type="button"
                      onClick={() => onWithdraw(s.id, amounts[s.id] ?? "0")}
                      aria-label={`Withdraw from stream #${s.id}`}
                    >
                      Withdraw
                    </button>
                    <button
                      type="button"
                      onClick={() => onWithdrawMax(s.id)}
                      title="Claim the entire accrued balance in one call"
                      aria-label={`Withdraw maximum from stream #${s.id}`}
                    >
                      Max
                    </button>
                    <button
                      type="button"
                      onClick={() => onTopUp(s.id, amounts[s.id] ?? "0")}
                      aria-label={`Top up stream #${s.id}`}
                    >
                      Top up
                    </button>
                    <button
                      type="button"
                      onClick={() => onCancel(s.id)}
                      aria-label={`Cancel stream #${s.id}`}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => onRefresh(s.id)}
                      aria-label={`Refresh stream #${s.id}`}
                    >
                      {/* The ↻ glyph is decorative; the aria-label above is
                          the accessible name (WCAG 4.1.2) */}
                      <span aria-hidden="true">↻</span>
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
