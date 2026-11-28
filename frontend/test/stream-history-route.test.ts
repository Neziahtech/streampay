import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";

describe("stream history proxy", () => {
  it("forwards validated pagination and preserves the indexer payload", async () => {
    let requested = "";
    const upstream = http.createServer((request, response) => {
      requested = request.url ?? "";
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ events: [], next_cursor: null }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const { port } = upstream.address() as { port: number };
    const previous = process.env.INDEXER_URL;
    process.env.INDEXER_URL = `http://127.0.0.1:${port}`;
    try {
      const { GET } = await import("../app/api/stream-history/route.ts?test=1");
      const response = await GET(new Request("http://localhost/api/stream-history?stream_id=7&after=4&limit=25"));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { events: [], next_cursor: null });
      assert.equal(requested, "/streams/7/events?after=4&limit=25");
      const invalid = await GET(new Request("http://localhost/api/stream-history?stream_id=bad"));
      assert.equal(invalid.status, 400);
    } finally {
      process.env.INDEXER_URL = previous;
      await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  });
});
