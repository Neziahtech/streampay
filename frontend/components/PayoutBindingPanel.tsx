"use client";

import { useCallback, useEffect, useId, useState } from "react";
import {
  cancelPayoutBinding,
  confirmPayoutBinding,
  describeError,
  PAYOUT_ROUTER_ID,
  proposePayoutBinding,
  readPayoutBinding,
  STREAMING_CONTRACT_ID,
  type TxSigner,
} from "@/lib/stellar";
import {
  BIND_DELAY_SECS,
  confirmBlockedReason,
  deriveBindingStatus,
  formatCountdown,
  registerHookInstructions,
  validatePayoutAddress,
  type BindingView,
} from "@/lib/payout-binding";

export interface PayoutBindingPanelProps {
  streamId: string;
  /** The connected wallet; must be the stream's recipient. */
  recipient: string;
  signTransaction: TxSigner;
  /** Overrides for tests and stories; default to the app's env config. */
  routerId?: string;
  streamingId?: string;
}

/**
 * Recipient-only panel for payout routing (issue #80): bind claims to another
 * address with a 24 h delay, then confirm. A pending address never receives
 * funds; only the confirmed one does.
 */
export default function PayoutBindingPanel({
  streamId,
  recipient,
  signTransaction,
  routerId = PAYOUT_ROUTER_ID,
  streamingId = STREAMING_CONTRACT_ID,
}: PayoutBindingPanelProps) {
  const inputId = useId();
  const errorId = useId();
  const [view, setView] = useState<BindingView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowSecs, setNowSecs] = useState(() => Math.floor(Date.now() / 1000));

  const configured = routerId !== "";

  const load = useCallback(async () => {
    try {
      const next = await readPayoutBinding(streamId);
      setNowSecs(Math.floor(Date.now() / 1000));
      setView(next);
      if (next === null) setError("Could not read the payout binding. Try again.");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoaded(true);
    }
  }, [streamId]);

  useEffect(() => {
    if (!configured) return;
    // Deferred to a microtask so the effect never sets state synchronously.
    void Promise.resolve().then(load);
  }, [configured, load]);

  const status = view ? deriveBindingStatus(view, nowSecs) : null;
  const waiting = status?.state === "pending-waiting";

  // One tick per second, only while a countdown is on screen. The cleanup
  // clears the interval when the wait ends or the panel unmounts.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      setNowSecs(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [waiting]);

  if (!configured) {
    return (
      <section className="card" aria-labelledby={`${inputId}-h`}>
        <h2 id={`${inputId}-h`}>Payout routing</h2>
        <p className="muted" role="note">
          Payout routing is not configured on this network.
        </p>
      </section>
    );
  }

  const check = validatePayoutAddress(input, recipient, {
    streaming: streamingId,
    router: routerId,
  });
  const showInputError = input.trim() !== "" && !check.valid;
  const blocked = status ? confirmBlockedReason(status) : null;

  async function run(action: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await action();
      after?.();
      await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const stateText: Record<string, string> = {
    none: "No payout address is bound. Claims go to your own address.",
    "pending-waiting":
      "A new payout address is waiting. It does not receive claims yet.",
    "pending-ready":
      "The waiting period is over. Confirm to start routing claims to the new address.",
    active: "Claims are routed to the payout address below.",
  };

  return (
    <section className="card" aria-labelledby={`${inputId}-h`}>
      <h2 id={`${inputId}-h`}>Payout routing</h2>
      <p className="muted">
        Send your claims to another address, such as an exchange deposit
        account. Your own key still signs every claim. A new address only starts
        receiving funds after a {BIND_DELAY_SECS / 3600} hour wait and your
        confirmation, so a stolen key cannot silently re-route your payouts.
      </p>

      {!loaded && <p className="muted">Loading payout binding…</p>}

      {status && (
        <div data-testid="payout-state" data-state={status.state}>
          <p>
            <strong>Status:</strong> {stateText[status.state]}
          </p>
          {status.active && (
            <p>
              Active payout address:{" "}
              <span className="mono" style={{ wordBreak: "break-all" }}>
                {status.active}
              </span>
            </p>
          )}
          {status.pending && (
            <p>
              Pending payout address:{" "}
              <span className="mono" style={{ wordBreak: "break-all" }}>
                {status.pending}
              </span>
            </p>
          )}
          {waiting && (
            <p>
              Time left before you can confirm:{" "}
              <span
                className="mono"
                aria-live="polite"
                aria-atomic="true"
                data-testid="payout-countdown"
              >
                {formatCountdown(status.remainingSecs)}
              </span>
            </p>
          )}
        </div>
      )}

      <div>
        <label htmlFor={inputId}>New payout address</label>
        <div className="row">
          <input
            id={inputId}
            type="text"
            className="mono"
            placeholder="G… or C…"
            autoComplete="off"
            spellCheck={false}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
            aria-invalid={showInputError}
            aria-describedby={showInputError ? errorId : undefined}
          />
          <button
            type="button"
            onClick={() =>
              void run(
                () =>
                  proposePayoutBinding(
                    recipient,
                    streamId,
                    check.address,
                    signTransaction
                  ),
                () => setInput("")
              )
            }
            disabled={busy || !check.valid}
          >
            {status?.pending ? "Replace and restart wait" : "Propose address"}
          </button>
        </div>
        {showInputError && (
          <p id={errorId} className="err">
            {check.error}
          </p>
        )}
        {status?.pending && (
          <p className="muted">
            Proposing again replaces the waiting address and restarts the{" "}
            {BIND_DELAY_SECS / 3600} hour wait.
          </p>
        )}
      </div>

      <div className="row">
        <button
          type="button"
          onClick={() =>
            void run(() =>
              confirmPayoutBinding(recipient, streamId, signTransaction)
            )
          }
          disabled={busy || !status?.canConfirm}
          aria-describedby={blocked ? `${inputId}-why` : undefined}
        >
          Confirm payout address
        </button>
        <button
          type="button"
          onClick={() =>
            void run(() =>
              cancelPayoutBinding(recipient, streamId, signTransaction)
            )
          }
          disabled={busy || !status || status.state === "none"}
        >
          Cancel binding
        </button>
      </div>
      {blocked && (
        <p id={`${inputId}-why`} className="muted">
          {blocked}
        </p>
      )}

      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}

      <details>
        <summary>One-time setup: connect the router to this stream</summary>
        <p className="muted">
          The router only sees your claims after you register it on this
          stream. Run this once with your recipient key. The Revert policy makes
          a failed forward cancel the claim instead of leaving it half-routed.
          Cancelling a stream and the withdraw-all call pay your own address,
          not the bound one.
        </p>
        <pre className="mono" style={{ whiteSpace: "pre-wrap" }}>
          {registerHookInstructions({
            streamingId,
            routerId,
            streamId,
            recipient,
          })}
        </pre>
      </details>
    </section>
  );
}
