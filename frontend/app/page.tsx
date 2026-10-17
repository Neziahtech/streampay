"use client";

import { useState } from "react";
import Link from "next/link";
import { isConnected, requestAccess } from "@stellar/freighter-api";
import {
  createStream,
  createStreams,
  withdrawFromStream,
  withdrawMaxFromStream,
  topUpStream,
  cancelStream,
  readStream,
  fetchStreamsFor,
  describeError,
  type StreamView,
} from "@/lib/stellar";
import { loadStreamIds, saveStreamId } from "@/lib/storage";
import { useStreamEvents, toStreamView } from "@/lib/useStreamEvents";
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

  // Live real-time stream event push from indexer via SSE
  const {
    isLive,
    isPollingFallback,
    status: sseStatus,
    lastEventAt,
    reconnect: reconnectSse,
  } = useStreamEvents({
    address,
    enabled: Boolean(address),
    onEvent: (event) => {
      if (event.eventType === "stream_created") {
        if (event.stream) {
          const view = toStreamView(event.stream);
          setStreams((prev) => [view, ...prev.filter((x) => x.id !== view.id)]);
        } else {
          void refresh(event.streamId);
        }
        if (address) saveStreamId(address, event.streamId);
        toast.info(`⚡ Live update: Stream #${event.streamId} created.`);
      } else if (event.stream) {
        const view = toStreamView(event.stream);
        setStreams((prev) => prev.map((s) => (s.id === view.id ? view : s)));
        toast.info(`⚡ Live update: Stream #${event.streamId} (${event.eventType}).`);
      } else {
        void refresh(event.streamId);
      }
    },
    onFallbackPoll: async () => {
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
        for (const s of found) saveStreamId(address, s.id);
      } catch {
        // Silent on background poll errors to avoid disrupting user
      }
    },
    fallbackPollIntervalMs: 12_000,
  });

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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", flexWrap: "wrap", gap: "8px" }}>
          <h2 style={{ margin: 0 }}>Your streams</h2>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px" }}>
            {isLive && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  color: "#4ade80",
                  background: "rgba(74, 222, 128, 0.1)",
                  padding: "4px 10px",
                  borderRadius: "999px",
                  border: "1px solid rgba(74, 222, 128, 0.3)",
                  fontWeight: 600,
                }}
                title="Connected to indexer live event feed via Server-Sent Events"
              >
                <span
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: "#4ade80",
                    boxShadow: "0 0 8px #4ade80",
                  }}
                />
                Live (SSE)
              </span>
            )}
            {isPollingFallback && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  color: "#fbbf24",
                  background: "rgba(251, 191, 36, 0.1)",
                  padding: "4px 10px",
                  borderRadius: "999px",
                  border: "1px solid rgba(251, 191, 36, 0.3)",
                  fontSize: "12px",
                }}
                title="SSE feed disconnected. Polling fallback active (every 12s)."
              >
                <span
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: "#fbbf24",
                  }}
                />
                Fallback Polling
                <button
                  type="button"
                  onClick={reconnectSse}
                  style={{
                    background: "none",
                    border: "none",
                    color: "inherit",
                    textDecoration: "underline",
                    cursor: "pointer",
                    padding: 0,
                    marginLeft: "4px",
                    fontSize: "11px",
                  }}
                >
                  Reconnect
                </button>
              </span>
            )}
            {!isLive && !isPollingFallback && sseStatus === "connecting" && (
              <span
                style={{
                  color: "#94a3b8",
                  fontSize: "12px",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <span
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: "#94a3b8",
                  }}
                />
                Connecting stream feed…
              </span>
            )}
          </div>
        </div>
        <div className="row" style={{ alignItems: "center" }}>
          <button onClick={discover} title="Scan the on-chain address indexes">
            Discover on-chain
          </button>
          {lastEventAt && (
            <span className="muted" style={{ fontSize: "12px" }}>
              Last live event: {lastEventAt.toLocaleTimeString()}
            </span>
          )}
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