"use client";

import Link from "next/link";
import type { StreamView, StreamArgs } from "@/lib/stellar";
import type { BatchStreamEntry } from "@/lib/batch";
import StreamForm from "@/components/StreamForm";
import BatchStreamForm from "@/components/BatchStreamForm";
import StreamList from "@/components/StreamList";

export interface StreamDashboardViewProps {
  address: string | null;
  streams: StreamView[];
  lookupId?: string;
  lookupLoading?: boolean;
  onConnect?: () => void | Promise<void>;
  onLookupChange?: (value: string) => void;
  onLookupSubmit?: () => void | Promise<void>;
  onCreateStream?: (args: StreamArgs) => Promise<void>;
  onCreateBatch?: (
    token: string,
    entries: BatchStreamEntry[],
    cancelable: boolean
  ) => Promise<boolean>;
  onDiscover?: () => void | Promise<void>;
  onWithdraw?: (id: string, amount: string) => Promise<void>;
  onWithdrawMax?: (id: string) => Promise<void>;
  onTopUp?: (id: string, amount: string) => Promise<void>;
  onCancel?: (id: string) => Promise<void>;
  onRefresh?: (id: string) => void | Promise<void>;
}

export default function StreamDashboardView({
  address,
  streams,
  lookupId = "",
  lookupLoading = false,
  onConnect,
  onLookupChange,
  onLookupSubmit,
  onCreateStream,
  onCreateBatch,
  onDiscover,
  onWithdraw,
  onWithdrawMax,
  onTopUp,
  onCancel,
  onRefresh,
}: StreamDashboardViewProps) {
  if (!address) {
    return (
      <main className="wrap">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div className="kicker mono">SOROBAN · STELLAR</div>
          <Link
            href="/docs"
            style={{
              color: "#38bdf8",
              fontSize: "0.85rem",
              textDecoration: "none",
            }}
          >
            API Docs ↗
          </Link>
        </div>
        <h1>⚡ StreamPay</h1>
        <p className="muted">
          Continuous, per-second payment streams — payroll, vesting,
          subscriptions. Connect Freighter to begin.
        </p>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <button onClick={() => void onConnect?.()}>Connect Freighter</button>
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
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
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
        onCreate={
          onCreateStream ??
          (async () => {})
        }
      />

      <BatchStreamForm
        onCreate={
          onCreateBatch ??
          (async () => true)
        }
      />

      <section className="card">
        <h2>Fetch stream by ID</h2>

        <div className="row">
          <input
            type="text"
            inputMode="numeric"
            placeholder="Stream ID"
            value={lookupId}
            onChange={(e) => onLookupChange?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void onLookupSubmit?.();
              }
            }}
          />

          <button
            type="button"
            onClick={() => void onLookupSubmit?.()}
            disabled={lookupLoading}
          >
            {lookupLoading ? "Fetching..." : "Fetch stream"}
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Your streams</h2>
        <div className="row">
          <button
            onClick={() => void onDiscover?.()}
            title="Scan the on-chain address indexes"
          >
            Discover on-chain
          </button>
        </div>
        <StreamList
          streams={streams}
          onWithdraw={onWithdraw ?? (async () => {})}
          onWithdrawMax={onWithdrawMax ?? (async () => {})}
          onTopUp={onTopUp ?? (async () => {})}
          onCancel={onCancel ?? (async () => {})}
          onRefresh={onRefresh ?? (() => {})}
        />
      </section>
    </main>
  );
}
