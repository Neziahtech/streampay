/**
 * Real backend: Soroban testnet via RPC, signing with throwaway keys.
 *
 * Every operation is built with the same functions the frontend uses
 * (`frontend/lib/contract-ops.ts`), so the canary fails when the frontend's
 * call construction stops matching the deployed contract.
 */
import {
  Contract,
  Keypair,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import {
  availableOperation,
  cancelStreamOperation,
  createStreamOperation,
  getStreamOperation,
  withdrawMaxOperation,
  withdrawOperation,
} from "../../../frontend/lib/contract-ops.ts";
import { BackendError, excerpt } from "./errors.ts";
import { approveOperation } from "./token-ops.ts";
import { SorobanPipeline } from "./tx.ts";
import type {
  CanaryBackend,
  CreateStreamInput,
  PrepareResult,
  StreamState,
  TxReceipt,
} from "./types.ts";

export interface SorobanBackendOptions {
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string;
  tokenId: string;
  deposit: bigint;
  senderSecret?: string;
  recipientSecret?: string;
  friendbotUrl: string;
  pollIntervalMs: number;
}

const STATUS: StreamState["status"][] = ["Active", "Cancelled", "Depleted"];

export class SorobanCanaryBackend implements CanaryBackend {
  private readonly contract: Contract;
  private readonly token: Contract;
  private readonly server: rpc.Server;
  private readonly pipeline: SorobanPipeline;
  private readonly sender: Keypair;
  private readonly recipient: Keypair;
  private readonly friendbotUrl: string;
  private readonly contractId: string;

  constructor(private readonly options: SorobanBackendOptions) {
    this.server = new rpc.Server(options.rpcUrl);
    this.contract = new Contract(options.contractId);
    this.token = new Contract(options.tokenId);
    this.contractId = options.contractId;
    this.sender =
      options.senderSecret === undefined
        ? Keypair.random()
        : Keypair.fromSecret(options.senderSecret);
    this.recipient =
      options.recipientSecret === undefined
        ? Keypair.random()
        : Keypair.fromSecret(options.recipientSecret);
    this.friendbotUrl = options.friendbotUrl;
    this.pipeline = new SorobanPipeline({
      server: this.server,
      networkPassphrase: options.networkPassphrase,
      pollIntervalMs: options.pollIntervalMs,
    });
  }

  /** Funds the throwaway wallets and approves the contract to pull the deposit. */
  async prepare(): Promise<PrepareResult> {
    const sender = this.sender.publicKey();
    const recipient = this.recipient.publicKey();

    await this.fund(sender);
    await this.fund(recipient);

    let ledger: number;
    try {
      const latest = await this.server.getLatestLedger();
      ledger = latest.sequence;
    } catch (error) {
      throw new BackendError("transport", `getLatestLedger failed: ${messageOf(error)}`, {
        rpcMethod: "getLatestLedger",
        rpcExcerpt: excerpt(messageOf(error)),
      });
    }

    const approval = await this.pipeline.submit(
      approveOperation(
        this.token,
        sender,
        this.contractId,
        this.options.deposit,
        ledger + 1_000
      ),
      this.sender,
      sender
    );

    return {
      sender,
      recipient,
      token: this.options.tokenId,
      approval: { hash: approval.hash, envelopeXdr: approval.envelopeXdr },
      friendbot: { sender: "funded", recipient: "funded" },
    };
  }

  async createStream(
    input: CreateStreamInput
  ): Promise<TxReceipt & { streamId: bigint }> {
    const receipt = await this.pipeline.submit(
      createStreamOperation(this.contract, {
        sender: input.sender,
        recipient: input.recipient,
        token: input.token,
        deposit: input.deposit,
        startTime: input.startTime,
        endTime: input.endTime,
        cancelable: input.cancelable,
      }),
      this.sender,
      input.sender
    );
    const streamId = toBigInt(receipt.returnValue, "create_stream result");
    return { hash: receipt.hash, envelopeXdr: receipt.envelopeXdr, streamId };
  }

  async getStream(streamId: bigint): Promise<StreamState> {
    const { value } = await this.pipeline.read(
      getStreamOperation(this.contract, streamId),
      this.sender.publicKey()
    );
    const raw = scValToNative(value) as Record<string, unknown>;
    const statusIndex = Number(raw.status);
    const status = STATUS[statusIndex];
    if (status === undefined) {
      throw new BackendError("assertion", `unknown StreamStatus ${String(raw.status)}`, {
        rpcExcerpt: excerpt(raw),
      });
    }
    return {
      id: BigInt(raw.id as bigint),
      sender: String(raw.sender),
      recipient: String(raw.recipient),
      token: String(raw.token),
      deposit: BigInt(raw.deposit as bigint),
      withdrawn: BigInt(raw.withdrawn as bigint),
      startTime: BigInt(raw.start_time as bigint),
      endTime: BigInt(raw.end_time as bigint),
      cancelable: Boolean(raw.cancelable),
      status,
    };
  }

  async available(streamId: bigint): Promise<bigint> {
    const { value } = await this.pipeline.read(
      availableOperation(this.contract, streamId),
      this.sender.publicKey()
    );
    return BigInt(scValToNative(value) as bigint);
  }

  async withdraw(streamId: bigint, amount: bigint): Promise<TxReceipt> {
    const receipt = await this.pipeline.submit(
      withdrawOperation(this.contract, streamId, amount),
      this.recipient,
      this.recipient.publicKey()
    );
    return { hash: receipt.hash, envelopeXdr: receipt.envelopeXdr };
  }

  async withdrawMax(
    streamId: bigint
  ): Promise<TxReceipt & { amount: bigint }> {
    const receipt = await this.pipeline.submit(
      withdrawMaxOperation(this.contract, streamId),
      this.recipient,
      this.recipient.publicKey()
    );
    return {
      hash: receipt.hash,
      envelopeXdr: receipt.envelopeXdr,
      amount: toBigInt(receipt.returnValue, "withdraw_max result"),
    };
  }

  async cancel(streamId: bigint, caller: "sender" | "recipient"): Promise<TxReceipt> {
    const signer = caller === "sender" ? this.sender : this.recipient;
    const receipt = await this.pipeline.submit(
      cancelStreamOperation(this.contract, signer.publicKey(), streamId),
      signer,
      signer.publicKey()
    );
    return { hash: receipt.hash, envelopeXdr: receipt.envelopeXdr };
  }

  private async fund(address: string): Promise<void> {
    const url = `${this.friendbotUrl}?addr=${encodeURIComponent(address)}`;
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      throw new BackendError("funding", `friendbot request failed: ${messageOf(error)}`, {
        rpcMethod: "friendbot",
        rpcExcerpt: excerpt(messageOf(error)),
      });
    }
    const body = await response.text();
    if (response.ok) return;
    // Re-running with a stable key: the account already exists.
    if (body.toLowerCase().includes("already") || body.includes("createAccountAlreadyExist")) {
      return;
    }
    throw new BackendError(
      "funding",
      `friendbot returned HTTP ${response.status} for ${address}`,
      {
        rpcMethod: "friendbot",
        rpcExcerpt: excerpt(body),
      }
    );
  }
}

function toBigInt(value: xdr.ScVal | null, label: string): bigint {
  if (value === null) {
    throw new BackendError("assertion", `${label} was empty`);
  }
  const native = scValToNative(value);
  if (typeof native !== "bigint" && typeof native !== "number") {
    throw new BackendError("assertion", `${label} was not an integer: ${String(native)}`);
  }
  return BigInt(native);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
