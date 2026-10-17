import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { StreamStore } from "./store.js";
import {
  globalIndexerTracer,
  InMemorySpanExporter,
} from "./telemetry.js";
import type { DecodedEvent } from "./types.js";
import { sanitizeAddress, sanitizeWebhookUrl } from "./privacy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Indexer Telemetry & Span Link Seam Verification", () => {
  it("ingests event and attaches SpanLink pointing to originating claim trace", () => {
    const memoryExporter = new InMemorySpanExporter();
    globalIndexerTracer.addExporter(memoryExporter);

    const testDbPath = path.resolve(__dirname, `test-indexer-otel-${Date.now()}.sqlite`);
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    try {
      const store = new StreamStore(testDbPath);

      const originatingTraceId = "e10adc3949ba59abbe56e057f20f883e";
      const originatingSpanId = "20f883e56e057f20";

      const event: DecodedEvent = {
        id: "evt_claim_001",
        pagingToken: "10502-0",
        ledger: 10502,
        ledgerClosedAt: new Date().toISOString(),
        contractId: "CDUMMYCONTRACT123",
        name: "withdrawn",
        streamId: "99",
        data: {
          withdrawn_total: "5000000",
          amount: "1000000",
          recipient: "GDJ6TEST1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12",
        },
        txHash: "0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678",
        linkedSpanContext: {
          traceId: originatingTraceId,
          spanId: originatingSpanId,
          traceFlags: 1,
        },
      };

      store.ingest(event);

      const spans = memoryExporter.getFinishedSpans();
      const ingestSpan = spans.find((s) => s.name === "indexer.ingest_event");
      const dbSpan = spans.find((s) => s.name === "indexer.db_write");

      assert.ok(ingestSpan, "indexer.ingest_event span must be generated");
      assert.ok(dbSpan, "indexer.db_write span must be generated");

      // Verify SpanLink (asynchronous event seam)
      assert.equal(ingestSpan.links.length, 1, "Must contain 1 SpanLink");
      assert.equal(ingestSpan.links[0].context.traceId, originatingTraceId);
      assert.equal(ingestSpan.links[0].context.spanId, originatingSpanId);
      assert.equal(ingestSpan.links[0].attributes?.["link.relationship"], "ledger_event_continuation");
      assert.equal(ingestSpan.links[0].attributes?.["ledger.sequence"], 10502);

      // Verify parent-child relationship: db_write is child of ingest_event
      assert.equal(dbSpan.parentSpanId, ingestSpan.context.spanId);

      store.close();
    } finally {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    }
  });

  it("strictly enforces privacy line on indexer attributes", () => {
    const raw = "GBMOCK1234567890123456789012345678901234567890123456789012";
    const sanitized = sanitizeAddress(raw);
    assert.equal(sanitized, "GBMOCK12...");
    assert.ok(sanitized.length <= 11);

    const webhook = "https://receiver.internal/hook?token=supersecret";
    assert.equal(sanitizeWebhookUrl(webhook), "https://receiver.internal/***");
  });
});
