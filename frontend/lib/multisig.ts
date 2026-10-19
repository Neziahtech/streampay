/**
 * Client-side helper for detecting and interacting with Soroban K-of-N Multisig contracts.
 */
import {
  Account,
  Networks,
  rpc,
  scValToNative,
  StrKey,
  TransactionBuilder,
  Contract,
  xdr,
} from "@stellar/stellar-sdk";

export interface MultisigInfo {
  address: string;
  isMultisig: boolean;
  threshold: number;
  signers: string[];
}

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
  "https://soroban-testnet.stellar.org";
const NETWORK =
  process.env.NEXT_PUBLIC_NETWORK === "PUBLIC"
    ? Networks.PUBLIC
    : Networks.TESTNET;

const DUMMY_SOURCE = new Account(
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  "0"
);

async function simulateContractCall(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = []
): Promise<unknown | null> {
  const server = new rpc.Server(RPC_URL);
  const target = new Contract(contractId);
  const transaction = new TransactionBuilder(DUMMY_SOURCE, {
    fee: "100",
    networkPassphrase: NETWORK,
  })
    .addOperation(target.call(method, ...args))
    .setTimeout(30)
    .build();

  const simulated = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulated)) return null;
  if (!simulated.result?.retval) return null;
  return scValToNative(simulated.result.retval);
}

/** In-memory cache to avoid repeated RPC queries for the same address */
const multisigCache = new Map<string, MultisigInfo | null>();

/**
 * Checks whether an address is a deployed K-of-N Multisig contract
 * and retrieves its threshold and active signer set.
 *
 * Safe to call with non-contract or non-multisig addresses (returns null).
 */
export async function fetchMultisigInfo(address: string): Promise<MultisigInfo | null> {
  const trimmed = (address || "").trim();
  if (!trimmed || !StrKey.isValidContract(trimmed)) {
    return null;
  }

  if (multisigCache.has(trimmed)) {
    return multisigCache.get(trimmed) ?? null;
  }

  try {
    // Check if contract implements the standard `is_multisig` entrypoint
    const isMultiVal = await simulateContractCall(trimmed, "is_multisig", []).catch(() => null);
    if (!isMultiVal) {
      multisigCache.set(trimmed, null);
      return null;
    }

    const [thresholdVal, signersVal] = await Promise.all([
      simulateContractCall(trimmed, "get_threshold", []).catch(() => null),
      simulateContractCall(trimmed, "get_signers", []).catch(() => null),
    ]);

    const threshold = typeof thresholdVal === "number" ? thresholdVal : Number(thresholdVal ?? 1);
    const signers: string[] = Array.isArray(signersVal)
      ? signersVal.map((s: unknown) => String(s))
      : [];

    const info: MultisigInfo = {
      address: trimmed,
      isMultisig: true,
      threshold: Math.max(1, threshold),
      signers,
    };

    multisigCache.set(trimmed, info);
    return info;
  } catch {
    // If query fails (e.g. offline / mock / not a multisig contract)
    multisigCache.set(trimmed, null);
    return null;
  }
}

/**
 * Resets the multisig cache (useful for tests).
 */
export function clearMultisigCache(): void {
  multisigCache.clear();
}
