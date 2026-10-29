import { Asset, TransactionBuilder, Networks, Keypair } from "@stellar/stellar-sdk";
import { buildClaimTransaction, keypairFromSeed } from "./schemas";

/**
 * Freighter API surface the conformance suite exercises.
 * This interface is the contract that both the mocked and live testnet
 * harnesses implement. It matches the shape of Freighter's `internalApi`
 * exposed to the frontend.
 */
export interface FreighterApi {
  isConnected(): Promise<{ publicKey?: string }>;
  connect(): Promise<{ publicKey: string }>;
  signTransaction(xdr: string, opts?: { network?: string }): Promise<{ signedXDR?: string; error?: string }>;
  signBlob(data: string): Promise<{ signature: string }>;
}

export interface HarnessResult {
  signedXDR: string;
  networkPassphrase: string;
  signerAddress: string;
}

/**
 * Mocked Freighter harness. Signs using a deterministic keypair derived from
 * a seed, so tests are reproducible and run in CI without network access.
 */
export class MockedFreighter implements FreighterApi {
  private readonly keypair: { publicKey: string; sign: (xdr: string, passphrase: string) => Promise<string> };
  private readonly seed: string;
  private connected = false;
  public recordedRequests: Array<{ xdr: string; network?: string }> = [];

  constructor(seed: string) {
    this.seed = seed;
    this.keypair = keypairFromSeed(seed);
  }

  async isConnected(): Promise<{ publicKey?: string }> {
    return this.connected ? { publicKey: this.keypair.publicKey } : {};
  }

  async connect(): Promise<{ publicKey: string }> {
    this.connected = true;
    return { publicKey: this.keypair.publicKey };
  }

  async signTransaction(
    xdr: string,
    opts?: { network?: string },
  ): Promise<{ signedXDR?: string; error?: string }> {
    this.recordedRequests.push({ xdr, network: opts?.network });
    const passphrase = opts?.network ?? Networks.TESTNET.networkPassphrase;
    try {
      const signed = await this.keypair.sign(xdr, passphrase);
      return { signedXDR: signed };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  async signBlob(data: string): Promise<{ signature: string }> {
    // Freighter signs the raw bytes of the provided data.
    const kp = Keypair.fromSecret(this.seed);
    const sig = kp.sign(Buffer.from(data, "utf-8"));
    return { signature: sig.toString() };
  }
}

/**
 * Build and sign a claim transaction through the Freighter API surface.
 * This is the function the conformance assertions drive.
 */
export async function signClaimViaFreighter(
  harness: FreighterApi,
  params: {
    sourcePublicKey: string;
    destination: string;
    amount: string;
    asset: Asset;
    fee: string;
    networkPassphrase: string;
  },
): Promise<HarnessResult> {
  const builder = await buildClaimTransaction(params);
  const xdr = builder.toXDR();
  const resp = await harness.signTransaction(xdr, { network: params.networkPassphrase });
  if (resp.error) throw new Error(`Freighter signing failed: ${resp.error}`);
  const signed = resp.signedXDR;
  if (!signed) throw new Error("Freighter returned no signed transaction");
  const tx = TransactionBuilder.fromXDR(signed, params.networkPassphrase);
  return {
    signedXDR: signed,
    networkPassphrase: params.networkPassphrase,
    signerAddress: tx.source,
  };
}
