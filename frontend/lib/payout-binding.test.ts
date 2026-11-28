import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Address, Keypair, StrKey, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  BIND_DELAY_SECS,
  buildBindingReadOperation,
  buildCancelPayoutOperation,
  buildConfirmPayoutOperation,
  buildProposePayoutOperation,
  confirmBlockedReason,
  deriveBindingStatus,
  formatCountdown,
  isValidStellarAddress,
  parseBindingView,
  registerHookInstructions,
  validatePayoutAddress,
  type BindingView,
} from "./payout-binding.ts";

const recipient = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const payout = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const streaming = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const router = StrKey.encodeContract(Buffer.alloc(32, 7));
const otherActive = Keypair.random().publicKey();

const T = 1_700_000_000;

describe("payout binding state derivation", () => {
  it("none: no active, no pending", () => {
    const s = deriveBindingStatus(
      { active: null, pending: null, activatesAt: 0 },
      T
    );
    assert.equal(s.state, "none");
    assert.equal(s.canConfirm, false);
    assert.equal(s.remainingSecs, 0);
  });

  it("pending-waiting: one second before activates_at", () => {
    const s = deriveBindingStatus(
      { active: null, pending: payout, activatesAt: T + 1 },
      T
    );
    assert.equal(s.state, "pending-waiting");
    assert.equal(s.remainingSecs, 1);
    assert.equal(s.canConfirm, false);
  });

  it("pending-waiting right after propose shows the full delay", () => {
    const s = deriveBindingStatus(
      { active: null, pending: payout, activatesAt: T + BIND_DELAY_SECS },
      T
    );
    assert.equal(s.state, "pending-waiting");
    assert.equal(s.remainingSecs, BIND_DELAY_SECS);
  });

  it("pending-ready: exactly at activates_at (inclusive boundary)", () => {
    const s = deriveBindingStatus(
      { active: null, pending: payout, activatesAt: T },
      T
    );
    assert.equal(s.state, "pending-ready");
    assert.equal(s.canConfirm, true);
    assert.equal(s.remainingSecs, 0);
  });

  it("pending-ready: long after activates_at, remaining never negative", () => {
    const s = deriveBindingStatus(
      { active: null, pending: payout, activatesAt: T },
      T + 10_000
    );
    assert.equal(s.state, "pending-ready");
    assert.equal(s.remainingSecs, 0);
  });

  it("fractional now rounds the remaining time up", () => {
    const s = deriveBindingStatus(
      { active: null, pending: payout, activatesAt: T + 1 },
      T + 0.5
    );
    assert.equal(s.state, "pending-waiting");
    assert.equal(s.remainingSecs, 1);
  });

  it("active: confirmed binding, nothing pending", () => {
    const s = deriveBindingStatus(
      { active: payout, pending: null, activatesAt: 0 },
      T
    );
    assert.equal(s.state, "active");
    assert.equal(s.active, payout);
    assert.equal(s.canConfirm, false);
  });

  it("a new proposal over an active binding is pending and keeps the active address", () => {
    const s = deriveBindingStatus(
      { active: otherActive, pending: payout, activatesAt: T + 5 },
      T
    );
    assert.equal(s.state, "pending-waiting");
    assert.equal(s.active, otherActive);
    assert.equal(s.pending, payout);
  });

  it("transitions: none -> waiting -> ready -> active", () => {
    const proposed: BindingView = {
      active: null,
      pending: payout,
      activatesAt: T + BIND_DELAY_SECS,
    };
    assert.equal(
      deriveBindingStatus({ active: null, pending: null, activatesAt: 0 }, T)
        .state,
      "none"
    );
    assert.equal(deriveBindingStatus(proposed, T).state, "pending-waiting");
    assert.equal(
      deriveBindingStatus(proposed, T + BIND_DELAY_SECS - 1).state,
      "pending-waiting"
    );
    assert.equal(
      deriveBindingStatus(proposed, T + BIND_DELAY_SECS).state,
      "pending-ready"
    );
    assert.equal(
      deriveBindingStatus(
        { active: payout, pending: null, activatesAt: 0 },
        T + BIND_DELAY_SECS
      ).state,
      "active"
    );
  });

  it("cancel returns to none from pending and from active", () => {
    const cleared: BindingView = { active: null, pending: null, activatesAt: 0 };
    assert.equal(deriveBindingStatus(cleared, T).state, "none");
  });
});

describe("parseBindingView", () => {
  it("decodes addresses, bigint timestamps and None as null", () => {
    const v = parseBindingView({
      active: null,
      pending: payout,
      activates_at: BigInt(T),
    });
    assert.deepEqual(v, { active: null, pending: payout, activatesAt: T });
  });

  it("treats undefined options and missing fields as none", () => {
    assert.deepEqual(parseBindingView({}), {
      active: null,
      pending: null,
      activatesAt: 0,
    });
    assert.deepEqual(parseBindingView(null), {
      active: null,
      pending: null,
      activatesAt: 0,
    });
  });

  it("zeroes the timestamp when nothing is pending", () => {
    const v = parseBindingView({
      active: payout,
      pending: undefined,
      activates_at: 123n,
    });
    assert.equal(v.activatesAt, 0);
    assert.equal(v.active, payout);
  });

  it("zeroes a non-finite timestamp", () => {
    assert.equal(
      parseBindingView({ pending: payout, activates_at: "nope" }).activatesAt,
      0
    );
  });
});

describe("formatCountdown", () => {
  it("formats hh:mm:ss", () => {
    assert.equal(formatCountdown(0), "00:00:00");
    assert.equal(formatCountdown(1), "00:00:01");
    assert.equal(formatCountdown(61), "00:01:01");
    assert.equal(formatCountdown(3661), "01:01:01");
    assert.equal(formatCountdown(86_399), "23:59:59");
  });

  it("exactly 24 h stays in hours; days appear only above it", () => {
    assert.equal(formatCountdown(86_400), "24:00:00");
    assert.equal(formatCountdown(86_401), "1d 00:00:01");
    assert.equal(formatCountdown(2 * 86_400 + 3_723), "2d 01:02:03");
  });

  it("never goes negative or non-numeric", () => {
    assert.equal(formatCountdown(-1), "00:00:00");
    assert.equal(formatCountdown(-1e9), "00:00:00");
    assert.equal(formatCountdown(Number.NaN), "00:00:00");
    assert.equal(formatCountdown(Number.POSITIVE_INFINITY), "00:00:00");
  });

  it("floors fractional seconds", () => {
    assert.equal(formatCountdown(59.9), "00:00:59");
  });
});

describe("address validation", () => {
  it("accepts G and C addresses", () => {
    assert.equal(isValidStellarAddress(payout), true);
    assert.equal(isValidStellarAddress(streaming), true);
  });

  it("rejects garbage, wrong checksum and other key types", () => {
    assert.equal(isValidStellarAddress("hello"), false);
    assert.equal(isValidStellarAddress(payout.slice(0, -1) + "A"), false);
    assert.equal(
      isValidStellarAddress(StrKey.encodeMed25519PublicKey(Buffer.alloc(40, 1))),
      false
    );
  });

  it("accepts a valid payout and trims whitespace", () => {
    const r = validatePayoutAddress(`  ${payout}\n`, recipient);
    assert.equal(r.valid, true);
    assert.equal(r.address, payout);
    assert.equal(r.error, null);
  });

  it("accepts a contract payout", () => {
    assert.equal(validatePayoutAddress(streaming, recipient).valid, true);
  });

  it("rejects empty input", () => {
    const r = validatePayoutAddress("   ", recipient);
    assert.equal(r.valid, false);
    assert.match(r.error ?? "", /Enter a payout address/);
  });

  it("rejects an invalid address", () => {
    const r = validatePayoutAddress("GNOTANADDRESS", recipient);
    assert.equal(r.valid, false);
    assert.match(r.error ?? "", /valid Stellar address/);
  });

  it("rejects payout == recipient", () => {
    const r = validatePayoutAddress(recipient, recipient);
    assert.equal(r.valid, false);
    assert.match(r.error ?? "", /your own address/);
  });

  it("rejects the streaming contract and the router when given", () => {
    const forbidden = { streaming, router };
    assert.match(
      validatePayoutAddress(streaming, recipient, forbidden).error ?? "",
      /streaming contract/
    );
    assert.match(
      validatePayoutAddress(router, recipient, forbidden).error ?? "",
      /router/
    );
    assert.equal(validatePayoutAddress(payout, recipient, forbidden).valid, true);
  });
});

describe("confirmBlockedReason", () => {
  const base = { active: null, pending: null, remainingSecs: 0, canConfirm: false };
  it("is null only when ready", () => {
    assert.equal(
      confirmBlockedReason({ ...base, state: "pending-ready", canConfirm: true }),
      null
    );
  });
  it("explains each blocked state", () => {
    assert.match(
      confirmBlockedReason({ ...base, state: "pending-waiting", remainingSecs: 3661 }) ??
        "",
      /01:01:01/
    );
    assert.match(
      confirmBlockedReason({ ...base, state: "none" }) ?? "",
      /Propose a payout address first/
    );
    assert.match(
      confirmBlockedReason({ ...base, state: "active" }) ?? "",
      /Nothing is waiting/
    );
  });
});

describe("router operation builders", () => {
  const routerId = streaming;
  function decode(op: ReturnType<typeof buildProposePayoutOperation>) {
    const raw = xdr.Operation.fromXDR(op.toXDR("base64"), "base64");
    if (raw.body.type !== "invokeHostFunction") throw new Error("not invoke");
    const host = raw.body.invokeHostFunctionOp.hostFunction;
    if (host.type !== "hostFunctionTypeInvokeContract") throw new Error("not invokeContract");
    const call = host.invokeContract;
    return {
      fn: call.functionName.toString(),
      args: call.args.map((a) => scValToNative(a) as unknown),
      contract: Address.fromScAddress(call.contractAddress).toString(),
    };
  }

  it("propose(stream_id, payout)", () => {
    const d = decode(buildProposePayoutOperation(routerId, "42", payout));
    assert.equal(d.fn, "propose");
    assert.equal(d.contract, routerId);
    assert.deepEqual(d.args, [42n, payout]);
  });

  it("confirm(stream_id)", () => {
    const d = decode(buildConfirmPayoutOperation(routerId, "42"));
    assert.equal(d.fn, "confirm");
    assert.deepEqual(d.args, [42n]);
  });

  it("cancel(stream_id)", () => {
    const d = decode(buildCancelPayoutOperation(routerId, "7"));
    assert.equal(d.fn, "cancel");
    assert.deepEqual(d.args, [7n]);
  });

  it("binding(stream_id) read", () => {
    const d = decode(buildBindingReadOperation(routerId, "7"));
    assert.equal(d.fn, "binding");
    assert.deepEqual(d.args, [7n]);
  });
});

describe("registerHookInstructions", () => {
  it("names every register_hook argument with the Revert policy", () => {
    const text = registerHookInstructions({
      streamingId: streaming,
      routerId: router,
      streamId: "42",
      recipient,
    });
    assert.match(text, new RegExp(`--id ${streaming}`));
    assert.match(text, /-- register_hook/);
    assert.match(text, new RegExp(`--caller ${recipient}`));
    assert.match(text, /--stream_id 42/);
    assert.match(text, /--event_class 1/);
    assert.match(text, new RegExp(`--callback_contract ${router}`));
    assert.match(text, /--selector on_withdraw/);
    assert.match(text, /--failure_policy 1/);
  });
});
