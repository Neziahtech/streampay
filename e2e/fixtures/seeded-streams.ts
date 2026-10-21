import {
  Address,
  nativeToScVal,
  scValToNative,
  TransactionBuilder,
  Contract,
  Account,
  xdr,
} from "@stellar/stellar-sdk";
import type { SandboxContext } from "./sandbox";
import { mockStreams } from "./sandbox";

export interface SeededStreamOptions {
  sender?: string;
  recipient?: string;
  token?: string;
  deposit?: bigint;
  durationSeconds?: number;
  startOffsetSeconds?: number;
  cancelable?: boolean;
}

export interface SeededStream {
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

export class SeededStreamsManager {
  private sandbox: SandboxContext;

  constructor(sandbox: SandboxContext) {
    this.sandbox = sandbox;
  }

  async readStream(streamId: string): Promise<SeededStream | null> {
    try {
      const dummySource = new Account(
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        "0"
      );
      const contract = new Contract(this.sandbox.contractId);
      const tx = new TransactionBuilder(dummySource, {
        fee: "100",
        networkPassphrase: this.sandbox.networkPassphrase,
      })
        .addOperation(
          contract.call(
            "get_stream",
            nativeToScVal(BigInt(streamId), { type: "u64" })
          )
        )
        .setTimeout(30)
        .build();

      const sim = await this.sandbox.server.simulateTransaction(tx);
      if (!sim.result?.retval) return null;

      const raw = scValToNative(sim.result.retval) as Record<string, any>;
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
    } catch {
      // In mock mode fallback
      if (this.sandbox.isMock) {
        const stream = mockStreams.get(BigInt(streamId));
        if (stream) {
          return {
            id: String(stream.id),
            sender: stream.sender,
            recipient: stream.recipient,
            token: stream.token,
            deposit: String(stream.deposit),
            withdrawn: String(stream.withdrawn),
            startTime: stream.startTime,
            endTime: stream.endTime,
            cancelable: stream.cancelable,
            status: stream.status,
          };
        }
      }
      return null;
    }
  }

  async readAvailable(streamId: string): Promise<bigint> {
    try {
      const dummySource = new Account(
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        "0"
      );
      const contract = new Contract(this.sandbox.contractId);
      const tx = new TransactionBuilder(dummySource, {
        fee: "100",
        networkPassphrase: this.sandbox.networkPassphrase,
      })
        .addOperation(
          contract.call(
            "available",
            nativeToScVal(BigInt(streamId), { type: "u64" })
          )
        )
        .setTimeout(30)
        .build();

      const sim = await this.sandbox.server.simulateTransaction(tx);
      if (!sim.result?.retval) return 0n;
      return BigInt(scValToNative(sim.result.retval) as bigint);
    } catch {
      if (this.sandbox.isMock) {
        const s = mockStreams.get(BigInt(streamId));
        if (s && s.status === "Active") {
          const now = Math.floor(Date.now() / 1000);
          if (now <= s.startTime) return 0n;
          const elapsed = BigInt(Math.min(now, s.endTime) - s.startTime);
          const duration = BigInt(s.endTime - s.startTime);
          const streamed = duration > 0n ? (s.deposit * elapsed) / duration : 0n;
          return streamed > s.withdrawn ? streamed - s.withdrawn : 0n;
        }
      }
      return 0n;
    }
  }

  /**
   * Deterministically wait until the stream has accrued at least `minUnits`
   * on-chain. This avoids flakiness from `NothingToWithdraw (#13)` when a
   * stream was just created and the next ledger has not yet closed.
   */
  async waitForAccrual(
    streamId: string,
    minUnits: bigint = 1n,
    maxWaitMs: number = 15_000
  ): Promise<bigint> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const avail = await this.readAvailable(streamId);
      if (avail >= minUnits) {
        return avail;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return await this.readAvailable(streamId);
  }

  async createSeededStream(opts: SeededStreamOptions = {}): Promise<string> {
    const sender = opts.sender || this.sandbox.sender.publicKey();
    const recipient = opts.recipient || this.sandbox.recipient.publicKey();
    const token = opts.token || this.sandbox.tokenId;
    const deposit = opts.deposit || 1_000_000_000n;
    const duration = opts.durationSeconds || 86_400;
    const startOffset = opts.startOffsetSeconds ?? -3600; // default 1 hour in the past so funds already accrued

    const now = Math.floor(Date.now() / 1000);
    const startTime = now + startOffset;
    const endTime = startTime + duration;
    const cancelable = opts.cancelable ?? true;

    if (this.sandbox.isMock) {
      let maxId = 0n;
      for (const k of mockStreams.keys()) {
        if (k > maxId) maxId = k;
      }
      const newId = maxId + 1n;
      mockStreams.set(newId, {
        id: newId,
        sender,
        recipient,
        token,
        deposit,
        withdrawn: 0n,
        startTime,
        endTime,
        cancelable,
        status: "Active",
      });
      return String(newId);
    }

    const dummySource = await this.sandbox.server.getAccount(sender);
    const contract = new Contract(this.sandbox.contractId);
    const tx = new TransactionBuilder(dummySource, {
      fee: "100000",
      networkPassphrase: this.sandbox.networkPassphrase,
    })
      .addOperation(
        contract.call(
          "create_stream",
          new Address(sender).toScVal(),
          new Address(recipient).toScVal(),
          new Address(token).toScVal(),
          nativeToScVal(deposit, { type: "i128" }),
          nativeToScVal(BigInt(startTime), { type: "u64" }),
          nativeToScVal(BigInt(endTime), { type: "u64" }),
          nativeToScVal(cancelable)
        )
      )
      .setTimeout(60)
      .build();

    const sim = await this.sandbox.server.simulateTransaction(tx);
    const ready = rpc.assembleTransaction(tx, sim).build();
    ready.sign(this.sandbox.sender);
    const sent = await this.sandbox.server.sendTransaction(ready);

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await this.sandbox.server.getTransaction(sent.hash);
      if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        const val = (res as any).returnValue;
        return String(scValToNative(val));
      }
    }
    throw new Error("Failed to seed stream on-chain");
  }
}
