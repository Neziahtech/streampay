"use client";

import { useState } from "react";
import { isConnected, requestAccess } from "@stellar/freighter-api";
import {
  createStream,
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
import StreamForm from "@/components/StreamForm";
import StreamList from "@/components/StreamList";

export default function Home() {
  const [address, setAddress] = useState<string | null>(null);
  const [streams, setStreams] = useState<StreamView[]>([]);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [lookupId, setLookupId] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);

  async function connect() {
    setError("");
    try {
      const { isConnected: connected, error: connectedError } =
        await isConnected();
      if (connectedError || !connected) {
        setError("Freighter not detected — install the extension and reload.");
        return;
      }
      const { address, error: accessError } = await requestAccess();
      if (accessError || !address) {
        setError(
          `Wallet connection failed: ${
            accessError?.message ?? "no address returned from Freighter."
          }`
        );
        return;
      }
      setAddress(address);
      setStatus(`Connected as ${address.slice(0, 8)}…`);
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
      setError(`Wallet connection failed: ${String(e)}`);
    }
  }

  async function refresh(id: string) {
    try {
      const s = await readStream(id);
      setStreams((prev) => [s, ...prev.filter((x) => x.id !== id)]);
      if (address) saveStreamId(address, id);
    } catch (e) {
      setError(describeError(e));
    }
  }

  async function discover() {
    if (!address) return;
    setError("");
    try {
      const [asRecipient, asSender] = await Promise.all([
        fetchStreamsFor(address, "recipient"),
        fetchStreamsFor(address, "sender"),
      ]);
      const byId = new Map<string, StreamView>();
      for (const s of [...asRecipient, ...asSender]) byId.set(s.id, s);
      const found = [...byId.values()].sort((a, b) => Number(b.id) - Number(a.id));
      setStreams(found);
      setStatus(`Discovered ${found.length} stream(s) on-chain.`);
      for (const s of found) saveStreamId(address, s.id);
    } catch (e) {
      setError(describeError(e));
    }
  }

  async function fetchStreamById() {
    const id = lookupId.trim();

    if (!id) {
      setError("Enter a stream ID.");
      return;
    }

    setError("");
    setLookupLoading(true);

    try {
      const stream = await readStream(id);
      setStreams((prev) => [stream, ...prev.filter((x) => x.id !== stream.id)]);
      setStatus(`Stream #${stream.id} loaded.`);
      setLookupId("");
    } catch {
      setError("Stream not found. Check the ID and try again.");
    } finally {
      setLookupLoading(false);
    }
  }

  if (!address) {
    return (
      <main className="wrap">
        <div className="kicker mono">SOROBAN · STELLAR</div>
        <h1>⚡ StreamPay</h1>
        <p className="muted">
          Continuous, per-second payment streams — payroll, vesting,
          subscriptions. Connect Freighter to begin.
        </p>
        <button onClick={connect}>Connect Freighter</button>
        {error && <p className="err">{error}</p>}
      </main>
    );
  }

  return (
    <main className="wrap">
      <h1>⚡ StreamPay</h1>
      <p className="muted">
        Connected: <code>{address}</code>
      </p>
      {status && <p className="ok">{status}</p>}
      {error && <p className="err">{error}</p>}

      <StreamForm
        onCreate={async (args) => {
          setError("");
          try {
            const id = await createStream(address, args);
            setStatus(`Stream #${id} created.`);
            await refresh(String(id));
          } catch (e) {
            setError(String(e));
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
              await refresh(id);
            } catch (e) {
              setError(describeError(e));
            }
          }}
          onWithdrawMax={async (id) => {
            try {
              const paid = await withdrawMaxFromStream(address, id);
              setStatus(`Claimed ${paid} units from stream #${id}.`);
              await refresh(id);
            } catch (e) {
              setError(describeError(e));
            }
          }}
          onTopUp={async (id, amount) => {
            try {
              await topUpStream(address, id, amount);
              await refresh(id);
            } catch (e) {
              setError(describeError(e));
            }
          }}
          onCancel={async (id) => {
            try {
              await cancelStream(address, id);
              await refresh(id);
            } catch (e) {
              setError(describeError(e));
            }
          }}
          onRefresh={(id) => refresh(id)}
        />
      </section>
    </main>
  );
}
