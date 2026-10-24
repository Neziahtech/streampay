#!/usr/bin/env node
/**
 * Builds sdks/vectors/*.json — the cross-language conformance fixtures.
 *
 * Sources of truth:
 *   * event payloads: copied verbatim from the contract's own test snapshots
 *     (contracts/streaming-payments/test_snapshots), re-encoded to
 *     ContractEvent XDR
 *   * transaction envelopes: real signed Soroban invoke envelopes built with
 *     @stellar/stellar-sdk from the spec's argument list
 *   * results: ScVal values encoded from the function's return type
 *
 * Everything is deterministic: fixed key seeds, fixed fee, no time bounds.
 * `git diff --exit-code sdks/vectors` is a valid regeneration check.
 *
 * Run from sdks/typescript:  node scripts/build-fixtures.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import {
  contractErrorScValXdr,
  contractEventXdr,
  scValXdr,
} from "./lib/scval-writer.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const vectorsDir = join(root, "sdks", "vectors");
const spec = JSON.parse(
  readFileSync(join(root, "sdks", "spec", "streampay.spec.json"), "utf8")
);
const fingerprint = readFileSync(
  join(root, "sdks", "spec", "FINGERPRINT"),
  "utf8"
).trim();

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4";
const SNAPSHOT_DIR = join(
  root,
  "contracts",
  "streaming-payments",
  "test_snapshots",
  "test"
);

/** Deterministic testnet-shaped signer: never used on any network. */
const signer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));

const toScVal = (type, value) => {
  if (type === "address") {
    return nativeToScVal(new Address(value), { type: "address" });
  }
  if (type === "bool") return nativeToScVal(Boolean(value));
  return nativeToScVal(BigInt(value), { type });
};

const envelopeFor = (functionName, args) => {
  const tx = new TransactionBuilder(new Account(signer.publicKey(), "0"), {
    fee: "100000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(new Contract(CONTRACT_ID).call(functionName, ...args))
    .setTimebounds(0, 0)
    .build();
  tx.sign(signer);
  return tx.toXDR();
};

/** Canonical decode of a snapshot ScVal JSON node. */
const decodeJson = (node, type) => {
  if (type === "bool") return Boolean(node.bool);
  if (type === "address") return node.address;
  if (type === "symbol" || type === "string") {
    return node.symbol ?? node.string;
  }
  if (
    ["u32", "u64", "i32", "i128", "u128", "timepoint", "duration"].includes(type)
  ) {
    return String(node[type]);
  }
  if ("map" in node) {
    return Object.fromEntries(
      node.map.map(({ key, val }) => [
        key.symbol ?? key.string,
        decodeJson(val, inferType(val)),
      ])
    );
  }
  if ("vec" in node) return node.vec.map((item) => decodeJson(item, inferType(item)));
  throw new Error(`cannot decode snapshot node ${JSON.stringify(node)}`);
};

const inferType = (node) => {
  for (const key of ["bool", "u64", "i128", "u32", "symbol", "string", "address"]) {
    if (key in node) return key;
  }
  if ("map" in node) return "map";
  if ("vec" in node) return "vec";
  return "void";
};

const loadEvent = (snapshotFile, eventName) => {
  const snapshot = JSON.parse(
    readFileSync(join(SNAPSHOT_DIR, snapshotFile), "utf8")
  );
  const matches = snapshot.events.filter(
    (entry) =>
      (entry.event?.type === "contract" || entry.event?.type_ === "contract") &&
      entry.event.contract_id === CONTRACT_ID &&
      entry.event.body.v0.topics[0]?.symbol === eventName
  );
  if (matches.length !== 1) {
    throw new Error(
      `${snapshotFile}: expected exactly one ${eventName} event, found ${matches.length}`
    );
  }
  return matches[0].event;
};

const eventToExpected = (event) => {
  const specEvent = spec.events.find(
    (candidate) => candidate.topic === event.body.v0.topics[0].symbol
  );
  if (!specEvent) {
    throw new Error(`event ${event.body.v0.topics[0].symbol} is not in the spec`);
  }
  const topics = {};
  specEvent.topicFields.forEach((field, index) => {
    topics[field.name] = decodeJson(event.body.v0.topics[index + 1], field.type);
  });
  const data = {};
  for (const entry of event.body.v0.data.map) {
    data[entry.key.symbol] = decodeJson(entry.val, inferType(entry.val));
  }
  return {
    contract: event.contract_id,
    name: specEvent.name,
    topics,
    data,
  };
};

const eventField = (event, name) => {
  const entry = event.body.v0.data.map.find(
    (candidate) => candidate.key.symbol === name
  );
  if (!entry) throw new Error(`event is missing data field ${name}`);
  return entry.val;
};

const build = (scenario) => {
  const event = scenario.event ? loadEvent(scenario.snapshot, scenario.event) : null;
  const args = scenario.args(event);
  const functionSpec = spec.functions.find((f) => f.name === scenario.function);
  const orderedArgs = functionSpec.args.map((arg) => toScVal(arg.type, args[arg.name]));
  const envelopeXdr = envelopeFor(scenario.function, orderedArgs);

  const events = event ? [event] : [];
  let result;
  if (scenario.error) {
    result = { error: { name: scenario.error, code: scenario.errorCode } };
  } else {
    result = { ok: scenario.result ? scenario.result : null };
  }

  const expectedTransaction = {
    contract: CONTRACT_ID,
    function: scenario.function,
    args,
    source: signer.publicKey(),
    fee: "100000",
    sequence: "1",
    signatures: 1,
  };

  return {
    schema: "streampay-vector/v1",
    name: scenario.name,
    specFingerprint: fingerprint,
    provenance: scenario.provenance,
    transactionEnvelopeXdr: envelopeXdr,
    resultXdr: scenario.error
      ? contractErrorScValXdr(scenario.errorCode)
      : scenario.resultScVal(event),
    eventsXdr: events.map((item) => contractEventXdr(item, StrKey)),
    expected: {
      transaction: expectedTransaction,
      result,
      events: events.map(eventToExpected),
    },
  };
};

const scenarios = [
  {
    name: "create-stream",
    provenance:
      "StreamCreated payload from contracts/streaming-payments/test_snapshots/test/create_stream_rejects_duration_over_max.1.json; envelope built from the same values.",
    snapshot: "create_stream_rejects_duration_over_max.1.json",
    event: "stream_created",
    function: "create_stream",
    args: (event) => ({
      sender: eventField(event, "sender").address,
      recipient: eventField(event, "recipient").address,
      token: eventField(event, "token").address,
      deposit_amount: eventField(event, "deposit").i128,
      start_time: eventField(event, "start_time").u64,
      end_time: eventField(event, "end_time").u64,
      cancelable: eventField(event, "cancelable").bool,
    }),
    resultScVal: (event) => scValXdr(event.body.v0.topics[1], StrKey),
    result: "1",
  },
  {
    name: "withdraw",
    provenance:
      "Withdrawn payload from contracts/streaming-payments/test_snapshots/test/withdraw_max_emits_withdrawn_event.1.json.",
    snapshot: "withdraw_max_emits_withdrawn_event.1.json",
    event: "withdrawn",
    function: "withdraw",
    args: (event) => ({
      stream_id: event.body.v0.topics[1].u64,
      amount: eventField(event, "amount").i128,
    }),
    resultScVal: () => scValXdr({ void: true }, StrKey),
    result: null,
  },
  {
    name: "withdraw-max",
    provenance:
      "Withdrawn payload from contracts/streaming-payments/test_snapshots/test/withdraw_max_emits_withdrawn_event.1.json; returns the paid amount.",
    snapshot: "withdraw_max_emits_withdrawn_event.1.json",
    event: "withdrawn",
    function: "withdraw_max",
    args: (event) => ({ stream_id: event.body.v0.topics[1].u64 }),
    resultScVal: (event) => scValXdr(eventField(event, "amount"), StrKey),
    result: "1000000000",
  },
  {
    name: "top-up",
    provenance:
      "StreamToppedUp payload from contracts/streaming-payments/test_snapshots/test/top_up_event_emitted.1.json.",
    snapshot: "top_up_event_emitted.1.json",
    event: "stream_topped_up",
    function: "top_up",
    args: (event) => ({
      stream_id: event.body.v0.topics[1].u64,
      amount: eventField(event, "amount").i128,
    }),
    resultScVal: () => scValXdr({ void: true }, StrKey),
    result: null,
  },
  {
    name: "cancel-stream",
    provenance:
      "StreamCancelled payload from contracts/streaming-payments/test_snapshots/test/events_are_emitted_with_expected_payloads.1.json.",
    snapshot: "events_are_emitted_with_expected_payloads.1.json",
    event: "stream_cancelled",
    function: "cancel_stream",
    args: (event) => ({
      caller: eventField(event, "cancelled_by").address,
      stream_id: event.body.v0.topics[1].u64,
    }),
    resultScVal: () => scValXdr({ void: true }, StrKey),
    result: null,
  },
  {
    name: "error-not-active",
    provenance:
      "WithdrawMax envelope against a cancelled stream; result is ScVal::Error(SCError::Contract(5)) = StreamNotActive.",
    snapshot: null,
    event: null,
    function: "withdraw_max",
    args: () => ({ stream_id: "1" }),
    resultScVal: () => contractErrorScValXdr(5),
    error: "StreamNotActive",
    errorCode: 5,
  },
];

mkdirSync(vectorsDir, { recursive: true });
for (const scenario of scenarios) {
  const vector = build(scenario);
  const path = join(vectorsDir, `${scenario.name}.json`);
  writeFileSync(path, JSON.stringify(vector, null, 2) + "\n");
  console.log(`wrote ${path}`);
}
