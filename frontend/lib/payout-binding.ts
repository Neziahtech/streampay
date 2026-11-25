/**
 * Payout routing (issue #80): pure logic for the recipient's "claim to another
 * address" binding.
 *
 * The router is a second Soroban contract (contracts/payout-router). A recipient
 * proposes a payout address, waits BIND_DELAY_SECS, then confirms. Only the
 * confirmed ("active") binding routes claims; a pending one never does.
 *
 * Like stellar-ops.ts, this module has no wallet, no RPC and no env-derived
 * state, so parity tests and headless tooling can import it.
 */
import { Contract, StrKey, type xdr } from "@stellar/stellar-sdk";
import { scAddr, u64 } from "./stellar-ops.ts";

/** Mirrors the router contract's BIND_DELAY_SECS (24 h). */
export const BIND_DELAY_SECS = 86_400;

/** The router's `binding(stream_id)` view, with numbers decoded. */
export interface BindingView {
  active: string | null;
  pending: string | null;
  /** Unix seconds when the pending binding may be confirmed; 0 if none. */
  activatesAt: number;
}

export type BindingState =
  | "none"
  | "pending-waiting"
  | "pending-ready"
  | "active";

export interface BindingStatus {
  state: BindingState;
  /** The payout address claims are routed to right now, if any. */
  active: string | null;
  /** The proposed payout address awaiting confirmation, if any. */
  pending: string | null;
  /** Seconds until the pending binding can be confirmed; never negative. */
  remainingSecs: number;
  /** True only for `pending-ready`. */
  canConfirm: boolean;
}

function toAddressOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s === "" ? null : s;
}

/**
 * Decodes the value `scValToNative` yields for the router's `BindingView`
 * struct. `Option<Address>` arrives as an address string or null/undefined;
 * `activates_at` (u64) arrives as a bigint.
 */
export function parseBindingView(raw: unknown): BindingView {
  const r = (raw ?? {}) as Record<string, unknown>;
  const pending = toAddressOrNull(r.pending);
  const at = Number(r.activates_at ?? 0);
  return {
    active: toAddressOrNull(r.active),
    pending,
    // A zero/garbage timestamp with a pending address would read as "ready";
    // the contract never returns that, so treat it as the value it gave.
    activatesAt: Number.isFinite(at) && at > 0 && pending ? Math.floor(at) : 0,
  };
}

/**
 * Derives the UI state. `nowSecs` is unix seconds. The boundary is inclusive:
 * at exactly `activatesAt` the binding is ready, matching the contract's
 * `now >= activates_at` check. A pending proposal always takes precedence over
 * an existing active one, because that is the next action the recipient has.
 */
export function deriveBindingStatus(
  view: BindingView,
  nowSecs: number
): BindingStatus {
  if (view.pending) {
    const remainingSecs = Math.max(0, Math.ceil(view.activatesAt - nowSecs));
    const ready = remainingSecs === 0;
    return {
      state: ready ? "pending-ready" : "pending-waiting",
      active: view.active,
      pending: view.pending,
      remainingSecs,
      canConfirm: ready,
    };
  }
  if (view.active) {
    return {
      state: "active",
      active: view.active,
      pending: null,
      remainingSecs: 0,
      canConfirm: false,
    };
  }
  return {
    state: "none",
    active: null,
    pending: null,
    remainingSecs: 0,
    canConfirm: false,
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * `hh:mm:ss`, with a leading `Nd ` only when strictly more than 24 h remain.
 * Negative, NaN and infinite input render as `00:00:00`.
 */
export function formatCountdown(secs: number): string {
  const total = Number.isFinite(secs) && secs > 0 ? Math.floor(secs) : 0;
  if (total > 86_400) {
    const days = Math.floor(total / 86_400);
    const rest = total % 86_400;
    return `${days}d ${pad2(Math.floor(rest / 3600))}:${pad2(
      Math.floor((rest % 3600) / 60)
    )}:${pad2(rest % 60)}`;
  }
  return `${pad2(Math.floor(total / 3600))}:${pad2(
    Math.floor((total % 3600) / 60)
  )}:${pad2(total % 60)}`;
}

export function isValidStellarAddress(value: string): boolean {
  return StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value);
}

export interface PayoutAddressCheck {
  valid: boolean;
  /** Trimmed input. */
  address: string;
  error: string | null;
}

/**
 * Client-side mirror of the contract's rejections: a payout must be a G... or
 * C... address and must not be the recipient, the streaming contract or the
 * router. The contract stays the authority; this only saves a failed
 * transaction.
 */
export function validatePayoutAddress(
  input: string,
  recipient: string,
  forbidden: { streaming?: string; router?: string } = {}
): PayoutAddressCheck {
  const address = input.trim();
  const fail = (error: string): PayoutAddressCheck => ({
    valid: false,
    address,
    error,
  });
  if (address === "") return fail("Enter a payout address.");
  if (!isValidStellarAddress(address)) {
    return fail("Not a valid Stellar address (it must start with G or C).");
  }
  if (address === recipient) {
    return fail(
      "The payout address is already your own address. Claims land there without a binding."
    );
  }
  if (forbidden.streaming && address === forbidden.streaming) {
    return fail("The payout address cannot be the streaming contract.");
  }
  if (forbidden.router && address === forbidden.router) {
    return fail("The payout address cannot be the payout router contract.");
  }
  return { valid: true, address, error: null };
}

/** Why the Confirm button is disabled, or null when it can be used. */
export function confirmBlockedReason(status: BindingStatus): string | null {
  switch (status.state) {
    case "pending-ready":
      return null;
    case "pending-waiting":
      return `Confirm unlocks in ${formatCountdown(status.remainingSecs)}.`;
    case "active":
      return "Nothing is waiting for confirmation.";
    default:
      return "Propose a payout address first.";
  }
}

// ---------------------------------------------------------------------------
// Operation builders (router contract; same style as stellar-ops.ts)
// ---------------------------------------------------------------------------

/** propose(stream_id, payout) -> activates_at. Recipient-authenticated. */
export function buildProposePayoutOperation(
  routerId: string,
  streamId: string,
  payout: string
): xdr.Operation {
  return new Contract(routerId).call("propose", u64(streamId), scAddr(payout));
}

/** confirm(stream_id). Recipient-authenticated; fails before activates_at. */
export function buildConfirmPayoutOperation(
  routerId: string,
  streamId: string
): xdr.Operation {
  return new Contract(routerId).call("confirm", u64(streamId));
}

/** cancel(stream_id). Clears both the pending and the active binding. */
export function buildCancelPayoutOperation(
  routerId: string,
  streamId: string
): xdr.Operation {
  return new Contract(routerId).call("cancel", u64(streamId));
}

/** binding(stream_id): read-only view, simulated and never signed. */
export function buildBindingReadOperation(
  routerId: string,
  streamId: string
): xdr.Operation {
  return new Contract(routerId).call("binding", u64(streamId));
}

/**
 * The one-time wiring step. The app has no hook-registration builder, so the
 * panel shows this as instructions: the recipient registers the router on the
 * streaming contract with the Revert policy, so a failed forward reverts the
 * claim instead of leaving it half-routed. HookEventClass and
 * HookFailurePolicy are integer-valued enums on the contract: Withdraw = 1 and
 * Revert = 1.
 */
export function registerHookInstructions(args: {
  streamingId: string;
  routerId: string;
  streamId: string;
  recipient: string;
}): string {
  return [
    `stellar contract invoke --id ${args.streamingId} --source <recipient-key> --network <network> -- register_hook`,
    `  --caller ${args.recipient}`,
    `  --stream_id ${args.streamId}`,
    `  --event_class 1`,
    `  --callback_contract ${args.routerId}`,
    `  --selector on_withdraw`,
    `  --failure_policy 1`,
  ].join(" \\\n");
}
