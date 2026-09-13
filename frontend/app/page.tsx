"use client";

import { useState } from "react";
import { isConnected, getAddress } from "@stellar/freighter-api";
import {
  createStream,
  withdrawFromStream,
  topUpStream,
  cancelStream,
  readStream,
  type StreamView,
} from "@/lib/stellar";
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
      if (!(await isConnected())) {
        setError("Freighter not detected — install the extension and reload.");
        return;
      }
      const { address } = await getAddress();
      setAddress(address);
      setStatus(`Connected as ${address.slice(0, 8)}…`);
    } catch (e) {
      setError(`Wallet connection failed: ${String(e)}`);
    }
  }

  async function refresh(id: string) {
    try {
      const s = await readStream(id);
      setStreams((prev) => [s, ...prev.filter((x) => x.id !== id)]);
    } catch (e) {
      setError(`Read failed: ${String(e)}`);
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
        <StreamList
          streams={streams}
          onWithdraw={async (id, amount) => {
            try {
              await withdrawFromStream(address, id, amount);
              await refresh(id);
            } catch (e) {
              setError(String(e));
            }
          }}
          onTopUp={async (id, amount) => {
            try {
              await topUpStream(address, id, amount);
              await refresh(id);
            } catch (e) {
              setError(String(e));
            }
          }}
          onCancel={async (id) => {
            try {
              await cancelStream(address, id);
              await refresh(id);
            } catch (e) {
              setError(String(e));
            }
          }}
          onRefresh={(id) => refresh(id)}
        />
      </section>
    </main>
  );
}
