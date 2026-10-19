"use client";

import { useEffect, useId, useState } from "react";
import {
  NATIVE_XLM,
  tokenContractId,
  fetchAssetMeta,
  type AssetMeta,
  type StreamArgs,
} from "@/lib/stellar";
import { readStreamPolicyAction } from "@/app/actions";
import type { StreamPolicyView } from "@/lib/stream-types";
import { formatAmount } from "@/lib/format";

/** Asset choices on the create form: native XLM, or a token contract id. */
type AssetChoice = "native" | "contract";

export default function StreamForm({
  onCreate,
}: {
  onCreate: (args: StreamArgs) => Promise<void>;
}) {
  const [asset, setAsset] = useState<AssetChoice>("native");
  const [contractMeta, setContractMeta] = useState<AssetMeta | null>(null);
  const [args, setArgs] = useState<StreamArgs>({
    token: "",
    recipient: "",
    deposit: "1000000000",
    days: "30",
    cancelable: true,
  });
  const [busy, setBusy] = useState(false);
  const [policy, setPolicy] = useState<StreamPolicyView | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);

  // Derived asset metadata: native XLM is always known; contract assets update asynchronously
  const assetMeta: AssetMeta =
    asset === "native"
      ? { code: "XLM", decimals: 7 }
      : contractMeta ?? { code: "TOKEN", decimals: 7 };

  // Load asset meta for contract token choices
  useEffect(() => {
    let active = true;
    if (asset === "contract") {
      const token = args.token.trim();
      if (token) {
        fetchAssetMeta(token).then((meta) => {
          if (active) setContractMeta(meta);
        });
      }
    }
    return () => {
      active = false;
    };
  }, [asset, args.token]);

  // Load policy for selected asset
  useEffect(() => {
    let active = true;
    const token = asset === "native" ? tokenContractId(NATIVE_XLM) : args.token.trim();
    if (token) {
      readStreamPolicyAction(token).then((p) => {
        if (active) setPolicy(p);
      });
    } else {
      readStreamPolicyAction().then((p) => {
        if (active) setPolicy(p);
      });
    }
    return () => {
      active = false;
    };
  }, [asset, args.token]);

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
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setPolicyError(null);
      setArgs((prev) => ({
        ...prev,
        [k]:
          k === "cancelable"
            ? (e.target as HTMLSelectElement).value === "yes"
            : e.target.value,
      }));
    };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPolicyError(null);

    // Client-side pre-validation against governance policy floors
    if (policy) {
      const depositVal = BigInt(args.deposit || "0");
      const durationSeconds = Math.floor(Number(args.days || "0") * 86400);

      if (BigInt(policy.minDeposit) > 0n && depositVal < BigInt(policy.minDeposit)) {
        setPolicyError(`Deposit is below the governance policy floor of ${policy.minDeposit} units.`);
        return;
      }
      if (policy.minDuration > 0 && durationSeconds < policy.minDuration) {
        setPolicyError(`Duration (${durationSeconds}s) is below the governance floor of ${policy.minDuration}s.`);
        return;
      }
      if (policy.maxDuration > 0 && durationSeconds > policy.maxDuration) {
        setPolicyError(`Duration (${durationSeconds}s) exceeds the governance ceiling of ${policy.maxDuration}s.`);
        return;
      }

      const rate = depositVal / BigInt(Math.max(1, durationSeconds));
      if (BigInt(policy.minRate) > 0n && rate < BigInt(policy.minRate)) {
        setPolicyError(`Accrual rate (${rate}/s) is below the governance policy floor of ${policy.minRate}/s.`);
        return;
      }
      if (BigInt(policy.maxRate) > 0n && rate > BigInt(policy.maxRate)) {
        setPolicyError(`Accrual rate (${rate}/s) exceeds the governance policy ceiling of ${policy.maxRate}/s.`);
        return;
      }
    }

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

      {(() => {
        const depositTrimmed = args.deposit.trim();
        const depositVal =
          depositTrimmed && /^\d+$/.test(depositTrimmed)
            ? BigInt(depositTrimmed)
            : 0n;
        const durationDays = parseFloat(args.days || "0");
        const durationSeconds = Math.floor(durationDays * 86400);
        const flowRatePerSec =
          durationSeconds > 0 ? depositVal / BigInt(durationSeconds) : 0n;
        const flowRatePerDay =
          durationDays > 0
            ? depositVal / BigInt(Math.max(1, Math.round(durationDays)))
            : 0n;

        if (depositVal <= 0n) return null;

        return (
          <div
            className="stream-preview"
            style={{
              background: "rgba(255, 255, 255, 0.02)",
              border: "1px solid var(--line)",
              borderRadius: "8px",
              padding: "12px 16px",
              marginTop: "14px",
              marginBottom: "14px",
            }}
            aria-label="Stream preview"
          >
            <div
              style={{
                fontSize: "0.75rem",
                fontWeight: 700,
                color: "var(--accent2)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                marginBottom: "8px",
              }}
            >
              Stream Preview
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                gap: "12px",
              }}
            >
              <div>
                <div className="muted" style={{ fontSize: "0.8rem" }}>
                  Total Deposit
                </div>
                <div className="mono" style={{ fontSize: "1.05rem", fontWeight: 600 }}>
                  {formatAmount(depositVal, assetMeta.decimals)} {assetMeta.code}
                </div>
              </div>
              {durationSeconds > 0 && (
                <div>
                  <div className="muted" style={{ fontSize: "0.8rem" }}>
                    Daily Flow Rate
                  </div>
                  <div className="mono" style={{ fontSize: "1.05rem", fontWeight: 600 }}>
                    ~{formatAmount(flowRatePerDay, assetMeta.decimals)} {assetMeta.code}/day
                  </div>
                </div>
              )}
              {durationSeconds > 0 && (
                <div>
                  <div className="muted" style={{ fontSize: "0.8rem" }}>
                    Per-Second Rate
                  </div>
                  <div className="mono" style={{ fontSize: "0.95rem", color: "var(--muted)" }}>
                    ~{formatAmount(flowRatePerSec, assetMeta.decimals)} {assetMeta.code}/s
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      <p className="muted">
        Amounts are in smallest units ({assetMeta.decimals} decimals for {assetMeta.code}).
        The UI checks the token allowance first and asks Freighter to approve
        the deposit only when it is short — expect one or two signatures.
      </p>

      {policy && (
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Active Policy Floors:
          {BigInt(policy.minDeposit) > 0n &&
            ` Min Deposit: ${formatAmount(BigInt(policy.minDeposit), assetMeta.decimals)} ${assetMeta.code}`}
          {policy.minDuration > 0 && ` | Min Duration: ${policy.minDuration}s`}
          {policy.maxDuration > 0 && ` | Max Duration: ${policy.maxDuration}s`}
          {BigInt(policy.minRate) > 0n &&
            ` | Min Rate: ${formatAmount(BigInt(policy.minRate), assetMeta.decimals)} ${assetMeta.code}/s`}
          {BigInt(policy.maxRate) > 0n &&
            ` | Max Rate: ${formatAmount(BigInt(policy.maxRate), assetMeta.decimals)} ${assetMeta.code}/s`}
        </p>
      )}

      {policyError && (
        <div role="alert" style={{ color: "#ef4444", marginBottom: "1rem", fontSize: "0.9rem" }}>
          {policyError}
        </div>
      )}

      <button type="submit" disabled={busy}>
        {busy ? "Streaming…" : "Create stream"}
      </button>
    </form>
  );
}
