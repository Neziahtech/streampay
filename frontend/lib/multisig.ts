import {
  Account,
  Contract,
  Networks,
  rpc,
  scValToNative,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

export const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
  "https://soroban-testnet.stellar.org";

export const NETWORK_LABEL =
  process.env.NEXT_PUBLIC_NETWORK === "PUBLIC" ? "public" : "testnet";

const DUMMY_SOURCE = new Account(
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  "0"
);

const NETWORK =
  process.env.NEXT_PUBLIC_NETWORK === "PUBLIC"
    ? Networks.PUBLIC
    : Networks.TESTNET;

async function simulateContractRead(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = []
): Promise<xdr.ScVal | null> {
  if (!contractId || !StrKey.isValidContract(contractId)) return null;
  try {
    const server = new rpc.Server(RPC_URL);
    const tx = new TransactionBuilder(DUMMY_SOURCE, {
      fee: "100",
      networkPassphrase: NETWORK,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) return null;
    return sim.result?.retval ?? null;
  } catch {
    return null;
  }
}

export interface MultisigDetection {
  isMultisig: boolean;
  type?: "contract" | "account";
  threshold?: number;
  totalSigners?: number;
  signers?: string[];
  cancelThreshold?: number;
  requiresProposals?: boolean;
}

/**
 * Detects whether an address is a multisig account (Stellar K-of-N signers)
 * or a Soroban multisig contract account.
 */
export async function detectMultisig(
  address: string
): Promise<MultisigDetection> {
  const clean = address.trim();
  if (!clean) return { isMultisig: false };

  // 1. Check if contract address (C...)
  if (StrKey.isValidContract(clean)) {
    try {
      const thresholdVal = await simulateContractRead(clean, "get_threshold");
      if (thresholdVal !== null) {
        const threshold = Number(scValToNative(thresholdVal));
        if (threshold > 0) {
          const signersVal = await simulateContractRead(clean, "get_signers");
          const signersRaw = signersVal ? scValToNative(signersVal) : [];
          const signers = Array.isArray(signersRaw)
            ? signersRaw.map((s) => String(s))
            : [];
          const cancelThreshVal = await simulateContractRead(
            clean,
            "get_cancel_threshold"
          );
          const cancelThreshold = cancelThreshVal
            ? Number(scValToNative(cancelThreshVal))
            : undefined;

          return {
            isMultisig: true,
            type: "contract",
            threshold,
            totalSigners: signers.length,
            signers,
            cancelThreshold,
            requiresProposals: true,
          };
        }
      }
    } catch {
      // Not a multisig contract or not reachable
    }
    return { isMultisig: false };
  }

  // 2. Check if Stellar G... public key
  if (StrKey.isValidEd25519PublicKey(clean)) {
    try {
      const horizonUrl =
        NETWORK_LABEL === "public"
          ? "https://horizon.stellar.org"
          : "https://horizon-testnet.stellar.org";
      const res = await fetch(`${horizonUrl}/accounts/${clean}`, {
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        const data = (await res.json()) as {
          signers?: Array<{ key: string; weight: number }>;
          thresholds?: { med_threshold?: number; high_threshold?: number };
        };
        const signers = data.signers || [];
        const medThreshold = data.thresholds?.med_threshold ?? 0;
        if (signers.length > 1 || medThreshold > 1) {
          return {
            isMultisig: true,
            type: "account",
            threshold: medThreshold,
            totalSigners: signers.length,
            signers: signers.map((s) => s.key),
            requiresProposals: false,
          };
        }
      }
    } catch {
      // Horizon unreachable or network offline
    }
  }

  return { isMultisig: false };
}
