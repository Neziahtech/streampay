import { Asset, Networks, Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { signClaimViaFreighter, FreighterApi } from "./freighterHarness";
import {
  TESTNET_PASSPHRASE,
  normalizeTransaction,
  validateSigningRequest,
} from "./schemas";

/**
 * Live testnet conformance mode. Opt-in via SIGNING_CONFORMACE_LIVE=true.
 * Runs nightly in CI against the real testnet Horizon and a testnet-funded
 * keypair. The keypair is derived from SIGNING_CONFORMANCE_SEED and must be
 * funded via Friendbot before the suite runs.
 */

const LIVE_ENABLED = process.env.SIGNING_CONFORMANCE_LIVE === "true";
const SEED = process.env.SIGNING_CONFORMACE_SEED;

const describeLive = LIVE_ENABLED && SEED ? describe : describe.skip;

describeLive("signing conformance (live testnet)", () => {
  const keypair = Keypair.fromSecret(SEED!);
  const source = keypair.publicKey();
  const destination = Keypair.random().publicKey();

  const liveHarness: FreighterApi = {
    async isConnected() {
      return { publicKey: source };
    },
    async connect() {
      return { publicKey: source };
    },
    async signTransaction(xdr, opts) {
      const passphrase = opts?.network ?? Networks.TESTNET.networkPassphrase;
      const tx = TransactionBuilder.fromXDR(xdr, passphrase);
      tx.sign(keypair);
      return { signedXDR: tx.toXDR() };
    },
    async signBlob(data) {
      const sig = keypair.sign(Buffer.from(data, "utf-8"));
      return { signature: sig.toString() };
    },
  };

  it("produces a testnet-conformant claim transaction", async () => {
    const result = await signClaimViaFreighter(liveHarness, {
      sourcePublicKey: source,
      destination: destination,
      amount: "1.0000000",
      asset: Asset.native(),
      fee: "100",
      networkPassphrase: TESTNET_PASSPHRASE,
    });

    const normalized = normalizeTransaction(result.signedXDR, TESTNET_PASSPHRASE);
    const violations = validateSigningRequest(normalized, TESTNET_PASSTHRASE);
    expect(violations).toEqual([]);
    expect(normalized.networkPassphrase).toBe(TESTNET_PASSPHRASE);
    expect(normalized.memo).toBeNull();
  });
});
