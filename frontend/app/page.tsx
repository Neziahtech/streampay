"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { isConnected, requestAccess } from "@stellar/freighter-api";
import {
  createStream,
  createStreams,
  withdrawFromStream,
  withdrawMaxFromStream,
  topUpStream,
  cancelStream,
  bindPayout,
  confirmPayout,
  cancelPayout,
  readPayoutAddress,
  readPendingPayout,
  readStream,
  fetchStreamsFor,
  describeError,
  type StreamView,
  type PayoutProposalView,
} from "@/lib/stellar";
import { loadStreamIds, saveStreamId } from "@/lib/storage";
import StreamForm from "@/components/StreamForm";
import BatchStreamForm from "@/components/BatchStreamForm";
import StreamList from "@/components/StreamList";
import { useToast } from "@/components/toast";

function formatCountdown(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return `${days}d ${hours}h ${minutes}m ${remainder}s`;
}

export default function Home() {
  const toast = useToast();
  const [address, setAddress] = useState<string | null>(null);
  const [streams, setStreams] = useState<StreamView[]>([]);
  const [lookupId, setLookupId] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [payoutAddress, setPayoutAddress] = useState<string | null>(null);
  const [pendingPayout, setPendingPayout] =
    useState<PayoutProposalView | null>(null);
  const [payoutInput, setPayoutInput] = useState("");
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [now, setNow] = useState(0);

  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function refreshPayoutBinding(owner: string) {
    const [active, pending] = await Promise.all([
      readPayoutAddress(owner),
      readPendingPayout(owner),
    ]);
    setPayoutAddress(active);
    setPendingPayout(pending);
  }

  async function connect() {
    try {
      const { isConnected: connected, error: connectedError } =
        await isConnected();
      if (connectedError || !connected) {
        toast.error("Freighter not detected — install the extension and reload.");
        return;
      }
      const { address, error: accessError } = await requestAccess();
      if (accessError || !address) {
        toast.error(
          `Wallet connection failed: ${
            accessError?.message ?? "no address returned from Freighter."
          }`
        );
        return;
      }
      setAddress(address);
      toast.success(`Connected as ${address.slice(0, 8)}…`);
      await refreshPayoutBinding(address);
      // Rehydrate the cached list (ids only; state is always read fresh).
      const cached = loadStreamIds(address);
      if (cached.length > 0) {
        const views = await Promise.all(
          cached.map((id) => readStream(id).catch(() => null))
        );
        setStreams(
          views.filter((s): s is StreamView => s !== null).reverse()
        );
      }
    } catch (e) {
      toast.error(`Wallet connection failed: ${String(e)}`);
    }
  }

  async function refresh(id: string) {
    try {
      const s = await readStream(id);
      setStreams((prev) => [s, ...prev.filter((x) => x.id !== id)]);
      if (address) saveStreamId(address, id);
    } catch (e) {
      toast.error(describeError(e));
    }
  }

  async function discover() {
    if (!address) return;
    try {
      const [asRecipient, asSender] = await Promise.all([
        fetchStreamsFor(address, "recipient"),
        fetchStreamsFor(address, "sender"),
      ]);
      const byId = new Map<string, StreamView>();
      for (const s of [...asRecipient, ...asSender]) byId.set(s.id, s);
      const found = [...byId.values()].sort((a, b) => Number(b.id) - Number(a.id));
      setStreams(found);
      toast.info(`Discovered ${found.length} stream(s) on-chain.`);
      for (const s of found) saveStreamId(address, s.id);
    } catch (e) {
      toast.error(describeError(e));
    }
  }

  async function fetchStreamById() {
    const id = lookupId.trim();

    if (!id) {
      toast.error("Enter a stream ID.");
      return;
    }

    setLookupLoading(true);

    try {
      const stream = await readStream(id);
      setStreams((prev) => [stream, ...prev.filter((x) => x.id !== stream.id)]);
      toast.success(`Stream #${stream.id} loaded.`);
      setLookupId("");
    } catch {
      toast.error("Stream not found. Check the ID and try again.");
    } finally {
      setLookupLoading(false);
    }
  }

  if (!address) {
    return (
      <main className="wrap">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="kicker mono">SOROBAN · STELLAR</div>
          <Link href="/docs" style={{ color: "#38bdf8", fontSize: "0.85rem", textDecoration: "none" }}>
            API Docs ↗
          </Link>
        </div>
        <h1>⚡ StreamPay</h1>
        <p className="muted">
          Continuous, per-second payment streams — payroll, vesting,
          subscriptions. Connect Freighter to begin.
        </p>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <button onClick={connect}>Connect Freighter</button>
          <a
            href="/simulator"
            style={{
              display: "inline-block",
              marginTop: "14px",
              padding: "10px 18px",
              background: "#161f30",
              border: "1px solid var(--line)",
              borderRadius: "8px",
              color: "var(--accent2)",
              textDecoration: "none",
              fontWeight: 600,
              fontSize: "14px",
            }}
          >
            Accrual Simulator →
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="wrap">
      <h1>⚡ StreamPay</h1>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <p className="muted">
          Connected: <code>{address}</code>
        </p>
        <a
          href="/simulator"
          style={{
            color: "var(--accent2)",
            textDecoration: "none",
            fontSize: "13px",
            fontWeight: 600,
          }}
        >
          Accrual Simulator →
        </a>
      </div>

      <StreamForm
        onCreate={async (args) => {
          try {
            const id = await createStream(address, args);
            toast.success(`Stream #${id} created.`);
            await refresh(String(id));
          } catch (e) {
            toast.error(describeError(e));
          }
        }}
      />

      <BatchStreamForm
        onCreate={async (token, entries, cancelable) => {
          try {
            const ids = await createStreams(address, token, entries, cancelable);
            toast.success(
              `${ids.length} stream${ids.length === 1 ? "" : "s"} created: ${ids
                .map((id) => `#${id}`)
                .join(", ")}.`
            );
            await Promise.all(ids.map((id) => refresh(String(id))));
            return true;
          } catch (e) {
            toast.error(describeError(e));
            return false;
          }
        }}
      />

      <section className="card payout-routing">
        <h2>Payout destination</h2>
        <p className="muted">
          Claims remain authorized by your connected address. A destination
          change takes 24 hours and needs a second confirmation.
        </p>
        <p className="payout-current">
          Active: <code>{payoutAddress ?? "Loading…"}</code>
        </p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const destination = payoutInput.trim();
            if (!destination) return;
            setPayoutBusy(true);
            try {
              const activatesAt = await bindPayout(address, destination);
              setPayoutInput("");
              toast.success(
                `Payout change proposed. Confirmation opens ${new Date(
                  Number(activatesAt) * 1000
                ).toLocaleString()}.`
              );
              await refreshPayoutBinding(address);
            } catch (e) {
              toast.error(describeError(e));
            } finally {
              setPayoutBusy(false);
            }
          }}
        >
          <label htmlFor="payout-address">New payout address</label>
          <div className="row">
            <input
              id="payout-address"
              type="text"
              autoComplete="off"
              placeholder="Stellar account address"
              value={payoutInput}
              onChange={(event) => setPayoutInput(event.target.value)}
            />
            <button type="submit" disabled={payoutBusy || !payoutInput.trim()}>
              {payoutBusy ? "Submitting…" : "Propose destination"}
            </button>
          </div>
        </form>
        {pendingPayout && (
          <div className="payout-pending" aria-live="polite">
            <p>
              Pending: <code>{pendingPayout.payoutAddress}</code>
            </p>
            <p className="muted">
              {now && pendingPayout.activatesAt > now
                ? `Confirm available in ${formatCountdown(
                    pendingPayout.activatesAt - now
                  )}`
                : "Confirmation is available"}
            </p>
            <div className="row">
              <button
                type="button"
                disabled={payoutBusy || !now || now < pendingPayout.activatesAt}
                onClick={async () => {
                  setPayoutBusy(true);
                  try {
                    await confirmPayout(address);
                    toast.success("Payout destination activated.");
                    await refreshPayoutBinding(address);
                  } catch (e) {
                    toast.error(describeError(e));
                  } finally {
                    setPayoutBusy(false);
                  }
                }}
              >
                Confirm destination
              </button>
              <button
                type="button"
                className="button-secondary"
                disabled={payoutBusy}
                onClick={async () => {
                  setPayoutBusy(true);
                  try {
                    await cancelPayout(address);
                    toast.success("Pending payout change cancelled.");
                    await refreshPayoutBinding(address);
                  } catch (e) {
                    toast.error(describeError(e));
                  } finally {
                    setPayoutBusy(false);
                  }
                }}
              >
                Cancel proposal
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Fetch stream by ID</h2>

        <div className="row">
          <input
            type="text"
            inputMode="numeric"
            placeholder="Stream ID"
            value={lookupId}
            onChange={(e) => setLookupId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void fetchStreamById();
              }
            }}
          />

          <button
            type="button"
            onClick={fetchStreamById}
            disabled={lookupLoading}
          >
            {lookupLoading ? "Fetching..." : "Fetch stream"}
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Your streams</h2>
        <div className="row">
          <button onClick={discover} title="Scan the on-chain address indexes">
            Discover on-chain
          </button>
        </div>
        <StreamList
          streams={streams}
          onWithdraw={async (id, amount) => {
            try {
              await withdrawFromStream(address, id, amount);
              toast.success(`Withdrew ${amount} units from stream #${id}.`);
              await refresh(id);
            } catch (e) {
              toast.error(describeError(e));
            }
          }}
          onWithdrawMax={async (id) => {
            try {
              const paid = await withdrawMaxFromStream(address, id);
              toast.success(`Claimed ${paid} units from stream #${id}.`);
              await refresh(id);
            } catch (e) {
              toast.error(describeError(e));
            }
          }}
          onTopUp={async (id, amount) => {
            try {
              await topUpStream(address, id, amount);
              toast.success(`Topped up stream #${id} by ${amount} units.`);
              await refresh(id);
            } catch (e) {
              toast.error(describeError(e));
            }
          }}
          onCancel={async (id) => {
            try {
              await cancelStream(address, id);
              toast.success(`Stream #${id} cancelled.`);
              await refresh(id);
            } catch (e) {
              toast.error(describeError(e));
            }
          }}
          onRefresh={(id) => refresh(id)}
        />
      </section>
    </main>
  );
}