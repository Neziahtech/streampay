/** Shared types for the StreamPay testnet canary. */

/** Where a lifecycle step failed. Simulation vs submission is the key split. */
export type FailureClass =
  | "simulation"
  | "submission"
  | "inclusion"
  | "assertion"
  | "timeout"
  | "funding"
  | "transport"
  | "config"
  | "unknown";

export interface FailureDetail {
  step: string;
  failureClass: FailureClass;
  message: string;
  hint: string;
  rpcMethod?: string;
  rpcExcerpt?: string;
  transactionXdr?: string;
  resultXdr?: string;
  /** Set when the failure was injected with --force-fail-at for alert testing. */
  forced?: boolean;
}

export interface StepRecord {
  name: string;
  status: "passed" | "failed";
  durationMs: number;
  txHash?: string;
  envelopeXdr?: string;
  detail?: FailureDetail;
}

export interface TxReceipt {
  hash: string;
  envelopeXdr: string;
}

export interface StreamState {
  id: bigint;
  sender: string;
  recipient: string;
  token: string;
  deposit: bigint;
  withdrawn: bigint;
  startTime: bigint;
  endTime: bigint;
  cancelable: boolean;
  status: "Active" | "Cancelled" | "Depleted";
}

export interface PrepareResult {
  sender: string;
  recipient: string;
  token: string;
  approval: TxReceipt;
  friendbot: { sender: string; recipient: string };
}

export interface CreateStreamInput {
  sender: string;
  recipient: string;
  token: string;
  deposit: bigint;
  startTime: number;
  endTime: number;
  cancelable: boolean;
}

/**
 * High-level chain operations the lifecycle drives. The real implementation
 * uses Soroban RPC plus the frontend's shared operation builders; tests inject
 * an in-memory fake.
 */
export interface CanaryBackend {
  prepare(): Promise<PrepareResult>;
  createStream(input: CreateStreamInput): Promise<TxReceipt & { streamId: bigint }>;
  getStream(streamId: bigint): Promise<StreamState>;
  available(streamId: bigint): Promise<bigint>;
  withdraw(streamId: bigint, amount: bigint): Promise<TxReceipt>;
  withdrawMax(streamId: bigint): Promise<TxReceipt & { amount: bigint }>;
  cancel(streamId: bigint, caller: "sender" | "recipient"): Promise<TxReceipt>;
}

export interface RunContext {
  workflow: string;
  job: string;
  runId: string;
  runUrl: string;
  actor: string;
  sha: string;
  ref: string;
  repository: string;
  eventName: string;
  attempt: string;
}

export interface StreamRef {
  id: string;
  sender: string;
  recipient: string;
  deposit: string;
  windowSeconds: number;
  startTime: string;
  endTime: string;
}

export interface GitCommitInfo {
  sha: string;
  subject: string;
  author: string;
  date: string;
  pullRequest: number | null;
}

export interface GitInfo {
  sha: string;
  subject: string;
  author: string;
  date: string;
  pullRequest: number | null;
  contract: GitCommitInfo | null;
  frontendOps: GitCommitInfo | null;
}
