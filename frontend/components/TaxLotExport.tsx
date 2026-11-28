"use client";

import { useEffect, useRef, useState } from "react";
import { fetchAssetMeta, iterateRecipientStreams, readRateSegmentCount } from "@/lib/stellar";
import { fetchStreamEventsPage } from "@/lib/tax-lot-source";
import {
  exportPortfolio,
  type CostBasisMethod,
  type TaxLot,
} from "@/lib/tax-lots";
import { downloadTaxLotExport } from "@/lib/tax-lot-download";

export default function TaxLotExport({ address }: { address: string }) {
  const [method, setMethod] = useState<CostBasisMethod>("fifo");
  const [format, setFormat] = useState<"csv" | "json">("csv");
  const [currency, setCurrency] = useState("USD");
  const [unitCost, setUnitCost] = useState("1");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [lotCount, setLotCount] = useState(0);
  const active = useRef<AbortController | null>(null);

  useEffect(() => () => active.current?.abort(), []);

  async function startExport() {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    setStatus("Reading exact stream histories…");
    setLotCount(0);
    try {
      const lots = exportPortfolio(
        {
          method,
          valuationCurrency: currency.trim().toUpperCase(),
          unitCostBasis: unitCost.trim(),
        },
        {
          streams: iterateRecipientStreams(address, controller.signal),
          fetchEvents: fetchStreamEventsPage,
          fetchAssetMeta,
          rateSegmentCount: readRateSegmentCount,
          signal: controller.signal,
        }
      );
      async function* trackedLots(): AsyncGenerator<TaxLot> {
        for await (const lot of lots) {
          setLotCount((count) => count + 1);
          yield lot;
        }
      }
      const result = await downloadTaxLotExport(
        trackedLots(),
        format,
        `streampay-tax-lots-${address.slice(0, 8)}-${method}.${format}`,
        controller.signal
      );
      setStatus(
        `Export ready: ${result.bytes.toLocaleString()} bytes${result.streamed ? " streamed to disk" : " downloaded"}.`
      );
    } catch (cause) {
      if (controller.signal.aborted) {
        setStatus("Export cancelled.");
      } else {
        setError(cause instanceof Error ? cause.message : "Tax-lot export failed.");
        setStatus("Export blocked; no reconciled file was completed.");
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <section className="card" aria-labelledby="tax-lot-export-title">
      <h2 id="tax-lot-export-title">Portfolio tax-lot export</h2>
      <p className="muted">
        Build CSV or JSON locally from immutable linear streams. Oracle-time,
        topped-up, paused, resumed, segmented, incomplete, or mismatched histories
        are blocked rather than approximated.
      </p>
      <div className="row" style={{ flexWrap: "wrap", alignItems: "end" }}>
        <label>
          Cost-basis method
          <select
            value={method}
            onChange={(event) => setMethod(event.target.value as CostBasisMethod)}
            disabled={busy}
          >
            <option value="fifo">FIFO</option>
            <option value="average">Average cost</option>
          </select>
        </label>
        <label>
          Format
          <select
            value={format}
            onChange={(event) => setFormat(event.target.value as "csv" | "json")}
            disabled={busy}
          >
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
          </select>
        </label>
        <label>
          Valuation currency
          <input
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
            maxLength={16}
            disabled={busy}
            aria-label="Valuation currency"
          />
        </label>
        <label>
          Unit cost basis
          <input
            value={unitCost}
            onChange={(event) => setUnitCost(event.target.value)}
            inputMode="decimal"
            disabled={busy}
            aria-label="Unit cost basis per whole token"
          />
        </label>
        {busy ? (
          <button type="button" onClick={() => active.current?.abort()}>
            Cancel
          </button>
        ) : (
          <button type="button" onClick={() => void startExport()}>
            Export tax lots
          </button>
        )}
      </div>
      <p className="muted">
        Unit cost is a user-supplied valuation per whole token; on-chain data does
        not contain fiat prices. Exports are never uploaded and include the
        connected wallet, stream ids, asset contracts, ledger timestamps, and
        transaction hashes.
      </p>
      {busy && <p role="status">Processed {lotCount} tax-lot components…</p>}
      {status && !busy && <p role="status">{status}</p>}
      {error && <p className="err" role="alert">{error}</p>}
    </section>
  );
}
