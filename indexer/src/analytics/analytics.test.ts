import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createApp } from "../index.js";
import { OutboxStore } from "../outbox/store.js";
import { StreamStore } from "../store.js";
import type { DecodedEvent, EventValue } from "../types.js";
import { AnalyticsMetrics } from "./metrics.js";
import { AnalyticsRefresher } from "./refresh.js";
import { AnalyticsStore } from "./store.js";
import { ANALYTICS_HISTORY_KEY, ANALYTICS_HISTORY_START_LEDGER_KEY, type JournalSource, VIEW_NAMES } from "./types.js";

const BASE_SEC = 1_767_225_600;
const BASE_MS = BASE_SEC * 1000;
const SENDER = "Gsender";
const RECIPIENT = "Grecipient";
const TOKEN = "Ctoken";

function event(
  id: string,
  name: string,
  ledger: number,
  data: Record<string, EventValue>,
  streamId: string | null = "1"
): DecodedEvent {
  return {
    id,
    pagingToken: String(ledger),
    ledger,
    ledgerClosedAt: new Date((BASE_SEC + ledger) * 1000).toISOString(),
    contractId: "Ccontract",
    name,
    streamId,
    data,
  };
}

function created(id = "create-1", streamId = "1", deposit = 1000n): DecodedEvent {
  return event(id, "stream_created", 10, {
    sender: SENDER,
    recipient: RECIPIENT,
    token: TOKEN,
    deposit,
    start_time: BigInt(BASE_SEC),
    end_time: BigInt(BASE_SEC + 100),
    cancelable: true,
  }, streamId);
}

function drain(analytics: AnalyticsStore): void {
  for (;;) {
    if (analytics.refreshOnce() === null) return;
  }
}

function rows(store: StreamStore, table: string, columns: string, order: string): Record<string, unknown>[] {
  return store.db.prepare(`SELECT ${columns} FROM ${table} ORDER BY ${order}`).all() as Record<string, unknown>[];
}

function viewSnapshot(store: StreamStore): Record<string, Record<string, unknown>[]> {
  return {
    address_totals: rows(
      store,
      "analytics_address_totals",
      "address, role, token, streams_created, streams_active, funded, claimed, settled, refunded, rate_per_second",
      "address, role, token"
    ),
    asset_totals: rows(
      store,
      "analytics_asset_totals",
      "token, streams_created, streams_active, funded, claimed, settled, refunded, rate_per_second",
      "token"
    ),
    accrual_buckets: rows(
      store,
      "analytics_accrual_buckets",
      "token, bucket_start_ms, funded, claimed, settled, refunded, streams_created, cancellations, withdrawals",
      "token, bucket_start_ms"
    ),
    rate_ladder: rows(store, "analytics_rate_ladder", "token, bucket_start_ms, rate_delta", "token, bucket_start_ms"),
  };
}

function ladder(store: StreamStore): Array<[number, bigint]> {
  return rows(store, "analytics_rate_ladder", "bucket_start_ms, rate_delta", "bucket_start_ms")
    .map((row) => [Number(row.bucket_start_ms), BigInt(String(row.rate_delta))]);
}

test("cash-flow fixtures keep portfolio escrow balanced", (t) => {
  const store = new StreamStore(":memory:");
  t.after(() => store.close());
  store.ingest(created());
  store.ingest(event("topup-1", "stream_topped_up", 20, { sender: SENDER, amount: 500n, new_deposit: 1500n }));
  store.ingest(event("withdraw-1", "withdrawn", 30, { recipient: RECIPIENT, amount: 200n, withdrawn_total: 200n }));
  store.ingest(event("cancel-1", "stream_cancelled", 40, { sender_amount: 500n, recipient_amount: 800n }));
  drain(store.analytics);

  const [asset] = store.analytics.readAsset(TOKEN);
  assert.ok(asset);
  assert.equal(asset.streams_created, 1n);
  assert.equal(asset.streams_active, 0n);
  assert.equal(asset.funded, 1500n);
  assert.equal(asset.claimed, 200n);
  assert.equal(asset.settled, 800n);
  assert.equal(asset.refunded, 500n);
  assert.equal(asset.rate_per_second, 0n);
  assert.equal(asset.escrow_remaining, 0n);

  const sender = store.analytics.readAddress(SENDER, { role: "sender" })[0];
  const recipient = store.analytics.readAddress(RECIPIENT, { role: "recipient" })[0];
  assert.ok(sender);
  assert.ok(recipient);
  assert.equal(sender.funded, 1500n);
  assert.equal(sender.refunded, 500n);
  assert.equal(recipient.claimed, 200n);
  assert.equal(recipient.settled, 800n);
  assert.equal(Object.hasOwn(sender, "escrow_remaining"), false);
  assert.equal(Object.hasOwn(recipient, "escrow_remaining"), false);

  const [bucket] = store.analytics.readBuckets({ token: TOKEN });
  assert.ok(bucket);
  assert.equal(bucket.funded, 1500n);
  assert.equal(bucket.claimed, 200n);
  assert.equal(bucket.settled, 800n);
  assert.equal(bucket.refunded, 500n);
  assert.equal(bucket.streams_created, 1n);
  assert.equal(bucket.cancellations, 1n);
  assert.equal(bucket.withdrawals, 1n);
});

test("atomic batch creation facts price each stream once and unlock lifecycle events", (t) => {
  const store = new StreamStore(":memory:");
  t.after(() => store.close());
  const secondRecipient = "Gsecondrecipient";
  store.ingest(created("atomic-create-1", "1", 100n));
  store.ingest(event("atomic-create-2", "stream_created", 11, {
    sender: SENDER,
    recipient: secondRecipient,
    token: TOKEN,
    deposit: 200n,
    start_time: BigInt(BASE_SEC),
    end_time: BigInt(BASE_SEC + 100),
    cancelable: true,
  }, "2"));
  store.ingest(event("atomic-summary", "streams_created", 11, {
    sender: SENDER,
    stream_ids: ["1", "2"],
  }, null));
  store.ingest(event("atomic-topup", "stream_topped_up", 12, {
    sender: SENDER,
    amount: 50n,
    new_deposit: 150n,
  }, "1"));
  drain(store.analytics);

  const [asset] = store.analytics.readAsset(TOKEN);
  assert.ok(asset);
  assert.equal(asset.streams_created, 2n);
  assert.equal(asset.streams_active, 2n);
  assert.equal(asset.funded, 350n);
  assert.equal(asset.rate_per_second, 3n);
  assert.equal(store.analytics.readAddress(secondRecipient, { role: "recipient" })[0]?.streams_created, 1n);
  assert.equal(store.analytics.stats().events_applied, 3);
  assert.equal(store.analytics.stats().events_counted_only, 1);
  assert.equal(store.analytics.stats().events_skipped_unknown, 0);
});

test("an independent naive event scan matches every incremental cash-flow view", (t) => {
  const store = new StreamStore(":memory:", { analytics: { config: { batchSize: 1, bucketMs: 10_000 } } });
  t.after(() => store.close());
  const otherRecipient = "Gotherrecipient";
  const payer = "Gpayer";
  const refundTarget = "Grefundtarget";
  const events = [
    created("naive-create-1", "1", 100n),
    event("naive-create-2", "stream_created", 11, {
      sender: SENDER, recipient: otherRecipient, token: TOKEN, deposit: 250n,
      start_time: BigInt(BASE_SEC), end_time: BigInt(BASE_SEC + 100), cancelable: true,
    }, "2"),
    event("naive-topup", "stream_topped_up", 12, { sender: payer, amount: 50n, new_deposit: 150n }, "1"),
    event("naive-rate-1", "rate_change_accepted", 13, {
      new_amount_per_second: 1n, deposit: 170n, adjustment: 20n,
      effective_from: BigInt(BASE_SEC + 30), reserved_at_new_rate: 140n,
    }, "1"),
    event("naive-rate-2", "rate_change_accepted", 14, {
      new_amount_per_second: 1n, deposit: 200n, adjustment: -50n,
      effective_from: BigInt(BASE_SEC + 30), reserved_at_new_rate: 170n,
    }, "2"),
    event("naive-withdraw", "withdrawn", 15, { recipient: RECIPIENT, amount: 30n, withdrawn_total: 30n }, "1"),
    event("naive-refund-target", "stream_refund_target_changed", 16, { new_target: refundTarget }, "1"),
    event("naive-cancel-1", "stream_cancelled", 17, { sender_amount: 70n, recipient_amount: 70n }, "1"),
    event("naive-cancel-2", "stream_cancelled", 18, { sender_amount: 150n, recipient_amount: 50n }, "2"),
    event("naive-unknown", "future_event", 19, { amount: 999n }, null),
    event("naive-batch", "batch_withdraw_summary", 20, { total_amount: 30n }, null),
    event("naive-counted", "streams_created", 21, { count: 2n }, null),
  ];
  store.ingestPage(events, "21", 21);

  type CashRow = {
    streams_created: bigint; funded: bigint; claimed: bigint; settled: bigint; refunded: bigint;
    cancellations: bigint; withdrawals: bigint;
  };
  const emptyCash = (): CashRow => ({
    streams_created: 0n, funded: 0n, claimed: 0n, settled: 0n, refunded: 0n, cancellations: 0n, withdrawals: 0n,
  });
  const expectedAddresses = new Map<string, CashRow>();
  const expectedAsset = emptyCash();
  const expectedBuckets = new Map<number, CashRow>();
  const streams = new Map<string, { sender: string; recipient: string; refundTarget: string | null }>();
  const addressRow = (address: string, role: string): CashRow => {
    const key = `${address}|${role}|${TOKEN}`;
    const row = expectedAddresses.get(key) ?? emptyCash();
    expectedAddresses.set(key, row);
    return row;
  };
  const bucketFor = (item: DecodedEvent): CashRow => {
    const at = Date.parse(item.ledgerClosedAt);
    const start = Math.floor(at / 10_000) * 10_000;
    const bucket = expectedBuckets.get(start) ?? emptyCash();
    expectedBuckets.set(start, bucket);
    return bucket;
  };
  for (const item of events) {
    const streamId = item.streamId;
    const dim = streamId ? streams.get(streamId) : undefined;
    switch (item.name) {
      case "stream_created": {
        const sender = String(item.data["sender"]);
        const recipient = String(item.data["recipient"]);
        const deposit = BigInt(String(item.data["deposit"]));
        const bucket = bucketFor(item);
        streams.set(streamId!, { sender, recipient, refundTarget: null });
        addressRow(sender, "sender").streams_created += 1n;
        addressRow(sender, "sender").funded += deposit;
        addressRow(recipient, "recipient").streams_created += 1n;
        for (const row of [expectedAsset, bucket]) {
          row.streams_created += 1n;
          row.funded += deposit;
        }
        break;
      }
      case "stream_topped_up": {
        const amount = BigInt(String(item.data["amount"]));
        const bucket = bucketFor(item);
        addressRow(String(item.data["sender"]), "sender").funded += amount;
        expectedAsset.funded += amount;
        bucket.funded += amount;
        break;
      }
      case "rate_change_accepted": {
        const adjustment = BigInt(String(item.data["adjustment"]));
        const amount = adjustment < 0n ? -adjustment : adjustment;
        const measure = adjustment < 0n ? "refunded" : "funded";
        const bucket = bucketFor(item);
        addressRow(dim!.sender, "sender")[measure] += amount;
        expectedAsset[measure] += amount;
        bucket[measure] += amount;
        break;
      }
      case "withdrawn": {
        const amount = BigInt(String(item.data["amount"]));
        const bucket = bucketFor(item);
        addressRow(String(item.data["recipient"]), "recipient").claimed += amount;
        expectedAsset.claimed += amount;
        bucket.claimed += amount;
        bucket.withdrawals += 1n;
        break;
      }
      case "stream_refund_target_changed":
        dim!.refundTarget = String(item.data["new_target"]);
        break;
      case "stream_cancelled": {
        const senderAmount = BigInt(String(item.data["sender_amount"]));
        const recipientAmount = BigInt(String(item.data["recipient_amount"]));
        const bucket = bucketFor(item);
        const refundTo = dim!.refundTarget ?? dim!.sender;
        addressRow(refundTo, refundTo === dim!.sender ? "sender" : "refund").refunded += senderAmount;
        addressRow(dim!.recipient, "recipient").settled += recipientAmount;
        expectedAsset.refunded += senderAmount;
        expectedAsset.settled += recipientAmount;
        bucket.refunded += senderAmount;
        bucket.settled += recipientAmount;
        bucket.cancellations += 1n;
        break;
      }
      default:
        break;
    }
  }

  const measures = ["streams_created", "funded", "claimed", "settled", "refunded"] as const;
  const assertCash = (): void => {
    const actualAddresses = new Map(rows(
      store, "analytics_address_totals",
      "address, role, token, streams_created, funded, claimed, settled, refunded", "address, role, token"
    ).map((row) => [`${row.address}|${row.role}|${row.token}`, row]));
    assert.equal(actualAddresses.size, expectedAddresses.size);
    for (const [key, expected] of expectedAddresses) {
      const actual = actualAddresses.get(key);
      assert.ok(actual, key);
      for (const measure of measures) assert.equal(BigInt(String(actual[measure])), expected[measure], `${key} ${measure}`);
    }
    const [asset] = store.analytics.readAsset(TOKEN);
    assert.ok(asset);
    for (const measure of measures) assert.equal(asset[measure], expectedAsset[measure], `asset ${measure}`);
    assert.equal(asset.escrow_remaining, 0n);
    const actualBuckets = new Map(store.analytics.readBuckets({ token: TOKEN, limit: 100 }).map((row) => [row.bucket_start_ms, row]));
    assert.equal(actualBuckets.size, expectedBuckets.size);
    for (const [start, expected] of expectedBuckets) {
      const actual = actualBuckets.get(start);
      assert.ok(actual, String(start));
      for (const measure of measures) assert.equal(actual[measure], expected[measure], `bucket ${start} ${measure}`);
      assert.equal(actual.cancellations, expected.cancellations);
      assert.equal(actual.withdrawals, expected.withdrawals);
    }
  };

  drain(store.analytics);
  assertCash();
  store.analytics.rebuild("independent naive parity");
  assertCash();
});

test("cancellation refunds follow the configured refund target", (t) => {
  const store = new StreamStore(":memory:");
  t.after(() => store.close());
  const refundTarget = "Grefundtarget";
  store.ingest(created());
  store.ingest(event("refund-target-1", "stream_refund_target_changed", 20, { new_target: refundTarget }));
  store.ingest(event("cancel-1", "stream_cancelled", 30, { sender_amount: 700n, recipient_amount: 300n }));
  drain(store.analytics);

  const sender = store.analytics.readAddress(SENDER, { role: "sender" })[0];
  const refund = store.analytics.readAddress(refundTarget, { role: "refund" })[0];
  assert.ok(sender);
  assert.ok(refund);
  assert.equal(sender.refunded, 0n);
  assert.equal(refund.refunded, 700n);
  assert.equal(Object.hasOwn(refund, "escrow_remaining"), false);
  assert.equal(store.analytics.readAsset(TOKEN)[0]?.refunded, 700n);
});

test("i128 amounts stay exact through the TEXT accumulator", (t) => {
  const store = new StreamStore(":memory:");
  t.after(() => store.close());
  const deposit = (1n << 120n) + 123n;
  store.ingest(created("huge-create", "1", deposit));
  drain(store.analytics);
  assert.equal(store.analytics.readAsset(TOKEN)[0]?.funded, deposit);
  const raw = store.db.prepare("SELECT funded FROM analytics_asset_totals WHERE token = ?").get(TOKEN) as { funded: string };
  assert.equal(raw.funded, deposit.toString());
});

test("incremental refresh equals rebuild and journal replay is idempotent", (t) => {
  const store = new StreamStore(":memory:", { analytics: { config: { batchSize: 2 } } });
  t.after(() => store.close());
  const events = [
    created(),
    event("topup-1", "stream_topped_up", 20, { sender: SENDER, amount: 500n, new_deposit: 1500n }),
    event("withdraw-1", "withdrawn", 30, { recipient: RECIPIENT, amount: 100n, withdrawn_total: 100n }),
    event("pause-1", "stream_paused", 40, { paused_at: BigInt(BASE_SEC + 300) }),
    event("resume-1", "stream_resumed", 50, { new_end_time: BigInt(BASE_SEC + 1200) }),
    event("rate-1", "rate_change_accepted", 60, {
      new_amount_per_second: 2n,
      deposit: 1600n,
      adjustment: 100n,
      effective_from: BigInt(BASE_SEC + 400),
      reserved_at_new_rate: 1600n,
    }),
    event("ownership-1", "ownership_accepted", 70, {
      previous_owner: RECIPIENT,
      new_owner: "Gnewrecipient",
      role: ["Recipient"],
    }),
    event("transfer-1", "sender_transferred", 80, { sender_from: SENDER, sender_to: "Gnewsender", refund_rights_transferred: false }),
    event("cancel-1", "stream_cancelled", 90, { sender_amount: 1200n, recipient_amount: 300n }),
  ];
  store.ingestPage(events, "90", 90);
  drain(store.analytics);
  const incremental = viewSnapshot(store);

  const rebuilt = store.analytics.rebuild("parity test");
  assert.equal(rebuilt.events_read, events.length);
  assert.deepEqual(viewSnapshot(store), incremental);
  assert.equal(store.analytics.stats().events_skipped_unknown, 0);

  store.ingestPage(events, "90", 90);
  assert.equal(store.analytics.refreshOnce(), null);
  assert.deepEqual(viewSnapshot(store), incremental);
});

test("top-ups reprice the original window or only the renegotiated tail", (t) => {
  const store = new StreamStore(":memory:", { analytics: { config: { batchSize: 1, bucketMs: 1_000 } } });
  t.after(() => store.close());
  store.ingest(created("single-create", "1", 100n));
  store.ingest(event("single-topup", "stream_topped_up", 20, { sender: SENDER, amount: 100n, new_deposit: 200n }));
  store.ingest(created("tail-create", "2", 100n));
  store.ingest(event("tail-rate", "rate_change_accepted", 30, {
    new_amount_per_second: 1n,
    deposit: 100n,
    adjustment: 0n,
    effective_from: BigInt(BASE_SEC + 30),
    reserved_at_new_rate: 70n,
  }, "2"));
  store.ingest(event("tail-topup", "stream_topped_up", 40, { sender: SENDER, amount: 70n, new_deposit: 170n }, "2"));
  drain(store.analytics);

  assert.deepEqual(ladder(store), [
    [BASE_MS, 3n],
    [BASE_MS + 30_000, 1n],
    [BASE_MS + 100_000, -4n],
  ]);
  const dim = store.analytics.readDims().find((row) => row.stream_id === "2");
  assert.ok(dim);
  assert.deepEqual(dim.segments.map((segment) => [segment.allocation, segment.basis_seconds]), [[100n, 100n], [140n, 70n]]);
  assert.equal(store.analytics.readAsset(TOKEN)[0]?.rate_per_second, 4n);
});

test("pause and resume leave a real-time gap and preserve future rate segments", (t) => {
  const store = new StreamStore(":memory:", { analytics: { config: { batchSize: 1, bucketMs: 1_000 } } });
  t.after(() => store.close());
  store.ingest(created());
  store.ingest(event("pause-1", "stream_paused", 20, { paused_at: BigInt(BASE_SEC + 20) }));
  store.ingest(event("resume-1", "stream_resumed", 30, { new_end_time: BigInt(BASE_SEC + 110) }));
  drain(store.analytics);

  assert.deepEqual(ladder(store), [
    [BASE_MS, 10n],
    [BASE_MS + 20_000, -10n],
    [BASE_MS + 30_000, 10n],
    [BASE_MS + 100_000, 0n],
    [BASE_MS + 110_000, -10n],
  ]);
  assert.equal(store.analytics.readAsset(TOKEN)[0]?.rate_per_second, 10n);
});

test("resume state survives a batch boundary", (t) => {
  const store = new StreamStore(":memory:", { analytics: { config: { batchSize: 1, bucketMs: 1_000 } } });
  t.after(() => store.close());
  store.ingest(created("boundary-create"));
  assert.equal(store.analytics.refreshOnce()?.events_read, 1);
  store.ingest(event("boundary-pause", "stream_paused", 20, { paused_at: BigInt(BASE_SEC + 20) }));
  assert.equal(store.analytics.refreshOnce()?.events_read, 1);
  store.ingest(event("boundary-resume", "stream_resumed", 30, { new_end_time: BigInt(BASE_SEC + 110) }));
  assert.equal(store.analytics.refreshOnce()?.events_read, 1);

  const dim = store.analytics.readDims()[0];
  assert.ok(dim);
  assert.equal(dim.status, "active");
  assert.equal(dim.paused_at_ms, null);
  assert.equal(dim.end_ms, BASE_MS + 110_000);
  assert.equal(dim.visible_from_ms, BASE_MS + 30_000);
  assert.deepEqual(ladder(store), [
    [BASE_MS, 10n],
    [BASE_MS + 20_000, -10n],
    [BASE_MS + 30_000, 10n],
    [BASE_MS + 100_000, 0n],
    [BASE_MS + 110_000, -10n],
  ]);
});

test("a top-up while paused rewrites only the live pre-pause schedule", (t) => {
  const store = new StreamStore(":memory:", { analytics: { config: { bucketMs: 1_000 } } });
  t.after(() => store.close());
  store.ingest(event("paused-topup-create", "stream_created", 0, {
    sender: SENDER, recipient: RECIPIENT, token: TOKEN, deposit: 100n,
    start_time: BigInt(BASE_SEC), end_time: BigInt(BASE_SEC + 100), cancelable: true,
  }));
  store.ingest(event("paused-topup-pause", "stream_paused", 20, { paused_at: BigInt(BASE_SEC + 20) }));
  store.ingest(event("paused-topup", "stream_topped_up", 30, { sender: SENDER, amount: 100n, new_deposit: 200n }));
  drain(store.analytics);

  assert.deepEqual(ladder(store), [
    [BASE_MS, 2n],
    [BASE_MS + 20_000, -2n],
    [BASE_MS + 100_000, 0n],
  ]);
  const forecast = store.analytics.forecast({ token: TOKEN, atMs: BASE_MS + 30_000, horizonMs: 10_000 });
  assert.equal(forecast.total_projected, "0");
  assert.equal(store.analytics.readAsset(TOKEN)[0]?.rate_per_second, 0n);
});

test("full withdrawal depletes the stream and cancellation recovers its effective stop", (t) => {
  const store = new StreamStore(":memory:", { analytics: { config: { batchSize: 1, bucketMs: 1_000 } } });
  t.after(() => store.close());
  store.ingest(event("deplete-create", "stream_created", 0, {
    sender: SENDER, recipient: RECIPIENT, token: TOKEN, deposit: 20n,
    start_time: BigInt(BASE_SEC), end_time: BigInt(BASE_SEC + 20), cancelable: true,
  }));
  store.ingest(event("deplete-withdraw", "withdrawn", 30, { recipient: RECIPIENT, amount: 20n, withdrawn_total: 20n }));
  store.ingest(created("cancel-create", "2", 100n));
  store.ingest(event("cancel-1", "stream_cancelled", 80, { sender_amount: 50n, recipient_amount: 50n }, "2"));
  drain(store.analytics);

  assert.equal(store.analytics.readAsset(TOKEN)[0]?.streams_active, 0n);
  assert.equal(store.analytics.readAsset(TOKEN)[0]?.rate_per_second, 0n);
  assert.deepEqual(ladder(store), [
    [BASE_MS, 2n],
    [BASE_MS + 20_000, -1n],
    [BASE_MS + 50_000, -1n],
    [BASE_MS + 100_000, 0n],
  ]);
});

test("sender transfers pin or move refund rights explicitly", (t) => {
  const store = new StreamStore(":memory:");
  t.after(() => store.close());
  store.ingest(created("pin-create", "1"));
  store.ingest(event("pin-transfer", "sender_transferred", 20, {
    sender_from: SENDER, sender_to: "Gnewsender", refund_rights_transferred: false,
  }, "1"));
  drain(store.analytics);
  assert.equal(store.analytics.readDims().find((row) => row.stream_id === "1")?.refund_target, SENDER);
  store.ingest(event("pin-cancel", "stream_cancelled", 30, { sender_amount: 1000n, recipient_amount: 0n }, "1"));
  store.ingest(created("move-create", "2"));
  store.ingest(event("move-transfer", "sender_transferred", 40, {
    sender_from: SENDER, sender_to: "Gnewsender", refund_rights_transferred: true,
  }, "2"));
  drain(store.analytics);
  assert.equal(store.analytics.readDims().find((row) => row.stream_id === "2")?.refund_target, "Gnewsender");

  assert.equal(store.analytics.readAddress(SENDER, { role: "refund" })[0]?.refunded, 1000n);
  assert.equal(store.analytics.readAddress("Gnewsender", { role: "sender" })[0]?.refunded, 0n);
});

test("forecasts seed from the ladder and do not apply scheduled changes twice", (t) => {
  const store = new StreamStore(":memory:", { analytics: { config: { bucketMs: 1_000 } } });
  t.after(() => store.close());
  store.ingest(event("forecast-create-1", "stream_created", 0, {
    sender: SENDER, recipient: RECIPIENT, token: TOKEN, deposit: 100n,
    start_time: BigInt(BASE_SEC), end_time: BigInt(BASE_SEC + 100), cancelable: true,
  }));
  store.ingest(event("forecast-create-2", "stream_created", 0, {
    sender: SENDER, recipient: RECIPIENT, token: TOKEN, deposit: 100n,
    start_time: BigInt(BASE_SEC + 50), end_time: BigInt(BASE_SEC + 150), cancelable: true,
  }, "2"));
  drain(store.analytics);

  const forecast = store.analytics.forecast({ token: TOKEN, atMs: BASE_MS + 20_000, horizonMs: 80_000 });
  assert.equal(forecast.total_projected, "130");
  assert.equal(forecast.points.length, 80);
  assert.ok(forecast.points.slice(0, 30).every((point) => point.rate_per_second === "1"));
  assert.ok(forecast.points.slice(30).every((point) => point.rate_per_second === "2"));
  assert.ok(BigInt(forecast.max_error_per_bucket) > 0n);
  const historical = store.analytics.forecast({ token: TOKEN, atMs: BASE_MS - 10_000, horizonMs: 20_000 });
  assert.equal(historical.total_projected, "10");
});

test("forecasts retain rate activity that nets out inside a public bucket", (t) => {
  const store = new StreamStore(":memory:", { analytics: { config: { bucketMs: 3_600_000 } } });
  t.after(() => store.close());
  store.ingest(event("coarse-create", "stream_created", 0, {
    sender: SENDER, recipient: RECIPIENT, token: TOKEN, deposit: 100n,
    start_time: BigInt(BASE_SEC), end_time: BigInt(BASE_SEC + 100), cancelable: true,
  }));
  store.ingest(event("coarse-cancel", "stream_cancelled", 20, { sender_amount: 50n, recipient_amount: 50n }));
  drain(store.analytics);

  assert.deepEqual(ladder(store), [[BASE_MS, 0n]]);
  const forecast = store.analytics.forecast({ token: TOKEN, atMs: BASE_MS, horizonMs: 80_000 });
  assert.equal(forecast.total_projected, "50");
  assert.ok(forecast.points.slice(0, 50).every((point) => point.rate_per_second === "1"));
  assert.ok(forecast.points.slice(50).every((point) => point.rate_per_second === "0"));
  store.analytics.rebuild("exact-rate parity");
  assert.equal(store.analytics.forecast({ token: TOKEN, atMs: BASE_MS, horizonMs: 80_000 }).total_projected, "50");
});

test("forecasts follow whole-second contract accrual at millisecond boundaries", (t) => {
  const store = new StreamStore(":memory:", { analytics: { config: { bucketMs: 3_600_000 } } });
  t.after(() => store.close());
  store.ingest(event("subsecond-create", "stream_created", 0, {
    sender: SENDER, recipient: RECIPIENT, token: TOKEN, deposit: 1000n,
    start_time: BigInt(BASE_SEC), end_time: BigInt(BASE_SEC + 1), cancelable: true,
  }));
  drain(store.analytics);

  const crossing = store.analytics.forecast({ token: TOKEN, atMs: BASE_MS + 999, horizonMs: 1 });
  assert.equal(crossing.total_projected, "1000");
  assert.ok(BigInt(crossing.max_error_per_bucket) >= 0n);
  const after = store.analytics.forecast({ token: TOKEN, atMs: BASE_MS + 1000, horizonMs: 1 });
  assert.equal(after.total_projected, "0");
});

test("fractional forecast rates stay within the contract accrual error bound", (t) => {
  const store = new StreamStore(":memory:", { analytics: { config: { bucketMs: 1_000 } } });
  t.after(() => store.close());
  store.ingest(event("fractional-create", "stream_created", 0, {
    sender: SENDER, recipient: RECIPIENT, token: TOKEN, deposit: 100n,
    start_time: BigInt(BASE_SEC), end_time: BigInt(BASE_SEC + 300), cancelable: true,
  }));
  drain(store.analytics);
  assert.equal(store.analytics.readAsset(TOKEN)[0]?.rate_per_second, 0n);

  const forecast = store.analytics.forecast({ token: TOKEN, atMs: BASE_MS, horizonMs: 300_000 });
  const bound = BigInt(forecast.max_error_per_bucket);
  assert.ok(bound > 0n);
  assert.equal(forecast.points.length, 300);
  assert.ok(forecast.points.every((point) => point.rate_per_second === "0.333333333333"));
  const accruedAt = (atMs: number): bigint => {
    const elapsed = BigInt(Math.max(0, Math.floor(atMs / 1000) - BASE_SEC));
    return (100n * elapsed) / 300n;
  };
  for (const point of forecast.points) {
    const exact = accruedAt(point.bucket_start_ms + 1_000) - accruedAt(point.bucket_start_ms);
    const error = BigInt(point.projected) > exact
      ? BigInt(point.projected) - exact
      : exact - BigInt(point.projected);
    assert.ok(error <= bound, `${point.bucket_start_ms}: ${error} exceeds ${bound}`);
  }
  assert.ok(BigInt(forecast.total_projected) <= 100n);
});

test("late scheduled creation preserves and backfills the contract start time", (t) => {
  const store = new StreamStore(":memory:", { analytics: { config: { bucketMs: 1_000 } } });
  t.after(() => store.close());
  store.ingest(event("late-create", "stream_created", 40, {
    sender: SENDER,
    recipient: RECIPIENT,
    token: TOKEN,
    deposit: 100n,
    start_time: BigInt(BASE_SEC),
    end_time: BigInt(BASE_SEC + 100),
    cancelable: true,
  }));
  drain(store.analytics);

  assert.equal(store.analytics.readDims()[0]?.visible_from_ms, BASE_MS);
  assert.deepEqual(ladder(store), [[BASE_MS, 1n], [BASE_MS + 100_000, -1n]]);
  const forecast = store.analytics.forecast({ token: TOKEN, atMs: BASE_MS + 20_000, horizonMs: 20_000 });
  assert.equal(forecast.total_projected, "20");
});

test("expired schedules project nothing while nominal totals remain event-driven", (t) => {
  const store = new StreamStore(":memory:", { analytics: { config: { bucketMs: 1_000 } } });
  t.after(() => store.close());
  store.ingest(event("expired-create", "stream_created", 0, {
    sender: SENDER, recipient: RECIPIENT, token: TOKEN, deposit: 100n,
    start_time: BigInt(BASE_SEC), end_time: BigInt(BASE_SEC + 100), cancelable: true,
  }));
  drain(store.analytics);
  assert.equal(store.analytics.readAsset(TOKEN)[0]?.rate_per_second, 1n);

  const forecast = store.analytics.forecast({ token: TOKEN, atMs: BASE_MS + 200_000, horizonMs: 10_000 });
  assert.equal(forecast.total_projected, "0");
  assert.equal(forecast.points.length, 10);
  assert.ok(forecast.points.every((point) => point.rate_per_second === "0" && point.projected === "0"));
  assert.equal(store.analytics.readAsset(TOKEN)[0]?.rate_per_second, 1n);
});

test("a database without complete event history fails closed", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "streampay-analytics-history-"));
  const path = join(directory, "indexer.sqlite");
  const store = new StreamStore(path);
  store.setState("cursor", "12345");
  store.close();
  const db = new Database(path);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.prepare("DELETE FROM analytics_counters WHERE key = ?").run(ANALYTICS_HISTORY_KEY);
  assert.throws(() => new AnalyticsStore(db, new OutboxStore(db)), /Reindex into a fresh database/);
  db.prepare("DELETE FROM analytics_counters WHERE key = ?").run(ANALYTICS_HISTORY_START_LEDGER_KEY);
  db.prepare("INSERT INTO analytics_counters(key, value) VALUES (?, ?)")
    .run(ANALYTICS_HISTORY_KEY, "1");
  assert.throws(() => new AnalyticsStore(db, new OutboxStore(db)), /marker has no start ledger/);
  db.prepare("INSERT INTO analytics_counters(key, value) VALUES (?, ?)")
    .run(ANALYTICS_HISTORY_START_LEDGER_KEY, "1");
  db.prepare("UPDATE analytics_counters SET value = ? WHERE key = ?").run("invalid", ANALYTICS_HISTORY_START_LEDGER_KEY);
  assert.throws(() => new AnalyticsStore(db, new OutboxStore(db)), /start ledger must be a positive safe integer/);
  db.prepare("UPDATE analytics_counters SET value = ? WHERE key = ?").run("0", ANALYTICS_HISTORY_START_LEDGER_KEY);
  assert.throws(() => new AnalyticsStore(db, new OutboxStore(db)), /start ledger must be a positive safe integer/);
  db.prepare("UPDATE analytics_counters SET value = ? WHERE key = ?").run("1", ANALYTICS_HISTORY_START_LEDGER_KEY);
  assert.throws(
    () => new AnalyticsStore(db, new OutboxStore(db), { historyStartLedger: 2 }),
    /start ledger 1 does not match configured START_LEDGER 2/
  );
  assert.doesNotThrow(() => new AnalyticsStore(db, new OutboxStore(db), { historyStartLedger: 1 }));
  db.prepare("DELETE FROM analytics_counters WHERE key = ?").run(ANALYTICS_HISTORY_KEY);
  const disabled = new AnalyticsStore(db, new OutboxStore(db), { certifyHistory: false });
  assert.equal(disabled.snapshot().history_ready, false);
  assert.throws(() => disabled.refreshOnce(), /history is not certified/);
});

test("a crash inside a refresh transaction leaves no partial rows or watermark", (t) => {
  const store = new StreamStore(":memory:");
  t.after(() => store.close());
  store.ingest(created());
  assert.throws(() => {
    store.db.transaction(() => {
      store.analytics.refreshOnce();
      throw new Error("simulated crash");
    })();
  }, /simulated crash/);
  assert.equal(store.analytics.appliedSeq(), 0);
  assert.equal(store.analytics.watermark("asset_totals").rows, 0);

  store.analytics.refreshOnce();
  assert.equal(store.analytics.appliedSeq(), 1);
  assert.equal(store.analytics.readAsset(TOKEN)[0]?.funded, 1000n);
});

test("a second connection cannot apply the same refresh batch twice", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "streampay-analytics-lock-"));
  const path = join(directory, "indexer.sqlite");
  const store = new StreamStore(path);
  const competingDb = new Database(path);
  competingDb.pragma("busy_timeout = 0");
  const competing = new AnalyticsStore(competingDb, new OutboxStore(competingDb));
  t.after(() => {
    competingDb.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.ingest(created());
  assert.equal(competing.appliedSeq(), 0);
  store.db.function("attempt_competing_refresh", () => {
    assert.throws(() => competing.refreshOnce(), /database is locked/);
    return 0;
  });
  store.db.exec(`
    CREATE TRIGGER attempt_competing_refresh
    BEFORE INSERT ON analytics_asset_totals
    BEGIN SELECT attempt_competing_refresh(); END;
  `);

  const batch = store.analytics.refreshOnce();
  assert.equal(batch?.applied, 1);
  assert.equal(store.analytics.readAsset(TOKEN)[0]?.funded, 1000n);
  assert.equal(store.analytics.appliedSeq(), 1);
  assert.equal(store.analytics.refreshOnce(), null);
  assert.equal(store.analytics.readAsset(TOKEN)[0]?.funded, 1000n);
});

test("operational snapshots never mix watermarks from different commits", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "streampay-analytics-snapshot-"));
  const path = join(directory, "indexer.sqlite");
  const store = new StreamStore(path);
  const competingDb = new Database(path);
  competingDb.pragma("busy_timeout = 0");
  const competing = new AnalyticsStore(competingDb, new OutboxStore(competingDb));
  t.after(() => {
    competingDb.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.ingest(created());
  store.analytics.refreshOnce();
  store.ingest(event("snapshot-topup", "stream_topped_up", 20, {
    sender: SENDER,
    amount: 500n,
    new_deposit: 1500n,
  }));

  let tipReads = 0;
  const journal: JournalSource = {
    journalAfterSeq: (afterSeq, limit) => store.outbox.journalAfterSeq(afterSeq, limit),
    journalTip: () => {
      const tip = store.outbox.journalTip();
      tipReads += 1;
      if (tipReads === 1) competing.refreshOnce();
      return tip;
    },
  };
  const observing = new AnalyticsStore(store.db, journal);
  const snapshot = observing.snapshot();

  assert.equal(snapshot.journal_seq, 2);
  assert.equal(snapshot.stats.watermark_seq, 1);
  assert.equal(snapshot.stats.lag_events, 1);
  assert.ok(snapshot.views.every((entry) => entry.watermark.last_seq === 1 && entry.staleness.journal_seq === 2));
  assert.equal(store.analytics.appliedSeq(), 2);
  assert.equal(store.analytics.readAsset(TOKEN)[0]?.funded, 1500n);
});

test("a concurrent retraction cannot be cleared by a rebuild that did not see it", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "streampay-analytics-rebuild-lock-"));
  const path = join(directory, "indexer.sqlite");
  const store = new StreamStore(path);
  const competingDb = new Database(path);
  competingDb.pragma("busy_timeout = 0");
  const competingOutbox = new OutboxStore(competingDb);
  t.after(() => {
    competingDb.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.ingest(created());
  store.ingest(event("locked-withdraw", "withdrawn", 20, { recipient: RECIPIENT, amount: 100n, withdrawn_total: 100n }));
  drain(store.analytics);
  store.db.function("attempt_competing_retraction", () => {
    assert.throws(() => competingOutbox.retractAfterLedger(10, "blocked reorg"), /database is locked/);
    return 0;
  });
  store.db.exec(`
    CREATE TRIGGER attempt_competing_retraction
    BEFORE INSERT ON analytics_asset_totals
    BEGIN SELECT attempt_competing_retraction(); END;
  `);

  store.analytics.rebuild("concurrency test");
  assert.equal(store.outbox.getEventBySeq(2)?.retracted_at, null);
  assert.equal(store.analytics.isDirty, false);
  assert.equal(store.analytics.readAsset(TOKEN)[0]?.claimed, 100n);

  store.db.exec("DROP TRIGGER attempt_competing_retraction");
  store.outbox.retractAfterLedger(10, "post-rebuild reorg");
  assert.equal(store.analytics.isDirty, true);
  const blocked = await store.analytics.readGated("asset_totals", {}, () => store.analytics.readAsset(TOKEN));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.staleness.dirty, true);
  store.analytics.refreshOnce();
  assert.equal(store.analytics.isDirty, false);
  assert.equal(store.analytics.readAsset(TOKEN)[0]?.claimed, 0n);
});

test("a reorg retraction invalidates reads and rebuilds from the surviving journal", async (t) => {
  const store = new StreamStore(":memory:");
  t.after(() => store.close());
  store.ingest(created());
  store.ingest(event("withdraw-1", "withdrawn", 20, { recipient: RECIPIENT, amount: 100n, withdrawn_total: 100n }));
  drain(store.analytics);
  assert.equal(store.analytics.readAsset(TOKEN)[0]?.claimed, 100n);

  store.outbox.retractAfterLedger(10, "test reorg");
  const blocked = await store.analytics.readGated("asset_totals", {}, () => store.analytics.readAsset(TOKEN));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.staleness.dirty, true);

  store.analytics.refreshOnce();
  assert.equal(store.analytics.isDirty, false);
  assert.equal(store.analytics.readAsset(TOKEN)[0]?.claimed, 0n);
  assert.equal(store.analytics.appliedSeq(), 1);
  assert.equal(store.analytics.watermark("asset_totals").last_ledger, 10);
  assert.equal(store.analytics.stats().rebuilds, 1);
});

test("reorg invalidation commits with retraction and survives restart", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "streampay-analytics-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "indexer.sqlite");
  {
    const store = new StreamStore(path);
    try {
      store.ingest(created());
      store.ingest(event("withdraw-1", "withdrawn", 20, { recipient: RECIPIENT, amount: 100n, withdrawn_total: 100n }));
      drain(store.analytics);
      assert.throws(() => {
        store.db.transaction(() => {
          store.outbox.retractAfterLedger(10, "rolled back reorg");
          throw new Error("simulated crash");
        })();
      }, /simulated crash/);
      assert.equal(store.analytics.isDirty, false);
      assert.equal(store.analytics.readAsset(TOKEN)[0]?.claimed, 100n);
      store.outbox.retractAfterLedger(10, "committed reorg");
      assert.equal(store.analytics.isDirty, true);
    } finally {
      store.close();
    }
  }

  const reopened = new StreamStore(path);
  try {
    assert.equal(reopened.analytics.isDirty, true);
    const blocked = await reopened.analytics.readGated("asset_totals", {}, () => reopened.analytics.readAsset(TOKEN));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.staleness.dirty, true);
    reopened.analytics.refreshOnce();
    assert.equal(reopened.analytics.isDirty, false);
    assert.equal(reopened.analytics.readAsset(TOKEN)[0]?.claimed, 0n);
    assert.equal(reopened.analytics.stats().last_rebuild_reason, "reorg_retracted above ledger 10 (committed reorg)");
  } finally {
    reopened.close();
  }
});

test("batch summaries are counted without pricing their amounts twice", (t) => {
  const store = new StreamStore(":memory:");
  t.after(() => store.close());
  store.ingest(created());
  store.ingest(event("withdraw-1", "withdrawn", 20, { recipient: RECIPIENT, amount: 200n, withdrawn_total: 200n }));
  store.ingest(event("batch-1", "batch_withdraw_summary", 21, { total_amount: 200n }, null));
  store.ingest(event("batch-created", "streams_created", 22, { count: 1n }, null));
  drain(store.analytics);
  assert.equal(store.analytics.readAsset(TOKEN)[0]?.claimed, 200n);
  assert.equal(store.analytics.stats().events_counted_only, 2);
});

test("staleness honors the SLO and gated reads block only until the writer catches up", async (t) => {
  let now = BASE_MS;
  const store = new StreamStore(":memory:", {
    analytics: { config: { sloMs: 1_000, maxWaitMs: 100, waitPollMs: 1 }, now: () => now },
  });
  t.after(() => store.close());
  store.ingest(created());
  store.analytics.refreshOnce();
  now += 20_000;
  assert.equal(store.analytics.staleness("asset_totals").in_slo, false);

  store.ingest(event("withdraw-1", "withdrawn", 20, { recipient: RECIPIENT, amount: 100n, withdrawn_total: 100n }));
  const timedOut = await store.analytics.readGated("asset_totals", { minLedger: 20, waitMs: 5 }, () => store.analytics.readAsset(TOKEN));
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.reason, "waited_out");

  const refresh = setImmediate(() => store.analytics.refreshOnce());
  try {
    const served = await store.analytics.readGated("asset_totals", { minLedger: 20, waitMs: 100 }, () => store.analytics.readAsset(TOKEN));
    assert.equal(served.ok, true);
    assert.equal(served.data?.[0]?.claimed, 100n);
  } finally {
    clearImmediate(refresh);
  }
});

test("the refresh worker enforces a non-default per-tick throughput budget", (t) => {
  const store = new StreamStore(":memory:", {
    analytics: { config: { batchSize: 500, refreshIntervalMs: 100, throughputBudgetPerSecond: 100 } },
  });
  t.after(() => store.close());
  const insert = store.db.prepare(
    `INSERT INTO outbox_events (idempotency_key, event_id, stream_id, name, ledger, ledger_cursor, payload, ingested_at)
     VALUES (?, ?, ?, 'stream_created', 10, ?, ?, ?)`
  );
  const payload = JSON.stringify({
    sender: SENDER,
    recipient: RECIPIENT,
    token: TOKEN,
    deposit: "1000",
    start_time: String(BASE_SEC),
    end_time: String(BASE_SEC + 100),
  });
  store.db.transaction(() => {
    for (let i = 0; i < 25; i += 1) {
      insert.run(`budget-${i}`, `budget-event-${i}`, String(i + 1), String(i + 1), payload, new Date(BASE_MS).toISOString());
    }
  })();

  const refresher = new AnalyticsRefresher(store.analytics, new AnalyticsMetrics());
  assert.equal(refresher.tick().events_read, 10);
  assert.equal(refresher.tick().events_read, 10);
  assert.equal(refresher.tick().events_read, 5);
  assert.equal(refresher.tick().events_read, 0);
  assert.equal(store.analytics.appliedSeq(), 25);
  assert.equal(store.analytics.readAsset(TOKEN)[0]?.streams_created, 25n);
  assert.equal(store.analytics.watermark("asset_totals").rows, 1);
  assert.equal(refresher.stats().ticks, 4);
  assert.equal(refresher.stats().events_read, 25);
});

test("metrics and view reads expose aggregates, never per-stream identifiers", (t) => {
  const store = new StreamStore(":memory:");
  t.after(() => store.close());
  store.ingest(created());
  drain(store.analytics);
  const exposition = new AnalyticsMetrics().render(store.analytics.snapshot());
  assert.equal(exposition.includes(SENDER), false);
  assert.equal(exposition.includes(RECIPIENT), false);
  assert.equal(exposition.includes(TOKEN), false);
  assert.equal(exposition.includes('"stream_id"'), false);
  const [asset] = store.analytics.readAsset(TOKEN);
  assert.ok(asset);
  assert.equal(Object.hasOwn(asset, "stream_id"), false);
  assert.equal(Object.hasOwn(asset, "deposit"), false);
  assert.deepEqual(store.analytics.snapshot().views.map((entry) => entry.view), [...VIEW_NAMES]);
});

test("analytics HTTP surface serializes amounts and enforces freshness", async (t) => {
  const sender = `G${"A".repeat(55)}`;
  const token = `C${"B".repeat(55)}`;
  const store = new StreamStore(":memory:");
  t.after(() => store.close());
  store.ingest(event("http-create", "stream_created", 10, {
    sender,
    recipient: `G${"C".repeat(55)}`,
    token,
    deposit: 1000n,
    start_time: BigInt(BASE_SEC),
    end_time: BigInt(BASE_SEC + 100),
  }));
  const metrics = new AnalyticsMetrics();
  const refresher = new AnalyticsRefresher(store.analytics, metrics);
  const app = createApp(
    store,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { refresher, metrics, apiToken: "analytics-test-token", mutationRateLimitPerSecond: 2, trustProxyHops: 1 }
  );
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const request = async (path: string, init?: RequestInit, authenticate = true): Promise<{ status: number; text: string; json: Record<string, unknown> }> => {
    const headers = new Headers(init?.headers);
    if (!headers.has("x-forwarded-for")) headers.set("x-forwarded-for", "203.0.113.10");
    if (authenticate) headers.set("authorization", "Bearer analytics-test-token");
    const response = await fetch(`${base}${path}`, { ...init, headers });
    const text = await response.text();
    return { status: response.status, text, json: text.startsWith("{") ? JSON.parse(text) as Record<string, unknown> : {} };
  };

  assert.equal((await request("/api/analytics/views", undefined, false)).status, 401);
  assert.equal((await request("/api/analytics/refresh", { method: "POST" }, false)).status, 401);
  assert.equal((await request("/api/analytics/refresh", { method: "POST" })).status, 200);
  const views = await request("/api/analytics/views");
  assert.equal(views.status, 200);
  assert.equal((views.json["views"] as unknown[]).length, 4);

  const assets = await request(`/api/analytics/assets?token=${token}`);
  assert.equal(assets.status, 200);
  const assetRows = assets.json["data"] as Array<Record<string, unknown>>;
  assert.equal(assetRows[0]?.["funded"], "1000");
  assert.equal(Object.hasOwn(assetRows[0]!, "stream_id"), false);

  assert.equal((await request(`/api/analytics/addresses/${sender}`)).status, 200);
  assert.equal((await request("/api/analytics/accrual")).status, 200);
  const forecast = await request(`/api/analytics/forecast?token=${token}&at_ms=${BASE_MS}&horizon_ms=3600000`);
  assert.equal(forecast.status, 200);
  assert.equal(typeof (forecast.json["data"] as Record<string, unknown>)["total_projected"], "string");
  assert.equal((await request(`/api/analytics/forecast?token=${token}&at_ms=0&horizon_ms=36000000001`)).status, 400);
  assert.equal((await request(`/api/analytics/forecast?token=${token}&at_ms=9007199254740991&horizon_ms=1`)).status, 400);
  assert.equal((await request("/api/analytics/rebuild", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "http test" }),
  })).status, 200);
  assert.equal((await request("/api/analytics/refresh/stats")).status, 200);
  const otherClient = await request("/api/analytics/refresh", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.11" },
  });
  assert.equal(otherClient.status, 200);
  const throttled = await request("/api/analytics/refresh", { method: "POST" });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.json["code"], "rate_limited");

  const exposition = await request("/metrics");
  assert.equal(exposition.status, 200);
  assert.match(exposition.text, /streampay_analytics_watermark_seq/);
  assert.equal(exposition.text.includes(sender), false);
  assert.equal(exposition.text.includes(token), false);

  store.ingest(event("http-withdraw", "withdrawn", 20, {
    recipient: `G${"C".repeat(55)}`,
    amount: 100n,
    withdrawn_total: 100n,
  }));
  const stale = await request("/api/analytics/assets?max_lag_events=0&wait_ms=0");
  assert.equal(stale.status, 503);
  assert.equal(stale.json["code"], "stale_view");
  assert.equal((await request("/api/analytics/assets?min_ledger=nope")).status, 400);
});
