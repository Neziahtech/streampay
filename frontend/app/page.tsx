"use client";

import { useState, useCallback } from "react";
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
import {
  decodeSelection,
  updateUrlSelection,
  createStreamSnapshot,
  detectStaleSelections,
  simulateBatchAction,
  executeBatch,
  notifyBatchResult,
  type BatchActionType,
  type BatchSimulationSummary,
  type BatchExecutionResult,
  type StreamSnapshot,
  type InvalidationNotice,
} from "@/lib/batch";
import StreamForm from "@/components/StreamForm";
import BatchStreamForm from "@/components/BatchStreamForm";
import StreamList from "@/components/StreamList";
import BatchActionBar from "@/components/BatchActionBar";
import BatchSimulationModal from "@/components/BatchSimulationModal";
import { useToast } from "@/components/toast";

export default function Home() {
  const toast = useToast();
  const [address, setAddress] = useState<string | null>(null);
  const [streams, setStreams] = useState<StreamView[]>([]);
  const [lookupId, setLookupId] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);

  // Multi-select & Batch states (lazy init to read URL selection without effect cascading render)
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    const params = new URLSearchParams(window.location.search);
    return decodeSelection(params.get("selected"));
  });
  const [snapshots, setSnapshots] = useState<Map<string, StreamSnapshot>>(
    () => new Map()
  );
  const [invalidatedNotices, setInvalidatedNotices] = useState<
    InvalidationNotice[]
  >([]);

  // Simulation & Confirmation Modal states
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulation, setSimulation] = useState<BatchSimulationSummary | null>(
    null
  );
  const [modalOpen, setModalOpen] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [progressText, setProgressText] = useState("");
  const [executionResult, setExecutionResult] =
    useState<BatchExecutionResult | null>(null);

  // Sync selectedIds with URL
  const updateSelection = useCallback((newIds: string[]) => {
    setSelectedIds(newIds);
    updateUrlSelection(newIds);
  }, []);

  // Live data race check: whenever `streams` updates, verify selected streams against snapshots
  const checkLiveRace = useCallback(
    (freshStreams: StreamView[], currentSelected: string[]) => {
      if (currentSelected.length === 0) return currentSelected;

      const { validIds, invalidated } = detectStaleSelections(
        currentSelected,
        freshStreams,
        snapshots
      );

      if (invalidated.length > 0) {
        setInvalidatedNotices((prev) => [...prev, ...invalidated]);
        updateSelection(validIds);
        return validIds;
      }
      return currentSelected;
    },
    [snapshots, updateSelection]
  );

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
        const validViews = views
          .filter((s): s is StreamView => s !== null)
          .reverse();
        setStreams((prev) => {
          const byId = new Map<string, StreamView>();
          for (const s of prev) byId.set(s.id, s);
          for (const s of validViews) byId.set(s.id, s);
          const next = [...byId.values()].reverse();
          checkLiveRace(next, selectedIds);
          return next;
        });
      }
    } catch (e) {
      toast.error(`Wallet connection failed: ${String(e)}`);
    }
  }

  async function refresh(id: string) {
    try {
      const s = await readStream(id);
      setStreams((prev) => {
        const next = [s, ...prev.filter((x) => x.id !== id)];
        checkLiveRace(next, selectedIds);
        return next;
      });
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
      const found = [...byId.values()].sort(
        (a, b) => Number(b.id) - Number(a.id)
      );
      setStreams((prev) => {
        const merged = new Map<string, StreamView>();
        for (const s of prev) merged.set(s.id, s);
        for (const s of found) merged.set(s.id, s);
        const next = [...merged.values()].sort(
          (a, b) => Number(b.id) - Number(a.id)
        );
        checkLiveRace(next, selectedIds);
        return next;
      });
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
      setStreams((prev) => {
        const next = [stream, ...prev.filter((x) => x.id !== stream.id)];
        checkLiveRace(next, selectedIds);
        return next;
      });
      toast.success(`Stream #${stream.id} loaded.`);
      setLookupId("");
    } catch {
      toast.error("Stream not found. Check the ID and try again.");
    } finally {
      setLookupLoading(false);
    }
  }

  // Multi-select handlers
  function handleToggleSelect(id: string) {
    const isSelected = selectedIds.includes(id);
    let updated: string[];
    if (isSelected) {
      updated = selectedIds.filter((item) => item !== id);
      setSnapshots((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    } else {
      updated = [...selectedIds, id];
      const targetStream = streams.find((s) => s.id === id);
      if (targetStream) {
        setSnapshots((prev) => {
          const next = new Map(prev);
          next.set(id, createStreamSnapshot(targetStream));
          return next;
        });
      }
    }
    updateSelection(updated);
  }

  function handleSelectAll() {
    const allIds = streams.map((s) => s.id);
    const newSnapshots = new Map<string, StreamSnapshot>();
    for (const s of streams) {
      newSnapshots.set(s.id, createStreamSnapshot(s));
    }
    setSnapshots(newSnapshots);
    updateSelection(allIds);
  }

  function handleDeselectAll() {
    setSnapshots(new Map());
    updateSelection([]);
  }

  // Simulation & Modal Trigger
  async function handleTriggerBatchAction(action: BatchActionType) {
    const selectedStreams = streams.filter((s) => selectedIds.includes(s.id));

    if (selectedStreams.length === 0) {
      toast.error("No streams currently selected for batch operation.");
      return;
    }

    setIsSimulating(true);
    setExecutionResult(null);
    setModalOpen(true);

    try {
      const sim = await simulateBatchAction(selectedStreams, action);
      setSimulation(sim);
    } catch (err) {
      toast.error(`Simulation preview failed: ${describeError(err)}`);
      setModalOpen(false);
    } finally {
      setIsSimulating(false);
    }
  }

  // Confirm and Execute Batch Submission
  async function handleConfirmSubmit() {
    if (!simulation || !address) return;

    setIsExecuting(true);
    setProgressText("Initializing batch execution…");

    try {
      const result = await executeBatch({
        caller: address,
        action: simulation.action,
        items: simulation.items,
        onProgress: (_comp, _tot, _curr, text) => {
          setProgressText(text);
        },
      });

      setExecutionResult(result);

      // Refresh all processed streams
      await Promise.all(
        simulation.items.map((it) => readStream(it.streamId).catch(() => null))
      ).then((fresh) => {
        const valid = fresh.filter((s): s is StreamView => s !== null);
        setStreams((prev) => {
          const map = new Map<string, StreamView>();
          for (const s of prev) map.set(s.id, s);
          for (const s of valid) map.set(s.id, s);
          return Array.from(map.values()).sort(
            (a, b) => Number(b.id) - Number(a.id)
          );
        });
      });

      // Clear successful items from selection
      const remainingSelected = selectedIds.filter(
        (id) => !result.succeeded.includes(id)
      );
      updateSelection(remainingSelected);

      // Report honest result toasts (distinguishing success, partial/mixed, and failure)
      notifyBatchResult(result, toast);
    } catch (err) {
      toast.error(`Batch execution error: ${describeError(err)}`);
    } finally {
      setIsExecuting(false);
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
        <h2>Your streams</h2>
        <div className="row">
          <button onClick={discover} title="Scan the on-chain address indexes">
            Discover on-chain
          </button>
        </div>

        <BatchActionBar
          selectedCount={selectedIds.length}
          invalidatedNotices={invalidatedNotices}
          onClearInvalidated={() => setInvalidatedNotices([])}
          onDeselectAll={handleDeselectAll}
          onTriggerBatchAction={handleTriggerBatchAction}
          isSimulating={isSimulating}
        />

        <StreamList
          streams={streams}
          selectedIds={selectedIds}
          onToggleSelect={handleToggleSelect}
          onSelectAll={handleSelectAll}
          onDeselectAll={handleDeselectAll}
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

      <BatchSimulationModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        simulation={simulation}
        isLoading={isSimulating}
        isExecuting={isExecuting}
        progressText={progressText}
        onConfirmSubmit={handleConfirmSubmit}
        executionResult={executionResult}
      />
    </main>
  );
}