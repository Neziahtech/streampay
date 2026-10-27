"use client";

import Link from "next/link";
import { isNativeXlm, type StreamView } from "@/lib/stellar";

export interface StreamDetailViewProps {
  id: string;
  stream: StreamView | null;
  loadError?: string;
  available?: bigint | null;
  displayAvailable?: bigint | null;
  address?: string | null;
  amount?: string;
  onAmountChange?: (value: string) => void;
  onWithdraw?: (max: boolean) => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
}

export default function StreamDetailView({
  id,
  stream,
  loadError,
  available,
  displayAvailable,
  address = null,
  amount = "",
  onAmountChange,
  onWithdraw,
  onCancel,
}: StreamDetailViewProps) {
  if (loadError && !stream) {
    return (
      <main className="wrap">
        <h1>Stream #{id}</h1>
        <p className="err">{loadError}</p>
        <Link href="/">← All streams</Link>
      </main>
    );
  }

  if (!stream) {
    return (
      <main className="wrap">
        <h1>Stream #{id}</h1>
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const deposit = BigInt(stream.deposit);
  const withdrawn = BigInt(stream.withdrawn);
  const progress =
    deposit > 0n ? Math.min(100, Number((withdrawn * 100n) / deposit)) : 0;
  const isRecipient = address !== null && address === stream.recipient;
  const isSender = address !== null && address === stream.sender;
  const overWithdrawal =
    available !== undefined &&
    available !== null &&
    amount !== "" &&
    BigInt(amount || "0") > available;

  const currentAvailable = (displayAvailable ?? available)?.toString() ?? "…";

  return (
    <main className="wrap">
      <p className="kicker mono">STREAM #{stream.id}</p>
      <h1>
        {stream.status === "Active" ? "⚡ Streaming" : `⏹ ${stream.status}`}
      </h1>

      <section className="card">
        <div className="row">
          <progress value={progress} max={100} style={{ flex: 1 }} />
          <span className="mono">{progress}% withdrawn</span>
        </div>
        <table>
          <tbody>
            <tr>
              <th>Sender</th>
              <td className="mono">{stream.sender}</td>
            </tr>
            <tr>
              <th>Recipient</th>
              <td className="mono">{stream.recipient}</td>
            </tr>
            <tr>
              <th>Token</th>
              <td className="mono" style={{ wordBreak: "break-all" }}>
                {isNativeXlm(stream.token)
                  ? `Native XLM — ${stream.token}`
                  : stream.token}
              </td>
            </tr>
            <tr>
              <th>Deposit</th>
              <td className="mono">{stream.deposit}</td>
            </tr>
            <tr>
              <th>Withdrawn</th>
              <td className="mono">{stream.withdrawn}</td>
            </tr>
            <tr>
              <th>Available now</th>
              <td className="mono">{currentAvailable}</td>
            </tr>
            <tr>
              <th>Window</th>
              <td className="mono">
                {new Date(stream.startTime * 1000).toISOString()} →{" "}
                {new Date(stream.endTime * 1000).toISOString()}
              </td>
            </tr>
            <tr>
              <th>Cancelable</th>
              <td>{String(stream.cancelable)}</td>
            </tr>
            <tr>
              <th>Status</th>
              <td>{stream.status}</td>
            </tr>
          </tbody>
        </table>
      </section>

      {isRecipient && stream.status === "Active" && (
        <section className="card">
          <h2>Withdraw accrued funds</h2>
          <div className="row">
            <input
              type="number"
              min="0"
              placeholder="amount (defaults to available)"
              value={amount}
              onChange={(e) => onAmountChange?.(e.target.value)}
            />
            <button onClick={() => void onWithdraw?.(false)}>Withdraw</button>
            <button
              onClick={() => void onWithdraw?.(true)}
              title="withdraw_max: atomic claim of the full accrued balance"
            >
              Withdraw max
            </button>
          </div>
          {overWithdrawal && (
            <p className="err">
              That exceeds the currently accrued {available?.toString()} units —
              the contract would reject it with AmountExceedsAvailable.
            </p>
          )}
        </section>
      )}

      {(isSender || (isRecipient && stream.cancelable)) &&
        stream.status === "Active" && (
          <section className="card">
            <h2>Cancel stream</h2>
            <p className="muted">
              Pays the recipient everything accrued and refunds the sender the
              rest, atomically. This is irreversible.
            </p>
            <button onClick={() => void onCancel?.()}>Cancel stream</button>
          </section>
        )}

      <p>
        <Link href="/">← All streams</Link>
      </p>
    </main>
  );
}
