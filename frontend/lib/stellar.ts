/**
 * Minimal Soroban integration for StreamPay.
 *
 * Flow for every mutating call: build the contract operation → simulate
 * (validity + resource estimate) → Freighter signs → send → poll until
 * inclusion, then decode the contract's return value. Read-only calls
 * simulate and decode the return value without signing.
 */
import {
  Account,
  Address,
  nativeToScVal,
  Networks,
  rpc,
  scValToNative,
  Transaction,
  TransactionBuilder,
  Contract,
  xdr,
} from "@stellar/stellar-sdk";
import freighterPkg from "@stellar/freighter-api";

// CJS / ESM interop for Node test runner and Next.js bundler
const freighter = ((freighterPkg as unknown as { default?: typeof freighterPkg }).default ||
  freighterPkg) as typeof freighterPkg;
const { signTransaction } = freighter;

export const DEFAULT_FEE = "100000";
export const DEFAULT_TIMEOUT_SECONDS = 60;
export const DEFAULT_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
  "https://soroban-testnet.stellar.org";
const NETWORK =
  process.env.NEXT_PUBLIC_NETWORK === "PUBLIC"
    ? Networks.PUBLIC
    : Networks.TESTNET;
const CONTRACT_ID = process.env.NEXT_PUBLIC_STREAMING_CONTRACT_ID || "";

export function getNetworkPassphrase(): string {
  return NETWORK;
}

export function contract(overrideContractId?: string): Contract {
  const targetId = overrideContractId || CONTRACT_ID || DEFAULT_CONTRACT_ID;
  if (!targetId) {
    throw new Error(
      "NEXT_PUBLIC_STREAMING_CONTRACT_ID is not set — deploy the contract and put its id in frontend/.env.local"
    );
  }
  return new Contract(targetId);
}

export interface StreamArgs {
  token: string;
  recipient: string;
  /** Deposit in smallest token units (stroops for classic assets), as a string. */
  deposit: string;
  /** Stream length in days (start = now). */
  days: string;
  cancelable: boolean;
}

export interface StreamView {
  id: string;
  sender: string;
  recipient: string;
  token: string;
  deposit: string;
  withdrawn: string;
  startTime: number;
  endTime: number;
  cancelable: boolean;
  status: string;
}

function scAddr(s: string) {
  return nativeToScVal(new Address(s), { type: "address" });
}

function u64(id: string | number | bigint) {
  return nativeToScVal(BigInt(id), { type: "u64" });
}

function i128(v: string) {
  return nativeToScVal(BigInt(v), { type: "i128" });
}

function u32(v: number) {
  return nativeToScVal(BigInt(v), { type: "u32" });
}

/**
 * Network label for localStorage keys — stream ids are per-network facts and
 * must never leak between testnet and publicnet caches.
 */
export const NETWORK_LABEL = NETWORK === Networks.PUBLIC ? "public" : "testnet";

/** Map a StreamError code (contract errors surface as `Error(Contract, #N)`). */
const STREAM_ERRORS: Record<number, string> = {
  1: "StreamNotFound",
  2: "NotStreamSender",
  3: "NotStreamRecipient",
  4: "StreamNotCancellable",
  5: "StreamNotActive",
  6: "StartTimeInPast",
  7: "InvalidTimeRange",
  8: "DurationTooLong",
  9: "ZeroAmount",
  10: "AmountExceedsAvailable",
  11: "MathOverflow",
  12: "NotAuthorized",
  13: "NothingToWithdraw",
  14: "FeeRateTooHigh",
  15: "NotGovernor",
  16: "NoPendingGovernor",
  17: "InsufficientTreasuryBalance",
};

/** Rewrites raw simulation/tx error text into a readable StreamError name. */
export function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const m = message.match(/Error\(Contract, #(\d+)\)/);
  if (m) {
    const name = STREAM_ERRORS[Number(m[1])];
    return name
      ? `Contract rejected the call: ${name} (#${m[1]})`
      : `Contract error #${m[1]}`;
  }
  return message;
}

/** The ed25519 all-zero key: a syntactically valid source for simulations. */
const DUMMY_SOURCE = new Account(
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  "0"
);

export function buildStreamTransaction(
  sourceAccount: Account,
  operation: xdr.Operation,
  options?: {
    fee?: string;
    networkPassphrase?: string;
    timeout?: number;
  }
): Transaction {
  return new TransactionBuilder(sourceAccount, {
    fee: options?.fee || DEFAULT_FEE,
    networkPassphrase: options?.networkPassphrase || NETWORK,
  })
    .addOperation(operation)
    .setTimeout(options?.timeout ?? DEFAULT_TIMEOUT_SECONDS)
    .build();
}

export function buildCreateStreamOp(
  sender: string,
  args: StreamArgs,
  overrideContractId?: string
): { operation: xdr.Operation; start: number; end: number } {
  const start = Math.floor(Date.now() / 1000) + 1;
  const end = start + Math.ceil(Number(args.days) * 86_400);
  const operation = contract(overrideContractId).call(
    "create_stream",
    scAddr(sender),
    scAddr(args.recipient),
    scAddr(args.token),
    i128(args.deposit),
    u64(start),
    u64(end),
    nativeToScVal(args.cancelable)
  );
  return { operation, start, end };
}

export function buildWithdrawOp(
  streamId: string,
  amount: string,
  overrideContractId?: string
): xdr.Operation {
  return contract(overrideContractId).call(
    "withdraw",
    u64(streamId),
    i128(amount)
  );
}

export function buildWithdrawMaxOp(
  streamId: string,
  overrideContractId?: string
): xdr.Operation {
  return contract(overrideContractId).call("withdraw_max", u64(streamId));
}

export function buildTopUpOp(
  streamId: string,
  amount: string,
  overrideContractId?: string
): xdr.Operation {
  return contract(overrideContractId).call(
    "top_up",
    u64(streamId),
    i128(amount)
  );
}

export function buildCancelStreamOp(
  caller: string,
  streamId: string,
  overrideContractId?: string
): xdr.Operation {
  return contract(overrideContractId).call(
    "cancel_stream",
    scAddr(caller),
    u64(streamId)
  );
}

/**
 * Builds, simulates, Freighter-signs, sends and polls a mutating contract
 * operation. Resolves with the contract method's decoded return value.
 */
async function send<T>(
  source: string,
  operation: xdr.Operation,
  decode: (v: xdr.ScVal) => T
): Promise<T> {
  const server = new rpc.Server(RPC_URL);
  const account = await server.getAccount(source);
  const tx = buildStreamTransaction(account, operation);

  // 1. Simulate: catches contract errors early and assembles Soroban tx data.
  const simulated = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulated)) {
    throw new Error(`Simulation failed: ${simulated.error}`);
  }
  const ready = rpc.assembleTransaction(tx, simulated).build();

  // 2. Sign with Freighter.
  const { signedTxXdr } = await signTransaction(ready.toXDR(), {
    networkPassphrase: NETWORK,
  });
  const signed = TransactionBuilder.fromXDR(signedTxXdr, NETWORK);

  // 3. Send and poll for inclusion.
  const sent = await server.sendTransaction(signed);
  if (sent.status === "ERROR") {
    throw new Error(`Submit failed: ${JSON.stringify(sent.errorResult)}`);
  }

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await server.getTransaction(sent.hash);
    if (res.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Transaction failed: ${JSON.stringify(res.resultXdr)}`);
    }
    if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      const successful = res as { returnValue: xdr.ScVal };
      return decode(successful.returnValue);
    }
    // PENDING / DUPLICATE / TRY_AGAIN_LATER — keep polling.
  }
  throw new Error("Timed out waiting for transaction inclusion");
}

export async function createStream(
  sender: string,
  args: StreamArgs
): Promise<bigint> {
  const { operation } = buildCreateStreamOp(sender, args);
  // create_stream returns the new stream id (u64).
  return send(sender, operation, (v) => BigInt(scValToNative(v) as bigint));
}

export async function withdrawFromStream(
  recipient: string,
  streamId: string,
  amount: string
): Promise<void> {
  await send(
    recipient,
    buildWithdrawOp(streamId, amount),
    () => undefined
  );
}

/**
 * Claims the full accrued balance in one atomic call (`withdraw_max`),
 * returning the amount paid (smallest token units).
 */
export async function withdrawMaxFromStream(
  recipient: string,
  streamId: string
): Promise<bigint> {
  return send(
    recipient,
    buildWithdrawMaxOp(streamId),
    (v) => BigInt(scValToNative(v) as bigint)
  );
}

export async function topUpStream(
  sender: string,
  streamId: string,
  amount: string
): Promise<void> {
  await send(
    sender,
    buildTopUpOp(streamId, amount),
    () => undefined
  );
}

export async function cancelStream(
  caller: string,
  streamId: string
): Promise<void> {
  await send(
    caller,
    buildCancelStreamOp(caller, streamId),
    () => undefined
  );
}

/** Read-only contract call: simulated, never signed, return value decoded. */
async function simulateRead(
  method: string,
  args: xdr.ScVal[]
): Promise<xdr.ScVal | null> {
  const server = new rpc.Server(RPC_URL);
  const tx = new TransactionBuilder(DUMMY_SOURCE, {
    fee: "100",
    networkPassphrase: NETWORK,
  })
    .addOperation(contract().call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return null;
  return sim.result?.retval ?? null;
}

/** Read-only view of one stream. */
export async function readStream(streamId: string): Promise<StreamView> {
  const retval = await simulateRead("get_stream", [u64(streamId)]);
  if (!retval) {
    throw new Error(`Stream #${streamId} not found or RPC unavailable`);
  }
  const raw = scValToNative(retval) as Record<string, unknown>;
  return {
    id: String(raw.id),
    sender: String(raw.sender),
    recipient: String(raw.recipient),
    token: String(raw.token),
    deposit: String(raw.deposit),
    withdrawn: String(raw.withdrawn),
    startTime: Number(raw.start_time),
    endTime: Number(raw.end_time),
    cancelable: Boolean(raw.cancelable),
    status: String(raw.status),
  };
}

/** Accrued-but-unwithdrawn balance of a stream at the current ledger time. */
export async function readAvailable(streamId: string): Promise<bigint> {
  const retval = await simulateRead("available", [u64(streamId)]);
  if (!retval) {
    throw new Error(`Stream #${streamId} not found or RPC unavailable`);
  }
  return BigInt(scValToNative(retval) as bigint);
}

const MAX_PAGE_SIZE = 50; // mirrors the contract's MAX_PAGE_SIZE

/** One page of stream ids from an address index view (read-only). */
async function readStreamIdsPage(
  view: "recipient_streams" | "sender_streams",
  address: string,
  offset: number
): Promise<string[]> {
  const retval = await simulateRead(view, [
    scAddr(address),
    u32(offset),
    u32(MAX_PAGE_SIZE),
  ]);
  if (!retval) return [];
  const raw = scValToNative(retval) as bigint[];
  return (raw ?? []).map((id) => String(id));
}

/**
 * Discovers all streams for an address through the on-chain indexes,
 * following pagination until exhausted. `role` selects the index:
 * streams where the address receives funds ("recipient") or funds them
 * ("sender"). Streams that fail to read (archived, RPC hiccups) are skipped.
 */
export async function fetchStreamsFor(
  address: string,
  role: "recipient" | "sender"
): Promise<StreamView[]> {
  const view = role === "recipient" ? "recipient_streams" : "sender_streams";
  const ids: string[] = [];
  for (let offset = 0; ; offset += MAX_PAGE_SIZE) {
    const page = await readStreamIdsPage(view, address, offset);
    ids.push(...page);
    if (page.length < MAX_PAGE_SIZE) break;
  }
  const streams = await Promise.all(
    ids.map((id) => readStream(id).catch(() => null))
  );
  return streams.filter((s): s is StreamView => s !== null);
}
