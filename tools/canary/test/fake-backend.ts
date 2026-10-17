/** In-memory StreamPay backend: same semantics as the contract, no network. */
import { Keypair } from "@stellar/stellar-sdk";

import { BackendError } from "../src/errors.ts";
import type {
  CanaryBackend,
  CreateStreamInput,
  PrepareResult,
  StreamState,
  TxReceipt,
} from "../src/types.ts";

const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

export class FakeBackend implements CanaryBackend {
  readonly sender = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
  readonly recipient = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
  clock = 1_000;
  tamperWithdrawn = false;
  failAt: Partial<Record<keyof CanaryBackend, Error>> = {};
  private streams = new Map<bigint, StreamState>();
  private nextId = 1n;
  private txCount = 0;

  async prepare(): Promise<PrepareResult> {
    this.maybeFail("prepare");
    return {
      sender: this.sender,
      recipient: this.recipient,
      token: TOKEN,
      approval: this.receipt("prepare"),
      friendbot: { sender: "funded", recipient: "funded" },
    };
  }

  async createStream(input: CreateStreamInput) {
    this.maybeFail("createStream");
    const id = this.nextId++;
    this.streams.set(id, {
      id,
      sender: input.sender,
      recipient: input.recipient,
      token: input.token,
      deposit: input.deposit,
      withdrawn: 0n,
      startTime: BigInt(input.startTime),
      endTime: BigInt(input.endTime),
      cancelable: input.cancelable,
      status: "Active",
    });
    return { ...this.receipt("create"), streamId: id };
  }

  async getStream(streamId: bigint): Promise<StreamState> {
    this.maybeFail("getStream");
    const state = this.streams.get(streamId);
    if (state === undefined) {
      throw new BackendError("simulation", `Error(Contract, #1)`, {
        rpcMethod: "simulateTransaction",
        rpcExcerpt: "HostError: Error(Contract, #1) StreamNotFound",
      });
    }
    return { ...state };
  }

  async available(streamId: bigint): Promise<bigint> {
    this.maybeFail("available");
    const state = await this.getStream(streamId);
    if (state.status !== "Active") return 0n;
    const elapsed = Math.max(0, this.clock - Number(state.startTime));
    const duration = Number(state.endTime - state.startTime);
    const streamed = (state.deposit * BigInt(elapsed)) / BigInt(duration);
    return streamed > state.withdrawn ? streamed - state.withdrawn : 0n;
  }

  async withdraw(streamId: bigint, amount: bigint): Promise<TxReceipt> {
    this.maybeFail("withdraw");
    const state = await this.getStream(streamId);
    const available = await this.available(streamId);
    if (amount > available) {
      throw new BackendError("simulation", "HostError: Error(Contract, #10)", {
        rpcMethod: "simulateTransaction",
        rpcExcerpt: "HostError: Error(Contract, #10) AmountExceedsAvailable",
        transactionXdr: "FAKE-WITHDRAW-XDR",
      });
    }
    state.withdrawn += amount;
    this.streams.set(streamId, state);
    return this.receipt("withdraw");
  }

  async withdrawMax(streamId: bigint) {
    this.maybeFail("withdrawMax");
    const state = await this.getStream(streamId);
    const amount = await this.available(streamId);
    if (amount <= 0n) {
      throw new BackendError("simulation", "HostError: Error(Contract, #13)", {
        rpcMethod: "simulateTransaction",
        rpcExcerpt: "HostError: Error(Contract, #13) NothingToWithdraw",
        transactionXdr: "FAKE-WITHDRAW-MAX-XDR",
      });
    }
    state.withdrawn += amount;
    this.streams.set(streamId, {
      ...state,
      withdrawn: this.tamperWithdrawn ? state.withdrawn + 1n : state.withdrawn,
    });
    return { ...this.receipt("withdrawMax"), amount };
  }

  async cancel(streamId: bigint): Promise<TxReceipt> {
    this.maybeFail("cancel");
    const state = await this.getStream(streamId);
    state.status = "Cancelled";
    this.streams.set(streamId, state);
    return this.receipt("cancel");
  }

  sleep = async (ms: number): Promise<void> => {
    this.clock += Math.max(1, Math.round(ms / 1_000));
  };

  private receipt(label: string): TxReceipt {
    this.txCount += 1;
    return {
      hash: `FAKEHASH${String(this.txCount).padStart(4, "0")}`,
      envelopeXdr: `FAKE-ENVELOPE-${label.toUpperCase()}-${this.txCount}`,
    };
  }

  private maybeFail(method: keyof CanaryBackend): void {
    const error = this.failAt[method];
    if (error !== undefined) throw error;
  }
}
