"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import {
  createStream,
  createStreams,
  withdrawFromStream,
  withdrawMaxFromStream,
  claimStreamsWithReceipt,
  withdrawAllFromStreams,
  topUpStream,
  cancelStream,
  readStream,
  fetchStreamsFor,
  fetchAssetMeta,
  describeError,
  type StreamView,
} from "@/lib/stellar";
import { BATCH_CLAIM_ENABLED } from "@/lib/withdrawal";
import { formatAmount } from "@/lib/format";
import { loadStreamIds, saveStreamId } from "@/lib/storage";
import { useStreamEvents, toStreamView } from "@/lib/useStreamEvents";
import { useWallet } from "@/lib/wallet-context";
import { useLocale } from "@/lib/i18n/provider";
import StreamForm from "@/components/StreamForm";
import BatchStreamForm from "@/components/BatchStreamForm";
import StreamList from "@/components/StreamList";
import WalletButton from "@/components/WalletButton";
import { useToast } from "@/components/toast";

export default function Home() {
  const toast = useToast();
  const { address, signTransaction } = useWallet();
  const { t, formatToken } = useLocale();
  const [streams, setStreams] = useState<StreamView[]>([]);
  const [lookupId, setLookupId] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [claimAllLoading, setClaimAllLoading] = useState(false);

  async function onConnected(addr: string) {
    // Rehydrate the cached list (ids only; state is always read fresh).
    const cached = loadStreamIds(addr);
    if (cached.length > 0) {
      const views = await Promise.all(
        cached.map((id) => readStream(id).catch(() => null))
      );
      setStreams(
        views.filter((s): s is StreamView => s !== null).reverse()
      );
    }
  }

  // Fire rehydration once address becomes known.
  const [lastAddress, setLastAddress] = useState<string | null>(null);
  if (address && address !== lastAddress) {
    setLastAddress(address);
    void onConnected(address);
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
      const found = [...byId.values()].sort((a, b) => Number(b.id) - Number(a.id));
      setStreams(found);
      toast.info(t("home.discovered", { count: found.length }));
      for (const s of found) saveStreamId(address, s.id);
    } catch (e) {
      toast.error(describeError(e));
    }
  }

  async function handleClaimAll() {
    if (!address) return;
    setClaimAllLoading(true);
    try {
      const res = await withdrawAllFromStreams(address, signTransaction);
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
      toast.error(t("home.enterStreamId"));
      return;
    }

    setLookupLoading(true);

    try {
      const stream = await readStream(id);
      setStreams((prev) => [stream, ...prev.filter((x) => x.id !== stream.id)]);
      toast.success(t("home.streamLoaded", { id: stream.id }));
      setLookupId("");
    } catch {
      toast.error(t("home.streamNotFound"));
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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap" }}>
          <div>
            <div className="kicker mono">{t("home.kicker")}</div>
            <h1>{t("home.title")}</h1>
          </div>
          <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
            <Link href="/benchmarks" style={{ color: "var(--accent2)", fontSize: "0.85rem", textDecoration: "none" }}>
              Benchmarks 📊
            </Link>
            <Link href="/docs" style={{ color: "#38bdf8", fontSize: "0.85rem", textDecoration: "none" }}>
              {t("chrome.apiDocs")}
            </Link>
            <Link href="/listings" style={{ color: "var(--accent2)", fontSize: "14px", textDecoration: "none" }}>
              {t("home.browse")}
            </Link>
          </div>
        </div>
        <p className="muted">{t("home.tagline")}</p>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <WalletButton />
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
            {t("chrome.simulatorLink")}
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="wrap">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap" }}>
        <h1>{t("home.title")}</h1>
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
            {t("chrome.simulatorLink")}
          </a>
          <WalletButton />
          <Link href="/listings" style={{ color: "var(--accent2)", fontSize: "14px", textDecoration: "none" }}>
            {t("home.browse")}
          </Link>
        </div>
      </div>
      <p className="muted">
        {t("home.connectedLabel")} <code>{address}</code>
      </p>

      <StreamForm
        onCreate={async (args) => {
          try {
            const id = await createStream(address, args, signTransaction);
            toast.success(t("home.created", { id }));
            await refresh(String(id));
          } catch (e) {
            toast.error(describeError(e));
          }
        }}
      />

      <BatchStreamForm
        onCreate={async (token, entries, cancelable) => {
          try {
            const ids = await createStreams(address, token, entries, cancelable, signTransaction);
            toast.success(
              t("home.batchCreated", {
                count: ids.length,
                ids: ids.map((id) => `#${id}`).join(", "),
              })
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
        <h2>{t("home.fetchById")}</h2>

        <div className="row">
          <input
            type="text"
            inputMode="numeric"
            placeholder={t("home.streamIdPlaceholder")}
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
            {lookupLoading ? t("home.fetching") : t("home.fetch")}
          </button>
        </div>
      </section>

      <section className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", flexWrap: "wrap", gap: "8px" }}>
          <h2 style={{ margin: 0 }}>{t("home.yourStreams")}</h2>
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
          <button onClick={discover} title={t("home.discoverOnchain")}>
            {t("home.discoverOnchain")}
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
          {lastEventAt && (
            <span className="muted" style={{ fontSize: "12px" }}>
              Last live event: {lastEventAt.toLocaleTimeString()}
            </span>
          )}
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
              await withdrawFromStream(address, id, amount, signTransaction);
              const target = streams.find((s) => s.id === id);
              let amountLabel = `${amount} ${t("home.unitsWord")}`;
              if (target) {
                const meta = await fetchAssetMeta(target.token);
                amountLabel = `${formatToken(BigInt(amount), meta.decimals)} ${meta.code}`;
              }
              toast.success(t("home.withdrew", { amount: amountLabel, id }));
              await refresh(id);
            } catch (e) {
              toast.error(describeError(e));
            }
          }}
          onWithdrawMax={async (id) => {
            try {
              const paid = await withdrawMaxFromStream(address, id, signTransaction);
              const target = streams.find((s) => s.id === id);
              let paidLabel = `${paid} ${t("home.unitsWord")}`;
              if (target) {
                const meta = await fetchAssetMeta(target.token);
                paidLabel = `${formatToken(paid, meta.decimals)} ${meta.code}`;
              }
              toast.success(t("home.claimed", { amount: paidLabel, id }));
              await refresh(id);
            } catch (e) {
              toast.error(describeError(e));
            }
          }}
          onClaimBatch={
            BATCH_CLAIM_ENABLED
              ? async (ids) => {
                  try {
                    const receipt = await claimStreamsWithReceipt(
                      address,
                      ids,
                      signTransaction
                    );
                    const settled = receipt.rows.filter((row) => row.settled);
                    const skipped = receipt.rows.length - settled.length;
                    toast.success(
                      `Claimed ${settled.length} stream(s) in one transaction, ` +
                        `${receipt.total} units total${skipped ? `, ${skipped} skipped` : ""}.`
                    );
                    await Promise.all(
                      receipt.rows.map((row) => refresh(row.streamId))
                    );
                  } catch (e) {
                    toast.error(describeError(e));
                  }
                }
              : undefined
          }
          onTopUp={async (id, amount) => {
            try {
              await topUpStream(address, id, amount, signTransaction);
              const target = streams.find((s) => s.id === id);
              let amountLabel = `${amount} ${t("home.unitsWord")}`;
              if (target) {
                const meta = await fetchAssetMeta(target.token);
                amountLabel = `${formatToken(BigInt(amount), meta.decimals)} ${meta.code}`;
              }
              toast.success(t("home.toppedUp", { amount: amountLabel, id }));
              await refresh(id);
            } catch (e) {
              toast.error(describeError(e));
            }
          }}
          onCancel={async (id) => {
            try {
              await cancelStream(address, id, signTransaction);
              toast.success(t("home.cancelled", { id }));
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