import { StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { scAddr, u32, u64 } from "./stellar-ops.ts";

export interface StreamPolicy {
  minRate: string;
  maxRate: string;
  minDuration: string;
  maxDuration: string;
  minDeposit: string;
}

export type GovernanceAction =
  | { variant: "SetFeeBps"; payload: [number] }
  | { variant: "SetStreamPolicy"; payload: [string | null, StreamPolicy] }
  | { variant: "SetFrozen"; payload: [boolean] }
  | { variant: "WithdrawTreasury"; payload: [string, string, string] }
  | { variant: "NominateGovernor"; payload: [string] }
  | { variant: "ProposeUpgrade"; payload: [string, string] }
  | { variant: "ExecuteUpgrade"; payload: [] }
  | { variant: "MigrateStorage"; payload: [string, number] }
  | { variant: "SetOracleConfig"; payload: [string[], number, string] }
  | { variant: "SetSigners"; payload: [string[]] }
  | { variant: "SetVetoWindow"; payload: [string] };

export interface GovernanceProposal {
  id: string;
  action: GovernanceAction;
  proposedBy: string;
  proposedAt: bigint;
  executableAt: bigint;
  signers: string[];
  vetoed: boolean;
  executed: boolean;
}

export interface QueuedAssetChange {
  allowed: boolean;
  queuedAt: bigint;
  executableAfter: bigint;
}

export interface AssetPolicyState {
  asset: string;
  allowed: boolean;
  queued: QueuedAssetChange | null;
}

export interface GovernanceSnapshot {
  initialized: boolean;
  signers: string[];
  vetoWindow: bigint;
  proposalCount: bigint;
  proposals: GovernanceProposal[];
  governor: string | null;
  pendingGovernor: string | null;
  policyAdmin: string | null;
  pendingPolicyAdmin: string | null;
  policyTimelockDelay: bigint;
  globalPolicy: StreamPolicy | null;
  assets: AssetPolicyState[];
  ledgerTimestamp: bigint;
}

export type GovernanceMutation =
  | { kind: "propose"; action: GovernanceAction }
  | { kind: "sign"; proposalId: string }
  | { kind: "veto"; proposalId: string }
  | { kind: "execute"; proposalId: string }
  | { kind: "assetPropose"; asset: string; allowed: boolean }
  | { kind: "assetExecute"; asset: string }
  | { kind: "policySetDelay"; delay: string }
  | { kind: "policyProposeHandoff"; newAdmin: string }
  | { kind: "policyAcceptHandoff" }
  | { kind: "policyCancelHandoff" }
  | { kind: "governorAccept" }
  | { kind: "bootstrap"; signers: string[]; vetoWindow: string };

export interface MutationEffect {
  title: string;
  details: string[];
  delaySeconds: bigint;
  requiredSignatures: number;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  status: "simulated" | "submitting" | "submitted" | "failed";
  txHash?: string;
  error?: string;
}

export const MIN_VETO_WINDOW_SECONDS = 86_400n;
export const ROTATION_WINDOW_MULTIPLIER = 4n;
export const REQUIRED_SIGNATURES = 2;

function bytesHex(value: unknown): string {
  if (value instanceof Uint8Array) return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return String(value);
}

function hexBytes(value: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2}){32}$/.test(value)) throw new Error("Upgrade hash must be exactly 32 bytes of hex");
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

export function decodeGovernanceAction(value: unknown): GovernanceAction {
  if (!Array.isArray(value) || typeof value[0] !== "string") {
    throw new Error("Invalid governance action returned by the contract");
  }
  const variant = value[0];
  const payload = value.slice(1);
  switch (variant) {
    case "SetFeeBps":
      return { variant, payload: [Number(payload[0])] };
    case "SetStreamPolicy":
      return { variant, payload: [payload[0] == null ? null : String(payload[0]), decodeStreamPolicy(payload[1])] };
    case "SetFrozen":
      return { variant, payload: [Boolean(payload[0])] };
    case "WithdrawTreasury":
      return { variant, payload: [String(payload[0]), String(payload[1]), String(payload[2])] };
    case "NominateGovernor":
      return { variant, payload: [String(payload[0])] };
    case "ProposeUpgrade":
      return { variant, payload: [bytesHex(payload[0]), String(payload[1])] };
    case "ExecuteUpgrade":
      return { variant, payload: [] };
    case "MigrateStorage":
      return { variant, payload: [String(payload[0]), Number(payload[1])] };
    case "SetOracleConfig":
      return { variant, payload: [(payload[0] as unknown[]).map(String), Number(payload[1]), String(payload[2])] };
    case "SetSigners":
      return { variant, payload: [(payload[0] as unknown[]).map(String)] };
    case "SetVetoWindow":
      return { variant, payload: [String(payload[0])] };
    default:
      throw new Error(`Unsupported governance action: ${variant}`);
  }
}

export function decodeStreamPolicy(value: unknown): StreamPolicy {
  if (!value || typeof value !== "object") throw new Error("Invalid stream policy");
  const raw = value as Record<string, unknown>;
  return {
    minRate: String(raw.min_rate),
    maxRate: String(raw.max_rate),
    minDuration: String(raw.min_duration),
    maxDuration: String(raw.max_duration),
    minDeposit: String(raw.min_deposit),
  };
}

export function encodeStreamPolicy(policy: StreamPolicy): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("min_rate"), val: u64(policy.minRate) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_rate"), val: u64(policy.maxRate) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("min_duration"), val: u64(policy.minDuration) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_duration"), val: u64(policy.maxDuration) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("min_deposit"), val: nativeToScVal(BigInt(policy.minDeposit), { type: "i128" }) }),
  ]);
}

export function encodeGovernanceAction(action: GovernanceAction): xdr.ScVal {
  const head = xdr.ScVal.scvSymbol(action.variant);
  switch (action.variant) {
    case "SetFeeBps":
      return xdr.ScVal.scvVec([head, u32(action.payload[0])]);
    case "SetStreamPolicy": {
      const [token, policy] = action.payload;
      return xdr.ScVal.scvVec([head, token ? scAddr(token) : xdr.ScVal.scvVoid(), encodeStreamPolicy(policy)]);
    }
    case "SetFrozen":
      return xdr.ScVal.scvVec([head, nativeToScVal(action.payload[0])]);
    case "WithdrawTreasury":
      return xdr.ScVal.scvVec([
        head,
        scAddr(action.payload[0]),
        scAddr(action.payload[1]),
        nativeToScVal(BigInt(action.payload[2]), { type: "i128" }),
      ]);
    case "NominateGovernor":
      return xdr.ScVal.scvVec([head, scAddr(action.payload[0])]);
    case "ProposeUpgrade":
      return xdr.ScVal.scvVec([
        head,
        nativeToScVal(hexBytes(action.payload[0]), { type: "bytes" }),
        u64(action.payload[1]),
      ]);
    case "ExecuteUpgrade":
      return xdr.ScVal.scvVec([head]);
    case "MigrateStorage":
      return xdr.ScVal.scvVec([head, u64(action.payload[0]), u32(action.payload[1])]);
    case "SetOracleConfig":
      return xdr.ScVal.scvVec([
        head,
        xdr.ScVal.scvVec(action.payload[0].map(scAddr)),
        u32(action.payload[1]),
        u64(action.payload[2]),
      ]);
    case "SetSigners":
      return xdr.ScVal.scvVec([head, xdr.ScVal.scvVec(action.payload[0].map(scAddr))]);
    case "SetVetoWindow":
      return xdr.ScVal.scvVec([head, u64(action.payload[0])]);
  }
}

export function actionSummary(action: GovernanceAction): string {
  switch (action.variant) {
    case "SetFeeBps":
      return `Set protocol fee to ${action.payload[0]} bps`;
    case "SetStreamPolicy": {
      const [token, policy] = action.payload;
      return `Set ${token ? `asset ${shortAddress(token)}` : "global"} stream policy (rate ${policy.minRate}–${policy.maxRate}, duration ${policy.minDuration}–${policy.maxDuration}, deposit ≥ ${policy.minDeposit})`;
    }
    case "SetFrozen":
      return action.payload[0] ? "Freeze stream mutations" : "Unfreeze stream mutations";
    case "WithdrawTreasury":
      return `Withdraw ${action.payload[2]} base units from ${shortAddress(action.payload[0])} to ${shortAddress(action.payload[1])}`;
    case "NominateGovernor":
      return `Nominate ${shortAddress(action.payload[0])} as treasury governor`;
    case "ProposeUpgrade":
      return `Propose contract upgrade ${action.payload[0].slice(0, 12)}… with ${action.payload[1]}s delay`;
    case "ExecuteUpgrade":
      return "Execute the pending contract upgrade";
    case "MigrateStorage":
      return `Migrate storage from stream ${action.payload[0]} (batch ${action.payload[1]})`;
    case "SetOracleConfig":
      return `Set oracle threshold ${action.payload[1]} across ${action.payload[0].length} publishers`;
    case "SetSigners":
      return `Replace governance signer set with ${action.payload[0].length} keys`;
    case "SetVetoWindow":
      return `Set governance veto window to ${action.payload[0]} seconds`;
  }
}

export function mutationSummary(mutation: GovernanceMutation): string {
  switch (mutation.kind) {
    case "propose":
      return `Propose: ${actionSummary(mutation.action)}`;
    case "sign":
      return `Sign proposal #${mutation.proposalId}`;
    case "veto":
      return `Veto proposal #${mutation.proposalId}`;
    case "execute":
      return `Execute proposal #${mutation.proposalId}`;
    case "assetPropose":
      return `Queue ${mutation.allowed ? "allow" : "remove"} for ${shortAddress(mutation.asset)}`;
    case "assetExecute":
      return `Execute queued allowlist change for ${shortAddress(mutation.asset)}`;
    case "policySetDelay":
      return `Set allowlist timelock delay to ${mutation.delay} seconds`;
    case "policyProposeHandoff":
      return `Nominate ${shortAddress(mutation.newAdmin)} as policy admin`;
    case "policyAcceptHandoff":
      return "Accept policy admin handoff";
    case "policyCancelHandoff":
      return "Cancel policy admin handoff";
    case "governorAccept":
      return "Accept treasury governor nomination";
    case "bootstrap":
      return `Bootstrap governance with ${mutation.signers.length} signers`;
  }
}

export function describeMutation(mutation: GovernanceMutation, snapshot: GovernanceSnapshot): MutationEffect {
  const title = mutationSummary(mutation);
  if (mutation.kind === "propose") {
    const rotation = mutation.action.variant === "SetSigners";
    return {
      title,
      details: [
        "The proposal starts with no signatures; proposing does not approve it.",
        rotation
          ? "Key rotation has a four-times-longer execution window and needs one current signer signature."
          : "Execution needs two distinct current signer signatures.",
        "Any current signer may veto before the execution timestamp.",
      ],
      delaySeconds: snapshot.vetoWindow * (rotation ? ROTATION_WINDOW_MULTIPLIER : 1n),
      requiredSignatures: rotation ? 1 : REQUIRED_SIGNATURES,
    };
  }
  if (mutation.kind === "sign" || mutation.kind === "veto" || mutation.kind === "execute") {
    const proposal = snapshot.proposals.find((item) => item.id === mutation.proposalId);
    const remaining = proposal ? proposal.executableAt - snapshot.ledgerTimestamp : 0n;
    return {
      title,
      details: [
        proposal ? actionSummary(proposal.action) : "The proposal will be re-read by contract simulation.",
        mutation.kind === "execute"
          ? "Execution is permissionless on-chain; this console only offers it to current signers."
          : mutation.kind === "veto"
            ? "Veto is permanent and available only before the execution timestamp."
            : "This adds only the connected wallet's signature; it does not execute the action.",
      ],
      delaySeconds: mutation.kind === "execute" && remaining > 0n ? remaining : 0n,
      requiredSignatures: mutation.kind === "veto" ? 1 : proposal?.action.variant === "SetSigners" ? 1 : REQUIRED_SIGNATURES,
    };
  }
  if (mutation.kind === "assetPropose" || mutation.kind === "assetExecute") {
    return {
      title,
      details: mutation.kind === "assetPropose"
        ? ["This queues the change; it does not alter the allowlist immediately.", "Only new streams are affected; withdrawals and refunds remain available."]
        : ["Execution is permissionless on-chain after the timelock; this console only offers it to the policy admin.", "The contract re-checks the queue and timelock before applying the change."],
      delaySeconds: mutation.kind === "assetPropose" ? snapshot.policyTimelockDelay : 0n,
      requiredSignatures: 0,
    };
  }
  if (mutation.kind === "bootstrap") {
    return {
      title,
      details: ["Bootstrap is one-time and closes direct governor-only admin paths.", "Two to ten distinct signer keys and a veto window of at least one day are required."],
      delaySeconds: 0n,
      requiredSignatures: 0,
    };
  }
  return {
    title,
    details: ["The contract enforces the connected wallet's role and all on-chain preconditions.", "No timelock guard is bypassed by this console."],
    delaySeconds: 0n,
    requiredSignatures: 0,
  };
}

export function proposalView(proposal: GovernanceProposal, currentSigners: string[], now: bigint) {
  const liveSignatures = proposal.signers.filter((signer) => currentSigners.includes(signer)).length;
  const requiredSignatures = proposal.action.variant === "SetSigners" ? 1 : REQUIRED_SIGNATURES;
  const remaining = proposal.executableAt > now ? proposal.executableAt - now : 0n;
  let status: "executed" | "vetoed" | "ready" | "awaiting_signatures" | "awaiting_timelock";
  if (proposal.executed) status = "executed";
  else if (proposal.vetoed) status = "vetoed";
  else if (remaining === 0n && liveSignatures >= requiredSignatures) status = "ready";
  else if (remaining === 0n) status = "awaiting_signatures";
  else status = "awaiting_timelock";
  return { liveSignatures, requiredSignatures, remaining, status };
}

export function canReviewMutation(mutation: GovernanceMutation, snapshot: GovernanceSnapshot, address: string | null): boolean {
  if (!address) return false;
  switch (mutation.kind) {
    case "propose":
    case "sign":
    case "veto":
    case "execute":
      return snapshot.initialized && snapshot.signers.includes(address);
    case "assetPropose":
    case "assetExecute":
    case "policySetDelay":
    case "policyProposeHandoff":
    case "policyCancelHandoff":
      return snapshot.policyAdmin === address;
    case "policyAcceptHandoff":
      return snapshot.pendingPolicyAdmin === address;
    case "governorAccept":
      return snapshot.pendingGovernor === address;
    case "bootstrap":
      return !snapshot.initialized && snapshot.governor === address;
  }
}

export function validatePolicy(policy: StreamPolicy): void {
  const fields = Object.entries(policy);
  for (const [name, value] of fields) {
    if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  }
  if (BigInt(policy.minRate) > BigInt(policy.maxRate) && policy.maxRate !== "0") {
    throw new Error("Minimum rate cannot exceed maximum rate");
  }
  if (BigInt(policy.minDuration) > BigInt(policy.maxDuration) && policy.maxDuration !== "0") {
    throw new Error("Minimum duration cannot exceed maximum duration");
  }
  if (BigInt(policy.minDeposit) < 0n) throw new Error("Minimum deposit cannot be negative");
}

export function validateSignerSet(signers: string[]): void {
  if (signers.length < 2 || signers.length > 10) throw new Error("Signer sets require 2–10 keys");
  if (new Set(signers).size !== signers.length) throw new Error("Signer keys must be distinct");
  for (const signer of signers) {
    if (!StrKey.isValidEd25519PublicKey(signer)) throw new Error(`Invalid signer address: ${signer}`);
  }
}

export function validateVetoWindow(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error("Veto window must be a non-negative integer");
  const seconds = BigInt(value);
  if (seconds < MIN_VETO_WINDOW_SECONDS) throw new Error("Veto window must be at least 86400 seconds");
  return seconds;
}

export function formatCountdown(seconds: bigint): string {
  if (seconds <= 0n) return "Ready";
  const days = seconds / 86_400n;
  const hours = (seconds % 86_400n) / 3_600n;
  const minutes = (seconds % 3_600n) / 60n;
  const secs = seconds % 60n;
  return days > 0n ? `${days}d ${hours}h ${minutes}m` : `${hours}h ${minutes}m ${secs}s`;
}

export function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-5)}` : address;
}
