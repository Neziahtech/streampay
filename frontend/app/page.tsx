"use client";

import { useState } from "react";
import Link from "next/link";
import { isConnected, requestAccess } from "@stellar/freighter-api";
import {
  createStream,
  createStreams,
  withdrawFromStream,
  withdrawMaxFromStream,
  withdrawAllFromStreams,
  topUpStream,
  cancelStream,
  readStream,
  fetchStreamsFor,
  fetchAssetMeta,
  describeError,
  type StreamView,
} from "@/lib/stellar";
import { formatAmount } from "@/lib/format";
import { loadStreamIds, saveStreamId } from "@/lib/storage";
import { checkWalletNetwork } from "@/lib/network";
import StreamForm from "@/components/StreamForm";
import BatchStreamForm from "@/components/BatchStreamForm";
import StreamList from "@/components/StreamList";
import { useToast } from "@/components/toast";

export default function Home() {
  const toast = useToast();
  const [address, setAddress] = useState<string | null>(null);
  const [streams, setStreams] = useState<StreamView[]>([]);
  const [lookupId, setLookupId] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [claimAllLoading, setClaimAllLoading] = useState(false);

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
      // Surface a wallet/app network mismatch here instead of letting it
      // arrive later as an opaque signing error (issue #33).
      await checkWalletNetwork();
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

  async function handleClaimAll() {
    if (!address) return;
    setClaimAllLoading(true);
    try {
      const res = await withdrawAllFromStreams(address);
      if (res.successfulStreamIds.length === 0) {
        if (res.failedStreams.length > 0) {
          toast.info(
            `No funds available to claim across ${res.failedStreams.length} stream(s).`
          );
        } else {
          toast.info("No claimable streams found.");
        }
      } else {
        const transferSummaries = await Promise.all(
          res.transfers.map(async (t) => {
            try {
              const meta = await fetchAssetMeta(t.token);
              return `${formatAmount(t.amount, meta.decimals)} ${meta.code}`;
            } catch {
              return `${t.amount} units`;
            }
          })
        );
        const transferText = transferSummaries.join(", ");
        let msg = `Successfully claimed ${transferText} across ${res.successfulStreamIds.length} stream(s).`;
        if (res.failedStreams.length > 0) {
          msg += ` (${res.failedStreams.length} skipped or non-claimable)`;
        }
        if (res.nextOffset !== null) {
          msg += ` Note: More streams remain (continuation offset ${res.nextOffset}). Click "Claim all" again to process the next page.`;
        }
        toast.success(msg);
        await Promise.all(
          res.successfulStreamIds.map((id) => refresh(id).catch(() => null))
        );
      }
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setClaimAllLoading(false);
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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap" }}>
          <div>
            <div className="kicker mono">SOROBAN · STELLAR</div>
            <h1>⚡ StreamPay</h1>
          </div>
          <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
            <Link href="/benchmarks" style={{ color: "var(--accent2)", fontSize: "0.85rem", textDecoration: "none" }}>
              Benchmarks 📊
            </Link>
            <Link href="/docs" style={{ color: "#38bdf8", fontSize: "0.85rem", textDecoration: "none" }}>
              API Docs ↗
            </Link>
            <Link href="/listings" style={{ color: "var(--accent2)", fontSize: "14px", textDecoration: "none" }}>
              Browse Discovery Directory →
            </Link>
          </div>
        </div>
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap" }}>
        <h1>⚡ StreamPay</h1>
        <div style={{ display: "flex", gap: "16px", alignItems: "baseline" }}>
          <Link
            href="/benchmarks"
            style={{
              color: "var(--accent2)",
              textDecoration: "none",
              fontSize: "13px",
              fontWeight: 600,
            }}
          >
            Benchmarks 📊
          </Link>
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
          <Link href="/listings" style={{ color: "var(--accent2)", fontSize: "14px", textDecoration: "none" }}>
            Browse Discovery Directory →
          </Link>
        </div>
      </div>
      <p className="muted">
        Connected: <code>{address}</code>
      </p>

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
        <div className="row" style={{ gap: "10px", flexWrap: "wrap" }}>
          <button onClick={discover} title="Scan the on-chain address indexes">
            Discover on-chain
          </button>
          <button
            type="button"
            onClick={handleClaimAll}
            disabled={claimAllLoading}
            title="Claim all accrued funds across all your streams in one transaction"
            style={{
              background: "var(--accent, #0ea5e9)",
              color: "#fff",
              fontWeight: 600,
            }}
          >
            {claimAllLoading ? "Claiming all..." : "⚡ Claim all"}
          </button>
        </div>
        <StreamList
          streams={streams}
          onWithdraw={async (id, amount) => {
            try {
              await withdrawFromStream(address, id, amount);
              const target = streams.find((s) => s.id === id);
              let amountLabel = `${amount} units`;
              if (target) {
                const meta = await fetchAssetMeta(target.token);
                amountLabel = `${formatAmount(BigInt(amount), meta.decimals)} ${meta.code}`;
              }
              toast.success(`Withdrew ${amountLabel} from stream #${id}.`);
              await refresh(id);
            } catch (e) {
              toast.error(describeError(e));
            }
          }}
          onWithdrawMax={async (id) => {
            try {
              const paid = await withdrawMaxFromStream(address, id);
              const target = streams.find((s) => s.id === id);
              let paidLabel = `${paid} units`;
              if (target) {
                const meta = await fetchAssetMeta(target.token);
                paidLabel = `${formatAmount(paid, meta.decimals)} ${meta.code}`;
              }
              toast.success(`Claimed ${paidLabel} from stream #${id}.`);
              await refresh(id);
            } catch (e) {
              toast.error(describeError(e));
            }
          }}
          onTopUp={async (id, amount) => {
            try {
              await topUpStream(address, id, amount);
              const target = streams.find((s) => s.id === id);
              let amountLabel = `${amount} units`;
              if (target) {
                const meta = await fetchAssetMeta(target.token);
                amountLabel = `${formatAmount(BigInt(amount), meta.decimals)} ${meta.code}`;
              }
              toast.success(`Topped up stream #${id} by ${amountLabel}.`);
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