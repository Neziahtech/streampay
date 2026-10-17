/**
 * Typed StreamPay client.
 *
 * Mutating calls follow the same pipeline as the StreamPay frontend:
 * build → simulate → sign → send → poll for inclusion → decode. Read-only
 * calls simulate without a signer, using a syntactically valid dummy source.
 */
import {
  Account,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import {
  MAX_PAGE_SIZE,
  METHODS,
  decodeAvailableResult,
  decodeCancelStreamResult,
  decodeCreateStreamResult,
  decodeGetStreamResult,
  decodeRecipientStreamsResult,
  decodeSenderStreamsResult,
  decodeTopUpResult,
  decodeWithdrawMaxResult,
  decodeWithdrawResult,
  encodeAvailableArgs,
  encodeCancelStreamArgs,
  encodeCreateStreamArgs,
  encodeGetStreamArgs,
  encodeRecipientStreamsArgs,
  encodeSenderStreamsArgs,
  encodeTopUpArgs,
  encodeWithdrawArgs,
  encodeWithdrawMaxArgs,
  type AvailableArgs,
  type CancelStreamArgs,
  type CreateStreamArgs,
  type GetStreamArgs,
  type RecipientStreamsArgs,
  type SenderStreamsArgs,
  type Stream,
  type TopUpArgs,
  type U64,
  type WithdrawArgs,
  type WithdrawMaxArgs,
} from "./generated.js";
import { StreamPayError } from "./errors.js";
import { collectPages, type IndexRole } from "./pagination.js";

/** Wallet adapter: Freighter, a server keypair, or a hardware signer. */
export interface Signer {
  publicKey(): string;
  signTransaction(
    envelopeXdr: string,
    options: { networkPassphrase: string }
  ): Promise<{ signedTxXdr: string }>;
}

/** Adapts a `Keypair` (e.g. a bot key) to the {@link Signer} interface. */
export function signerFromKeypair(keypair: Keypair): Signer {
  return {
    publicKey: () => keypair.publicKey(),
    async signTransaction(envelopeXdr, { networkPassphrase }) {
      const tx = TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
      tx.sign(keypair);
      return { signedTxXdr: tx.toXDR() };
    },
  };
}

export interface StreamPayClientOptions {
  rpcUrl?: string;
  contractId: string;
  networkPassphrase?: string;
  signer?: Signer;
  /** Injected for tests; defaults to `new rpc.Server(rpcUrl)`. */
  server?: rpc.Server;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

/** ed25519 all-zero key: valid source for simulations, never signs. */
const DUMMY_SOURCE = new Account(
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  "0"
);

export class StreamPayClient {
  readonly contractId: string;
  readonly networkPassphrase: string;
  private readonly server: rpc.Server;
  private readonly signer?: Signer;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;

  constructor(options: StreamPayClientOptions) {
    if (!options.contractId) throw new Error("contractId is required");
    this.contractId = options.contractId;
    this.networkPassphrase = options.networkPassphrase ?? Networks.TESTNET;
    this.server = options.server ?? new rpc.Server(options.rpcUrl ?? "https://soroban-testnet.stellar.org");
    if (options.signer !== undefined) this.signer = options.signer;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 30_000;
  }

  // ---------------------------------------------------------------- writes
  createStream(args: CreateStreamArgs): Promise<bigint> {
    return this.call(METHODS.createStream, encodeCreateStreamArgs(args), true, decodeCreateStreamResult);
  }

  withdraw(args: WithdrawArgs): Promise<void> {
    return this.call(METHODS.withdraw, encodeWithdrawArgs(args), true, decodeWithdrawResult);
  }

  withdrawMax(args: WithdrawMaxArgs): Promise<bigint> {
    return this.call(METHODS.withdrawMax, encodeWithdrawMaxArgs(args), true, decodeWithdrawMaxResult);
  }

  cancelStream(args: CancelStreamArgs): Promise<void> {
    return this.call(METHODS.cancelStream, encodeCancelStreamArgs(args), true, decodeCancelStreamResult);
  }

  topUp(args: TopUpArgs): Promise<void> {
    return this.call(METHODS.topUp, encodeTopUpArgs(args), true, decodeTopUpResult);
  }

  // ----------------------------------------------------------------- reads
  getStream(streamId: U64): Promise<Stream> {
    const args: GetStreamArgs = { streamId };
    return this.call(METHODS.getStream, encodeGetStreamArgs(args), false, decodeGetStreamResult);
  }

  available(streamId: U64): Promise<bigint> {
    const args: AvailableArgs = { streamId };
    return this.call(METHODS.available, encodeAvailableArgs(args), false, decodeAvailableResult);
  }

  // ------------------------------------------------------------- pagination
  /** One page of ids from the on-chain sender/recipient index. */
  async streamIdsPage(
    role: IndexRole,
    address: string,
    offset: number,
    limit: number = MAX_PAGE_SIZE
  ): Promise<bigint[]> {
    if (role === "sender") {
      const args: SenderStreamsArgs = { sender: address, offset, limit };
      return this.call(
        METHODS.senderStreams,
        encodeSenderStreamsArgs(args),
        false,
        decodeSenderStreamsResult
      );
    }
    const args: RecipientStreamsArgs = { recipient: address, offset, limit };
    return this.call(
      METHODS.recipientStreams,
      encodeRecipientStreamsArgs(args),
      false,
      decodeRecipientStreamsResult
    );
  }

  /** Every indexed stream id for `address`, following pages to exhaustion. */
  streamIds(role: IndexRole, address: string): Promise<bigint[]> {
    return collectPages((offset, limit) => this.streamIdsPage(role, address, offset, limit));
  }

  /**
   * Loads every stream for `address`. Ids that no longer resolve (read
   * failures, archived state) are skipped, matching the frontend's discovery
   * behaviour.
   */
  async streamsFor(role: IndexRole, address: string): Promise<Stream[]> {
    const ids = await this.streamIds(role, address);
    const streams: Stream[] = [];
    for (const id of ids) {
      try {
        streams.push(await this.getStream(id));
      } catch {
        // A stale index entry must not hide the rest of the portfolio.
      }
    }
    return streams;
  }

  // ----------------------------------------------------------------- internals
  private requireSigner(): Signer {
    if (this.signer === undefined) {
      throw new StreamPayError(
        "a signer is required for mutating calls (pass options.signer)",
        "transport"
      );
    }
    return this.signer;
  }

  private async call<T>(
    method: string,
    args: xdr.ScVal[],
    mutating: boolean,
    decode: (value: xdr.ScVal) => T
  ): Promise<T> {
    const signer = mutating ? this.requireSigner() : undefined;
    const source = signer === undefined ? DUMMY_SOURCE.accountId() : signer.publicKey();

    let account: Account;
    try {
      account = mutating
        ? await this.server.getAccount(source)
        : new Account(source, "0");
    } catch (error) {
      throw StreamPayError.fromRpc("transport", messageOf(error));
    }

    const operation = new Contract(this.contractId).call(method, ...args);
    const tx = new TransactionBuilder(account, {
      fee: mutating ? "1000000" : "100",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(60)
      .build();

    const simulation = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simulation)) {
      throw StreamPayError.fromRpc("simulation", simulation.error, tx.toXDR());
    }

    const simulated = simulation as rpc.Api.SimulateTransactionSuccessResponse;
    const simulatedValue = simulated.result?.retval;
    if (simulatedValue === undefined) {
      throw new StreamPayError(
        "simulation returned no value",
        "simulation",
        { transactionXdr: tx.toXDR() }
      );
    }
    if (!mutating) return this.safeDecode(decode, simulatedValue, tx.toXDR());

    const ready = rpc.assembleTransaction(tx, simulated).build();
    const signedXdr = await signer!.signTransaction(ready.toXDR(), {
      networkPassphrase: this.networkPassphrase,
    });
    const signed = TransactionBuilder.fromXDR(
      signedXdr.signedTxXdr,
      this.networkPassphrase
    );

    const sent = await this.server.sendTransaction(signed);
    if (sent.status === "ERROR") {
      throw StreamPayError.fromRpc(
        "submission",
        `sendTransaction: ${JSON.stringify(sent.errorResult)}`,
        signed.toXDR()
      );
    }

    const deadline = Date.now() + this.pollTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      const result = await this.server.getTransaction(sent.hash);
      if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw StreamPayError.fromRpc(
          "inclusion",
          `transaction ${sent.hash} failed: ${JSON.stringify(result.resultXdr)}`,
          signed.toXDR()
        );
      }
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        const returned = (result as { returnValue?: xdr.ScVal }).returnValue;
        const value = returned ?? simulatedValue;
        return this.safeDecode(decode, value, signed.toXDR());
      }
    }
    throw new StreamPayError(
      `timed out after ${this.pollTimeoutMs}ms waiting for ${sent.hash}`,
      "inclusion",
      { transactionXdr: signed.toXDR() }
    );
  }

  private safeDecode<T>(
    decode: (value: xdr.ScVal) => T,
    value: xdr.ScVal,
    transactionXdr: string
  ): T {
    try {
      return decode(value);
    } catch (error) {
      throw new StreamPayError(`decode failed: ${messageOf(error)}`, "decode", {
        transactionXdr,
      });
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
