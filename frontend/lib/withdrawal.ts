/**
 * Pure validation and formatting helpers for stream withdrawal operations.
 */

/**
 * Protocol economic threshold: minimum withdrawal amount allowed by contract (in stroops).
 * Withdrawing amounts below this burns more in network transaction fees than value received.
 */
export const MIN_CLAIM_AMOUNT = 50n;

/**
 * Protocol economic threshold: minimum stream deposit allowed by contract (in stroops).
 */
export const MIN_STREAM_DEPOSIT = 100n;

export interface WithdrawalValidationResult {
  valid: boolean;
  error?: string;
  overWithdrawal: boolean;
  belowMinimum: boolean;
  amount: bigint;
}

/**
 * Evaluates whether an accrued balance is worth claiming right now.
 * Protects users from burning network fees on economically irrational dust claims.
 */
export function isClaimWorthwhile(
  available: bigint | null,
  minClaim: bigint = MIN_CLAIM_AMOUNT
): boolean {
  if (available === null || available <= 0n) return false;
  return available >= minClaim;
}

/**
 * Validates a user-input withdrawal amount against the available balance and economic floor.
 * Prevents client-side over-withdrawal, negative amounts, dust claims, and invalid numbers.
 */
export function validateWithdrawal(
  amountStr: string,
  available: bigint | null,
  minClaim: bigint = MIN_CLAIM_AMOUNT
): WithdrawalValidationResult {
  const trimmed = amountStr.trim();
  if (!trimmed) {
    return {
      valid: false,
      error: "Please enter an amount to withdraw.",
      overWithdrawal: false,
      belowMinimum: false,
      amount: 0n,
    };
  }

  let amount: bigint;
  try {
    amount = BigInt(trimmed);
  } catch {
    return {
      valid: false,
      error: "Invalid numeric amount.",
      overWithdrawal: false,
      belowMinimum: false,
      amount: 0n,
    };
  }

  if (amount <= 0n) {
    return {
      valid: false,
      error: "Withdrawal amount must be greater than zero.",
      overWithdrawal: false,
      belowMinimum: false,
      amount,
    };
  }

  if (minClaim > 0n && amount < minClaim) {
    return {
      valid: false,
      error: `Amount (${amount.toString()}) is below the minimum economic claim floor of ${minClaim.toString()} units. Network fees would exceed this claim.`,
      overWithdrawal: false,
      belowMinimum: true,
      amount,
    };
  }

  if (available !== null && amount > available) {
    return {
      valid: false,
      error: `Amount exceeds the currently accrued ${available.toString()} units. The contract will reject this call with AmountExceedsAvailable.`,
      overWithdrawal: true,
      belowMinimum: false,
      amount,
    };
  }

  return {
    valid: true,
    overWithdrawal: false,
    belowMinimum: false,
    amount,
  };
}

/**
 * Formats token units for display.
 */
export function fmtUnits(v: bigint | number | string): string {
  try {
    return BigInt(v).toString();
  } catch {
    return String(v);
  }
}

/** The contract's batch-claim cap (`stream::MAX_WITHDRAW_BATCH`), mirrored. */
export const MAX_WITHDRAW_BATCH = 20;

/**
 * Multi-select batch claiming is opt-in while `withdraw_many` is new: the
 * contract is the authority, this flag only gates the affordance.
 */
export const BATCH_CLAIM_ENABLED =
  process.env.NEXT_PUBLIC_BATCH_CLAIM === "1";

export interface BatchSelectionResult {
  valid: boolean;
  error?: string;
  /** The ids to send, in the order the contract will answer them. */
  ids: string[];
}

/**
 * Checks a batch-claim selection against the bounds `withdraw_many` enforces
 * on-chain, so an impossible request is caught before a wallet prompt instead
 * of as a failed transaction. The contract's own rejections are
 * `WithdrawBatchEmpty` (#96), `WithdrawBatchTooLarge` (#97) and
 * `WithdrawDuplicateStreamIds` (#98).
 */
export function validateBatchSelection(selection: string[]): BatchSelectionResult {
  if (selection.length === 0) {
    return {
      valid: false,
      error: "Select at least one stream to claim.",
      ids: [],
    };
  }
  if (selection.length > MAX_WITHDRAW_BATCH) {
    return {
      valid: false,
      error: `A single claim covers at most ${MAX_WITHDRAW_BATCH} streams.`,
      ids: [],
    };
  }
  if (new Set(selection).size !== selection.length) {
    return {
      valid: false,
      error: "A stream can only be claimed once per batch.",
      ids: [],
    };
  }
  return { valid: true, ids: [...selection] };
}
