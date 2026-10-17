/**
 * The canary must build calls with the frontend's builders. These tests put
 * those operations into a canary-built transaction and inspect the resulting
 * envelope, which also catches duplicate stellar-sdk copies diverging.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Account,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";

import {
  cancelStreamOperation,
  createStreamOperation,
  withdrawMaxOperation,
  withdrawOperation,
} from "../../../frontend/lib/contract-ops.ts";

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM";
const SENDER = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M";
const RECIPIENT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4";
const TOKEN = "CBEPDNVYXQGWB5YUBXKJWYJA7OXTZW5LFLNO5JRRGE6Z6C5OSUZPCCEL";
const SIGNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));

function invocation(operation: xdr.Operation): {
  contract_address: string;
  function_name: string;
  args: Array<Record<string, unknown>>;
} {
  const tx = new TransactionBuilder(new Account(SIGNER.publicKey(), "0"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();
  const envelope = JSON.parse(JSON.stringify(tx.toEnvelope())) as {
    tx: {
      tx: {
        operations: Array<{
          body: {
            invoke_host_function: {
              host_function: { invoke_contract: ReturnType<typeof invocation> };
            };
          };
        }>;
      };
    };
  };
  const body = envelope.tx.tx.operations[0]?.body.invoke_host_function.host_function.invoke_contract;
  assert.ok(body, "operation is a Soroban invokeContract");
  return body;
}

test("create_stream keeps the frontend's argument order and units", () => {
  const call = invocation(
    createStreamOperation(new Contract(CONTRACT), {
      sender: SENDER,
      recipient: RECIPIENT,
      token: TOKEN,
      deposit: "1000000",
      startTime: 1000,
      endTime: 1120,
      cancelable: true,
    })
  );

  assert.equal(call.contract_address, CONTRACT);
  assert.equal(call.function_name, "create_stream");
  assert.deepEqual(call.args, [
    { address: SENDER },
    { address: RECIPIENT },
    { address: TOKEN },
    { i128: "1000000" },
    { u64: "1000" },
    { u64: "1120" },
    { bool: true },
  ]);
});

test("withdraw, withdraw_max, and cancel encode typed arguments", () => {
  const contract = new Contract(CONTRACT);

  const withdraw = invocation(withdrawOperation(contract, 3, 250n));
  assert.equal(withdraw.function_name, "withdraw");
  assert.deepEqual(withdraw.args, [{ u64: "3" }, { i128: "250" }]);

  const max = invocation(withdrawMaxOperation(contract, 3));
  assert.equal(max.function_name, "withdraw_max");
  assert.deepEqual(max.args, [{ u64: "3" }]);

  const cancel = invocation(cancelStreamOperation(contract, SENDER, 3));
  assert.equal(cancel.function_name, "cancel_stream");
  assert.deepEqual(cancel.args, [{ address: SENDER }, { u64: "3" }]);
});
