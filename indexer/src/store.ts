import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DecodedEvent, Stream } from "./types.js";
import { WebhookStore } from "./webhooks/store.js";
import { OutboxStore, newOutboxEventFromDecoded } from "./outbox/store.js";
import { globalIndexerTracer, traceCorrelationRegistry } from "./telemetry.js";

export class StreamStore {
  readonly db: Database.Database;
  readonly webhooks: WebhookStore;
  readonly outbox: OutboxStore;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS streams (
        stream_id TEXT PRIMARY KEY, sender TEXT, recipient TEXT, token TEXT,
        deposit TEXT, withdrawn TEXT NOT NULL DEFAULT '0', start_time TEXT,
        end_time TEXT, cancelable INTEGER, status TEXT NOT NULL DEFAULT 'active',
        cancelled_by TEXT, recipient_amount TEXT, sender_amount TEXT,
        last_ledger INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS streams_sender ON streams(sender, stream_id);
      CREATE INDEX IF NOT EXISTS streams_recipient ON streams(recipient, stream_id);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, name TEXT NOT NULL,
        ledger INTEGER NOT NULL, ledger_closed_at TEXT NOT NULL,
        tx_hash TEXT, trace_id TEXT, span_id TEXT, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_stream ON events(stream_id, ledger);
      CREATE TABLE IF NOT EXISTS indexer_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    try {
      this.db.exec("ALTER TABLE events ADD COLUMN tx_hash TEXT;");
    } catch {}
    try {
      this.db.exec("ALTER TABLE events ADD COLUMN trace_id TEXT;");
    } catch {}
    try {
      this.db.exec("ALTER TABLE events ADD COLUMN span_id TEXT;");
    } catch {}
    this.webhooks = new WebhookStore(this.db);
    this.outbox = new OutboxStore(this.db);
  }

  close(): void { this.db.close(); }
  getState(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM indexer_state WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }
  setState(key: string, value: string): void {
    this.db.prepare("INSERT INTO indexer_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  ingest(event: DecodedEvent): void {
    this.db.transaction(() => this.ingestWithinTransaction(event, event.pagingToken))();
  }

  ingestPage(events: DecodedEvent[], cursor: string | undefined, latestLedger: number): void {
    this.db.transaction(() => {
      for (const event of events) this.ingestWithinTransaction(event, cursor ?? event.pagingToken);
      if (cursor) this.setState("cursor", cursor);
      this.setState("lastLedger", String(latestLedger));
    })();
  }

  private ingestWithinTransaction(event: DecodedEvent, ledgerCursor: string): void {
    const ingestSpan = globalIndexerTracer.startSpan("indexer.ingest_event", {
      kind: "CONSUMER",
      attributes: {
        "event.name": event.name,
        "ledger.sequence": event.ledger,
        "stream.id": event.streamId,
        "soroban.tx_hash": event.txHash || "unknown",
      },
    });

    // Check correlation registry for the asynchronous event seam (linking originating claim trace)
    const linkedContext =
      event.linkedSpanContext ||
      (event.txHash ? traceCorrelationRegistry.get(event.txHash) : null) ||
      traceCorrelationRegistry.getByStream(event.streamId);

    if (linkedContext) {
      ingestSpan.addLink({
        context: linkedContext,
        attributes: {
          "link.relationship": "ledger_event_continuation",
          "event.name": event.name,
          "ledger.sequence": event.ledger,
          "soroban.tx_hash": event.txHash || "unknown",
        },
      });
    }

    event.traceId = ingestSpan.context.traceId;
    event.spanId = ingestSpan.context.spanId;

    try {
      const dbSpan = globalIndexerTracer.startSpan("indexer.db_write", {
        parent: ingestSpan,
        kind: "INTERNAL",
        attributes: {
          "db.system": "sqlite",
          "stream.id": event.streamId,
          "event.name": event.name,
        },
      });

      const inserted = this.db.prepare(`INSERT OR IGNORE INTO events
        (id, stream_id, name, ledger, ledger_closed_at, tx_hash, trace_id, span_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          event.id,
          event.streamId,
          event.name,
          event.ledger,
          event.ledgerClosedAt,
          event.txHash ?? null,
          event.traceId ?? null,
          event.spanId ?? null,
          JSON.stringify(event.data, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)
        );

      if (inserted.changes === 0) {
        dbSpan.end();
        ingestSpan.setStatus("OK");
        ingestSpan.end();
        return;
      }

      // Transactional outbox: the delivery-intent journal is committed in the
      // same transaction as the event row, so intents can never be lost.
      // Deliberately NOT wrapped in try/catch — any failure must roll back the
      // whole ingestion transaction.
      this.outbox.enqueueWithinTransaction(newOutboxEventFromDecoded(event, ledgerCursor));

      // Queue webhook deliveries for subscribers
      try {
        this.webhooks.queueDeliveriesForEvent({
          id: event.id,
          name: event.name,
          streamId: event.streamId,
          ledgerClosedAt: event.ledgerClosedAt,
          data: event.data as Record<string, unknown>,
        });
      } catch (err) {
        console.error("Failed to queue webhook delivery for event:", err);
      }

      const d = event.data;
      const existing = this.db.prepare("SELECT * FROM streams WHERE stream_id = ?").get(event.streamId) as Record<string, unknown> | undefined;
      const get = (key: string): string | null => d[key] === undefined || d[key] === null ? null : String(d[key]);
      const patch: Partial<Stream & { cancelled_by?: string | null; recipient_amount?: string | null; sender_amount?: string | null }> = {
        lastLedger: event.ledger,
        updatedAt: event.ledgerClosedAt,
      };

      switch (event.name) {
        case "stream_created":
          Object.assign(patch, {
            sender: get("sender"),
            recipient: get("recipient"),
            token: get("token"),
            deposit: get("deposit"),
            startTime: get("start_time"),
            endTime: get("end_time"),
            cancelable: Boolean(d.cancelable),
            status: "active",
            withdrawn: "0",
          });
          break;
        case "withdrawn":
          patch.withdrawn = get("withdrawn_total") ?? (existing?.withdrawn as string | undefined) ?? "0";
          break;
        case "stream_topped_up":
          patch.deposit = get("new_deposit") ?? (existing?.deposit as string | undefined) ?? null;
          break;
        case "stream_cancelled": {
          patch.status = "cancelled";
          patch.cancelled_by = get("cancelled_by") ?? (existing?.cancelled_by as string | undefined) ?? null;
          patch.recipient_amount = get("recipient_amount") ?? (existing?.recipient_amount as string | undefined) ?? null;
          patch.sender_amount = get("sender_amount") ?? (existing?.sender_amount as string | undefined) ?? null;
          if (patch.recipient_amount) {
            const prevWithdrawn = BigInt((existing?.withdrawn as string) ?? "0");
            patch.withdrawn = (prevWithdrawn + BigInt(patch.recipient_amount)).toString();
          }
          break;
        }
        case "stream_paused": patch.status = "paused"; break;
        case "stream_resumed": patch.status = "active"; break;
        default: return;
      }

      const current = existing ?? {};
      const row = {
        stream_id: event.streamId,
        sender: patch.sender ?? current.sender ?? null,
        recipient: patch.recipient ?? current.recipient ?? null,
        token: patch.token ?? current.token ?? null,
        deposit: patch.deposit ?? current.deposit ?? null,
        withdrawn: patch.withdrawn ?? current.withdrawn ?? "0",
        start_time: patch.startTime ?? current.start_time ?? null,
        end_time: patch.endTime ?? current.end_time ?? null,
        cancelable: patch.cancelable === undefined ? current.cancelable ?? null : Number(patch.cancelable),
        status: patch.status ?? current.status ?? "active",
        cancelled_by: patch.cancelled_by ?? current.cancelled_by ?? null,
        recipient_amount: patch.recipient_amount ?? current.recipient_amount ?? null,
        sender_amount: patch.sender_amount ?? current.sender_amount ?? null,
        last_ledger: event.ledger,
        updated_at: event.ledgerClosedAt,
      };

      this.db.prepare(`INSERT INTO streams(stream_id,sender,recipient,token,deposit,withdrawn,start_time,end_time,cancelable,status,cancelled_by,recipient_amount,sender_amount,last_ledger,updated_at)
        VALUES(@stream_id,@sender,@recipient,@token,@deposit,@withdrawn,@start_time,@end_time,@cancelable,@status,@cancelled_by,@recipient_amount,@sender_amount,@last_ledger,@updated_at)
        ON CONFLICT(stream_id) DO UPDATE SET sender=excluded.sender, recipient=excluded.recipient, token=excluded.token,
        deposit=excluded.deposit, withdrawn=excluded.withdrawn, start_time=excluded.start_time, end_time=excluded.end_time,
        cancelable=excluded.cancelable, status=excluded.status, cancelled_by=excluded.cancelled_by,
        recipient_amount=excluded.recipient_amount, sender_amount=excluded.sender_amount,
        last_ledger=excluded.last_ledger, updated_at=excluded.updated_at`).run(row);

      dbSpan.setStatus("OK");
      dbSpan.end();
      ingestSpan.setStatus("OK");
    } catch (err) {
      ingestSpan.recordException(err);
      ingestSpan.setStatus("ERROR", String(err));
      throw err;
    } finally {
      ingestSpan.end();
    }
  }

  getStream(id: string): Stream | undefined {
    const row = this.db.prepare("SELECT * FROM streams WHERE stream_id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.toStream(row) : undefined;
  }

  listAddress(address: string): Stream[] {
    return (this.db.prepare("SELECT * FROM streams WHERE sender = ? OR recipient = ? ORDER BY CAST(stream_id AS INTEGER) DESC").all(address, address) as Record<string, unknown>[]).map((row) => this.toStream(row));
  }

  listStreamsByRecipient(recipient: string): Stream[] {
    return (this.db.prepare("SELECT * FROM streams WHERE recipient = ? ORDER BY CAST(stream_id AS INTEGER) ASC").all(recipient) as Record<string, unknown>[]).map((row) => this.toStream(row));
  }

  getStreamHistory(streamId: string): Array<{ id: string; stream_id: string; event_type: string; ledger: number; ledger_closed_at: string; tx_hash?: string | null; trace_id?: string | null; span_id?: string | null; payload: unknown }> {
    return (this.db.prepare("SELECT id, stream_id, name as event_type, ledger, ledger_closed_at, tx_hash, trace_id, span_id, payload FROM events WHERE stream_id = ? ORDER BY ledger ASC, id ASC").all(streamId) as Array<{ id: string; stream_id: string; event_type: string; ledger: number; ledger_closed_at: string; tx_hash: string | null; trace_id: string | null; span_id: string | null; payload: string }>).map((row) => {
      let parsed = row.payload;
      try { parsed = JSON.parse(row.payload); } catch {}
      return { ...row, payload: parsed };
    });
  }

  private toStream(row: Record<string, unknown>): Stream {
    return {
      id: String(row.stream_id),
      streamId: String(row.stream_id),
      sender: row.sender as string | null,
      recipient: row.recipient as string | null,
      token: row.token as string | null,
      deposit: row.deposit as string | null,
      withdrawn: String(row.withdrawn),
      startTime: row.start_time as string | null,
      endTime: row.end_time as string | null,
      cancelable: row.cancelable === null ? null : Boolean(row.cancelable),
      status: String(row.status),
      cancelled_by: (row.cancelled_by as string | null) ?? undefined,
      recipient_amount: (row.recipient_amount as string | null) ?? undefined,
      sender_amount: (row.sender_amount as string | null) ?? undefined,
      lastLedger: Number(row.last_ledger),
      updatedAt: String(row.updated_at),
    };
  }
}
