import { Account, rpc, scValToNative, SorobanDataBuilder, Transaction, xdr } from "@stellar/stellar-sdk";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prepareGovernanceMutation } from "./governance-client";
import type { GovernanceMutation } from "./governance.ts";

const SOURCE = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const NOMINEE = "GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG";
const previousContractId = vi.hoisted(() => {
  const previous = process.env.NEXT_PUBLIC_STREAMING_CONTRACT_ID;
  process.env.NEXT_PUBLIC_STREAMING_CONTRACT_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  return previous;
});

const cases: Array<{ mutation: GovernanceMutation; method: string; args: unknown[] }> = [
  { mutation: { kind: "assetPropose", asset: TOKEN, allowed: true }, method: "policy_propose_asset", args: [TOKEN, true] },
  { mutation: { kind: "assetExecute", asset: TOKEN }, method: "policy_execute_asset", args: [TOKEN] },
  { mutation: { kind: "policySetDelay", delay: "86400" }, method: "policy_set_timelock_delay", args: [86_400n] },
  { mutation: { kind: "policyProposeHandoff", newAdmin: NOMINEE }, method: "policy_propose_handoff", args: [NOMINEE] },
  { mutation: { kind: "policyAcceptHandoff" }, method: "policy_accept_handoff", args: [] },
  { mutation: { kind: "policyCancelHandoff" }, method: "policy_cancel_handoff", args: [] },
];

function invocation(transaction: Transaction) {
  const operation = transaction.operations[0];
  if (operation.type !== "invokeHostFunction") throw new Error("Expected a contract invocation");
  const hostFunction = operation.func;
  if (hostFunction.type !== "hostFunctionTypeInvokeContract") throw new Error("Expected an invoke-contract host function");
  return {
    method: hostFunction.invokeContract.functionName.toString(),
    args: hostFunction.invokeContract.args.map(scValToNative),
  };
}

afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  if (previousContractId === undefined) delete process.env.NEXT_PUBLIC_STREAMING_CONTRACT_ID;
  else process.env.NEXT_PUBLIC_STREAMING_CONTRACT_ID = previousContractId;
});

describe("governance client contract ABI", () => {
  it("uses implicit transaction-source authorization for policy-admin calls", async () => {
    const transactions: Transaction[] = [];
    vi.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(SOURCE, "0"));
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(async (transaction) => {
      if (!(transaction instanceof Transaction)) throw new Error("Expected a standard transaction");
      transactions.push(transaction);
      return {
        id: "simulation",
        latestLedger: 1,
        events: [],
        _parsed: true,
        transactionData: new SorobanDataBuilder(),
        minResourceFee: "100",
        result: { auth: [], retval: xdr.ScVal.scvVoid() },
      };
    });
    for (const { mutation } of cases) {
      await prepareGovernanceMutation(SOURCE, mutation);
    }

    expect(transactions.map(invocation)).toEqual(cases.map(({ method, args }) => ({ method, args })));
  });
});
