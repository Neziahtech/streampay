import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  classifyReconciliation,
  exportPortfolio,
  reconcileStream,
  serializeTaxLots,
  TAX_LOT_SCHEMA_VERSION,
  type CostBasisMethod,
  type StreamHistoryEvent,
  type StreamHistoryPage,
  type TaxLot,
} from "./tax-lots.ts";
import { taxLotEvents, taxLotPage, taxLotStream } from "./__fixtures__/tax-lots.ts";
import type { StreamView } from "./pagination.ts";

const options = {
  method: "fifo" as CostBasisMethod,
  valuationCurrency: "USD",
  unitCostBasis: "2",
};

function deps(events: StreamHistoryEvent[] = taxLotEvents, stream: StreamView = taxLotStream) {
  const cursors: number[] = [];
  return {
    cursors,
    value: {
      streams: (async function* () { yield stream; })(),
      fetchEvents: async (streamId: string, after: number, limit: number): Promise<StreamHistoryPage> => {
        assert.equal(streamId, stream.id);
        cursors.push(after);
        return taxLotPage(events, after, limit);
      },
      fetchAssetMeta: async () => ({ code: "TOK", decimals: 7 }),
      rateSegmentCount: async () => 0,
    },
  };
}

async function collect(method: CostBasisMethod = "fifo"): Promise<TaxLot[]> {
  const source = deps();
  const rows: TaxLot[] = [];
  for await (const row of exportPortfolio({ ...options, method }, source.value)) rows.push(row);
  return rows;
}

describe("tax-lot accrual and cost basis", () => {
  it("uses streamed_at and ledger close time for FIFO lots", async () => {
    const rows = await collect();
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.amount), ["150", "100", "250"]);
    assert.deepEqual(rows.map((row) => row.accrual_start_time), ["1000", "1000", "1025"]);
    assert.deepEqual(rows.map((row) => row.accrual_end_time), ["1025", "1025", "1050"]);
    assert.deepEqual(rows.map((row) => row.accrual_period_seconds), ["25", "25", "25"]);
    assert.deepEqual(rows.map((row) => row.ledger_closed_at), [
      "1970-01-01T00:17:05.000Z",
      "1970-01-01T00:17:30.000Z",
      "1970-01-01T00:17:30.000Z",
    ]);
    assert.equal(rows[0].cost_basis, "0.00003");
    assert.equal(rows[0].amount_display, "0.000015");
    assert.equal(rows[0].schema_version, TAX_LOT_SCHEMA_VERSION);
    assert.equal(rows.reduce((sum, row) => sum + BigInt(row.amount), 0n), 500n);
  });

  it("pools accrued lots for average cost without using wall-clock time", async () => {
    const rows = await collect("average");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.amount), ["150", "350"]);
    assert.equal(rows[1].accrual_start_time, "1017");
    assert.equal(rows[1].accrual_end_time, "1042");
    assert.equal(rows[1].accrual_period_seconds, "25");
    assert.equal(rows[1].cost_basis, "0.00007");
    assert.match(rows[1].lot_id, /:average:1$/);
  });

  it("includes cancellation recipient payouts in withdrawn totals", async () => {
    const events: StreamHistoryEvent[] = [
      taxLotEvents[0],
      taxLotEvents[1],
      {
        seq: 3,
        event_id: "00060-1",
        name: "stream_cancelled",
        ledger: 60,
        ledger_closed_at: "1970-01-01T00:18:00.000Z",
        tx_hash: "tx-cancel",
        payload: {
          cancelled_by: "GRECIPIENT",
          recipient_amount: "500",
          sender_amount: "400",
        },
      },
    ];
    const stream = { ...taxLotStream, withdrawn: "650", status: "Cancelled" };
    const source = deps(events, stream);
    const rows: TaxLot[] = [];
    for await (const row of exportPortfolio(options, source.value)) rows.push(row);
    assert.deepEqual(rows.map((row) => row.amount), ["150", "100", "400"]);
    assert.equal(rows.reduce((sum, row) => sum + BigInt(row.amount), 0n), 650n);
  });

  it("matches the #490 one-base-unit tolerance and blocks larger mismatches", async () => {
    assert.deepEqual(classifyReconciliation(500n, 500n), {
      difference: 0n,
      classification: "reconciled",
    });
    assert.equal(reconcileStream("7", 500n, 501n).classification, "rounding_within_epsilon");
    assert.equal(reconcileStream("7", 500n, 502n).classification, "value_mismatch");
    const source = deps(taxLotEvents, { ...taxLotStream, withdrawn: "502" });
    await assert.rejects(async () => {
      for await (const row of exportPortfolio(options, source.value)) assert.ok(row);
    }, /reconciliation blocked export/);
  });

  it("blocks incomplete, oracle, segmented, and mutated histories", async () => {
    const cases: Array<{ events: StreamHistoryEvent[]; stream?: StreamView; segments?: number; pattern: RegExp }> = [
      { events: taxLotEvents.slice(1), pattern: /missing stream_created/ },
      { events: taxLotEvents, stream: { ...taxLotStream, useOracle: true }, pattern: /oracle time/ },
      { events: taxLotEvents, segments: 1, pattern: /segmented rate schedule/ },
      {
        events: [taxLotEvents[0], { ...taxLotEvents[1], name: "stream_topped_up" }],
        pattern: /stream_topped_up/,
      },
    ];
    for (const testCase of cases) {
      const source = deps(testCase.events, testCase.stream ?? taxLotStream);
      source.value.rateSegmentCount = async () => testCase.segments ?? 0;
      await assert.rejects(async () => {
        for await (const row of exportPortfolio(options, source.value)) assert.ok(row);
      }, testCase.pattern);
    }
  });
});

describe("tax-lot pagination and serialization", () => {
  it("follows event cursors without retaining the full history", async () => {
    const events: StreamHistoryEvent[] = [
      taxLotEvents[0],
      ...Array.from({ length: 249 }, (_, index): StreamHistoryEvent => ({
        seq: index + 2,
        event_id: `fee-${index + 2}`,
        name: "fee_charged",
        ledger: index + 11,
        ledger_closed_at: "1970-01-01T00:16:40.000Z",
        payload: {},
      })),
      { ...taxLotEvents[1], seq: 251 },
      { ...taxLotEvents[2], seq: 252 },
    ];
    const source = deps(events);
    const rows: TaxLot[] = [];
    for await (const row of exportPortfolio(options, source.value)) rows.push(row);
    assert.deepEqual(source.cursors, [0, 250, 252]);
    assert.equal(rows.length, 3);
  });

  it("starts yielding a portfolio before later streams are requested", async () => {
    let secondRequested = false;
    const source = deps();
    source.value.streams = (async function* () {
      yield taxLotStream;
      secondRequested = true;
      yield { ...taxLotStream, id: "8", withdrawn: "0" };
    })();
    const iterator = exportPortfolio(options, source.value)[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.done, false);
    assert.equal(secondRequested, false);
    await iterator.return?.();
  });

  it("matches versioned CSV and JSON golden exports", async () => {
    const rows = await collect();
    const csv = await collectText(serializeTaxLots((async function* () { yield* rows; })(), "csv"));
    const json = await collectText(serializeTaxLots((async function* () { yield* rows; })(), "json"));
    assert.equal(
      csv,
      (await readFile(new URL("./__fixtures__/tax-lots.golden.csv", import.meta.url), "utf8"))
        .replace(/\r\n/g, "\n")
    );
    assert.equal(
      json,
      await readFile(new URL("./__fixtures__/tax-lots.golden.json", import.meta.url), "utf8")
    );
  });
});

async function collectText(chunks: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of chunks) text += chunk;
  return text;
}
