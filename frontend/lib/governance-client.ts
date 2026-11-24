import {
  Account,
  Address,
  Contract,
  Networks,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { NATIVE_XLM, tokenContractId, type TxSigner } from "./stellar.ts";
import { scAddr, u64 } from "./stellar-ops.ts";
import {
  decodeGovernanceAction,
  decodeStreamPolicy,
  encodeGovernanceAction,
  type AssetPolicyState,
  type GovernanceAction,
  type GovernanceMutation,
  type GovernanceProposal,
  type GovernanceSnapshot,
  type StreamPolicy,
} from "./governance.ts";

const RPC_URL = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK = process.env.NEXT_PUBLIC_NETWORK === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET;
const CONTRACT_ID = process.env.NEXT_PUBLIC_STREAMING_CONTRACT_ID || "";
const DUMMY_SOURCE = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0");

export interface PreparedGovernanceMutation {
  xdr: string;
  minFee: string;
  preparedAt: number;
}

export interface GovernanceSubmission {
  txHash: string;
  result: unknown;
}

function streamingContract(): Contract {
  if (!CONTRACT_ID) {
    throw new Error("NEXT_PUBLIC_STREAMING_CONTRACT_ID is not set; configure the deployed contract before opening governance.");
  }
  return new Contract(CONTRACT_ID);
}

async function readContract(method: string, args: xdr.ScVal[]): Promise<xdr.ScVal | null> {
  const server = new rpc.Server(RPC_URL);
  const transaction = new TransactionBuilder(DUMMY_SOURCE, {
    fee: "100",
    networkPassphrase: NETWORK,
  })
    .addOperation(streamingContract().call(method, ...args))
    .setTimeout(30)
    .build();
  const simulated = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulated)) {
    throw new Error(`Governance read failed (${method}): ${simulated.error}`);
  }
  return simulated.result?.retval ?? null;
}

function required(value: xdr.ScVal | null, label: string): xdr.ScVal {
  if (!value) throw new Error(`Governance read returned no value for ${label}`);
  return value;
}

function native(value: xdr.ScVal | null, label: string): unknown {
  return scValToNative(required(value, label));
}

function nullableAddress(value: xdr.ScVal | null): string | null {
  if (!value) return null;
  const decoded = scValToNative(value);
  return decoded == null ? null : String(decoded);
}

function decodeProposal(value: xdr.ScVal): GovernanceProposal {
  const raw = native(value, "governance_proposal") as Record<string, unknown>;
  return {
    id: String(raw.id),
    action: decodeGovernanceAction(raw.action),
    proposedBy: String(raw.proposed_by),
    proposedAt: BigInt(String(raw.proposed_at)),
    executableAt: BigInt(String(raw.executable_at)),
    signers: (raw.signers as unknown[]).map(String),
    vetoed: Boolean(raw.vetoed),
    executed: Boolean(raw.executed),
  };
}

export async function readAssetPolicy(asset: string): Promise<AssetPolicyState> {
  const [allowedValue, queuedValue] = await Promise.all([
    readContract("policy_is_asset_allowed", [scAddr(asset)]),
    readContract("policy_get_queued_asset", [scAddr(asset)]),
  ]);
  const queuedRaw = queuedValue ? (native(queuedValue, "policy_get_queued_asset") as Record<string, unknown> | null) : null;
  return {
    asset,
    allowed: Boolean(native(required(allowedValue, "policy_is_asset_allowed"), "policy_is_asset_allowed")),
    queued: queuedRaw
      ? {
          allowed: Boolean(queuedRaw.allowed),
          queuedAt: BigInt(String(queuedRaw.queued_at)),
          executableAfter: BigInt(String(queuedRaw.executable_after)),
        }
      : null,
  };
}

export async function readGovernanceSnapshot(assets: string[] = [tokenContractId(NATIVE_XLM)]): Promise<GovernanceSnapshot> {
  const token = tokenContractId(NATIVE_XLM);
  const [initializedValue, signersValue, vetoWindowValue, countValue, adminValue, pendingAdminValue, delayValue, treasuryValue, policyValue] = await Promise.all([
    readContract("governance_is_initialized", []),
    readContract("governance_signers", []),
    readContract("governance_veto_window", []),
    readContract("governance_proposal_count", []),
    readContract("policy_admin", []),
    readContract("policy_pending_admin", []),
    readContract("policy_timelock_delay", []),
    readContract("treasury_status", [scAddr(token)]),
    readContract("get_stream_policy", [xdr.ScVal.scvVoid()]),
  ]);

  const signers = (native(required(signersValue, "governance_signers"), "governance_signers") as unknown[]).map(String);
  const count = BigInt(String(native(required(countValue, "governance_proposal_count"), "governance_proposal_count")));
  const proposals: GovernanceProposal[] = [];
  for (let id = 1n; id <= count; id++) {
    const value = await readContract("governance_proposal", [u64(id)]);
    if (value) proposals.push(decodeProposal(value));
  }
  const treasury = native(required(treasuryValue, "treasury_status"), "treasury_status") as Record<string, unknown>;
  const policyRaw = policyValue ? (native(policyValue, "get_stream_policy") as unknown) : null;
  const assetStates = await Promise.all([...new Set([token, ...assets])].map(readAssetPolicy));

  return {
    initialized: Boolean(native(required(initializedValue, "governance_is_initialized"), "governance_is_initialized")),
    signers,
    vetoWindow: BigInt(String(native(required(vetoWindowValue, "governance_veto_window"), "governance_veto_window"))),
    proposalCount: count,
    proposals,
    governor: treasury.governor == null ? null : String(treasury.governor),
    pendingGovernor: treasury.pending_governor == null ? null : String(treasury.pending_governor),
    policyAdmin: nullableAddress(adminValue),
    pendingPolicyAdmin: nullableAddress(pendingAdminValue),
    policyTimelockDelay: BigInt(String(native(required(delayValue, "policy_timelock_delay"), "policy_timelock_delay"))),
    globalPolicy: policyRaw == null ? null : decodeStreamPolicy(policyRaw),
    assets: assetStates,
    ledgerTimestamp: BigInt(Math.floor(Date.now() / 1000)),
  };
}

function operationFor(source: string, mutation: GovernanceMutation): xdr.Operation {
  const contract = streamingContract();
  switch (mutation.kind) {
    case "propose":
      return contract.call("governance_propose", scAddr(source), encodeGovernanceAction(mutation.action));
    case "sign":
      return contract.call("governance_sign", scAddr(source), u64(mutation.proposalId));
    case "veto":
      return contract.call("governance_veto", scAddr(source), u64(mutation.proposalId));
    case "execute":
      return contract.call("governance_execute", scAddr(source), u64(mutation.proposalId));
    case "assetPropose":
      return contract.call("policy_propose_asset", scAddr(mutation.asset), nativeToScVal(mutation.allowed));
    case "assetExecute":
      return contract.call("policy_execute_asset", scAddr(mutation.asset));
    case "policySetDelay":
      return contract.call("policy_set_timelock_delay", u64(mutation.delay));
    case "policyProposeHandoff":
      return contract.call("policy_propose_handoff", scAddr(mutation.newAdmin));
    case "policyAcceptHandoff":
      return contract.call("policy_accept_handoff");
    case "policyCancelHandoff":
      return contract.call("policy_cancel_handoff");
    case "governorAccept":
      return contract.call("accept_governor", scAddr(source));
    case "bootstrap":
      return contract.call(
        "governance_bootstrap",
        scAddr(source),
        xdr.ScVal.scvVec(mutation.signers.map(scAddr)),
        u64(mutation.vetoWindow),
      );
  }
}

export async function prepareGovernanceMutation(source: string, mutation: GovernanceMutation): Promise<PreparedGovernanceMutation> {
  const server = new rpc.Server(RPC_URL);
  const account = await server.getAccount(source);
  const transaction = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: NETWORK,
  })
    .addOperation(operationFor(source, mutation))
    .setTimeout(300)
    .build();
  const simulated = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulated)) {
    throw new Error(`Simulation failed: ${simulated.error}`);
  }
  const ready = rpc.assembleTransaction(transaction, simulated).build();
  return {
    xdr: ready.toXDR(),
    minFee: String(simulated.minResourceFee ?? "0"),
    preparedAt: Date.now(),
  };
}

export async function submitPreparedGovernanceMutation(
  prepared: PreparedGovernanceMutation,
  signer: TxSigner,
): Promise<GovernanceSubmission> {
  const server = new rpc.Server(RPC_URL);
  const signedXdr = await signer(prepared.xdr, NETWORK);
  const signed = TransactionBuilder.fromXDR(signedXdr, NETWORK);
  const sent = await server.sendTransaction(signed);
  if (sent.status === "ERROR") throw new Error(`Submit failed: ${JSON.stringify(sent.errorResult)}`);

  for (let attempt = 0; attempt < 45; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
    const result = await server.getTransaction(sent.hash);
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Transaction failed: ${JSON.stringify(result.resultXdr)}`);
    }
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      const complete = result as { returnValue?: xdr.ScVal };
      return {
        txHash: sent.hash,
        result: complete.returnValue ? scValToNative(complete.returnValue) : null,
      };
    }
  }
  throw new Error("Timed out waiting for governance transaction inclusion");
}

export function governanceContractId(): string {
  return CONTRACT_ID;
}

export function validateGovernanceAddress(address: string, label = "address"): void {
  let valid = false;
  try {
    valid = new Address(address).toString() === address;
  } catch {
    valid = false;
  }
  if (!valid) throw new Error(`${label} is not a valid Stellar address`);
}
export function actionForPolicy(token: string | null, policy: StreamPolicy): GovernanceAction {
  return { variant: "SetStreamPolicy", payload: [token, policy] };
}
