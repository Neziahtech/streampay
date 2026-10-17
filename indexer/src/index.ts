import express from "express";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { decodeEvent } from "./decoder.js";
import { StreamStore } from "./store.js";
import type { DecodedEvent, RpcEvent, Stream } from "./types.js";

export function createApp(store: StreamStore): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      status: "ok",
      lastLedger: store.getState("lastLedger") ?? null,
      cursor: store.getState("cursor") ?? null,
    });
  });

  // GET /events/stream (SSE push endpoint)
  app.get("/events/stream", (req, res) => {
    const address = req.query.address as string | undefined;
    const streamId = req.query.streamId as string | undefined;
    const lastEventId = (req.headers["last-event-id"] as string | undefined) ?? (req.query.lastEventId as string | undefined);

    if (address && !/^[GCB][A-Z2-7]{55}$/.test(address)) {
      return res.status(400).json({ error: "invalid Stellar address" });
    }
    if (streamId && !/^\d+$/.test(streamId)) {
      return res.status(400).json({ error: "stream id must be an unsigned integer" });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });

    if (typeof (res as unknown as { flushHeaders?: () => void }).flushHeaders === "function") {
      (res as unknown as { flushHeaders: () => void }).flushHeaders();
    }

    // Initial keepalive greeting
    res.write(": ok\n\n");

    const formatSse = (evt: {
      id: string;
      streamId: string;
      name: string;
      ledger: number;
      ledgerClosedAt: string;
      payload: Record<string, unknown>;
      stream?: unknown;
    }): string => {
      const data = JSON.stringify({
        id: evt.id,
        streamId: evt.streamId,
        eventType: evt.name,
        ledger: evt.ledger,
        ledgerClosedAt: evt.ledgerClosedAt,
        data: evt.payload,
        stream: evt.stream,
      });
      return `id: ${evt.id}\nevent: ${evt.name}\ndata: ${data}\n\n`;
    };

    // Replay historical events if lastEventId was supplied
    if (lastEventId) {
      const historical = store.getEventsAfter(lastEventId, address, streamId);
      for (const evt of historical) {
        res.write(formatSse(evt));
      }
    }

    // Subscribe to live events
    const onLiveEvent = (event: DecodedEvent, stream?: Stream) => {
      if (streamId && event.streamId !== streamId) {
        return;
      }
      if (address && stream && stream.sender !== address && stream.recipient !== address) {
        return;
      }
      res.write(
        formatSse({
          id: event.id,
          streamId: event.streamId,
          name: event.name,
          ledger: event.ledger,
          ledgerClosedAt: event.ledgerClosedAt,
          payload: event.data as Record<string, unknown>,
          stream,
        })
      );
    };

    store.on("event", onLiveEvent);

    // Heartbeat ping every 15 seconds to prevent reverse proxy/load-balancer timeouts
    const pingInterval = setInterval(() => {
      res.write(": ping\n\n");
    }, 15000);

    req.on("close", () => {
      clearInterval(pingInterval);
      store.off("event", onLiveEvent);
      res.end();
    });
  });

  // GET /streams?recipient=<address>
  app.get("/streams", (req, res) => {
    const recipient = req.query.recipient as string | undefined;
    if (!recipient) {
      return res.json([]);
    }
    const streams = store.listStreamsByRecipient(recipient);
    return res.json(streams);
  });

  // GET /streams/:id/history
  app.get("/streams/:id/history", (req, res) => {
    const streamId = req.params.id;
    if (!streamId) {
      return res.json([]);
    }
    const history = store.getStreamHistory(streamId);
    return res.json(history);
  });

  // GET /streams/:id
  app.get("/streams/:id", (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "stream id must be an unsigned integer" });
    const stream = store.getStream(req.params.id);
    return stream ? res.json(stream) : res.status(404).json({ error: "stream not found" });
  });

  // GET /address/:addr/streams
  app.get("/address/:addr/streams", (req, res) => {
    const address = req.params.addr;
    if (!/^[GCB][A-Z2-7]{55}$/.test(address)) return res.status(400).json({ error: "invalid Stellar address" });
    const streams = store.listAddress(address);
    return res.json({ address, count: streams.length, streams });
  });

  return app;
}

export async function run(): Promise<void> {
  const rpcUrl = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
  const contractId = process.env.CONTRACT_ID;
  const pollInterval = Number(process.env.POLL_INTERVAL_MS ?? 5000);
  const port = Number(process.env.PORT ?? 8787);
  const dbPath = process.env.DATABASE_PATH ?? "./data/streampay.sqlite";

  if (!contractId) throw new Error("CONTRACT_ID is required");
  if (!Number.isFinite(pollInterval) || pollInterval < 250) throw new Error("POLL_INTERVAL_MS must be at least 250");

  const store = new StreamStore(dbPath);
  const app = createApp(store);

  const eventNames = ["stream_created", "withdrawn", "stream_cancelled", "stream_topped_up", "stream_paused", "stream_resumed"];
  const topicFilters = eventNames.map((name) => [nativeToScVal(name, { type: "symbol" }).toXDR("base64")]);
  let rpcId = 0;

  async function rpc<T>(method: string, params: unknown): Promise<T> {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}: ${await response.text()}`);
    const body = (await response.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
    if (!body.result) throw new Error(`RPC ${method} returned no result`);
    return body.result;
  }

  interface EventsResult {
    events: RpcEvent[];
    cursor: string;
    latestLedger: number;
  }

  async function poll(): Promise<void> {
    let cursor = store.getState("cursor");
    let startLedger: number | undefined;
    if (!cursor) {
      const configured = process.env.START_LEDGER;
      if (configured && !/^\d+$/.test(configured)) throw new Error("START_LEDGER must be an integer ledger sequence");
      startLedger = configured ? Number(configured) : (await rpc<{ sequence: number }>("getLatestLedger", {})).sequence;
    }
    for (;;) {
      const params = {
        ...(cursor ? { cursor } : { startLedger }),
        filters: [{ type: "contract", contractIds: [contractId], topics: topicFilters }],
        pagination: { limit: 1000 },
        xdrFormat: "base64",
      };
      const page = await rpc<EventsResult>("getEvents", params);
      const nextCursor = page.cursor || cursor;
      store.ingestPage(page.events.map(decodeEvent), nextCursor, page.latestLedger);
      cursor = nextCursor;
      if (page.events.length < 1000 || !cursor) break;
    }
  }

  app.listen(port, () => console.log(`StreamPay indexer listening on http://localhost:${port}`));
  let polling = false;

  async function pollSafely(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      await poll();
    } catch (error) {
      console.error("Indexer poll failed:", error);
    } finally {
      polling = false;
    }
  }

  void pollSafely();
  setInterval(() => void pollSafely(), pollInterval);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      store.close();
      process.exit(0);
    });
  }
}

// Auto-run if executed directly as entrypoint
if (process.argv[1] && (process.argv[1].endsWith("index.js") || process.argv[1].endsWith("index.ts"))) {
  void run();
}
