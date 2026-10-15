"use client";

import Link from "next/link";
import { useState } from "react";
import { isNativeXlm, type StreamView } from "@/lib/stellar";

export interface StreamListProps {
  streams: StreamView[];
  selectedIds?: string[];
  onToggleSelect?: (id: string) => void;
  onSelectAll?: () => void;
  onDeselectAll?: () => void;
  onWithdraw: (id: string, amount: string) => Promise<void>;
  onWithdrawMax: (id: string) => Promise<void>;
  onTopUp: (id: string, amount: string) => Promise<void>;
  onCancel: (id: string) => Promise<void>;
  onRefresh: (id: string) => void | Promise<void>;
}

export default function StreamList({
  streams,
  selectedIds = [],
  onToggleSelect,
  onSelectAll,
  onDeselectAll,
  onWithdraw,
  onWithdrawMax,
  onTopUp,
  onCancel,
  onRefresh,
}: StreamListProps) {
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  if (streams.length === 0) {
    return (
      <p className="muted">
        No streams loaded yet. Create one above, fetch one by id, or use
        “Discover on-chain” to scan the contract&apos;s address indexes.
      </p>
    );
  }

  const allSelected =
    streams.length > 0 && streams.every((s) => selectedIds.includes(s.id));
  const someSelected =
    streams.some((s) => selectedIds.includes(s.id)) && !allSelected;

  function handleHeaderCheckboxChange() {
    if (allSelected) {
      onDeselectAll?.();
    } else {
      onSelectAll?.();
    }
  }

  return (
    <table>
      <thead>
        <tr>
          {onToggleSelect && (
            <th style={{ width: "40px", textAlign: "center" }}>
              <input
                type="checkbox"
                aria-label="Select all streams"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected;
                }}
                onChange={handleHeaderCheckboxChange}
              />
            </th>
          )}
          <th>#</th>
          <th>Token</th>
          <th>Recipient</th>
          <th>Deposit</th>
          <th>Withdrawn</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {streams.map((s) => {
          const isSelected = selectedIds.includes(s.id);
          return (
            <tr key={s.id} className={isSelected ? "selected-row" : undefined}>
              {onToggleSelect && (
                <td style={{ textAlign: "center" }}>
                  <input
                    type="checkbox"
                    aria-label={`Select stream #${s.id}`}
                    checked={isSelected}
                    onChange={() => onToggleSelect(s.id)}
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
                <span className={`status-badge status-${s.status.toLowerCase()}`}>
                  {s.status}
                </span>
              </td>
              <td>
                <div className="row">
                  <input
                    type="number"
                    min="1"
                    placeholder="amount"
                    value={amounts[s.id] ?? ""}
                    onChange={(e) =>
                      setAmounts((prev) => ({ ...prev, [s.id]: e.target.value }))
                    }
                  />
                  <button onClick={() => onWithdraw(s.id, amounts[s.id] ?? "0")}>
                    Withdraw
                  </button>
                  <button
                    onClick={() => onWithdrawMax(s.id)}
                    title="Claim the entire accrued balance in one call"
                  >
                    Max
                  </button>
                  <button onClick={() => onTopUp(s.id, amounts[s.id] ?? "0")}>
                    Top up
                  </button>
                  <button onClick={() => onCancel(s.id)}>Cancel</button>
                  <button onClick={() => onRefresh(s.id)}>↻</button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
