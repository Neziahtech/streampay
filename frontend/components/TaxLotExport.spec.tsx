// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaxLotExport from "./TaxLotExport";

const mocks = vi.hoisted(() => ({
  exportPortfolio: vi.fn(),
  download: vi.fn(),
  iterate: vi.fn(),
  events: vi.fn(),
  meta: vi.fn(),
  segments: vi.fn(),
}));

vi.mock("@/lib/stellar", () => ({
  iterateRecipientStreams: mocks.iterate,
  fetchAssetMeta: mocks.meta,
  readRateSegmentCount: mocks.segments,
}));
vi.mock("@/lib/tax-lot-source", () => ({ fetchStreamEventsPage: mocks.events }));
vi.mock("@/lib/tax-lots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tax-lots")>();
  return { ...actual, exportPortfolio: mocks.exportPortfolio };
});
vi.mock("@/lib/tax-lot-download", () => ({ downloadTaxLotExport: mocks.download }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.iterate.mockReturnValue((async function* () {})());
  mocks.exportPortfolio.mockReturnValue((async function* () {})());
  mocks.download.mockResolvedValue({ bytes: 42, streamed: true });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function render() {
  await act(async () => root.render(<TaxLotExport address="GRECIPIENT" />));
}

async function click(selector: string) {
  const element = container.querySelector<HTMLElement>(selector);
  expect(element).not.toBeNull();
  await act(async () => element!.click());
}

describe("TaxLotExport", () => {
  it("exports the selected method and format through the local-only path", async () => {
    await render();
    const method = container.querySelector<HTMLSelectElement>("select")!;
    const format = container.querySelectorAll<HTMLSelectElement>("select")[1];
    await act(async () => {
      method.value = "average";
      method.dispatchEvent(new Event("change", { bubbles: true }));
      format.value = "json";
      format.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("button");

    expect(mocks.exportPortfolio).toHaveBeenCalledWith(
      expect.objectContaining({ method: "average", valuationCurrency: "USD", unitCostBasis: "1" }),
      expect.objectContaining({ fetchEvents: mocks.events, fetchAssetMeta: mocks.meta })
    );
    expect(mocks.download).toHaveBeenCalledWith(
      expect.anything(),
      "json",
      "streampay-tax-lots-GRECIPIE-average.json",
      expect.any(AbortSignal)
    );
    expect(container.textContent).toContain("Export ready: 42 bytes streamed to disk");
    expect(container.textContent).toContain("Exports are never uploaded");
  });

  it("surfaces reconciliation failures instead of reporting success", async () => {
    mocks.download.mockImplementation(async (lots: AsyncIterable<unknown>) => {
      for await (const lot of lots) expect(lot).toBeDefined();
    });
    mocks.exportPortfolio.mockReturnValue((async function* () {
      throw new Error("Stream #7 reconciliation blocked export");
    })());
    await render();
    await click("button");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "reconciliation blocked export"
    );
    expect(container.textContent).toContain("no reconciled file was completed");
  });
});
