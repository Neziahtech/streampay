"use client";

import { useState, type FormEvent } from "react";
import {
  actionSummary,
  canReviewMutation,
  formatCountdown,
  proposalView,
  shortAddress,
  validatePolicy,
  validateSignerSet,
  validateVetoWindow,
  type AuditEntry,
  type GovernanceMutation,
  type GovernanceSnapshot,
  type StreamPolicy,
} from "@/lib/governance";
import { validateGovernanceAddress } from "@/lib/governance-client";

interface PanelProps {
  snapshot: GovernanceSnapshot;
  address: string | null;
  now: bigint;
  busy: boolean;
  onReview(mutation: GovernanceMutation): void;
}

const EMPTY_POLICY: StreamPolicy = {
  minRate: "0",
  maxRate: "0",
  minDuration: "0",
  maxDuration: "0",
  minDeposit: "0",
};

function ReadOnlyNotice({ snapshot, address }: { snapshot: GovernanceSnapshot; address: string | null }) {
  if (!address) return <p className="muted">Connect a wallet to see any role-specific controls. Governance state remains publicly readable.</p>;
  const signer = snapshot.signers.includes(address);
  const policyAdmin = snapshot.policyAdmin === address;
  if (signer || policyAdmin || snapshot.pendingGovernor === address || snapshot.pendingPolicyAdmin === address) return null;
  return <p className="warn" role="status">Read-only: this wallet is not a current governance signer or policy admin.</p>;
}

export function GovernanceQueuePanel({ snapshot, address, now, busy, onReview }: PanelProps) {
  const proposals = [...snapshot.proposals].reverse();
  return (
    <section className="card governance-panel" aria-labelledby="governance-queue-title">
      <div className="governance-panel__heading">
        <div><h2 id="governance-queue-title">Timelock queue</h2><p className="muted">{snapshot.proposalCount.toString()} proposals · veto window {formatCountdown(snapshot.vetoWindow)}</p></div>
        <ReadOnlyNotice snapshot={snapshot} address={address} />
      </div>
      {proposals.length === 0 ? <p className="muted">No governance proposals have been created.</p> : (
        <div className="table-responsive">
          <table>
            <thead><tr><th scope="col">Proposal</th><th scope="col">Effect</th><th scope="col">Status</th><th scope="col">Signatures</th><th scope="col">Actions</th></tr></thead>
            <tbody>
              {proposals.map((proposal) => {
                const view = proposalView(proposal, snapshot.signers, now);
                const canSign = canReviewMutation({ kind: "sign", proposalId: proposal.id }, snapshot, address)
                  && !proposal.executed && !proposal.vetoed && !proposal.signers.includes(address ?? "");
                const canVeto = canReviewMutation({ kind: "veto", proposalId: proposal.id }, snapshot, address)
                  && view.status === "awaiting_timelock";
                const canExecute = canReviewMutation({ kind: "execute", proposalId: proposal.id }, snapshot, address)
                  && view.status === "ready";
                return (
                  <tr key={proposal.id} data-proposal-id={proposal.id}>
                    <td><strong>#{proposal.id}</strong><br /><span className="muted">by {shortAddress(proposal.proposedBy)}</span></td>
                    <td>{actionSummary(proposal.action)}</td>
                    <td><span className={`status-badge governance-status governance-status--${view.status}`}>{view.status.replaceAll("_", " ")}</span><br /><span className="muted">{view.remaining > 0n ? `${formatCountdown(view.remaining)} remaining` : "Timelock elapsed"}</span></td>
                    <td>{view.liveSignatures}/{view.requiredSignatures} current<br /><span className="muted">{proposal.signers.map(shortAddress).join(", ") || "None"}</span></td>
                    <td>
                      <div className="governance-actions">
                        {canSign && <button type="button" className="btn-secondary" disabled={busy} onClick={() => onReview({ kind: "sign", proposalId: proposal.id })}>Sign</button>}
                        {canVeto && <button type="button" className="btn-secondary governance-danger" disabled={busy} onClick={() => onReview({ kind: "veto", proposalId: proposal.id })}>Veto</button>}
                        {canExecute && <button type="button" disabled={busy} onClick={() => onReview({ kind: "execute", proposalId: proposal.id })}>Execute</button>}
                        {!canSign && !canVeto && !canExecute && <span className="muted">No action available</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function PolicyBoundsPanel({ snapshot, address, busy, onReview }: PanelProps) {
  const [policy, setPolicy] = useState<StreamPolicy>(snapshot.globalPolicy ?? EMPTY_POLICY);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      validatePolicy(policy);
      if (token) validateGovernanceAddress(token, "Token");
      onReview({ kind: "propose", action: { variant: "SetStreamPolicy", payload: [token || null, policy] } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const allowed = snapshot.initialized && Boolean(address && snapshot.signers.includes(address));
  return (
    <section className="card governance-panel" aria-labelledby="policy-bounds-title">
      <h2 id="policy-bounds-title">Stream policy bounds</h2>
      <p className="muted">Zero disables an individual bound. Token-specific policies override the global policy for new streams.</p>
      {snapshot.globalPolicy ? (
        <dl className="governance-facts">
          <div><dt>Rate</dt><dd>{snapshot.globalPolicy.minRate}–{snapshot.globalPolicy.maxRate}</dd></div>
          <div><dt>Duration</dt><dd>{snapshot.globalPolicy.minDuration}–{snapshot.globalPolicy.maxDuration}s</dd></div>
          <div><dt>Minimum deposit</dt><dd>{snapshot.globalPolicy.minDeposit}</dd></div>
        </dl>
      ) : <p className="muted">No global policy is configured.</p>}
      <ReadOnlyNotice snapshot={snapshot} address={address} />
      <form onSubmit={submit}>
        <label htmlFor="policy-token">Token contract (blank for global)</label>
        <input id="policy-token" type="text" value={token} onChange={(event) => setToken(event.target.value.trim())} placeholder="C…" disabled={!allowed || busy} />
        <div className="row">
          {(["minRate", "maxRate", "minDuration", "maxDuration", "minDeposit"] as const).map((field) => (
            <div key={field}>
              <label htmlFor={`policy-${field}`}>{field.replace(/([A-Z])/g, " $1")}</label>
              <input id={`policy-${field}`} type="text" inputMode="numeric" value={policy[field]} onChange={(event) => setPolicy((current) => ({ ...current, [field]: event.target.value }))} disabled={!allowed || busy} />
            </div>
          ))}
        </div>
        {error && <p className="err" role="alert">{error}</p>}
        {allowed && <button type="submit" disabled={busy}>Review policy proposal</button>}
      </form>
    </section>
  );
}

interface AssetPanelProps extends PanelProps {
  onInspect(asset: string): void;
}

export function AssetAllowlistPanel({ snapshot, address, now, busy, onReview, onInspect }: AssetPanelProps) {
  const [asset, setAsset] = useState("");
  const [error, setError] = useState<string | null>(null);
  const allowed = snapshot.policyAdmin !== null && snapshot.policyAdmin === address;
  const pendingNominee = Boolean(address && snapshot.pendingPolicyAdmin === address);

  function inspect() {
    setError(null);
    try {
      validateGovernanceAddress(asset, "Asset");
      if (snapshot.assets.some((item) => item.asset === asset)) return;
      onInspect(asset);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <section className="card governance-panel" aria-labelledby="allowlist-title">
      <h2 id="allowlist-title">Asset allowlist</h2>
      <p className="muted">The contract has no allowlist enumeration read. Inspect a token contract to load its current and queued state.</p>
      <ReadOnlyNotice snapshot={snapshot} address={address} />
      <div className="row governance-inspect">
        <div><label htmlFor="allowlist-asset">Asset contract</label><input id="allowlist-asset" type="text" value={asset} onChange={(event) => setAsset(event.target.value.trim())} placeholder="C…" /></div>
        <button type="button" className="btn-secondary" onClick={inspect} disabled={busy || !asset}>Inspect asset</button>
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      {snapshot.assets.length === 0 ? <p className="muted">No assets inspected yet.</p> : (
        <div className="table-responsive"><table><thead><tr><th scope="col">Asset</th><th scope="col">Current</th><th scope="col">Queued</th><th scope="col">Actions</th></tr></thead><tbody>
          {snapshot.assets.map((item) => (
            <tr key={item.asset}>
              <td><code>{shortAddress(item.asset)}</code></td>
              <td>{item.allowed ? "Allowed" : "Blocked"}</td>
              <td>{item.queued ? <>{item.queued.allowed ? "Allow" : "Remove"} · {formatCountdown(item.queued.executableAfter > now ? item.queued.executableAfter - now : 0n)}</> : "None"}</td>
              <td><div className="governance-actions">
                {allowed && <><button type="button" className="btn-secondary" disabled={busy} onClick={() => onReview({ kind: "assetPropose", asset: item.asset, allowed: true })}>Queue allow</button><button type="button" className="btn-secondary governance-danger" disabled={busy} onClick={() => onReview({ kind: "assetPropose", asset: item.asset, allowed: false })}>Queue removal</button></>}
                {allowed && item.queued && item.queued.executableAfter <= now && <button type="button" disabled={busy} onClick={() => onReview({ kind: "assetExecute", asset: item.asset })}>Execute queued</button>}
                {!allowed && <span className="muted">Read-only</span>}
              </div></td>
            </tr>
          ))}
        </tbody></table></div>
      )}
      {(allowed || pendingNominee) && <details className="governance-advanced" open={pendingNominee}><summary>Policy admin controls</summary>
        {allowed && <>
          <label htmlFor="policy-delay">Allowlist timelock delay (seconds)</label>
          <input id="policy-delay" type="text" inputMode="numeric" defaultValue={snapshot.policyTimelockDelay.toString()} />
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => {
            const input = document.getElementById("policy-delay") as HTMLInputElement;
            onReview({ kind: "policySetDelay", delay: input.value });
          }}>Review delay change</button>
          <label htmlFor="policy-handoff">New policy admin</label>
          <input id="policy-handoff" type="text" placeholder="G…" />
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => {
            const input = document.getElementById("policy-handoff") as HTMLInputElement;
            try { validateGovernanceAddress(input.value, "Policy admin"); onReview({ kind: "policyProposeHandoff", newAdmin: input.value }); }
            catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
          }}>Review handoff</button>
        </>}
        {snapshot.pendingPolicyAdmin && <div className="row">
          {allowed && <button type="button" className="btn-secondary" disabled={busy} onClick={() => onReview({ kind: "policyCancelHandoff" })}>Cancel handoff</button>}
          {pendingNominee && <button type="button" disabled={busy} onClick={() => onReview({ kind: "policyAcceptHandoff" })}>Accept handoff</button>}
        </div>}
      </details>}
    </section>
  );
}

export function GovernorSetPanel({ snapshot, address, busy, onReview }: PanelProps) {
  const [nominee, setNominee] = useState("");
  const [error, setError] = useState<string | null>(null);
  const canNominate = snapshot.initialized && Boolean(address && snapshot.signers.includes(address));
  return (
    <section className="card governance-panel" aria-labelledby="governor-title">
      <h2 id="governor-title">Treasury governor</h2>
      <dl className="governance-facts">
        <div><dt>Current governor</dt><dd>{snapshot.governor ? shortAddress(snapshot.governor) : "Unavailable"}</dd></div>
        <div><dt>Pending nominee</dt><dd>{snapshot.pendingGovernor ? shortAddress(snapshot.pendingGovernor) : "None"}</dd></div>
      </dl>
      <p className="muted">After bootstrap, nomination itself is a two-signature timelocked proposal. The nominee must then call <code>accept_governor</code> to prove control.</p>
      <ReadOnlyNotice snapshot={snapshot} address={address} />
      <form onSubmit={(event) => {
        event.preventDefault();
        try { validateGovernanceAddress(nominee, "Nominee"); onReview({ kind: "propose", action: { variant: "NominateGovernor", payload: [nominee] } }); }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      }}>
        <label htmlFor="governor-nominee">Nominee address</label>
        <input id="governor-nominee" type="text" value={nominee} onChange={(event) => setNominee(event.target.value.trim())} placeholder="G…" disabled={!canNominate || busy} />
        {error && <p className="err" role="alert">{error}</p>}
        {canNominate && <button type="submit" disabled={busy}>Review governor nomination</button>}
      </form>
      {snapshot.pendingGovernor === address && address && <button type="button" disabled={busy} onClick={() => onReview({ kind: "governorAccept" })}>Review governor acceptance</button>}
    </section>
  );
}

export function KeyRotationPanel({ snapshot, address, busy, onReview }: PanelProps) {
  const [signers, setSigners] = useState(snapshot.signers.join("\n"));
  const [vetoWindow, setVetoWindow] = useState(snapshot.vetoWindow.toString());
  const [error, setError] = useState<string | null>(null);
  const allowed = snapshot.initialized && Boolean(address && snapshot.signers.includes(address));

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const candidate = signers.split(/\s+/).map((item) => item.trim()).filter(Boolean);
      validateSignerSet(candidate);
      onReview({ kind: "propose", action: { variant: "SetSigners", payload: [candidate] } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <section className="card governance-panel" aria-labelledby="key-rotation-title">
      <h2 id="key-rotation-title">Governance key rotation</h2>
      <p className="warn">Use the key ceremony runbook. Rotation waits four veto windows ({formatCountdown(snapshot.vetoWindow * 4n)}) and needs one current signer signature. Removed keys lose authority over other half-signed proposals.</p>
      <ReadOnlyNotice snapshot={snapshot} address={address} />
      <form onSubmit={submit}>
        <label htmlFor="rotation-signers">Candidate signer addresses (one per line)</label>
        <textarea id="rotation-signers" rows={5} value={signers} onChange={(event) => setSigners(event.target.value)} disabled={!allowed || busy} />
        <label htmlFor="rotation-veto-window">Veto window (seconds)</label>
        <input id="rotation-veto-window" type="text" inputMode="numeric" value={vetoWindow} onChange={(event) => setVetoWindow(event.target.value)} disabled={!allowed || busy} />
        {error && <p className="err" role="alert">{error}</p>}
        {allowed && <><button type="submit" disabled={busy}>Review key rotation</button>
        <button type="button" className="btn-secondary" disabled={busy || vetoWindow === snapshot.vetoWindow.toString()} onClick={() => {
          try {
            const window = validateVetoWindow(vetoWindow).toString();
            onReview({ kind: "propose", action: { variant: "SetVetoWindow", payload: [window] } });
          } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        }}>Review veto-window change</button></>}
      </form>
      {!snapshot.initialized && snapshot.governor === address && <BootstrapGovernance busy={busy} onReview={onReview} />}
    </section>
  );
}

function BootstrapGovernance({ busy, onReview }: { busy: boolean; onReview(mutation: GovernanceMutation): void }) {
  const [signers, setSigners] = useState("");
  const [window, setWindow] = useState("172800");
  const [error, setError] = useState<string | null>(null);
  return <details className="governance-advanced" open><summary>One-time governance bootstrap</summary>
    <p className="warn">Bootstrap permanently closes direct governor-only admin entry points. Verify the signer ceremony before continuing.</p>
    <label htmlFor="bootstrap-signers">Initial signers (one per line)</label><textarea id="bootstrap-signers" rows={4} value={signers} onChange={(event) => setSigners(event.target.value)} />
    <label htmlFor="bootstrap-window">Veto window (seconds)</label><input id="bootstrap-window" type="text" inputMode="numeric" value={window} onChange={(event) => setWindow(event.target.value)} />
    {error && <p className="err" role="alert">{error}</p>}
    <button type="button" disabled={busy} onClick={() => {
      try {
        const candidate = signers.split(/\s+/).map((item) => item.trim()).filter(Boolean);
        validateSignerSet(candidate);
        const vetoWindow = validateVetoWindow(window).toString();
        onReview({ kind: "bootstrap", signers: candidate, vetoWindow });
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    }}>Review bootstrap</button>
  </details>;
}

export function GovernanceAuditLogPanel({ entries, onClear }: { entries: AuditEntry[]; onClear(): void }) {
  return (
    <section className="card governance-panel" aria-labelledby="governance-audit-title">
      <div className="governance-panel__heading"><div><h2 id="governance-audit-title">Client-side audit log</h2><p className="muted">Stored only in this browser. No transaction XDR or wallet secret is recorded.</p></div><button type="button" className="btn-secondary" onClick={onClear} disabled={entries.length === 0}>Clear log</button></div>
      {entries.length === 0 ? <p className="muted">No governance actions recorded.</p> : <ol className="governance-audit">
        {entries.map((entry) => <li key={entry.id}><time dateTime={entry.at}>{entry.at}</time><span className={`status-badge governance-status--${entry.status}`}>{entry.status}</span><div><strong>{entry.action}</strong><br /><span className="muted">{shortAddress(entry.actor)}{entry.txHash ? ` · ${entry.txHash}` : ""}</span>{entry.error && <p className="err">{entry.error}</p>}</div></li>)}
      </ol>}
    </section>
  );
}
