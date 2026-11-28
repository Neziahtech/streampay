import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import type {
  WebhookEndpoint,
  WebhookDelivery,
  WebhookDeadLetterItem,
  WebhookAttemptRecord,
} from "./types.js";
import { calculateNextRetryDelay, isTerminalAttempt } from "./retry.js";
import { SecretCipher, secretContext } from "./secrets.js";

function nullableId(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** How long a rotated-out secret keeps verifying, unless overridden. */
export const DEFAULT_ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;

/** A secret rotation, recorded by fingerprint so history leaks nothing. */
export interface SecretRotationRecord {
  id: string;
  endpoint_id: string;
  tenant_id: string;
  fingerprint: string;
  previous_fingerprint: string | null;
  rotated_at: number;
  expires_at: number;
}

export interface WebhookStoreOptions {
  /** When present, signing secrets are stored as sealed envelopes. */
  cipher?: SecretCipher | null;
  /** Injectable clock; time-dependent APIs also take an explicit `nowMs`. */
  now?: () => number;
}

export class WebhookStore {
  private readonly cipher: SecretCipher | null;
  private readonly now: () => number;

  constructor(private readonly db: Database.Database, options: WebhookStoreOptions = {}) {
    this.cipher = options.cipher ?? null;
    this.now = options.now ?? Date.now;
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_endpoints (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        previous_secret TEXT,
        events TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        endpoint_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        stream_id TEXT,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending',
        status_code INTEGER,
        error TEXT,
        next_retry_at INTEGER NOT NULL,
        history TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_pending ON webhook_deliveries(status, next_retry_at);

      CREATE TABLE IF NOT EXISTS webhook_dead_letter (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL,
        endpoint_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        stream_id TEXT,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        attempts_count INTEGER NOT NULL,
        last_error TEXT NOT NULL,
        last_status_code INTEGER,
        created_at TEXT NOT NULL,
        replayed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_dlq_endpoint ON webhook_dead_letter(endpoint_id);

      CREATE TABLE IF NOT EXISTS webhook_secret_rotations (
        id TEXT PRIMARY KEY,
        endpoint_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        previous_fingerprint TEXT,
        rotated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rotations_endpoint ON webhook_secret_rotations(endpoint_id, rotated_at);
    `);

    // Forward-only, idempotent adds, the same way StreamStore migrates its own
    // columns: an existing deployment gains tenancy and rotation bookkeeping
    // without a migration runner, and a fresh database already has them.
    for (const ddl of [
      "ALTER TABLE webhook_endpoints ADD COLUMN tenant_id TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE webhook_endpoints ADD COLUMN secret_fingerprint TEXT",
      "ALTER TABLE webhook_endpoints ADD COLUMN previous_secret_fingerprint TEXT",
      "ALTER TABLE webhook_endpoints ADD COLUMN previous_secret_expires_at INTEGER",
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        // Already present.
      }
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_endpoints_tenant ON webhook_endpoints(tenant_id, created_at)");
  }

  /** True when secrets are sealed at rest rather than stored in the clear. */
  get encryptionEnabled(): boolean {
    return this.cipher !== null;
  }

  /** Seals a secret for one row, or passes it through when encryption is off. */
  private seal(plaintext: string | null | undefined, tenantId: string, endpointId: string): string | null {
    if (plaintext === null || plaintext === undefined) return null;
    if (!this.cipher) return plaintext;
    return this.cipher.encrypt(plaintext, secretContext(tenantId, endpointId));
  }

  private unseal(stored: string | null | undefined, tenantId: string, endpointId: string): string | null {
    if (stored === null || stored === undefined) return null;
    if (!this.cipher || !this.cipher.isManaged(stored)) return stored;
    return this.cipher.decrypt(stored, secretContext(tenantId, endpointId));
  }

  createEndpoint(params: {
    url: string;
    events: string[];
    secret?: string;
    tenantId?: string;
    nowMs?: number;
  }): WebhookEndpoint {
    const id = `wh_${randomBytes(12).toString("hex")}`;
    const tenantId = params.tenantId ?? "";
    const secret = params.secret || `whsec_${randomBytes(24).toString("hex")}`;
    const at = params.nowMs ?? this.now();
    const now = new Date(at).toISOString();
    const endpoint: WebhookEndpoint = {
      id,
      tenant_id: tenantId,
      url: params.url,
      secret,
      previous_secret: null,
      events: params.events.length === 0 ? ["*"] : params.events,
      status: "active",
      created_at: now,
      updated_at: now,
      secret_fingerprint: SecretCipher.fingerprint(secret),
      previous_secret_fingerprint: null,
      previous_secret_expires_at: null,
    };

    this.db
      .prepare(
        `INSERT INTO webhook_endpoints
         (id, tenant_id, url, secret, previous_secret, events, status, created_at, updated_at,
          secret_fingerprint, previous_secret_fingerprint, previous_secret_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        endpoint.id,
        endpoint.tenant_id,
        endpoint.url,
        this.seal(endpoint.secret, tenantId, id),
        null,
        JSON.stringify(endpoint.events),
        endpoint.status,
        endpoint.created_at,
        endpoint.updated_at,
        endpoint.secret_fingerprint,
        null,
        null
      );

    return endpoint;
  }

  /**
   * Issues a new signing secret and keeps the old one verifying until
   * `overlapMs` has passed, so an in-flight delivery signed with the previous
   * key is still accepted by a consumer that has not picked up the new one.
   *
   * The registry supplies an options object and owns the durable expiry metadata.
   * The upstream key-rotation engine instead supplies a `Date` and enforces its
   * own policy from `updated_at`; imposing the registry's default window on that
   * form would shorten or extend a configured `SECRET_OVERLAP_MS` policy.
   */
  rotateEndpointSecret(
    endpointId: string,
    options?: { secret?: string; overlapMs?: number; nowMs?: number }
  ): { secret: string; previous_secret: string; expires_at: number };
  rotateEndpointSecret(
    endpointId: string,
    at: Date
  ): { secret: string; previous_secret: string };
  rotateEndpointSecret(
    endpointId: string,
    options: { secret?: string; overlapMs?: number; nowMs?: number } | Date = {}
  ): { secret: string; previous_secret: string; expires_at?: number } {
    const ep = this.getEndpoint(endpointId);
    if (!ep) {
      throw new Error(`Webhook endpoint ${endpointId} not found`);
    }

    const engineManaged = options instanceof Date;
    const newSecret =
      (options instanceof Date ? undefined : options.secret) || `whsec_${randomBytes(24).toString("hex")}`;
    const previousSecret = ep.secret;
    const at = options instanceof Date ? options.getTime() : options.nowMs ?? this.now();
    // A registry rotation that lands inside the old overlap window must not
    // inherit it: the outgoing key is the one just replaced, and its own window
    // restarts. Engine-managed rotations deliberately leave expiry unset here.
    const overlapMs = options instanceof Date
      ? DEFAULT_ROTATION_OVERLAP_MS
      : options.overlapMs ?? DEFAULT_ROTATION_OVERLAP_MS;
    const expiresAt = engineManaged ? null : at + Math.max(0, overlapMs);
    const now = new Date(at).toISOString();

    this.db
      .prepare(
        `UPDATE webhook_endpoints
         SET secret = ?, previous_secret = ?, updated_at = ?,
             secret_fingerprint = ?, previous_secret_fingerprint = ?, previous_secret_expires_at = ?
         WHERE id = ?`
      )
      .run(
        this.seal(newSecret, ep.tenant_id, endpointId),
        this.seal(previousSecret, ep.tenant_id, endpointId),
        now,
        SecretCipher.fingerprint(newSecret),
        engineManaged ? null : SecretCipher.fingerprint(previousSecret),
        expiresAt,
        endpointId
      );

    if (expiresAt !== null) {
      this.db
        .prepare(
          `INSERT INTO webhook_secret_rotations
           (id, endpoint_id, tenant_id, fingerprint, previous_fingerprint, rotated_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          `rot_${randomBytes(12).toString("hex")}`,
          endpointId,
          ep.tenant_id,
          SecretCipher.fingerprint(newSecret),
          SecretCipher.fingerprint(previousSecret),
          at,
          expiresAt
        );
    }

    return expiresAt === null
      ? { secret: newSecret, previous_secret: previousSecret }
      : { secret: newSecret, previous_secret: previousSecret, expires_at: expiresAt };
  }

  /** Rotations for one endpoint, newest first, by fingerprint only. */
  listRotations(endpointId: string, limit = 20): SecretRotationRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM webhook_secret_rotations WHERE endpoint_id = ? ORDER BY rotated_at DESC LIMIT ?"
      )
      .all(endpointId, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      endpoint_id: String(row.endpoint_id),
      tenant_id: String(row.tenant_id),
      fingerprint: String(row.fingerprint),
      previous_fingerprint: (row.previous_fingerprint as string) ?? null,
      rotated_at: Number(row.rotated_at),
      expires_at: Number(row.expires_at),
    }));
  }

  countRotationsSince(endpointId: string, sinceMs: number): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM webhook_secret_rotations WHERE endpoint_id = ? AND rotated_at > ?"
      )
      .get(endpointId, sinceMs) as { n: number } | undefined;
    return row ? Number(row.n) : 0;
  }

  /**
   * Drops an overlap secret once its window has elapsed. Until this runs the
   * dispatcher keeps offering both signatures; after it the old key is gone
   * from the row and from every future header.
   */
  expireRotationOverlap(nowMs: number = this.now()): number {
    const result = this.db
      .prepare(
        `UPDATE webhook_endpoints
         SET previous_secret = NULL, previous_secret_fingerprint = NULL, previous_secret_expires_at = NULL
         WHERE previous_secret_expires_at IS NOT NULL AND previous_secret_expires_at <= ?`
      )
      .run(nowMs);
    return result.changes;
  }

  /**
   * Clear the previous signing secret once its overlap window has elapsed
   * (issue #615). The active secret is untouched and deliveries in flight keep
   * verifying against it. Feature-side fingerprint and expiry metadata is
   * cleared with the secret so a retired overlap cannot remain observable.
   */
  retirePreviousSecret(endpointId: string, at: Date = new Date()): boolean {
    const now = at.toISOString();
    const result = this.db
      .prepare(
        `UPDATE webhook_endpoints
         SET previous_secret = NULL, previous_secret_fingerprint = NULL,
             previous_secret_expires_at = NULL, updated_at = ?
         WHERE id = ? AND previous_secret IS NOT NULL`
      )
      .run(now, endpointId);
    return result.changes > 0;
  }

  getEndpoint(id: string): WebhookEndpoint | undefined {
    const row = this.db
      .prepare("SELECT * FROM webhook_endpoints WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.toEndpoint(row) : undefined;
  }

  /** The endpoint, but only when it belongs to `tenantId`. */
  getEndpointForTenant(id: string, tenantId: string): WebhookEndpoint | undefined {
    const ep = this.getEndpoint(id);
    return ep && ep.tenant_id === tenantId ? ep : undefined;
  }

  listEndpoints(tenantId?: string): WebhookEndpoint[] {
    const rows = (
      tenantId === undefined
        ? this.db.prepare("SELECT * FROM webhook_endpoints ORDER BY created_at DESC").all()
        : this.db
            .prepare("SELECT * FROM webhook_endpoints WHERE tenant_id = ? ORDER BY created_at DESC")
            .all(tenantId)
    ) as Record<string, unknown>[];
    return rows.map((r) => this.toEndpoint(r));
  }

  countEndpoints(tenantId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM webhook_endpoints WHERE tenant_id = ?")
      .get(tenantId) as { n: number } | undefined;
    return row ? Number(row.n) : 0;
  }

  updateEndpoint(
    id: string,
    patch: { url?: string; events?: string[]; status?: "active" | "disabled"; nowMs?: number }
  ): WebhookEndpoint | undefined {
    const current = this.getEndpoint(id);
    if (!current) return undefined;
    const at = patch.nowMs ?? this.now();
    const next: WebhookEndpoint = {
      ...current,
      url: patch.url ?? current.url,
      events: patch.events ?? current.events,
      status: patch.status ?? current.status,
      updated_at: new Date(at).toISOString(),
    };
    this.db
      .prepare("UPDATE webhook_endpoints SET url = ?, events = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(next.url, JSON.stringify(next.events), next.status, next.updated_at, id);
    return next;
  }

  deleteEndpoint(id: string): boolean {
    const result = this.db.prepare("DELETE FROM webhook_endpoints WHERE id = ?").run(id);
    return result.changes > 0;
  }

  private toEndpoint(row: Record<string, unknown>): WebhookEndpoint {
    let parsedEvents: string[] = ["*"];
    try {
      parsedEvents = JSON.parse(String(row.events));
    } catch {}
    const tenantId = row.tenant_id === undefined || row.tenant_id === null ? "" : String(row.tenant_id);
    const id = String(row.id);
    const expiresAt =
      row.previous_secret_expires_at === null || row.previous_secret_expires_at === undefined
        ? null
        : Number(row.previous_secret_expires_at);
    return {
      id,
      tenant_id: tenantId,
      url: String(row.url),
      secret: this.unseal(String(row.secret), tenantId, id) ?? "",
      previous_secret: this.unseal((row.previous_secret as string) || null, tenantId, id),
      events: parsedEvents,
      status: row.status as "active" | "disabled",
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      secret_fingerprint: (row.secret_fingerprint as string) || undefined,
      previous_secret_fingerprint: (row.previous_secret_fingerprint as string) || null,
      previous_secret_expires_at: expiresAt,
    };
  }

  /**
   * The keys a consumer must accept for this endpoint right now. The previous
   * secret is only offered while its overlap window is still open, which is
   * what makes rotation zero-downtime without being permanent.
   */
  activeSigningSecrets(endpoint: WebhookEndpoint, nowMs: number = this.now()): string[] {
    const expires = endpoint.previous_secret_expires_at;
    const overlapOpen =
      endpoint.previous_secret !== null &&
      endpoint.previous_secret !== undefined &&
      (expires === undefined || expires === null || expires > nowMs);
    return overlapOpen ? [endpoint.secret, endpoint.previous_secret as string] : [endpoint.secret];
  }


  queueDeliveriesForEvent(
    event: {
      id: string;
      name: string;
      /** `null` for the events that are not about a stream; subscribers matching
       *  by event name still receive them, with the field present and null. */
      streamId: string | null;
      ledgerClosedAt: string;
      data: Record<string, unknown>;
    },
    /**
     * Contract events are broadcast to every subscriber. An alert about one
     * tenant's traffic is not, so a tenant-scoped fan-out has to say whose.
     */
    options: { tenantId?: string } = {}
  ): number {
    const endpoints = this.listEndpoints(options.tenantId).filter((ep) => ep.status === "active");
    let queued = 0;
    const now = Date.now();

    for (const ep of endpoints) {
      const match =
        ep.events.includes("*") ||
        ep.events.includes(event.name);
      if (!match) continue;

      const deliveryId = `del_${randomBytes(12).toString("hex")}`;
      this.db
        .prepare(
          `INSERT INTO webhook_deliveries
           (id, endpoint_id, event_id, stream_id, event_type, payload, attempt, status, next_retry_at, history, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', ?, '[]', ?)`
        )
        .run(
          deliveryId,
          ep.id,
          event.id,
          event.streamId,
          event.name,
          JSON.stringify(event.data),
          now, // first attempt immediate
          new Date(now).toISOString()
        );
      queued++;
    }

    return queued;
  }

  getDueDeliveries(limit = 50): WebhookDelivery[] {
    const now = Date.now();
    const rows = this.db
      .prepare(
        `SELECT * FROM webhook_deliveries
         WHERE status = 'pending' AND next_retry_at <= ?
         ORDER BY next_retry_at ASC LIMIT ?`
      )
      .all(now, limit) as Record<string, unknown>[];

    return rows.map((r) => this.toDelivery(r));
  }

  markDeliverySuccess(deliveryId: string, statusCode: number, durationMs: number): void {
    const d = this.getDelivery(deliveryId);
    if (!d) return;

    const record: WebhookAttemptRecord = {
      attempt: d.attempt,
      timestamp: Date.now(),
      status_code: statusCode,
      duration_ms: durationMs,
    };
    const newHistory = [...d.history, record];

    this.db
      .prepare(
        `UPDATE webhook_deliveries
         SET status = 'delivered', status_code = ?, history = ?, completed_at = ?
         WHERE id = ?`
      )
      .run(statusCode, JSON.stringify(newHistory), new Date().toISOString(), deliveryId);
  }

  recordDeliveryFailure(
    deliveryId: string,
    statusCode: number | undefined,
    errorMessage: string,
    durationMs: number
  ): void {
    const d = this.getDelivery(deliveryId);
    if (!d) return;

    const record: WebhookAttemptRecord = {
      attempt: d.attempt,
      timestamp: Date.now(),
      status_code: statusCode,
      error: errorMessage,
      duration_ms: durationMs,
    };
    const newHistory = [...d.history, record];

    if (isTerminalAttempt(d.attempt)) {
      // Move to Dead-Letter Queue
      this.db
        .prepare(
          `UPDATE webhook_deliveries
           SET status = 'dead_letter', status_code = ?, error = ?, history = ?, completed_at = ?
           WHERE id = ?`
        )
        .run(
          statusCode ?? null,
          errorMessage,
          JSON.stringify(newHistory),
          new Date().toISOString(),
          deliveryId
        );

      const dlqId = `dlq_${randomBytes(12).toString("hex")}`;
      this.db
        .prepare(
          `INSERT INTO webhook_dead_letter
           (id, delivery_id, endpoint_id, event_id, stream_id, event_type, payload, attempts_count, last_error, last_status_code, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          dlqId,
          deliveryId,
          d.endpoint_id,
          d.event_id,
          d.stream_id,
          d.event_type,
          JSON.stringify(d.payload),
          d.attempt,
          errorMessage,
          statusCode ?? null,
          new Date().toISOString()
        );
    } else {
      // Schedule next retry with exponential backoff and jitter
      const nextAttempt = d.attempt + 1;
      const delayMs = calculateNextRetryDelay(nextAttempt);
      const nextRetryAt = Date.now() + delayMs;

      this.db
        .prepare(
          `UPDATE webhook_deliveries
           SET attempt = ?, status = 'pending', status_code = ?, error = ?, next_retry_at = ?, history = ?
           WHERE id = ?`
        )
        .run(
          nextAttempt,
          statusCode ?? null,
          errorMessage,
          nextRetryAt,
          JSON.stringify(newHistory),
          deliveryId
        );
    }
  }

  getDelivery(id: string): WebhookDelivery | undefined {
    const row = this.db
      .prepare("SELECT * FROM webhook_deliveries WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.toDelivery(row) : undefined;
  }

  listDeliveries(limit = 50): WebhookDelivery[] {
    const rows = this.db
      .prepare("SELECT * FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.toDelivery(r));
  }

  /** Deliveries the tenant owns: the join, not a filter on a caller-supplied id. */
  listDeliveriesForTenant(tenantId: string, limit = 50): WebhookDelivery[] {
    const rows = this.db
      .prepare(
        `SELECT d.* FROM webhook_deliveries d
         JOIN webhook_endpoints e ON e.id = d.endpoint_id
         WHERE e.tenant_id = ? ORDER BY d.created_at DESC LIMIT ?`
      )
      .all(tenantId, limit) as Record<string, unknown>[];
    return rows.map((r) => this.toDelivery(r));
  }

  listDLQ(limit = 50): WebhookDeadLetterItem[] {
    const rows = this.db
      .prepare("SELECT * FROM webhook_dead_letter ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.toDLQ(r));
  }

  getDLQItem(id: string): WebhookDeadLetterItem | undefined {
    const row = this.db
      .prepare("SELECT * FROM webhook_dead_letter WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.toDLQ(row) : undefined;
  }

  replayDLQItem(dlqId: string): boolean {
    const item = this.getDLQItem(dlqId);
    if (!item) return false;
    return this.replay(item);
  }

  /**
   * Replay that refuses an item belonging to another tenant. `false` for both
   * "no such item" and "not yours", so a caller cannot probe id ownership.
   */
  replayDLQItemForTenant(dlqId: string, tenantId: string): boolean {
    const item = this.getDLQItem(dlqId);
    if (!item) return false;
    const endpoint = this.getEndpoint(item.endpoint_id);
    if (!endpoint || endpoint.tenant_id !== tenantId) return false;
    return this.replay(item);
  }

  /** Delivery state counts, optionally for one tenant, plus backlog age. */
  deliveryStats(tenantId?: string, nowMs: number = this.now()): {
    byState: Record<WebhookDelivery["status"], number>;
    oldestPendingAgeMs: number;
    averageAttempts: number;
  } {
    const byState: Record<WebhookDelivery["status"], number> = {
      pending: 0,
      delivered: 0,
      failed: 0,
      dead_letter: 0,
    };
    const where = tenantId === undefined ? "" : "WHERE e.tenant_id = ?";
    const join = tenantId === undefined ? "" : "JOIN webhook_endpoints e ON e.id = d.endpoint_id";
    const rows = this.db
      .prepare(`SELECT d.status AS status, d.attempt AS attempt, d.next_retry_at AS next_retry_at
                FROM webhook_deliveries d ${join} ${where}`)
      .all(...(tenantId === undefined ? [] : [tenantId])) as Array<{
        status: string;
        attempt: number;
        next_retry_at: number;
      }>;

    let oldest = nowMs;
    let attempts = 0;
    for (const row of rows) {
      const state = row.status as WebhookDelivery["status"];
      if (byState[state] === undefined) continue;
      byState[state] += 1;
      attempts += Number(row.attempt);
      if (state === "pending") oldest = Math.min(oldest, Number(row.next_retry_at));
    }
    return {
      byState,
      oldestPendingAgeMs: rows.length === 0 ? 0 : Math.max(0, nowMs - oldest),
      averageAttempts: rows.length === 0 ? 0 : attempts / rows.length,
    };
  }

  private replay(item: WebhookDeadLetterItem): boolean {
    // Queue a fresh delivery
    const newDeliveryId = `del_${randomBytes(12).toString("hex")}`;
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO webhook_deliveries
         (id, endpoint_id, event_id, stream_id, event_type, payload, attempt, status, next_retry_at, history, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', ?, '[]', ?)`
      )
      .run(
        newDeliveryId,
        item.endpoint_id,
        item.event_id,
        item.stream_id,
        item.event_type,
        JSON.stringify(item.payload),
        now,
        new Date(now).toISOString()
      );

    this.db
      .prepare("UPDATE webhook_dead_letter SET replayed_at = ? WHERE id = ?")
      .run(new Date().toISOString(), item.id);

    return true;
  }

  /** Dead-letter items the tenant owns. */
  listDLQForTenant(tenantId: string, limit = 50): WebhookDeadLetterItem[] {
    const rows = this.db
      .prepare(
        `SELECT q.* FROM webhook_dead_letter q
         JOIN webhook_endpoints e ON e.id = q.endpoint_id
         WHERE e.tenant_id = ? ORDER BY q.created_at DESC LIMIT ?`
      )
      .all(tenantId, limit) as Record<string, unknown>[];
    return rows.map((r) => this.toDLQ(r));
  }

  private toDelivery(row: Record<string, unknown>): WebhookDelivery {
    let payload = {};
    let history: WebhookAttemptRecord[] = [];
    try {
      payload = JSON.parse(String(row.payload));
    } catch {}
    try {
      history = JSON.parse(String(row.history));
    } catch {}

    return {
      id: String(row.id),
      endpoint_id: String(row.endpoint_id),
      event_id: String(row.event_id),
      stream_id: nullableId(row.stream_id),
      event_type: String(row.event_type),
      payload,
      attempt: Number(row.attempt),
      status: row.status as WebhookDelivery["status"],
      status_code: row.status_code !== null ? Number(row.status_code) : undefined,
      error: (row.error as string) || undefined,
      next_retry_at: Number(row.next_retry_at),
      history,
      created_at: String(row.created_at),
      completed_at: (row.completed_at as string) || undefined,
    };
  }

  private toDLQ(row: Record<string, unknown>): WebhookDeadLetterItem {
    let payload = {};
    try {
      payload = JSON.parse(String(row.payload));
    } catch {}

    return {
      id: String(row.id),
      delivery_id: String(row.delivery_id),
      endpoint_id: String(row.endpoint_id),
      event_id: String(row.event_id),
      stream_id: nullableId(row.stream_id),
      event_type: String(row.event_type),
      payload,
      attempts_count: Number(row.attempts_count),
      last_error: String(row.last_error),
      last_status_code: row.last_status_code !== null ? Number(row.last_status_code) : undefined,
      created_at: String(row.created_at),
      replayed_at: (row.replayed_at as string) || undefined,
    };
  }
}
