"use client";

import { useId, useState } from "react";
import {
  NATIVE_XLM,
  tokenContractId,
  type StreamArgs,
} from "@/lib/stellar";

/** Asset choices on the create form: native XLM, or a token contract id. */
type AssetChoice = "native" | "contract";

export default function StreamForm({
  onCreate,
}: {
  onCreate: (args: StreamArgs) => Promise<void>;
}) {
  const [asset, setAsset] = useState<AssetChoice>("native");
  const [args, setArgs] = useState<StreamArgs>({
    token: "",
    recipient: "",
    deposit: "1000000000",
    days: "30",
    cancelable: true,
  });
  const [busy, setBusy] = useState(false);

  // Stable IDs for ARIA associations (WCAG 1.3.1 / 4.1.2)
  const formId = useId();
  const assetId = `${formId}-asset`;
  const tokenId = `${formId}-token`;
  const tokenHintId = `${formId}-token-hint`;
  const recipientId = `${formId}-recipient`;
  const recipientHintId = `${formId}-recipient-hint`;
  const depositId = `${formId}-deposit`;
  const depositHintId = `${formId}-deposit-hint`;
  const daysId = `${formId}-days`;
  const cancelableId = `${formId}-cancelable`;
  const formDescId = `${formId}-desc`;

  const set =
    (k: keyof StreamArgs) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setArgs((prev) => ({
        ...prev,
        [k]:
          k === "cancelable"
            ? (e.target as HTMLSelectElement).value === "yes"
            : e.target.value,
      }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      // Native XLM streams through its Stellar Asset Contract; the contract
      // only ever sees a token contract id either way.
      await onCreate({
        ...args,
        token: asset === "native" ? NATIVE_XLM : args.token.trim(),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="card"
      onSubmit={submit}
      aria-labelledby={`${formId}-heading`}
      aria-describedby={formDescId}
      noValidate
    >
      <h2 id={`${formId}-heading`}>Create a stream</h2>

      {/* Invisible form-level description for SR context */}
      <p id={formDescId} className="sr-only">
        Fill in the fields below to create a per-second payment stream on
        Stellar. Required fields are marked with an asterisk (*).
      </p>

      <div className="row">
        <div>
          <label htmlFor={assetId}>
            Asset <span aria-hidden="true">*</span>
            <span className="sr-only">(required)</span>
          </label>
          <select
            id={assetId}
            value={asset}
            onChange={(e) => setAsset(e.target.value as AssetChoice)}
            required
          >
            <option value="native">Native XLM</option>
            <option value="contract">Token contract (USDC-style)</option>
          </select>
        </div>

        {asset === "contract" && (
          <div>
            <label htmlFor={tokenId}>
              Token contract id <span aria-hidden="true">*</span>
              <span className="sr-only">(required)</span>
            </label>
            <input
              id={tokenId}
              type="text"
              required
              placeholder="C… (asset's Stellar Asset Contract id)"
              value={args.token}
              onChange={set("token")}
              aria-describedby={tokenHintId}
              autoComplete="off"
            />
            <span id={tokenHintId} className="sr-only">
              Enter the Stellar Asset Contract (SAC) id for the token you want
              to stream. It starts with the letter C.
            </span>
          </div>
        )}

        <div>
          <label htmlFor={recipientId}>
            Recipient <span aria-hidden="true">*</span>
            <span className="sr-only">(required)</span>
          </label>
          <input
            id={recipientId}
            type="text"
            required
            placeholder="G…"
            value={args.recipient}
            onChange={set("recipient")}
            aria-describedby={recipientHintId}
            autoComplete="off"
          />
          <span id={recipientHintId} className="sr-only">
            Enter the Stellar public key (G… address) of the stream recipient.
          </span>
        </div>
      </div>

      {asset === "native" && (
        <p className="muted mono" style={{ wordBreak: "break-all" }}>
          Native XLM streams through its Stellar Asset Contract:{" "}
          {tokenContractId(NATIVE_XLM)}
        </p>
      )}

      <div className="row">
        <div>
          <label htmlFor={depositId}>
            Deposit (smallest units) <span aria-hidden="true">*</span>
            <span className="sr-only">(required)</span>
          </label>
          <input
            id={depositId}
            type="number"
            min="1"
            required
            value={args.deposit}
            onChange={set("deposit")}
            aria-describedby={depositHintId}
          />
          <span id={depositHintId} className="sr-only">
            Total amount to lock in the stream, expressed in the token&apos;s
            smallest unit (stroops for XLM, 7 decimal places).
          </span>
        </div>

        <div>
          <label htmlFor={daysId}>
            Duration (days) <span aria-hidden="true">*</span>
            <span className="sr-only">(required)</span>
          </label>
          <input
            id={daysId}
            type="number"
            min="0.001"
            step="any"
            required
            value={args.days}
            onChange={set("days")}
          />
        </div>

        <div>
          <label htmlFor={cancelableId}>Recipient may cancel?</label>
          <select
            id={cancelableId}
            value={args.cancelable ? "yes" : "no"}
            onChange={set("cancelable")}
          >
            <option value="yes">Yes (cancelable)</option>
            <option value="no">No (sender-only)</option>
          </select>
        </div>
      </div>

      <p className="muted">
        Amounts are in smallest units (7 decimals for XLM and testnet USDC).
        The UI checks the token allowance first and asks Freighter to approve
        the deposit only when it is short — expect one or two signatures.
      </p>

      <button type="submit" disabled={busy}>
        {busy ? "Streaming…" : "Create stream"}
      </button>
    </form>
  );
}
