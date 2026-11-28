/**
 * The analytics fold (issue #581).
 *
 * One pass of the journal, one event at a time, into view deltas. This module
 * owns *all* arithmetic and is deliberately storage-free: the incremental
 * refresh and the rebuild-from-scratch both call it, which is why the two paths
 * agree by construction rather than by a test that hopes they do.
 *
 * Invariants that make that safe:
 * - Journal order is the only order that matters. A stream's facts are taken
 *   from `stream_created` and carried in the dimension map, never read from the
 *   mutable `streams` projection — so folding the same range twice, on any
 *   machine, at any wall-clock time, yields identical deltas.
 * - Amounts move only on the per-stream events. `batch_withdraw_summary` and
 *   `streams_created` restate amounts those events already carried, so they are
 *   counted, never priced; double-counting a withdrawal is a wrong dashboard.
 * - A forecast needs a rate per unit of time. Pause and resume are therefore
 *   ladder edits (the rate stops and restarts), and a rate change is an edit
 *   from its effective time, not from the ledger it landed on.
 */

import { COUNTED_ONLY_EVENTS, RATE_SCALE, type AccrualBucketRow, type AddressTotalsRow, type AssetTotalsRow, type JournalEvent, type RateEventRow, type RateLadderRow, type RateSegment, type Role, type StreamDim } from "./types.js";

/** Aggregated deltas for one batch, keyed exactly like the view rows. */
export interface FoldDeltas {
  address: Map<string, AddressTotalsRow>;
  asset: Map<string, AssetTotalsRow>;
  bucket: Map<string, AccrualBucketRow>;
  ladder: Map<string, RateLadderRow>;
  /** Exact effective-time deltas used by forecasts; the public ladder stays bucketed. */
  rateEvents: Map<string, RateEventRow>;
  dims: Map<string, StreamDim>;
  /** Streams whose facts this batch changed, so the writer knows what to persist. */
  dimTouched: Set<string>;
  /** Streams that stopped accruing: their dimension row is no longer needed. */
  dimClosed: Set<string>;
  events_applied: number;
  events_counted_only: number;
  events_unknown: number;
  last_seq: number;
  last_ledger: number;
  last_event_ms: number;
}

export interface FoldContext {
  bucketMs: number;
  deltas: FoldDeltas;
}

export const addressKey = (address: string, role: Role, token: string): string => `${address}|${role}|${token}`;
export const bucketKey = (token: string, startMs: number): string => `${token}|${startMs}`;

export function emptyDeltas(): FoldDeltas {
  return {
    address: new Map(),
    asset: new Map(),
    bucket: new Map(),
    ladder: new Map(),
    rateEvents: new Map(),
    dims: new Map(),
    dimTouched: new Set(),
    dimClosed: new Set(),
    events_applied: 0,
    events_counted_only: 0,
    events_unknown: 0,
    last_seq: 0,
    last_ledger: 0,
    last_event_ms: 0,
  };
}

/** Payload numbers arrive as strings (bigints are stringified into the journal). */
function num(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

/** `scValToNative` decodes a Rust enum as `[variant, ...fields]`. */
function roleOf(value: unknown): Role | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const role = raw.toLowerCase();
  return role === "sender" || role === "recipient" ? role : null;
}

/**
 * Event time in milliseconds. A bucket must be comparable across tokens and
 * across streams, and `ledger_closed_at` is the timestamp every journal row
 * carries, so bucketing is chain time. The stream's own `start_time` /
 * `end_time` are used only inside the ladder.
 */
export function eventMs(event: JournalEvent): number {
  const parsed = Date.parse(event.ledger_closed_at);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function bucketStart(ms: number, bucketMs: number): number {
  return Math.floor(ms / bucketMs) * bucketMs;
}

/** Floor division, matching the contract's and the frontend oracle's rate math. */
export function rateOf(deposit: bigint, startMs: number, endMs: number): bigint {
  const span = BigInt(Math.max(0, endMs - startMs)) / 1000n;
  if (span <= 0n) return deposit;
  return deposit / span;
}

function addressRow(deltas: FoldDeltas, address: string, role: Role, token: string): AddressTotalsRow {
  const key = addressKey(address, role, token);
  const existing = deltas.address.get(key);
  if (existing) return existing;
  const row: AddressTotalsRow = {
    address,
    role,
    token,
    streams_created: 0n,
    streams_active: 0n,
    funded: 0n,
    claimed: 0n,
    settled: 0n,
    refunded: 0n,
    rate_per_second: 0n,
  };
  deltas.address.set(key, row);
  return row;
}

function assetRow(deltas: FoldDeltas, token: string): AssetTotalsRow {
  const existing = deltas.asset.get(token);
  if (existing) return existing;
  const row: AssetTotalsRow = {
    token,
    streams_created: 0n,
    streams_active: 0n,
    funded: 0n,
    claimed: 0n,
    settled: 0n,
    refunded: 0n,
    rate_per_second: 0n,
  };
  deltas.asset.set(token, row);
  return row;
}

function bucketRow(deltas: FoldDeltas, token: string, ms: number, bucketMs: number): AccrualBucketRow {
  const start = bucketStart(ms, bucketMs);
  const key = bucketKey(token, start);
  const existing = deltas.bucket.get(key);
  if (existing) return existing;
  const row: AccrualBucketRow = {
    token,
    bucket_start_ms: start,
    funded: 0n,
    claimed: 0n,
    settled: 0n,
    refunded: 0n,
    streams_created: 0n,
    cancellations: 0n,
    withdrawals: 0n,
  };
  deltas.bucket.set(key, row);
  return row;
}

/** Add exact forecast deltas and their bucketed public representation. */
function ladderDelta(
  deltas: FoldDeltas,
  token: string,
  ms: number,
  rateDelta: bigint,
  scaledDelta: bigint,
  activeDelta: bigint,
  bucketMs: number
): void {
  if (rateDelta === 0n && scaledDelta === 0n && activeDelta === 0n) return;
  const exactKey = `${token}|${ms}`;
  const exact = deltas.rateEvents.get(exactKey);
  if (exact) {
    exact.rate_delta += rateDelta;
    exact.rate_scaled_delta += scaledDelta;
    exact.active_delta += activeDelta;
    if (exact.rate_delta === 0n && exact.rate_scaled_delta === 0n && exact.active_delta === 0n) {
      deltas.rateEvents.delete(exactKey);
    }
  } else {
    deltas.rateEvents.set(exactKey, {
      token,
      effective_ms: ms,
      rate_delta: rateDelta,
      rate_scaled_delta: scaledDelta,
      active_delta: activeDelta,
    });
  }

  const start = bucketStart(ms, bucketMs);
  const key = bucketKey(token, start);
  const existing = deltas.ladder.get(key);
  if (existing) {
    existing.rate_delta += rateDelta;
    existing.rate_scaled_delta += scaledDelta;
    existing.active_delta += activeDelta;
    return;
  }
  deltas.ladder.set(key, {
    token,
    bucket_start_ms: start,
    rate_delta: rateDelta,
    rate_scaled_delta: scaledDelta,
    active_delta: activeDelta,
  });
}

/**
 * Record a scheduled span across [fromMs, toMs). The floor rate serves nominal
 * totals; the fixed-point rate and active-span count let forecasts retain
 * fractional accrual and bound their rounding error.
 */
function addRateSpan(
  deltas: FoldDeltas,
  token: string,
  fromMs: number,
  toMs: number,
  rate: bigint,
  scaledRate: bigint,
  bucketMs: number,
  sign: 1 | -1
): void {
  if (toMs <= fromMs || (rate === 0n && scaledRate === 0n)) return;
  const start = sign === 1 ? 1n : -1n;
  ladderDelta(deltas, token, fromMs, rate * start, scaledRate * start, start, bucketMs);
  ladderDelta(deltas, token, toMs, -rate * start, -scaledRate * start, -start, bucketMs);
}

/** A stream's nominal rate contribution: a paused or terminal stream contributes none. */
function liveRate(dim: StreamDim): bigint {
  return dim.status === "active" ? dim.rate_per_second : 0n;
}

function segmentRate(segment: RateSegment): bigint {
  return segment.basis_seconds > 0n ? segment.allocation / segment.basis_seconds : segment.allocation;
}

function scaledSegmentRate(segment: RateSegment): bigint {
  return segment.basis_seconds > 0n
    ? (segment.allocation * RATE_SCALE) / segment.basis_seconds
    : segment.allocation * RATE_SCALE;
}

function scheduleSegments(dim: StreamDim): RateSegment[] {
  if (dim.segments.length > 0) return dim.segments;
  return [{
    start_ms: dim.start_ms,
    end_ms: dim.end_ms,
    allocation: dim.deposit,
    basis_seconds: BigInt(Math.max(0, dim.end_ms - dim.start_ms)) / 1000n,
  }];
}

function addSchedule(
  context: FoldContext,
  dim: StreamDim,
  untilRealMs: number,
  sign: 1 | -1
): void {
  for (const segment of scheduleSegments(dim)) {
    const from = Math.max(segment.start_ms, dim.visible_from_ms);
    const to = Math.min(segment.end_ms, untilRealMs);
    addRateSpan(context.deltas, dim.token, from, to, segmentRate(segment), scaledSegmentRate(segment), context.bucketMs, sign);
  }
}

function replaceSchedule(
  context: FoldContext,
  dim: StreamDim,
  oldUntilRealMs: number,
  newUntilRealMs: number
): void {
  addSchedule(context, dim, oldUntilRealMs, -1);
  addSchedule(context, dim, newUntilRealMs, 1);
}

function accruedAt(dim: StreamDim, atMs: number): bigint {
  const at = BigInt(Math.max(0, Math.floor(atMs / 1000)));
  let total = 0n;
  for (const segment of scheduleSegments(dim)) {
    const start = BigInt(Math.max(0, Math.floor(segment.start_ms / 1000)));
    const end = BigInt(Math.max(0, Math.floor(segment.end_ms / 1000)));
    const elapsed = at <= start ? 0n : at >= end ? end - start : at - start;
    const amount = segment.basis_seconds > 0n
      ? (segment.allocation * elapsed) / segment.basis_seconds
      : elapsed > 0n ? segment.allocation : 0n;
    total += amount < segment.allocation ? amount : segment.allocation;
  }
  return total;
}

/** Invert the contract's monotone accrual formula to recover its effective stop time. */
function stopForAccrual(dim: StreamDim, target: bigint): number {
  if (target <= 0n) return dim.start_ms;
  if (target >= dim.deposit) return dim.end_ms;
  let low = Math.floor(dim.start_ms / 1000);
  let high = Math.ceil(dim.end_ms / 1000);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (accruedAt(dim, middle * 1000) >= target) high = middle;
    else low = middle + 1;
  }
  return low * 1000;
}

function createStream(context: FoldContext, event: JournalEvent): void {
  const { deltas, bucketMs } = context;
  const streamId = event.stream_id ?? text(event.payload["stream_id"]);
  const sender = text(event.payload["sender"]);
  const recipient = text(event.payload["recipient"]);
  const token = text(event.payload["token"]);
  const deposit = num(event.payload["deposit"]);
  const startTime = num(event.payload["start_time"]);
  const endTime = num(event.payload["end_time"]);
  if (!streamId || !sender || !recipient || !token || deposit === null || startTime === null || endTime === null) {
    deltas.events_unknown += 1;
    return;
  }
  const startMs = Number(startTime) * 1000;
  const endMs = Number(endTime) * 1000;
  const rate = rateOf(deposit, startMs, endMs);
  const at = eventMs(event);
  const dim: StreamDim = {
    stream_id: streamId,
    token,
    sender,
    recipient,
    deposit,
    claimed: 0n,
    start_ms: startMs,
    end_ms: endMs,
    rate_per_second: rate,
    status: "active",
    paused_at_ms: null,
    visible_from_ms: startMs,
    segments: [],
    refund_target: null,
    created_seq: event.seq,
  };
  deltas.dims.set(streamId, dim);
  deltas.dimTouched.add(streamId);
  deltas.dimClosed.delete(streamId);

  const senderRow = addressRow(deltas, sender, "sender", token);
  senderRow.streams_created += 1n;
  senderRow.streams_active += 1n;
  senderRow.funded += deposit;
  senderRow.rate_per_second += rate;
  const recipientRow = addressRow(deltas, recipient, "recipient", token);
  recipientRow.streams_created += 1n;
  recipientRow.streams_active += 1n;
  recipientRow.rate_per_second += rate;

  const asset = assetRow(deltas, token);
  asset.streams_created += 1n;
  asset.streams_active += 1n;
  asset.funded += deposit;
  asset.rate_per_second += rate;

  const bucket = bucketRow(deltas, token, at, bucketMs);
  bucket.funded += deposit;
  bucket.streams_created += 1n;

  // Scheduled execution preserves the start and immediately credits elapsed accrual.
  addSchedule(context, dim, endMs, 1);
  deltas.events_applied += 1;
}

function topUp(context: FoldContext, event: JournalEvent): void {
  const { deltas, bucketMs } = context;
  const dim = event.stream_id ? deltas.dims.get(event.stream_id) : undefined;
  const amount = num(event.payload["amount"]);
  const sender = text(event.payload["sender"]);
  if (!dim || amount === null) {
    deltas.events_unknown += 1;
    return;
  }
  const at = eventMs(event);
  const oldRate = liveRate(dim);
  const untilRealMs = dim.status === "paused"
    ? dim.paused_at_ms ?? dim.start_ms
    : dim.end_ms;
  addSchedule(context, dim, untilRealMs, -1);
  let newRate: bigint;
  if (dim.segments.length === 0) {
    dim.deposit += amount;
    newRate = rateOf(dim.deposit, dim.start_ms, dim.end_ms);
  } else {
    const tail = dim.segments[dim.segments.length - 1]!;
    tail.allocation += amount;
    dim.deposit += amount;
    newRate = segmentRate(tail);
  }
  dim.rate_per_second = newRate;
  addSchedule(context, dim, untilRealMs, 1);
  deltas.dimTouched.add(dim.stream_id);

  const token = dim.token;
  const payer = sender ?? dim.sender;
  addressRow(deltas, payer, "sender", token).funded += amount;

  const rateShift = liveRate(dim) - oldRate;
  addressRow(deltas, dim.sender, "sender", token).rate_per_second += rateShift;
  addressRow(deltas, dim.recipient, "recipient", token).rate_per_second += rateShift;

  const asset = assetRow(deltas, token);
  asset.funded += amount;
  asset.rate_per_second += rateShift;

  const bucket = bucketRow(deltas, token, at, bucketMs);
  bucket.funded += amount;
  deltas.events_applied += 1;
}

function withdrawn(context: FoldContext, event: JournalEvent): void {
  const { deltas, bucketMs } = context;
  const dim = event.stream_id ? deltas.dims.get(event.stream_id) : undefined;
  const amount = num(event.payload["amount"]);
  const recipient = text(event.payload["recipient"]);
  const withdrawnTotal = num(event.payload["withdrawn_total"]) ?? (dim ? dim.claimed + (amount ?? 0n) : null);
  if (!dim || amount === null) {
    deltas.events_unknown += 1;
    return;
  }
  const at = eventMs(event);
  const token = dim.token;
  const who = recipient ?? dim.recipient;
  addressRow(deltas, who, "recipient", token).claimed += amount;
  assetRow(deltas, token).claimed += amount;
  const bucket = bucketRow(deltas, token, at, bucketMs);
  bucket.claimed += amount;
  bucket.withdrawals += 1n;
  dim.claimed += amount;
  deltas.dimTouched.add(dim.stream_id);
  if (withdrawnTotal === dim.deposit) {
    const rate = liveRate(dim);
    addSchedule(context, dim, dim.end_ms, -1);
    dim.status = "depleted";
    addSchedule(context, dim, at, 1);
    deltas.dimClosed.add(dim.stream_id);
    addressRow(deltas, dim.sender, "sender", token).streams_active -= 1n;
    addressRow(deltas, dim.recipient, "recipient", token).streams_active -= 1n;
    addressRow(deltas, dim.sender, "sender", token).rate_per_second -= rate;
    addressRow(deltas, dim.recipient, "recipient", token).rate_per_second -= rate;
    assetRow(deltas, token).streams_active -= 1n;
    assetRow(deltas, token).rate_per_second -= rate;
  }
  deltas.events_applied += 1;
}

function cancelled(context: FoldContext, event: JournalEvent): void {
  const { deltas, bucketMs } = context;
  const dim = event.stream_id ? deltas.dims.get(event.stream_id) : undefined;
  const recipientAmount = num(event.payload["recipient_amount"]);
  const senderAmount = num(event.payload["sender_amount"]);
  if (!dim || recipientAmount === null || senderAmount === null) {
    deltas.events_unknown += 1;
    return;
  }
  const at = eventMs(event);
  const token = dim.token;
  const oldUntilRealMs = dim.status === "paused"
    ? dim.paused_at_ms ?? dim.start_ms
    : dim.end_ms;
  const stopStreamMs = dim.status === "paused"
    ? dim.paused_at_ms ?? dim.start_ms
    : stopForAccrual(dim, dim.deposit - senderAmount);
  const stopRealMs = stopStreamMs;
  // Everything the stream still held leaves escrow here, split two ways: the
  // accrued half settles as income, the remainder refunds. So
  // `funded - claimed - settled - refunded` stays the live escrow exactly.
  const senderRow = addressRow(deltas, dim.sender, "sender", token);
  const refundTo = dim.refund_target ?? dim.sender;
  if (refundTo === dim.sender) senderRow.refunded += senderAmount;
  else addressRow(deltas, refundTo, "refund", token).refunded += senderAmount;
  senderRow.streams_active -= 1n;
  const recipientRow = addressRow(deltas, dim.recipient, "recipient", token);
  recipientRow.settled += recipientAmount;
  recipientRow.streams_active -= 1n;

  const asset = assetRow(deltas, token);
  asset.settled += recipientAmount;
  asset.refunded += senderAmount;
  asset.streams_active -= 1n;

  const bucket = bucketRow(deltas, token, at, bucketMs);
  bucket.settled += recipientAmount;
  bucket.refunded += senderAmount;
  bucket.cancellations += 1n;

  const rate = liveRate(dim);
  addSchedule(context, dim, oldUntilRealMs, -1);
  asset.rate_per_second -= rate;
  senderRow.rate_per_second -= rate;
  recipientRow.rate_per_second -= rate;

  dim.status = "cancelled";
  addSchedule(context, dim, stopRealMs, 1);
  deltas.dimTouched.add(dim.stream_id);
  deltas.dimClosed.add(dim.stream_id);
  deltas.events_applied += 1;
}

function paused(context: FoldContext, event: JournalEvent): void {
  const { deltas } = context;
  const dim = event.stream_id ? deltas.dims.get(event.stream_id) : undefined;
  const pausedAt = num(event.payload["paused_at"]);
  if (!dim || dim.status !== "active" || pausedAt === null) {
    deltas.events_unknown += 1;
    return;
  }
  const pausedMs = Number(pausedAt) * 1000;
  const rate = dim.rate_per_second;
  addSchedule(context, dim, dim.end_ms, -1);
  dim.status = "paused";
  dim.paused_at_ms = pausedMs;
  addSchedule(context, dim, pausedMs, 1);
  deltas.dimTouched.add(dim.stream_id);
  addressRow(deltas, dim.sender, "sender", dim.token).rate_per_second -= rate;
  addressRow(deltas, dim.recipient, "recipient", dim.token).rate_per_second -= rate;
  assetRow(deltas, dim.token).rate_per_second -= rate;
  deltas.events_applied += 1;
}

function resumed(context: FoldContext, event: JournalEvent): void {
  const { deltas } = context;
  const dim = event.stream_id ? deltas.dims.get(event.stream_id) : undefined;
  const newEnd = num(event.payload["new_end_time"]);
  if (!dim || dim.status !== "paused" || newEnd === null) {
    deltas.events_unknown += 1;
    return;
  }
  const pausedMs = dim.paused_at_ms ?? dim.start_ms;
  const oldStart = dim.start_ms;
  const oldEnd = dim.end_ms;
  const newEndMs = Number(newEnd) * 1000;
  const shift = newEndMs - oldEnd;
  for (const segment of dim.segments) {
    segment.start_ms += shift;
    segment.end_ms += shift;
  }
  dim.start_ms += shift;
  dim.end_ms = newEndMs;
  const resumeStreamMs = shift > 0
    ? pausedMs < oldStart ? oldStart + shift : pausedMs + shift
    : pausedMs;
  dim.visible_from_ms = resumeStreamMs;
  dim.status = "active";
  dim.paused_at_ms = null;
  addSchedule(context, dim, dim.end_ms, 1);
  deltas.dimTouched.add(dim.stream_id);
  addressRow(deltas, dim.sender, "sender", dim.token).rate_per_second += dim.rate_per_second;
  addressRow(deltas, dim.recipient, "recipient", dim.token).rate_per_second += dim.rate_per_second;
  assetRow(deltas, dim.token).rate_per_second += dim.rate_per_second;
  deltas.events_applied += 1;
}

function rateChanged(context: FoldContext, event: JournalEvent): void {
  const { deltas, bucketMs } = context;
  const dim = event.stream_id ? deltas.dims.get(event.stream_id) : undefined;
  const newRateInput = num(event.payload["new_amount_per_second"]);
  const deposit = num(event.payload["deposit"]);
  const adjustment = num(event.payload["adjustment"]);
  const effectiveFrom = num(event.payload["effective_from"]);
  const reserved = num(event.payload["reserved_at_new_rate"]);
  if (!dim || newRateInput === null || deposit === null || adjustment === null || effectiveFrom === null || reserved === null) {
    deltas.events_unknown += 1;
    return;
  }
  const at = eventMs(event);
  const from = Number(effectiveFrom) * 1000;
  const token = dim.token;
  const oldLive = liveRate(dim);
  const signed = adjustment >= 0n ? adjustment : -adjustment;
  const senderRow = addressRow(deltas, dim.sender, "sender", token);
  const recipientRow = addressRow(deltas, dim.recipient, "recipient", token);
  const asset = assetRow(deltas, token);
  const bucket = bucketRow(deltas, token, at, bucketMs);
  if (adjustment > 0n) {
    senderRow.funded += signed;
    asset.funded += signed;
    bucket.funded += signed;
  } else if (adjustment < 0n) {
    senderRow.refunded += signed;
    asset.refunded += signed;
    bucket.refunded += signed;
  }

  // The old schedule stops where the change takes effect and the reserved tail
  // starts there. While paused, both are clipped at the freeze point; resume
  // later shifts the stored schedule and restarts it in real event time.
  const untilRealMs = dim.status === "paused"
    ? dim.paused_at_ms ?? dim.start_ms
    : dim.end_ms;
  addSchedule(context, dim, untilRealMs, -1);
  const kept: RateSegment[] = [];
  for (const segment of scheduleSegments(dim)) {
    const endMs = Math.min(segment.end_ms, from);
    if (endMs > segment.start_ms) {
      kept.push({ ...segment, end_ms: endMs });
    }
  }
  kept.push({
    start_ms: from,
    end_ms: dim.end_ms,
    allocation: reserved,
    basis_seconds: BigInt(Math.max(0, dim.end_ms - from)) / 1000n,
  });
  dim.deposit = deposit;
  dim.rate_per_second = newRateInput;
  dim.segments = kept;
  addSchedule(context, dim, untilRealMs, 1);
  deltas.dimTouched.add(dim.stream_id);
  const shift = liveRate(dim) - oldLive;
  senderRow.rate_per_second += shift;
  recipientRow.rate_per_second += shift;
  asset.rate_per_second += shift;
  deltas.events_applied += 1;
}

/** `stream_refund_target_changed`: cancellation refunds follow this address. */
function refundTargetChanged(context: FoldContext, event: JournalEvent): void {
  const dim = event.stream_id ? context.deltas.dims.get(event.stream_id) : undefined;
  const target = text(event.payload["new_target"]);
  if (!dim || !target) {
    context.deltas.events_unknown += 1;
    return;
  }
  dim.refund_target = target;
  context.deltas.dimTouched.add(dim.stream_id);
  context.deltas.events_applied += 1;
}

/** `ownership_accepted`: the role address moves; the stream's accounting does not. */
function ownershipMoved(context: FoldContext, event: JournalEvent): void {
  const { deltas } = context;
  const dim = event.stream_id ? deltas.dims.get(event.stream_id) : undefined;
  const role = roleOf(event.payload["role"]);
  const previous = text(event.payload["previous_owner"]);
  const next = text(event.payload["new_owner"]);
  if (!dim || !previous || !next || (role !== "sender" && role !== "recipient")) {
    deltas.events_unknown += 1;
    return;
  }
  moveAddress(context, dim, role, previous, next);
  if (role === "sender") dim.sender = next;
  else dim.recipient = next;
  deltas.dimTouched.add(dim.stream_id);
  deltas.events_applied += 1;
}

/** `sender_transferred`: who pays moves, by the recipient's consent. */
function senderTransferred(context: FoldContext, event: JournalEvent): void {
  const { deltas } = context;
  const dim = event.stream_id ? deltas.dims.get(event.stream_id) : undefined;
  const from = text(event.payload["sender_from"]);
  const to = text(event.payload["sender_to"]);
  const refundRights = event.payload["refund_rights_transferred"];
  if (!dim || !from || !to || typeof refundRights !== "boolean") {
    deltas.events_unknown += 1;
    return;
  }
  moveAddress(context, dim, "sender", from, to);
  dim.refund_target = refundRights ? to : dim.refund_target ?? from;
  dim.sender = to;
  deltas.dimTouched.add(dim.stream_id);
  deltas.events_applied += 1;
}

/**
 * Carry a stream's *live* attribution from one address to another. Historical
 * cash facts stay where they happened: `funded` belongs to whoever deposited,
 * `claimed`/`settled` to whoever was paid, `streams_created` to the address the
 * contract named. Only the obligation moves — an address that took over a
 * stream yesterday did not pay for it, but it is the one living with it now.
 */
function moveAddress(context: FoldContext, dim: StreamDim, role: Role, from: string, to: string): void {
  const { deltas } = context;
  const outgoing = addressRow(deltas, from, role, dim.token);
  const incoming = addressRow(deltas, to, role, dim.token);
  const rate = liveRate(dim);
  outgoing.streams_active -= 1n;
  incoming.streams_active += 1n;
  outgoing.rate_per_second -= rate;
  incoming.rate_per_second += rate;
}

function countedOnly(context: FoldContext): void {
  context.deltas.events_counted_only += 1;
  // Per-stream events carry the facts; the summary records the batch call only.
}

/**
 * Fold one journal row. An event the views do not cover is not an error: it is
 * a fact analytics does not claim, so it is counted as unknown and skipped.
 */
export function foldEvent(context: FoldContext, event: JournalEvent): void {
  const deltas = context.deltas;
  deltas.last_seq = Math.max(deltas.last_seq, event.seq);
  deltas.last_ledger = Math.max(deltas.last_ledger, event.ledger);
  deltas.last_event_ms = Math.max(deltas.last_event_ms, eventMs(event));

  switch (event.name) {
    case "stream_created":
      createStream(context, event);
      return;
    case "stream_topped_up":
      topUp(context, event);
      return;
    case "withdrawn":
      withdrawn(context, event);
      return;
    case "stream_cancelled":
      cancelled(context, event);
      return;
    case "stream_paused":
      paused(context, event);
      return;
    case "stream_resumed":
      resumed(context, event);
      return;
    case "rate_change_accepted":
      rateChanged(context, event);
      return;
    case "ownership_accepted":
      ownershipMoved(context, event);
      return;
    case "sender_transferred":
      senderTransferred(context, event);
      return;
    case "stream_refund_target_changed":
      refundTargetChanged(context, event);
      return;
    default:
      break;
  }

  if ((COUNTED_ONLY_EVENTS as readonly string[]).includes(event.name)) {
    countedOnly(context);
    return;
  }
  deltas.events_unknown += 1;
}

/** Fold a batch in journal order. */
export function foldEvents(context: FoldContext, events: JournalEvent[]): void {
  for (const event of events) foldEvent(context, event);
}
