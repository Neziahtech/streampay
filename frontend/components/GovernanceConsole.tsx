"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@/lib/wallet-context";
import { NETWORK_LABEL } from "@/lib/stellar";
import {
  canReviewMutation,
  describeMutation,
  mutationSummary,
  type AuditEntry,
  type GovernanceMutation,
  type GovernanceSnapshot,
  type MutationEffect,
} from "@/lib/governance";
import {
  governanceContractId,
  prepareGovernanceMutation,
  readAssetPolicy,
  readGovernanceSnapshot,
  submitPreparedGovernanceMutation,
  validateGovernanceAddress,
  type PreparedGovernanceMutation,
} from "@/lib/governance-client";
import {
  AssetAllowlistPanel,
  GovernanceAuditLogPanel,
  GovernanceQueuePanel,
  GovernorSetPanel,
  KeyRotationPanel,
  PolicyBoundsPanel,
} from "./GovernancePanels";
import MutationConfirmation from "./MutationConfirmation";
import WalletButton from "./WalletButton";

interface PendingMutation {
  source: string;
  mutation: GovernanceMutation;
  effect: MutationEffect;
  prepared: PreparedGovernanceMutation;
}

const AUDIT_VERSION = "v1";
const MAX_AUDIT_ENTRIES = 100;

export default function GovernanceConsole() {
  const { address, signTransaction, connectionState } = useWallet();
  const [snapshot, setSnapshot] = useState<GovernanceSnapshot | null>(null);
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMutation | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [auditLoaded, setAuditLoaded] = useState(false);
  const inspectedAssets = useRef<string[]>([]);

  const auditKey = useMemo(
    () => `streampay:governance-audit:${AUDIT_VERSION}:${NETWORK_LABEL}:${governanceContractId()}`,
    [],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await readGovernanceSnapshot(inspectedAssets.current.length ? inspectedAssets.current : undefined);
      setSnapshot(next);
      setNow(BigInt(Math.floor(Date.now() / 1000)));
    } catch (cause) {
      setSnapshot(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const stored = window.localStorage.getItem(auditKey);
        setEntries(stored ? (JSON.parse(stored) as AuditEntry[]).slice(0, MAX_AUDIT_ENTRIES) : []);
      } catch {
        setEntries([]);
      } finally {
        setAuditLoaded(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [auditKey]);

  useEffect(() => {
    if (!auditLoaded) return;
    try { window.localStorage.setItem(auditKey, JSON.stringify(entries.slice(0, MAX_AUDIT_ENTRIES))); }
    catch { /* A blocked localStorage must not prevent a governance transaction. */ }
  }, [auditKey, auditLoaded, entries]);

  function record(entry: Omit<AuditEntry, "id" | "at" | "actor">) {
    if (!address) return;
    setEntries((current) => [{
      ...entry,
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      actor: address,
    }, ...current].slice(0, MAX_AUDIT_ENTRIES));
  }

  async function review(mutation: GovernanceMutation) {
    if (!address || !snapshot || busy) return;
    if (!canReviewMutation(mutation, snapshot, address)) {
      setError("This wallet is not authorized for the requested governance action.");
      return;
    }
    setBusy(true);
    setError(null);
    setMutationError(null);
    try {
      const prepared = await prepareGovernanceMutation(address, mutation);
      const effect = describeMutation(mutation, snapshot);
      setPending({ source: address, mutation, effect, prepared });
      record({ action: mutationSummary(mutation), status: "simulated" });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`Transaction simulation blocked submission: ${message}`);
      record({ action: mutationSummary(mutation), status: "failed", error: message });
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!address || !pending || busy) return;
    if (address !== pending.source) {
      setMutationError("The connected wallet changed after simulation. Cancel and review the transaction again.");
      return;
    }
    if (!snapshot || !canReviewMutation(pending.mutation, snapshot, address)) {
      setMutationError("The connected wallet no longer has the required on-chain role. Nothing was submitted.");
      return;
    }
    setBusy(true);
    setMutationError(null);
    record({ action: mutationSummary(pending.mutation), status: "submitting" });
    try {
      const result = await submitPreparedGovernanceMutation(pending.prepared, signTransaction);
      record({ action: mutationSummary(pending.mutation), status: "submitted", txHash: result.txHash });
      setPending(null);
      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setMutationError(message);
      record({ action: mutationSummary(pending.mutation), status: "failed", error: message });
    } finally {
      setBusy(false);
    }
  }

  async function inspect(asset: string) {
    if (!snapshot || busy) return;
    setBusy(true);
    setError(null);
    try {
      validateGovernanceAddress(asset, "Asset");
      const state = await readAssetPolicy(asset);
      if (!inspectedAssets.current.includes(asset)) inspectedAssets.current.push(asset);
      setSnapshot((current) => current ? {
        ...current,
        assets: [...current.assets.filter((item) => item.asset !== asset), state],
      } : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const isSigner = Boolean(address && snapshot?.signers.includes(address));
  const isPolicyAdmin = Boolean(address && snapshot?.policyAdmin === address);
  const isReadOnly = Boolean(address && snapshot && !isSigner && !isPolicyAdmin && snapshot.pendingGovernor !== address && snapshot.pendingPolicyAdmin !== address);

  return (
    <main className="wrap governance-wrap">
      <div className="governance-header">
        <div><Link href="/" className="muted">← StreamPay dashboard</Link><h1>Governance console</h1><p className="muted">On-chain timelock, policy, allowlist, governor, and key-rotation controls.</p></div>
        <WalletButton />
      </div>
      <div className="governance-toolbar">
        <span className={`status-badge ${connectionState === "connected" ? "status-badge--active" : ""}`}>{connectionState === "connected" ? "Wallet connected" : "Public read-only view"}</span>
        {address && <code className="muted">{address}</code>}
        <button type="button" className="btn-secondary" onClick={() => void load()} disabled={loading || busy}>Refresh chain state</button>
      </div>
      {isReadOnly && <p className="warn governance-readonly" role="status">Read-only mode: the connected wallet has no governance or policy-admin role. Mutation controls are hidden.</p>}
      {snapshot && !snapshot.initialized && <p className="warn">Governance is not bootstrapped. Direct governor entry points remain active on-chain.</p>}
      {error && <p className="err" role="alert">{error}</p>}
      {loading && !snapshot ? <p role="status">Loading governance state…</p> : snapshot && (
        <div className="governance-grid">
          <GovernanceQueuePanel snapshot={snapshot} address={address} now={now} busy={busy} onReview={review} />
          <PolicyBoundsPanel key={JSON.stringify(snapshot.globalPolicy)} snapshot={snapshot} address={address} now={now} busy={busy} onReview={review} />
          <AssetAllowlistPanel snapshot={snapshot} address={address} now={now} busy={busy} onReview={review} onInspect={inspect} />
          <GovernorSetPanel snapshot={snapshot} address={address} now={now} busy={busy} onReview={review} />
          <KeyRotationPanel key={`${snapshot.signers.join(",")}:${snapshot.vetoWindow}`} snapshot={snapshot} address={address} now={now} busy={busy} onReview={review} />
          <GovernanceAuditLogPanel entries={entries} onClear={() => setEntries([])} />
        </div>
      )}
      {pending && snapshot && <MutationConfirmation
        key={pending.prepared.xdr}
        effect={pending.effect}
        prepared={pending.prepared}
        busy={busy}
        error={mutationError}
        onCancel={() => { if (!busy) { setPending(null); setMutationError(null); } }}
        onConfirm={() => void confirm()}
      />}
    </main>
  );
}
