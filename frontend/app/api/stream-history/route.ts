export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const streamId = params.get("stream_id") ?? "";
  const after = params.get("after") ?? "0";
  const limit = params.get("limit") ?? "250";
  if (!/^\d+$/.test(streamId)) {
    return Response.json({ error: "stream_id must be an unsigned integer" }, { status: 400 });
  }
  if (!/^\d+$/.test(after) || !/^\d+$/.test(limit)) {
    return Response.json({ error: "after and limit must be unsigned integers" }, { status: 400 });
  }
  const parsedLimit = Number(limit);
  if (parsedLimit < 1 || parsedLimit > 1000) {
    return Response.json({ error: "limit must be between 1 and 1000" }, { status: 400 });
  }

  const indexerUrl = process.env.INDEXER_URL || "http://localhost:8787";
  const upstream = new URL(`/streams/${streamId}/events`, indexerUrl);
  upstream.searchParams.set("after", after);
  upstream.searchParams.set("limit", String(parsedLimit));
  try {
    const response = await fetch(upstream, {
      method: "GET",
      cache: "no-store",
      signal: request.signal,
    });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return Response.json({ error: "Stream history indexer is unavailable" }, { status: 502 });
  }
}
