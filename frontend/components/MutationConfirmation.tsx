"use client";

import { useEffect, useRef, useState } from "react";
import { useModalFocus } from "@/lib/use-modal-focus";
import { formatCountdown, type MutationEffect } from "@/lib/governance";
import type { PreparedGovernanceMutation } from "@/lib/governance-client";

interface MutationConfirmationProps {
  effect: MutationEffect;
  prepared: PreparedGovernanceMutation;
  busy: boolean;
  error: string | null;
  onCancel(): void;
  onConfirm(): void;
}

export default function MutationConfirmation({
  effect,
  prepared,
  busy,
  error,
  onCancel,
  onConfirm,
}: MutationConfirmationProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useModalFocus(dialogRef, true, busy ? () => {} : onCancel);

  return (
    <dialog
      ref={dialogRef}
      className="wallet-modal governance-confirm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="governance-confirm-title"
    >
      <div className="wallet-modal__inner">
        <header className="wallet-modal__header">
          <h2 id="governance-confirm-title" className="wallet-modal__title" tabIndex={-1} data-autofocus>
            Confirm governance transaction
          </h2>
          <button type="button" className="wallet-modal__close" onClick={onCancel} disabled={busy} aria-label="Close confirmation">
            ✕
          </button>
        </header>

        <p className="ok">Simulation succeeded. No wallet signature has been requested.</p>
        <h3>{effect.title}</h3>
        <ul>
          {effect.details.map((detail) => <li key={detail}>{detail}</li>)}
        </ul>
        <dl className="governance-facts">
          <div><dt>Timelock</dt><dd>{effect.delaySeconds > 0n ? formatCountdown(effect.delaySeconds) : "No additional delay"}</dd></div>
          <div><dt>Required current signatures</dt><dd>{effect.requiredSignatures || "Role check only"}</dd></div>
          <div><dt>Simulated resource fee</dt><dd>{prepared.minFee} stroops</dd></div>
        </dl>
        <p className="muted">The contract will enforce these preconditions when the signed transaction reaches the ledger.</p>

        <label className="governance-ack">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            disabled={busy}
          />
          I reviewed the exact effect, role requirements, and timelock.
        </label>
        {error && <p className="err" role="alert">{error}</p>}
        <div className="row">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" onClick={onConfirm} disabled={!acknowledged || busy}>
            {busy ? "Waiting for wallet / ledger…" : "Sign and submit"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
