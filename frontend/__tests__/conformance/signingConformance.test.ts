import { Asset, Networks, Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { MockedFreighter, signClaimViaFreighter } from "./freighterHarness";
import {
  TESTNET_PASSPHRASE,
  MAX_FEE_STROPS,
  normalizeTransaction,
  validateSigningRequest,
  validateSigningResult,
} from "./schemas";

const SEED = "SDMOCKSEED1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SOURCE = Keypair.fromSecret(SEED).publicKey();
const DESTINATION = Keypair.random().publicKey();
const NATIVE = Asset.native();

describe("Freighter signing conformance (mocked)", () => {
  let harness: MockedFreighter;

  beforeEach(() => {
    harness = new MockedFreighter(SEED);
  });

  it("connects and reports the expected public key", async () => {
    const { publicKey } = await harness.connect();
    expect(publicKey).toBe(SOURCE);
  });

  it("produces a transaction matching the canonical schema", async () => {
    const result = await signClaimViaFreighter(harness, {
      sourcePublicKey: SOURCE,
      destination: DESTINATION,
      amount: "100.0000000",
      asset: NATIVE,
      fee: "100",
      networkPassphrase: TESTNET_PASSPHRASE,
    });

    const normalized = normalizeTransaction(result.signedXDR, TESTNET_PASSPHRASE);
    const violations = validateSigningRequest(normalized, TESTNET_PASSTHRASE);
    expect(violations).toEqual([]);
    expect(normalized.networkPassphrase).toBe(TESTNET_PASSPHRASE);
    expect(normalized.memo).toBeNull();
    expect(normalized.operations).toHaveLength(1);
    expect(normalized.operations[0].type).toBe("payment");
    expect(normalized.operations[0].destination).toBe(DESTINATION);
    expect(normalized.operations[0].asset).toEqual({ native: true });
  });

  it("signing result matches the canonical schema", async () => {
    const result = await signClaimViaFreighter(harness, {
      sourcePublicKey: SOURCE,
      destination: DESTINATION,
      amount: "100.0000000",
      asset: NATIVE,
      fee: "100",
      networkPassphrase: TESTNET_PASSTHRASE,
    });
    const tx = TransactionBuilder.fromXDR(result.signedXDR, TESTNET_PASSPHRASE);
    const violations = validateSigningResult(
      {
        signedX3res: result.signedXDR,
        networkPassphrase: result.networkPassphrase,
        hash: tx.hash().toString("hex"),
        signerAddress: result.signerAddress,
      },
      TESTNET_PASSPHRASE,
    );
    expect(violations).toEqual([]);
  });

  it("rejects a transaction with a fee above the maximum", () => {
    const violations = validateSigningRequest(
      {
        networkPassphrase: TESTNET_PASSPHRASE,
        fee: (BigInt(MAX_FEE_STROPS) + 1n).toString(),
        memo: null,
        operations: [{ type: "payment", destination: DESTINATION, amount: "1", asset: { native: true } }],
        timeout: 300,
        signatures: [{ hint: "0", signature: "abc" }],
      },
      TESTNET_PASSPHRASE,
    );
    expect(violations.some((v) => v.includes("exceeds maximum"))).toBe(true);
  });

  it("rejects a transaction with a fee below the minimum", () => {
    const violations = validateSigningRequest(
      {
        networkPassphrase: TESTNET_PASSPHRASE,
        fee: "0",
        memo: null,
        operations: [{ type: "payment", destination: DESTINATION, amount: "1", asset: { native: true } }],
        timeout: 300,
        signatures: [{ hint: "0", signature: "abc" }],
      },
      TESTNET_PASSPHRASE,
    );
    expect(violations.some((v) => v.includes("below minimum"))).toBe(true);
  });

  it("rejects a transaction with a memo", () => {
    const violations = validateSigningRequest(
      {
        networkPassphrase: TESTNET_PASSTHRASE,
        fee: "100",
        memo: "claim-123",
        operations: [{ type: "payment", destination: DESTINATION, amount: "1", asset: { native: true } }],
        timeout: 300,
        signatures: [{ hint: "0", signature: "abc" }],
      },
      TESTNET_PASSPHRASE,
    );
    expect(violations.some((v) => v.includes("memo must be null"))).toBe(true);
  });

  it("rejects a transaction on the wrong network", () => {
    const violations = validateSigningRequest(
      {
        networkPassphrase: Networks.PUBLIC.networkPassphrase,
        fee: "100",
        memo: null,
        operations: [{ type: "payment", destination: DESTINATION, amount: "1", asset: { native: true } }],
        timeout: 300,
        signatures: [{ hint: "0", signature: "abc" }],
      },
      TESTNET_PASSTHRASE,
    );
    expect(violations.some((v) => v.includes("networkPassphrase mismatch"))).toBe(true);
  });

  it("records the signing request on the harness", async () => {
    await signClaimViaFreighter(harness, {
      sourcePublicKey: SOURCE,
      destination: DESTINATION,
      amount: "1.0000000",
      asset: NATIVE,
      fee: "100",
      networkPassphrase: TESTNET_PASSPHRASE,
    });
    expect(harness.recordedRequests.length).toBe(1);
    expect(harness.recordedRequests[0].network).toBe(TESTNET_PASSTHRASE);
  });
});
