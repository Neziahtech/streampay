/**
 * Wallet Signing Request Conformance Suite
 *
 * Verifies that all stream lifecycle operations (create, withdraw, withdraw_max,
 * top_up, cancel) produce transactions that strictly adhere to documented schemas:
 * - Network passphrase isolation (Testnet vs Publicnet)
 * - Strict fee bounds (100 stroops <= fee <= 100,000 stroops)
 * - Memo-less claims & operations (MemoNone)
 * - Correct invokeHostFunction schemas and ScVal argument types
 * - Runnable against Freighter's API surface in mock mode (CI default) and opt-in live mode
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

import {
  DEFAULT_CONTRACT_ID,
  DEFAULT_FEE,
  buildCreateStreamOp,
  buildWithdrawOp,
  buildWithdrawMaxOp,
  buildTopUpOp,
  buildCancelStreamOp,
  buildStreamTransaction,
} from "../../lib/stellar.ts";

import {
  assertSigningConformance,
  assertSigningRequestXdr,
} from "./schemas.ts";
import { FreighterHarness } from "./freighter-harness.ts";

describe("Signing Request Conformance Suite", () => {
  const dummySenderKeypair = Keypair.random();
  const dummyRecipientKeypair = Keypair.random();
  const dummyTokenKeypair = Keypair.random();

  const dummySender = dummySenderKeypair.publicKey();
  const dummyRecipient = dummyRecipientKeypair.publicKey();
  const dummyToken = dummyTokenKeypair.publicKey();

  const dummyAccount = new Account(dummySender, "1000");

  describe("Transaction Schema Invariants", () => {
    it("asserts correct network passphrase and rejects mismatch", () => {
      const op = buildWithdrawMaxOp("1", DEFAULT_CONTRACT_ID);
      const validTx = buildStreamTransaction(dummyAccount, op, {
        networkPassphrase: Networks.TESTNET,
      });

      // Valid on testnet
      const report = assertSigningConformance(validTx, {
        expectedNetworkPassphrase: Networks.TESTNET,
      });
      assert.strictEqual(report.networkPassphrase, Networks.TESTNET);

      // Rejects on publicnet
      assert.throws(
        () =>
          assertSigningConformance(validTx, {
            expectedNetworkPassphrase: Networks.PUBLIC,
          }),
        /Network passphrase mismatch/
      );
    });

    it("enforces fee bounds and rejects out-of-bound fees", () => {
      const op = buildWithdrawMaxOp("1", DEFAULT_CONTRACT_ID);

      // Within bounds (100_000)
      const validTx = buildStreamTransaction(dummyAccount, op, {
        fee: DEFAULT_FEE,
      });
      assert.doesNotThrow(() => assertSigningConformance(validTx));

      // Over max fee bound (e.g. 200_000 stroops)
      const highFeeTx = new TransactionBuilder(dummyAccount, {
        fee: "200000",
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(op)
        .setTimeout(60)
        .build();

      assert.throws(
        () =>
          assertSigningConformance(highFeeTx, {
            maxFeeStroops: 100_000,
          }),
        /Fee out of bounds/
      );

      // Zero or negative fee
      const zeroFeeTx = new TransactionBuilder(dummyAccount, {
        fee: "0",
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(op)
        .setTimeout(60)
        .build();

      assert.throws(
        () => assertSigningConformance(zeroFeeTx),
        /Fee out of bounds/
      );
    });

    it("enforces memo-less claims and operations", () => {
      const op = buildWithdrawOp("42", "5000000", DEFAULT_CONTRACT_ID);

      // Default stream transaction has MemoNone
      const memoLessTx = buildStreamTransaction(dummyAccount, op);
      assert.strictEqual(memoLessTx.memo.type, "none");
      assert.doesNotThrow(() => assertSigningConformance(memoLessTx));

      // Transaction with MemoText must be rejected
      const memoTextTx = new TransactionBuilder(dummyAccount, {
        fee: DEFAULT_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(op)
        .addMemo(Memo.text("withdraw-claim-42"))
        .setTimeout(60)
        .build();

      assert.throws(
        () => assertSigningConformance(memoTextTx),
        /Memo-less claims invariant violated/
      );

      // Transaction with MemoId must be rejected
      const memoIdTx = new TransactionBuilder(dummyAccount, {
        fee: DEFAULT_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(op)
        .addMemo(Memo.id("12345"))
        .setTimeout(60)
        .build();

      assert.throws(
        () => assertSigningConformance(memoIdTx),
        /Memo-less claims invariant violated/
      );
    });

    it("enforces single operation and rejects non-host-function operations", () => {
      const op = buildWithdrawMaxOp("1", DEFAULT_CONTRACT_ID);

      // Multiple operations rejected
      const multiOpTx = new TransactionBuilder(dummyAccount, {
        fee: DEFAULT_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(op)
        .addOperation(op)
        .setTimeout(60)
        .build();

      assert.throws(
        () => assertSigningConformance(multiOpTx),
        /Expected exactly 1 operation per transaction/
      );

      // Classic payment operation rejected
      const paymentTx = new TransactionBuilder(dummyAccount, {
        fee: DEFAULT_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({
            destination: dummyRecipient,
            asset: Asset.native(),
            amount: "10",
          })
        )
        .setTimeout(60)
        .build();

      assert.throws(
        () => assertSigningConformance(paymentTx),
        /Expected operation type "invokeHostFunction"/
      );
    });
  });

  describe("Frontend Action Conformance (runnable against Freighter harness)", () => {
    it("conforms on createStream operation schema", async () => {
      const harness = new FreighterHarness();
      const args = {
        token: dummyToken,
        recipient: dummyRecipient,
        deposit: "10000000000",
        days: "30",
        cancelable: true,
      };

      const { operation, start, end } = buildCreateStreamOp(
        dummySender,
        args,
        DEFAULT_CONTRACT_ID
      );
      const tx = buildStreamTransaction(dummyAccount, operation);

      // Sign with Freighter harness
      const { signedTxXdr } = await harness.signTransaction(tx.toXDR());
      assert.ok(signedTxXdr);

      // Verify signed transaction schema
      const report = assertSigningRequestXdr(signedTxXdr, {
        expectedContractId: DEFAULT_CONTRACT_ID,
        expectedMethod: "create_stream",
        expectedArgCount: 7,
      });

      assert.strictEqual(report.method, "create_stream");
      assert.strictEqual(report.fee, 100_000);
      assert.strictEqual(report.memoType, "none");
      assert.strictEqual(report.args?.[0], dummySender);
      assert.strictEqual(report.args?.[1], dummyRecipient);
      assert.strictEqual(report.args?.[2], dummyToken);
      assert.strictEqual(report.args?.[3], 10000000000n);
      assert.strictEqual(report.args?.[4], BigInt(start));
      assert.strictEqual(report.args?.[5], BigInt(end));
      assert.strictEqual(report.args?.[6], true);
    });

    it("conforms on withdrawFromStream operation schema", async () => {
      const harness = new FreighterHarness();
      const streamId = "7";
      const amount = "2500000000";

      const op = buildWithdrawOp(streamId, amount, DEFAULT_CONTRACT_ID);
      const recipientAccount = new Account(dummyRecipient, "200");
      const tx = buildStreamTransaction(recipientAccount, op);

      const { signedTxXdr } = await harness.signTransaction(tx.toXDR());
      assert.ok(signedTxXdr);

      const report = assertSigningRequestXdr(signedTxXdr, {
        expectedContractId: DEFAULT_CONTRACT_ID,
        expectedMethod: "withdraw",
        expectedArgCount: 2,
      });

      assert.strictEqual(report.method, "withdraw");
      assert.strictEqual(report.fee, 100_000);
      assert.strictEqual(report.memoType, "none");
      assert.strictEqual(report.args?.[0], 7n);
      assert.strictEqual(report.args?.[1], 2500000000n);
    });

    it("conforms on withdrawMaxFromStream operation schema", async () => {
      const harness = new FreighterHarness();
      const streamId = "99";

      const op = buildWithdrawMaxOp(streamId, DEFAULT_CONTRACT_ID);
      const recipientAccount = new Account(dummyRecipient, "201");
      const tx = buildStreamTransaction(recipientAccount, op);

      const { signedTxXdr } = await harness.signTransaction(tx.toXDR());
      assert.ok(signedTxXdr);

      const report = assertSigningRequestXdr(signedTxXdr, {
        expectedContractId: DEFAULT_CONTRACT_ID,
        expectedMethod: "withdraw_max",
        expectedArgCount: 1,
      });

      assert.strictEqual(report.method, "withdraw_max");
      assert.strictEqual(report.fee, 100_000);
      assert.strictEqual(report.memoType, "none");
      assert.strictEqual(report.args?.[0], 99n);
    });

    it("conforms on topUpStream operation schema", async () => {
      const harness = new FreighterHarness();
      const streamId = "12";
      const topUpAmount = "5000000000";

      const op = buildTopUpOp(streamId, topUpAmount, DEFAULT_CONTRACT_ID);
      const tx = buildStreamTransaction(dummyAccount, op);

      const { signedTxXdr } = await harness.signTransaction(tx.toXDR());
      assert.ok(signedTxXdr);

      const report = assertSigningRequestXdr(signedTxXdr, {
        expectedContractId: DEFAULT_CONTRACT_ID,
        expectedMethod: "top_up",
        expectedArgCount: 2,
      });

      assert.strictEqual(report.method, "top_up");
      assert.strictEqual(report.fee, 100_000);
      assert.strictEqual(report.memoType, "none");
      assert.strictEqual(report.args?.[0], 12n);
      assert.strictEqual(report.args?.[1], 5000000000n);
    });

    it("conforms on cancelStream operation schema", async () => {
      const harness = new FreighterHarness();
      const streamId = "15";

      const op = buildCancelStreamOp(dummySender, streamId, DEFAULT_CONTRACT_ID);
      const tx = buildStreamTransaction(dummyAccount, op);

      const { signedTxXdr } = await harness.signTransaction(tx.toXDR());
      assert.ok(signedTxXdr);

      const report = assertSigningRequestXdr(signedTxXdr, {
        expectedContractId: DEFAULT_CONTRACT_ID,
        expectedMethod: "cancel_stream",
        expectedArgCount: 2,
      });

      assert.strictEqual(report.method, "cancel_stream");
      assert.strictEqual(report.fee, 100_000);
      assert.strictEqual(report.memoType, "none");
      assert.strictEqual(report.args?.[0], dummySender);
      assert.strictEqual(report.args?.[1], 15n);
    });
  });

  describe("Freighter API Surface Conformance", () => {
    it("satisfies Freighter API surface methods and records history", async () => {
      const harness = new FreighterHarness();

      assert.strictEqual(await harness.isConnected(), true);
      assert.strictEqual(await harness.isAllowed(), true);
      assert.strictEqual(typeof (await harness.getPublicKey()), "string");
      assert.strictEqual(
        (await harness.getUserInfo()).publicKey,
        await harness.getPublicKey()
      );
      assert.strictEqual(await harness.getNetwork(), "TESTNET");

      const netDetails = await harness.getNetworkDetails();
      assert.strictEqual(netDetails.networkPassphrase, Networks.TESTNET);

      assert.strictEqual(harness.getHistory().length, 0);

      // Sign transaction
      const op = buildWithdrawMaxOp("1", DEFAULT_CONTRACT_ID);
      const tx = buildStreamTransaction(dummyAccount, op);
      await harness.signTransaction(tx.toXDR());

      assert.strictEqual(harness.getHistory().length, 1);
      assert.strictEqual(harness.getHistory()[0].tx.networkPassphrase, Networks.TESTNET);

      harness.clearHistory();
      assert.strictEqual(harness.getHistory().length, 0);
    });

    it("handles signAuthEntry Soroban API surface", async () => {
      const harness = new FreighterHarness();
      const mockAuthEntry = "AAAAAgAAAAEAAAA=";
      const res = await harness.signAuthEntry(mockAuthEntry);
      assert.strictEqual(res.signedAuthEntry, mockAuthEntry);
    });
  });

  describe("Opt-in Live Testnet Mode", () => {
    it("reports live mode status and runs when enabled", async () => {
      const isLive = process.env.FREIGHTER_CONFORMANCE_LIVE === "1";
      if (!isLive) {
        // Mocked mode is the default for CI / offline development
        assert.ok(true, "Offline mock mode active. Set FREIGHTER_CONFORMANCE_LIVE=1 for live testnet mode.");
        return;
      }

      const harness = new FreighterHarness({ mode: "live" });
      assert.strictEqual(harness.mode, "live");
    });
  });
});
