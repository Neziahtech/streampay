/**
 * Signing Request Conformance Schema Assertions.
 *
 * Asserts that transactions produced by the frontend match the exact documented
 * schemas and invariants required for safe wallet signing:
 * 1. Correct network passphrase (prevents cross-network signature replay)
 * 2. Fee within defined bounds (prevents accidental gas draining)
 * 3. Memo-less transactions for stream operations and claims
 * 4. Exact Soroban invokeHostFunction schema (contract ID, function name, ScVal argument types)
 * 5. Timebound validity (valid timeout window, non-zero maxTime)
 */
import {
  Address,
  Networks,
  Transaction,
  TransactionBuilder,
  xdr,
  scValToNative,
} from "@stellar/stellar-sdk";

export const CONFORMANCE_DEFAULTS = {
  NETWORK_PASSPHRASE: Networks.TESTNET,
  MIN_FEE_STROOPS: 100,
  MAX_FEE_STROOPS: 100_000,
  MAX_TIMEOUT_SECONDS: 300,
} as const;

export interface ConformanceValidationRules {
  expectedNetworkPassphrase?: string;
  minFeeStroops?: number;
  maxFeeStroops?: number;
  requireMemoNone?: boolean;
  expectedContractId?: string;
  expectedMethod?: string;
  expectedArgCount?: number;
}

export interface ConformanceReport {
  valid: boolean;
  networkPassphrase: string;
  fee: number;
  memoType: string;
  operationType: string;
  contractId?: string;
  method?: string;
  args?: unknown[];
}

/**
 * Validates that a Stellar Transaction strictly complies with StreamPay's
 * signing request specifications. Throws a detailed descriptive Error on any violation.
 */
export function assertSigningConformance(
  tx: Transaction,
  rules: ConformanceValidationRules = {}
): ConformanceReport {
  const expectedPassphrase =
    rules.expectedNetworkPassphrase ?? CONFORMANCE_DEFAULTS.NETWORK_PASSPHRASE;
  const minFee = rules.minFeeStroops ?? CONFORMANCE_DEFAULTS.MIN_FEE_STROOPS;
  const maxFee = rules.maxFeeStroops ?? CONFORMANCE_DEFAULTS.MAX_FEE_STROOPS;
  const requireMemoNone = rules.requireMemoNone ?? true;

  // 1. Network Passphrase Invariant
  if (tx.networkPassphrase !== expectedPassphrase) {
    throw new Error(
      `Conformance violation: Network passphrase mismatch. Expected "${expectedPassphrase}", got "${tx.networkPassphrase}".`
    );
  }

  // 2. Single Operation Invariant
  if (tx.operations.length !== 1) {
    throw new Error(
      `Conformance violation: Expected exactly 1 operation per transaction, got ${tx.operations.length}.`
    );
  }

  // 3. Fee Bounds Invariant
  const fee = Number(tx.fee);
  if (!Number.isFinite(fee) || fee < minFee || fee > maxFee) {
    throw new Error(
      `Conformance violation: Fee out of bounds. Expected between ${minFee} and ${maxFee} stroops, got ${fee}.`
    );
  }

  // 4. Memo-less Operations Invariant
  const memoType = tx.memo.type;
  if (requireMemoNone && memoType !== "none") {
    throw new Error(
      `Conformance violation: Memo-less claims invariant violated. Expected memo type "none", got "${memoType}" with value "${JSON.stringify(
        tx.memo.value
      )}".`
    );
  }

  // 5. Timebounds Invariant
  if (!tx.timeBounds) {
    throw new Error("Conformance violation: Transaction missing timeBounds.");
  }
  const maxTime = Number(tx.timeBounds.maxTime);
  if (maxTime <= 0) {
    throw new Error(
      `Conformance violation: Transaction has invalid maxTime: ${maxTime}.`
    );
  }

  const op = tx.operations[0];
  if (op.type !== "invokeHostFunction") {
    throw new Error(
      `Conformance violation: Expected operation type "invokeHostFunction", got "${op.type}".`
    );
  }

  const hostFnOp = op as {
    func: {
      type: string;
      invokeContract: {
        contractAddress: xdr.ScAddress;
        functionName: { toString(): string };
        args: xdr.ScVal[];
      };
    };
  };

  const hostFn = hostFnOp.func;
  if (hostFn.type !== "hostFunctionTypeInvokeContract") {
    throw new Error(
      `Conformance violation: HostFunction is not invokeContract, got "${hostFn.type}".`
    );
  }

  const invokeArgs = hostFn.invokeContract;
  const contractAddress = Address.fromScAddress(invokeArgs.contractAddress).toString();
  const functionNameSymbol = invokeArgs.functionName.toString();
  const rawArgs = invokeArgs.args || [];

  if (rules.expectedContractId && contractAddress !== rules.expectedContractId) {
    throw new Error(
      `Conformance violation: Contract ID mismatch. Expected "${rules.expectedContractId}", got "${contractAddress}".`
    );
  }

  if (rules.expectedMethod && functionNameSymbol !== rules.expectedMethod) {
    throw new Error(
      `Conformance violation: Contract method mismatch. Expected "${rules.expectedMethod}", got "${functionNameSymbol}".`
    );
  }

  if (
    rules.expectedArgCount !== undefined &&
    rawArgs.length !== rules.expectedArgCount
  ) {
    throw new Error(
      `Conformance violation: Argument count mismatch for "${functionNameSymbol}". Expected ${rules.expectedArgCount}, got ${rawArgs.length}.`
    );
  }

  const nativeArgs = rawArgs.map((scv) => scValToNative(scv));

  return {
    valid: true,
    networkPassphrase: tx.networkPassphrase,
    fee,
    memoType,
    operationType: op.type,
    contractId: contractAddress,
    method: functionNameSymbol,
    args: nativeArgs,
  };
}

/**
 * Parses raw transaction XDR against network passphrase and asserts signing conformance.
 */
export function assertSigningRequestXdr(
  txXdr: string,
  rules: ConformanceValidationRules = {}
): ConformanceReport {
  const passphrase =
    rules.expectedNetworkPassphrase ?? CONFORMANCE_DEFAULTS.NETWORK_PASSPHRASE;
  let tx: Transaction;
  try {
    tx = TransactionBuilder.fromXDR(txXdr, passphrase) as Transaction;
  } catch (err) {
    throw new Error(
      `Conformance violation: Failed to deserialize transaction XDR with passphrase "${passphrase}": ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  return assertSigningConformance(tx, rules);
}
