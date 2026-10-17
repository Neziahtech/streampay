/** Soroban RPC transaction pipeline with step-classified failures. */
import {
  Keypair,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

import { BackendError, excerpt } from "./errors.ts";

export interface PipelineConfig {
  server: rpc.Server;
  networkPassphrase: string;
  pollIntervalMs: number;
  pollTimeoutMs?: number;
}

export interface SubmitResult {
  hash: string;
  envelopeXdr: string;
  returnValue: xdr.ScVal | null;
}

export interface ReadResult {
  value: xdr.ScVal;
  envelopeXdr: string;
}

export class SorobanPipeline {
  private readonly pollTimeoutMs: number;

  constructor(private readonly config: PipelineConfig) {
    this.pollTimeoutMs = config.pollTimeoutMs ?? 60_000;
  }

  private async account(publicKey: string) {
    try {
      return await this.config.server.getAccount(publicKey);
    } catch (error) {
      throw new BackendError("transport", `getAccount failed: ${messageOf(error)}`, {
        rpcMethod: "getAccount",
        rpcExcerpt: excerpt(messageOf(error)),
      });
    }
  }

  private async simulate(tx: ReturnType<TransactionBuilder["build"]>) {
    let simulation;
    try {
      simulation = await this.config.server.simulateTransaction(tx);
    } catch (error) {
      throw new BackendError("transport", `simulateTransaction failed: ${messageOf(error)}`, {
        rpcMethod: "simulateTransaction",
        rpcExcerpt: excerpt(messageOf(error)),
        transactionXdr: tx.toXDR(),
      });
    }
    if (rpc.Api.isSimulationError(simulation)) {
      throw new BackendError("simulation", simulation.error, {
        rpcMethod: "simulateTransaction",
        rpcExcerpt: excerpt(simulation.error),
        transactionXdr: tx.toXDR(),
      });
    }
    return simulation as rpc.Api.SimulateTransactionSuccessResponse;
  }

  async read(
    operation: xdr.Operation,
    sourcePublicKey: string
  ): Promise<ReadResult> {
    const account = await this.account(sourcePublicKey);
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simulation = await this.simulate(tx);
    const value = simulation.result?.retval;
    if (value === undefined) {
      throw new BackendError("simulation", "simulation returned no value", {
        rpcMethod: "simulateTransaction",
        rpcExcerpt: excerpt(simulation),
        transactionXdr: tx.toXDR(),
      });
    }
    return { value, envelopeXdr: tx.toXDR() };
  }

  async submit(
    operation: xdr.Operation,
    signer: Keypair,
    sourcePublicKey: string
  ): Promise<SubmitResult> {
    const account = await this.account(sourcePublicKey);
    const tx = new TransactionBuilder(account, {
      fee: "1000000",
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(60)
      .build();

    const simulation = await this.simulate(tx);
    const ready = rpc.assembleTransaction(tx, simulation).build();
    ready.sign(signer);
    const envelopeXdr = ready.toXDR();

    let sent;
    try {
      sent = await this.config.server.sendTransaction(ready);
    } catch (error) {
      throw new BackendError("transport", `sendTransaction failed: ${messageOf(error)}`, {
        rpcMethod: "sendTransaction",
        rpcExcerpt: excerpt(messageOf(error)),
        transactionXdr: envelopeXdr,
      });
    }
    if (sent.status === "ERROR") {
      throw new BackendError(
        "submission",
        `sendTransaction rejected the transaction (status ERROR)`,
        {
          rpcMethod: "sendTransaction",
          rpcExcerpt: excerpt(sent.errorResult ?? sent),
          transactionXdr: envelopeXdr,
        }
      );
    }

    const deadline = Date.now() + this.pollTimeoutMs;
    let last: unknown = null;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.config.pollIntervalMs));
      let result;
      try {
        result = await this.config.server.getTransaction(sent.hash);
      } catch (error) {
        throw new BackendError("transport", `getTransaction failed: ${messageOf(error)}`, {
          rpcMethod: "getTransaction",
          rpcExcerpt: excerpt(messageOf(error)),
          transactionXdr: envelopeXdr,
        });
      }
      last = result;
      if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new BackendError(
          "inclusion",
          `transaction ${sent.hash} was included but failed`,
          {
            rpcMethod: "getTransaction",
            rpcExcerpt: excerpt(result),
            transactionXdr: envelopeXdr,
            resultXdr: excerpt(result.resultXdr ?? result, 4000),
          }
        );
      }
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        const returned = (result as { returnValue?: xdr.ScVal }).returnValue;
        return {
          hash: sent.hash,
          envelopeXdr,
          returnValue: returned ?? simulation.result?.retval ?? null,
        };
      }
    }

    throw new BackendError(
      "timeout",
      `timed out after ${this.pollTimeoutMs}ms waiting for ${sent.hash}`,
      {
        rpcMethod: "getTransaction",
        rpcExcerpt: excerpt(last),
        transactionXdr: envelopeXdr,
      }
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
