"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { readAvailableAction, readStreamAction } from "@/app/actions";
import { describeError } from "@/lib/errors";
import { computeAvailable, type StreamSnapshot } from "@/lib/accrual";
import type { StreamView } from "@/lib/stream-types";

function fmtUnits(value: bigint): string {
  return value.toString();
}

export default function StreamDetailClient({
  initialStream,
}: {
  initialStream: StreamView;
}) {
  const id = initialStream.id;
  const [stream, setStream] = useState<StreamView>(initialStream);
  const [available, setAvailable] = useState<bigint | null>(null);
  const [displayAvailable, setDisplayAvailable] = useState<bigint | null>(null);
  const [snapshot, setSnapshot] = useState<StreamSnapshot | null>(null);
  const [amount, setAmount] = useState("");
  const [address, setAddress] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const applyStream = useCallback((next: StreamView) => {
    setStream(next);
    setSnapshot({
      deposit: BigInt(next.deposit),
      startTime: next.startTime,
      endTime: next.endTime,
      withdrawn: BigInt(next.withdrawn),
      status: next.status,
    });
  }, []);

  const reload = useCallback(async () => {
    try {
      const [nextStream, nextAvailable] = await Promise.all([
        readStreamAction(id),
        readAvailableAction(id),
      ]);
      applyStream(nextStream);
      setAvailable(BigInt(nextAvailable));
      setError("");
    } catch (e) {
      setError(describeError(e));
    }
  }, [applyStream, id]);

  useEffect(() => {
    applyStream(initialStream);
    void readAvailableAction(id)
      .then((value) => setAvailable(BigInt(value)))
      .catch((e: unknown) => setError(describeError(e)));
    const timer = setInterval(() => void reload(), 15_000);
    return () => clearInterval(timer);
  }, [applyStream, id, initialStream, reload]);

  useEffect(() => {
    if (!snapshot) return;
    const timer = setInterval(() => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      setDisplayAvailable(
        computeAvailable(
          snapshot.deposit,
          snapshot.startTime,
          snapshot.endTime,
          snapshot.withdrawn,
          snapshot.status,
          now
        )
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [snapshot]);

  useEffect(() => {
    void (async () => {
      try {
        const { getAddress, isConnected } = await import("@stellar/freighter-api");
        if (await isConnected()) {
          const { address: walletAddress } = await getAddress();
          setAddress(walletAddress);
        }
      } catch {
        // Detail view stays read-only without a wallet.
      }
    })();
  }, []);

  const deposit = BigInt(stream.deposit);
  const withdrawn = BigInt(stream.withdrawn);
  const progress =
    deposit > 0n ? Math.min(100, Number((withdrawn * 100n) / deposit)) : 0;
  const isRecipient = address !== null && address === stream.recipient;
  const isSender = address !== null && address === stream.sender;
  const overWithdrawal =
    available !== null && amount !== "" && BigInt(amount || "0") > available;

  async function doWithdraw(max: boolean) {
    if (!address) return;
    setError("");
    setStatus("");
    try {
      if (max) {
        const { withdrawMaxFromStream } = await import("@/lib/stellar");
        const paid = await withdrawMaxFromStream(address, stream.id);
        setStatus(`Claimed ${fmtUnits(paid)} units.`);
      } else {
        if (overWithdrawal) {
          setError(
            `Amount exceeds the accrued balance (${available?.toString()} units). Try “Withdraw max”.`
          );
          return;
        }
        const { withdrawFromStream } = await import("@/lib/stellar");
        await withdrawFromStream(address, stream.id, amount || "0");
        setStatus("Withdrawal sent.");
      }
      setAmount("");
      await reload();
    } catch (e) {
      setError(describeError(e));
    }
  }

  async function doCancel() {
    if (!address) return;
    setError("");
    try {
      const { cancelStream } = await import("@/lib/stellar");
      await cancelStream(address, stream.id);
      setStatus("Stream cancelled.");
      await reload();
    } catch (e) {
      setError(describeError(e));
    }
  }

  return (
    <main className="wrap">
      <p className="kicker mono">STREAM #{stream.id}</p>
      <h1>
        {stream.status === "Active" ? "⚡ Streaming" : `⏹ ${stream.status}`}
      </h1>
      {status && <p className="ok">{status}</p>}
      {error && <p className="err">{error}</p>}

      <section className="card">
        <div className="row">
          <progress value={progress} max={100} style={{ flex: 1 }} />
          <span className="mono">{progress}% withdrawn</span>
        </div>
        <table>
          <tbody>
            <tr><th>Sender</th><td className="mono">{stream.sender}</td></tr>
            <tr><th>Recipient</th><td className="mono">{stream.recipient}</td></tr>
            <tr><th>Token</th><td className="mono">{stream.token}</td></tr>
            <tr><th>Deposit</th><td className="mono">{stream.deposit}</td></tr>
            <tr><th>Withdrawn</th><td className="mono">{stream.withdrawn}</td></tr>
            <tr>
              <th>Available now</th>
              <td className="mono">
                {snapshot?.status === "Active"
                  ? (displayAvailable ?? available)?.toString() ?? "…"
                  : available?.toString() ?? "…"}
              </td>
            </tr>
            <tr>
              <th>Window</th>
              <td className="mono">
                {new Date(stream.startTime * 1000).toISOString()} →{" "}
                {new Date(stream.endTime * 1000).toISOString()}
              </td>
            </tr>
            <tr><th>Cancelable</th><td>{String(stream.cancelable)}</td></tr>
            <tr><th>Status</th><td>{stream.status}</td></tr>
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
              onChange={(event) => setAmount(event.target.value)}
            />
            <button onClick={() => void doWithdraw(false)}>Withdraw</button>
            <button
              onClick={() => void doWithdraw(true)}
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
            <button onClick={() => void doCancel()}>Cancel stream</button>
          </section>
        )}

      <p><Link href="/">← All streams</Link></p>
    </main>
  );
}