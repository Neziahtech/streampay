import type { StreamHistoryPage } from "./tax-lots.ts";

export async function fetchStreamEventsPage(
  streamId: string,
  after: number,
  limit: number,
  signal?: AbortSignal
): Promise<StreamHistoryPage> {
  const query = new URLSearchParams({
    stream_id: streamId,
    after: String(after),
    limit: String(limit),
  });
  const response = await fetch(`/api/stream-history?${query}`, {
    method: "GET",
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Stream history read failed (${response.status})`);
  }
  return response.json() as Promise<StreamHistoryPage>;
}
