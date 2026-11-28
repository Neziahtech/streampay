import { serializeTaxLots, type TaxLot } from "./tax-lots.ts";

const FALLBACK_MAX_BYTES = 8 * 1024 * 1024;

interface FileWritable {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

interface SaveFilePicker {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<{ createWritable(): Promise<FileWritable> }>;
}

export interface DownloadResult {
  bytes: number;
  streamed: boolean;
}

export async function downloadTaxLotExport(
  lots: AsyncIterable<TaxLot>,
  format: "csv" | "json",
  filename: string,
  signal?: AbortSignal
): Promise<DownloadResult> {
  const picker = (window as unknown as SaveFilePicker).showSaveFilePicker;
  if (picker) {
    const handle = await picker.call(window, {
      suggestedName: filename,
      types: [{
        description: format === "csv" ? "CSV tax lots" : "JSON tax lots",
        accept: { [format === "csv" ? "text/csv" : "application/json"]: [`.${format}`] },
      }],
    });
    const writable = await handle.createWritable();
    let bytes = 0;
    try {
      for await (const chunk of serializeTaxLots(lots, format)) {
        signal?.throwIfAborted();
        await writable.write(chunk);
        bytes += new TextEncoder().encode(chunk).byteLength;
      }
      await writable.close();
    } catch (error) {
      await writable.close().catch(() => undefined);
      throw error;
    }
    return { bytes, streamed: true };
  }

  const chunks: string[] = [];
  const encoder = new TextEncoder();
  let bytes = 0;
  for await (const chunk of serializeTaxLots(lots, format)) {
    signal?.throwIfAborted();
    bytes += encoder.encode(chunk).byteLength;
    if (bytes > FALLBACK_MAX_BYTES) {
      throw new Error(
        "This browser cannot stream large files. Use a File System Access browser or narrow the export."
      );
    }
    chunks.push(chunk);
  }
  const blob = new Blob(chunks, {
    type: format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return { bytes, streamed: false };
}
