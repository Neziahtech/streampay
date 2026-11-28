import { streamedAt } from "./oracle.ts";
import type { StreamView } from "./pagination.ts";

export const TAX_LOT_SCHEMA_VERSION = "1.0.0" as const;
export const TAX_LOT_PAGE_SIZE = 250;
export const RECONCILIATION_EPSILON = 1n;

export type CostBasisMethod = "fifo" | "average";
export type ReconciliationClassification =
  | "reconciled"
  | "rounding_within_epsilon"
  | "value_mismatch";

export interface AssetMeta {
  code: string;
  decimals: number;
}

export interface StreamHistoryEvent {
  seq: number;
  event_id: string;
  name: string;
  ledger: number;
  ledger_closed_at: string;
  tx_hash?: string | null;
  payload: Record<string, unknown>;
}

export interface StreamHistoryPage {
  events: StreamHistoryEvent[];
  next_cursor: number | null;
}

export interface TaxLot {
  schema_version: typeof TAX_LOT_SCHEMA_VERSION;
  lot_id: string;
  withdrawal_event_id: string;
  component_index: number;
  stream_id: string;
  asset: string;
  asset_contract: string;
  amount: string;
  amount_display: string;
  decimals: number;
  accrual_start_time: string;
  accrual_end_time: string;
  accrual_period_seconds: string;
  ledger: number;
  ledger_closed_at: string;
  tx_hash: string | null;
  cost_basis_method: CostBasisMethod;
  cost_basis: string;
  unit_cost_basis: string;
  valuation_currency: string;
}

export interface StreamReconciliation {
  stream_id: string;
  exported_amount: string;
  on_chain_withdrawn: string;
  difference: string;
  tolerance: string;
  classification: ReconciliationClassification;
}

export interface TaxLotOptions {
  method: CostBasisMethod;
  valuationCurrency: string;
  unitCostBasis?: string;
}

export interface TaxLotDependencies {
  streams: AsyncIterable<StreamView>;
  fetchEvents: (
    streamId: string,
    after: number,
    limit: number,
    signal?: AbortSignal
  ) => Promise<StreamHistoryPage>;
  fetchAssetMeta: (token: string) => Promise<AssetMeta>;
  rateSegmentCount: (streamId: string) => Promise<number>;
  signal?: AbortSignal;
}

interface AccrualLot {
  id: number;
  amount: bigint;
  start: bigint;
  end: bigint;
}

interface Creation {
  deposit: bigint;
  startTime: bigint;
  endTime: bigint;
  token: string;
  recipient: string;
}

const MUTATING_EVENTS = new Set([
  "stream_topped_up",
  "stream_paused",
  "stream_resumed",
  "rate_change_accepted",
]);

export class TaxLotExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaxLotExportError";
  }
}

function integer(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new TaxLotExportError(`${label} must be an unsigned decimal string`);
  }
  return BigInt(value);
}

function ledgerSeconds(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TaxLotExportError(`${label} is not a valid ledger timestamp`);
  }
  return BigInt(Math.floor(Date.parse(value) / 1000));
}

function formatUnits(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = absolute / base;
  const fraction = (absolute % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function parseUnitCost(value: string): { units: bigint; scale: number } {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new TaxLotExportError("Unit cost basis must be a non-negative decimal");
  }
  const [whole, fraction = ""] = value.split(".");
  return { units: BigInt(whole + fraction), scale: fraction.length };
}

function costBasis(amount: bigint, decimals: number, unitCost: string): string {
  const { units, scale } = parseUnitCost(unitCost);
  const outputScale = 8n;
  const numerator = amount * units * 10n ** outputScale;
  const denominator = 10n ** BigInt(scale + decimals);
  const rounded = (numerator + denominator / 2n) / denominator;
  return formatUnits(rounded, Number(outputScale));
}

function inverseAccrual(amount: bigint, creation: Creation): bigint {
  const duration = creation.endTime - creation.startTime;
  if (amount <= 0n) return creation.startTime;
  if (amount >= creation.deposit) return creation.endTime;
  const offset = (amount * duration + creation.deposit - 1n) / creation.deposit;
  return creation.startTime + offset;
}

function accruedAt(creation: Creation, timestamp: bigint): bigint {
  const elapsed = timestamp < creation.startTime
    ? 0n
    : timestamp > creation.endTime
      ? creation.endTime - creation.startTime
      : timestamp - creation.startTime;
  return streamedAt(creation.deposit, creation.endTime - creation.startTime, elapsed);
}

function validateCreation(stream: StreamView, payload: Record<string, unknown>): Creation {
  const creation: Creation = {
    deposit: integer(payload.deposit, "stream_created.deposit"),
    startTime: integer(payload.start_time, "stream_created.start_time"),
    endTime: integer(payload.end_time, "stream_created.end_time"),
    token: String(payload.token ?? ""),
    recipient: String(payload.recipient ?? ""),
  };
  if (creation.endTime <= creation.startTime || creation.deposit <= 0n) {
    throw new TaxLotExportError(`Stream #${stream.id} has an invalid creation window`);
  }
  if (
    creation.deposit !== BigInt(stream.deposit) ||
    creation.startTime !== BigInt(stream.startTime) ||
    creation.endTime !== BigInt(stream.endTime) ||
    creation.token !== stream.token ||
    creation.recipient !== stream.recipient
  ) {
    throw new TaxLotExportError(
      `Stream #${stream.id} changed after creation; exact historical replay is unavailable`
    );
  }
  return creation;
}

function payout(
  event: StreamHistoryEvent,
  previousWithdrawn: bigint
): { amount: bigint; total: bigint } {
  const amount = integer(event.payload.amount, `${event.name}.amount`);
  const total = integer(event.payload.withdrawn_total, `${event.name}.withdrawn_total`);
  if (previousWithdrawn + amount !== total) {
    throw new TaxLotExportError(
      `Stream event ${event.event_id} has an inconsistent withdrawn_total`
    );
  }
  return { amount, total };
}

function cancellationPayout(
  event: StreamHistoryEvent,
  previousWithdrawn: bigint
): { amount: bigint; total: bigint } {
  const amount = integer(event.payload.recipient_amount, "stream_cancelled.recipient_amount");
  return { amount, total: previousWithdrawn + amount };
}

function allocateFifo(
  pool: AccrualLot[],
  head: number,
  amount: bigint
): { components: AccrualLot[]; head: number } {
  const components: AccrualLot[] = [];
  let remaining = amount;
  while (remaining > 0n) {
    const lot = pool[head];
    if (!lot) throw new TaxLotExportError("Withdrawal exceeds exactly accrued lots");
    const used = remaining < lot.amount ? remaining : lot.amount;
    components.push({ ...lot, amount: used });
    remaining -= used;
    lot.amount -= used;
    if (lot.amount === 0n) head += 1;
  }
  if (head > 1024 && head * 2 > pool.length) {
    pool.splice(0, head);
    head = 0;
  }
  return { components, head };
}

function allocateAverage(pool: AccrualLot[], amount: bigint): AccrualLot[] {
  const lot = pool[0];
  if (!lot || lot.amount < amount) {
    throw new TaxLotExportError("Withdrawal exceeds exactly accrued lots");
  }
  lot.amount -= amount;
  return [{ ...lot, amount }];
}

async function buildStreamLots(
  stream: StreamView,
  options: TaxLotOptions,
  deps: TaxLotDependencies
): Promise<TaxLot[]> {
  if (stream.useOracle) {
    throw new TaxLotExportError(
      `Stream #${stream.id} uses oracle time; ledger time cannot reproduce its accrual exactly`
    );
  }
  if ((await deps.rateSegmentCount(stream.id)) !== 0) {
    throw new TaxLotExportError(
      `Stream #${stream.id} has a segmented rate schedule; exact historical replay is unavailable`
    );
  }

  const meta = await deps.fetchAssetMeta(stream.token);
  if (!Number.isInteger(meta.decimals) || meta.decimals < 0 || meta.decimals > 38 || !meta.code) {
    throw new TaxLotExportError(`Stream #${stream.id} has invalid asset metadata`);
  }
  const unitCost = options.unitCostBasis ?? "1";
  parseUnitCost(unitCost);

  let creation: Creation | null = null;
  let previousAccrued = 0n;
  let previousWithdrawn = 0n;
  let after = 0;
  let lotSequence = 0;
  let fifoHead = 0;
  const pool: AccrualLot[] = [];
  const rows: TaxLot[] = [];

  for (;;) {
    deps.signal?.throwIfAborted();
    const page = await deps.fetchEvents(stream.id, after, TAX_LOT_PAGE_SIZE, deps.signal);
    if (page.events.length === 0) break;
    const nextCursor = page.next_cursor ?? page.events[page.events.length - 1].seq;
    if (nextCursor <= after) {
      throw new TaxLotExportError(`Stream #${stream.id} returned a non-advancing event cursor`);
    }
    after = nextCursor;

    for (const event of page.events) {
      if (event.name === "stream_created") {
        if (creation) {
          throw new TaxLotExportError(`Stream #${stream.id} has duplicate creation events`);
        }
        creation = validateCreation(stream, event.payload);
        continue;
      }
      if (MUTATING_EVENTS.has(event.name)) {
        throw new TaxLotExportError(
          `Stream #${stream.id} includes ${event.name}; exact historical replay is unavailable`
        );
      }
      if (event.name !== "withdrawn" && event.name !== "stream_cancelled") continue;
      if (!creation) {
        throw new TaxLotExportError(`Stream #${stream.id} history is missing stream_created`);
      }

      const timestamp = ledgerSeconds(event.ledger_closed_at, `${event.name}.ledger_closed_at`);
      const accrued = accruedAt(creation, timestamp);
      if (accrued < previousAccrued) {
        throw new TaxLotExportError(`Stream #${stream.id} event history moves ledger time backwards`);
      }
      if (accrued > previousAccrued) {
        const acquired: AccrualLot = {
          id: ++lotSequence,
          amount: accrued - previousAccrued,
          start: inverseAccrual(previousAccrued, creation),
          end: inverseAccrual(accrued, creation),
        };
        if (options.method === "average" && pool[0]) {
          const pooled = pool[0];
          const total = pooled.amount + acquired.amount;
          pooled.start = (pooled.start * pooled.amount + acquired.start * acquired.amount) / total;
          pooled.end = (pooled.end * pooled.amount + acquired.end * acquired.amount) / total;
          pooled.amount = total;
        } else {
          pool.push(acquired);
        }
      }
      previousAccrued = accrued;

      const withdrawn = event.name === "withdrawn"
        ? payout(event, previousWithdrawn)
        : cancellationPayout(event, previousWithdrawn);
      if (withdrawn.amount === 0n) {
        previousWithdrawn = withdrawn.total;
        continue;
      }
      let components: AccrualLot[];
      if (options.method === "fifo") {
        const allocated = allocateFifo(pool, fifoHead, withdrawn.amount);
        components = allocated.components;
        fifoHead = allocated.head;
      } else {
        components = allocateAverage(pool, withdrawn.amount);
      }

      components.forEach((component, index) => {
        const duration = component.end > component.start
          ? component.end - component.start
          : 0n;
        rows.push({
          schema_version: TAX_LOT_SCHEMA_VERSION,
          lot_id: `${stream.id}:${event.event_id}:${options.method}:${index + 1}`,
          withdrawal_event_id: event.event_id,
          component_index: index + 1,
          stream_id: stream.id,
          asset: meta.code,
          asset_contract: stream.token,
          amount: component.amount.toString(),
          amount_display: formatUnits(component.amount, meta.decimals),
          decimals: meta.decimals,
          accrual_start_time: component.start.toString(),
          accrual_end_time: component.end.toString(),
          accrual_period_seconds: duration.toString(),
          ledger: event.ledger,
          ledger_closed_at: event.ledger_closed_at,
          tx_hash: event.tx_hash ?? null,
          cost_basis_method: options.method,
          cost_basis: costBasis(component.amount, meta.decimals, unitCost),
          unit_cost_basis: unitCost,
          valuation_currency: options.valuationCurrency,
        });
      });
      previousWithdrawn = withdrawn.total;
    }
  }

  if (!creation) {
    throw new TaxLotExportError(`Stream #${stream.id} history is missing stream_created`);
  }
  return rows;
}

export function classifyReconciliation(exported: bigint, onChain: bigint): {
  difference: bigint;
  classification: ReconciliationClassification;
} {
  const absolute = exported > onChain ? exported - onChain : onChain - exported;
  if (absolute === 0n) return { difference: 0n, classification: "reconciled" };
  if (absolute <= RECONCILIATION_EPSILON) {
    return { difference: absolute, classification: "rounding_within_epsilon" };
  }
  return { difference: absolute, classification: "value_mismatch" };
}

export function reconcileStream(
  streamId: string,
  exported: bigint,
  onChain: bigint
): StreamReconciliation {
  const { difference, classification } = classifyReconciliation(exported, onChain);
  return {
    stream_id: streamId,
    exported_amount: exported.toString(),
    on_chain_withdrawn: onChain.toString(),
    difference: difference.toString(),
    tolerance: RECONCILIATION_EPSILON.toString(),
    classification,
  };
}

export async function* exportPortfolio(
  options: TaxLotOptions,
  deps: TaxLotDependencies
): AsyncGenerator<TaxLot> {
  if (!/^[A-Za-z0-9]{1,16}$/.test(options.valuationCurrency)) {
    throw new TaxLotExportError("Valuation currency must be 1-16 letters or digits");
  }
  for await (const stream of deps.streams) {
    deps.signal?.throwIfAborted();
    const rows = await buildStreamLots(stream, options, deps);
    const exported = rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
    const reconciliation = reconcileStream(stream.id, exported, BigInt(stream.withdrawn));
    if (reconciliation.classification === "value_mismatch") {
      throw new TaxLotExportError(
        `Stream #${stream.id} reconciliation blocked export: exported ${exported}, on-chain ${stream.withdrawn}`
      );
    }
    yield* rows;
  }
}

const CSV_COLUMNS: Array<keyof TaxLot> = [
  "schema_version",
  "lot_id",
  "withdrawal_event_id",
  "component_index",
  "stream_id",
  "asset",
  "asset_contract",
  "amount",
  "amount_display",
  "decimals",
  "accrual_start_time",
  "accrual_end_time",
  "accrual_period_seconds",
  "ledger",
  "ledger_closed_at",
  "tx_hash",
  "cost_basis_method",
  "cost_basis",
  "unit_cost_basis",
  "valuation_currency",
];

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function* serializeTaxLots(
  lots: AsyncIterable<TaxLot>,
  format: "csv" | "json"
): AsyncGenerator<string> {
  if (format === "csv") {
    yield `${CSV_COLUMNS.join(",")}\n`;
    for await (const lot of lots) {
      yield `${CSV_COLUMNS.map((column) => csvCell(lot[column])).join(",")}\n`;
    }
    return;
  }

  yield "[\n";
  let first = true;
  for await (const lot of lots) {
    yield `${first ? "" : ",\n"}  ${JSON.stringify(lot)}`;
    first = false;
  }
  yield `${first ? "" : "\n"}]\n`;
}
