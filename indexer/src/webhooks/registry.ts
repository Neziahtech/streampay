import { sanitizeWebhookUrl } from "../privacy.js";
import { isContractEventName } from "../generated/events.js";
import type { WebhookDeadLetterItem, WebhookDelivery, WebhookEndpoint, WebhookSubscriptionView } from "./types.js";
import { validateWebhookUrl, type SsrfCheckResult } from "./ssrf.js";
import type { TenantDirectory, Principal, TenantQuotas } from "./tenants.js";
import type { WebhookStore, SecretRotationRecord } from "./store.js";
import { DEFAULT_ROTATION_OVERLAP_MS } from "./store.js";
import { SecretCipher } from "./secrets.js";
import type { WebhookMetrics, WebhookSlaSnapshot } from "./metrics.js";

/**
 * Everything a caller may select: the contract catalog, plus the reserved
 * names this indexer originates itself. `anomaly_alert` (issue #582) is
 * detector output and never comes from the contract, so it has no schema entry
 * to validate against.
 */
export const RESERVED_EVENT_NAMES: readonly string[] = ["*", "stream_ping", "anomaly_alert"];

export type SubscriptionErrorCode =
  | "invalid_url"
  | "invalid_secret"
  | "ssrf_rejected"
  | "invalid_events"
  | "quota_subscriptions"
  | "quota_events"
  | "quota_rotations"
  | "not_found"
  | "forbidden"
  | "tenant_disabled"
  | "encryption_required";

const STATUS_BY_CODE: Record<SubscriptionErrorCode, number> = {
  invalid_url: 400,
  invalid_secret: 400,
  ssrf_rejected: 400,
  invalid_events: 400,
  quota_subscriptions: 403,
  quota_events: 403,
  quota_rotations: 429,
  not_found: 404,
  forbidden: 403,
  tenant_disabled: 403,
  encryption_required: 503,
};

export class SubscriptionError extends Error {
  readonly code: SubscriptionErrorCode;
  readonly status: number;
  /** Extra machine-readable context (quota limits, offending values). */
  readonly details: Record<string, unknown>;

  constructor(code: SubscriptionErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SubscriptionError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }

  toJSON(): { error: string; code: string; details: Record<string, unknown> } {
    return { error: this.message, code: this.code, details: this.details };
  }
}

/** One redacted line about a registry action. Never secret material. */
export interface RegistryAuditEvent {
  action: string;
  tenantId: string;
  keyId: string;
  endpointId?: string;
  url?: string;
  events?: string[];
  fingerprint?: string;
  code?: SubscriptionErrorCode;
  at: number;
}

export interface SubscriptionCreateInput {
  url: string;
  events?: string[];
  /** Optional caller-supplied secret; the registry generates one when absent. */
  secret?: string;
}

export interface SubscriptionUpdateInput {
  url?: string;
  events?: string[];
  status?: "active" | "disabled";
}

export interface SubscriptionRecord {
  subscription: WebhookSubscriptionView;
  /** Returned exactly once, at create/rotate time. Never stored in the clear. */
  secret_once: string;
}

export interface RegistryOptions {
  store: WebhookStore;
  directory: TenantDirectory;
  /** Injectable so subscribe-time checks can be exercised without DNS. */
  validateUrl?: (url: string) => Promise<SsrfCheckResult>;
  metrics?: WebhookMetrics;
  /** Override the default overlap window for a rotation. */
  rotationOverlapMs?: number;
  /**
   * Refuse to hold secrets in the clear. Off by default so a deployment that
   * has not provisioned `WEBHOOK_SECRET_ENCRYPTION_KEY` still runs; on, a
   * missing key fails loudly instead of silently storing plaintext.
   */
  requireEncryption?: boolean;
  /** Receives already-redacted audit events; defaults to a no-op. */
  onAudit?: (event: RegistryAuditEvent) => void;
  now?: () => number;
}

function normalizeEvents(events: string[] | undefined): string[] {
  if (events === undefined || events.length === 0) return ["*"];
  const seen = new Set<string>();
  for (const name of events) {
    if (typeof name !== "string" || name.length === 0) {
      throw new SubscriptionError("invalid_events", "event names must be non-empty strings", { events });
    }
    if (!RESERVED_EVENT_NAMES.includes(name) && !isContractEventName(name)) {
      throw new SubscriptionError("invalid_events", `unknown event name '${name}'`, {
        event: name,
        hint: "a contract event from the registry, or one of " + RESERVED_EVENT_NAMES.map((name) => `'${name}'`).join(", "),
      });
    }
    seen.add(name);
  }
  if (seen.has("*") && seen.size > 1) {
    throw new SubscriptionError("invalid_events", "'*' already selects every event", {
      events: [...seen],
    });
  }
  return [...seen];
}

function assertUrlShape(url: string): void {
  if (typeof url !== "string" || url.trim() === "") {
    throw new SubscriptionError("invalid_url", "subscription URL is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SubscriptionError("invalid_url", "subscription URL is not a valid absolute URL", {
      url: sanitizeWebhookUrl(url),
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SubscriptionError("invalid_url", `subscription URL must be http(s), got ${parsed.protocol}`, {
      url: sanitizeWebhookUrl(url),
    });
  }
  // Credentials in the URL would be a second secret to protect, and the
  // dispatcher never needs one.
  if (parsed.username !== "" || parsed.password !== "") {
    throw new SubscriptionError("invalid_url", "subscription URL must not embed credentials", {
      url: sanitizeWebhookUrl(url),
    });
  }
}

/**
 * Tenant-facing surface over the shared webhook store.
 *
 * Every operation is expressed against a `Principal`, and the tenant is taken
 * from that principal rather than the request body: a subscription created for
 * one tenant is only ever visible, mutable, rotatable or replayable by that
 * tenant. A cross-tenant id reads as `not_found` rather than `forbidden`,
 * because answering 403 would confirm the id exists and hand out an
 * enumeration oracle.
 */
export class WebhookSubscriptionRegistry {
  private readonly store: WebhookStore;
  private readonly directory: TenantDirectory;
  private readonly validateUrl: (url: string) => Promise<SsrfCheckResult>;
  private readonly metrics: WebhookMetrics | undefined;
  private readonly rotationOverlapMs: number;
  private readonly requireEncryption: boolean;
  private readonly onAudit: (event: RegistryAuditEvent) => void;
  private readonly now: () => number;

  constructor(options: RegistryOptions) {
    this.store = options.store;
    this.directory = options.directory;
    this.validateUrl = options.validateUrl ?? ((url: string) => validateWebhookUrl(url));
    this.metrics = options.metrics;
    this.rotationOverlapMs = options.rotationOverlapMs ?? DEFAULT_ROTATION_OVERLAP_MS;
    this.requireEncryption = options.requireEncryption ?? false;
    this.onAudit = options.onAudit ?? (() => {});
    this.now = options.now ?? Date.now;
  }

  async create(principal: Principal, input: SubscriptionCreateInput): Promise<SubscriptionRecord> {
    const tenant = this.authorize(principal, "create");
    assertUrlShape(input.url);
    const events = normalizeEvents(input.events);

    if (events.length > tenant.quotas.maxEventsPerSubscription) {
      throw new SubscriptionError(
        "quota_events",
        `tenant '${tenant.tenantId}' may select at most ${tenant.quotas.maxEventsPerSubscription} events per subscription`,
        { limit: tenant.quotas.maxEventsPerSubscription, requested: events.length }
      );
    }

    const held = this.store.countEndpoints(tenant.tenantId);
    if (held >= tenant.quotas.maxSubscriptions) {
      throw new SubscriptionError(
        "quota_subscriptions",
        `tenant '${tenant.tenantId}' already holds ${held} of ${tenant.quotas.maxSubscriptions} subscriptions`,
        { limit: tenant.quotas.maxSubscriptions, held }
      );
    }

    // Subscribe-time SSRF rejection: a private destination must never become a
    // row that the dispatcher later reads. Checking only at delivery time lets
    // the subscription itself be stored, quoted and retried forever.
    await this.assertPublicDestination(input.url, tenant.tenantId);

    const secret = input.secret ?? SecretCipher.generateSecret();
    this.assertSecretShape(secret);

    const endpoint = this.store.createEndpoint({
      url: input.url,
      events,
      secret,
      tenantId: tenant.tenantId,
      nowMs: this.now(),
    });

    this.metrics?.observeSubscription(endpoint.status, 1);
    this.audit("create", principal, {
      endpointId: endpoint.id,
      url: endpoint.url,
      events: endpoint.events,
      fingerprint: endpoint.secret_fingerprint,
    });
    return { subscription: this.toView(endpoint), secret_once: secret };
  }

  list(principal: Principal): { subscriptions: WebhookSubscriptionView[]; quota: { maxSubscriptions: number; used: number } } {
    const tenant = this.authorize(principal, "list");
    const subscriptions = this.store
      .listEndpoints(tenant.tenantId)
      .map((endpoint) => this.toView(endpoint));
    return {
      subscriptions,
      quota: { maxSubscriptions: tenant.quotas.maxSubscriptions, used: subscriptions.length },
    };
  }

  get(principal: Principal, endpointId: string): WebhookSubscriptionView {
    const tenant = this.authorize(principal, "get");
    return this.toView(this.own(tenant.tenantId, endpointId));
  }

  async update(principal: Principal, endpointId: string, patch: SubscriptionUpdateInput): Promise<WebhookSubscriptionView> {
    const tenant = this.authorize(principal, "update");
    const current = this.own(tenant.tenantId, endpointId);

    const nextUrl = patch.url === undefined ? current.url : patch.url;
    if (patch.url !== undefined && patch.url !== current.url) {
      assertUrlShape(patch.url);
      await this.assertPublicDestination(patch.url, tenant.tenantId);
    }

    const nextEvents = patch.events === undefined ? current.events : normalizeEvents(patch.events);
    if (nextEvents.length > tenant.quotas.maxEventsPerSubscription) {
      throw new SubscriptionError(
        "quota_events",
        `tenant '${tenant.tenantId}' may select at most ${tenant.quotas.maxEventsPerSubscription} events per subscription`,
        { limit: tenant.quotas.maxEventsPerSubscription, requested: nextEvents.length }
      );
    }

    const updated = this.store.updateEndpoint(endpointId, {
      url: nextUrl,
      events: nextEvents,
      status: patch.status,
      nowMs: this.now(),
    });
    if (!updated) throw new SubscriptionError("not_found", `subscription '${endpointId}' not found`, {
      endpoint_id: endpointId,
    });

    if (updated.status !== current.status) this.metrics?.observeSubscription(current.status, -1);
    this.metrics?.observeSubscription(updated.status, 1);
    this.audit("update", principal, {
      endpointId,
      url: updated.url,
      events: updated.events,
      fingerprint: updated.secret_fingerprint,
    });
    return this.toView(updated);
  }

  remove(principal: Principal, endpointId: string): { ok: true } {
    const tenant = this.authorize(principal, "delete");
    const existing = this.own(tenant.tenantId, endpointId);
    if (!this.store.deleteEndpoint(endpointId)) {
      throw new SubscriptionError("not_found", `subscription '${endpointId}' not found`, { endpoint_id: endpointId });
    }
    this.metrics?.observeSubscription(existing.status, -1);
    this.audit("delete", principal, { endpointId, url: existing.url });
    return { ok: true };
  }

  /**
   * Issues a new secret and keeps the outgoing one verifying for
   * `overlapMs`. A consumer that has not yet picked up the replacement still
   * accepts deliveries signed with the key it holds, so no window of accepted
   * but unverifiable traffic opens during the switch.
   */
  rotateSecret(
    principal: Principal,
    endpointId: string,
    opts: { overlapMs?: number } = {}
  ): { secret_once: string; fingerprint: string; previous_fingerprint: string; expires_at: number } {
    const tenant = this.authorize(principal, "rotate_secret");
    const existing = this.own(tenant.tenantId, endpointId);

    const at = this.now();
    const rotations = this.store.countRotationsSince(endpointId, at - 3_600_000);
    if (rotations >= tenant.quotas.maxRotationsPerHour) {
      throw new SubscriptionError(
        "quota_rotations",
        `subscription '${endpointId}' has already rotated ${rotations} times this hour (limit ${tenant.quotas.maxRotationsPerHour})`,
        { limit: tenant.quotas.maxRotationsPerHour, rotations, retry_after_ms: 3_600_000 - (at % 3_600_000) }
      );
    }

    const overlapMs = opts.overlapMs ?? this.rotationOverlapMs;
    const rotated = this.store.rotateEndpointSecret(endpointId, {
      overlapMs,
      nowMs: at,
    });

    this.audit("rotate_secret", principal, {
      endpointId,
      url: existing.url,
      fingerprint: SecretCipher.fingerprint(rotated.secret),
    });
    return {
      secret_once: rotated.secret,
      fingerprint: SecretCipher.fingerprint(rotated.secret),
      previous_fingerprint: SecretCipher.fingerprint(rotated.previous_secret),
      expires_at: rotated.expires_at,
    };
  }

  rotationHistory(principal: Principal, endpointId: string, limit = 20): SecretRotationRecord[] {
    const tenant = this.authorize(principal, "rotation_history");
    this.own(tenant.tenantId, endpointId);
    return this.store.listRotations(endpointId, limit);
  }

  /** Deliveries for this tenant only, with the payload left intact and no secret. */
  deliveries(principal: Principal, limit = 50): WebhookDelivery[] {
    const tenant = this.authorize(principal, "list_deliveries");
    return this.store.listDeliveriesForTenant(tenant.tenantId, limit);
  }

  dlq(principal: Principal, limit = 50): WebhookDeadLetterItem[] {
    const tenant = this.authorize(principal, "list_dlq");
    return this.store.listDLQForTenant(tenant.tenantId, limit);
  }

  replayDlq(principal: Principal, dlqItemId: string): { ok: true; replayed: true } {
    const tenant = this.authorize(principal, "replay_dlq");
    if (!this.store.replayDLQItemForTenant(dlqItemId, tenant.tenantId)) {
      throw new SubscriptionError("not_found", `dead-letter item '${dlqItemId}' not found`, {
        dlq_id: dlqItemId,
      });
    }
    this.audit("replay_dlq", principal, { url: undefined });
    return { ok: true, replayed: true };
  }

  /**
   * Measured SLA for this tenant plus whether it is inside its budget — the
   * number a dashboard panel and a breach alert both read.
   */
  sla(principal: Principal): { tenant_id: string; quota: { maxSubscriptions: number; used: number }; delivery: WebhookSlaSnapshot | null } {
    const tenant = this.authorize(principal, "sla");
    const used = this.store.countEndpoints(tenant.tenantId);
    return {
      tenant_id: tenant.tenantId,
      quota: { maxSubscriptions: tenant.quotas.maxSubscriptions, used },
      delivery: this.metrics ? this.metrics.snapshot(tenant.tenantId) : null,
    };
  }

  /** Alarm state for every tenant with traffic, for the operator surface. */
  breaches(): Array<{ tenant_id: string; breached: boolean; snapshot: WebhookSlaSnapshot }> {
    if (!this.metrics) return [];
    return this.metrics.tenantsSnapshot().map((entry) => ({
      tenant_id: entry.tenantId,
      breached: entry.snapshot.breached,
      snapshot: entry.snapshot,
    }));
  }

  /**
   * Closes expired rotation overlaps. Safe to call from a maintenance tick:
   * an endpoint that has been offline through its window simply stops being
   * able to prove deliveries signed with the old key, which is the point.
   */
  retireExpiredRotations(nowMs: number = this.now()): { cleared: number } {
    const cleared = this.store.expireRotationOverlap(nowMs);
    if (cleared > 0) {
      this.onAudit({ action: "retire_rotations", tenantId: "*", keyId: "maintenance", at: nowMs });
    }
    return { cleared };
  }

  private authorize(principal: Principal, action: string): { tenantId: string; quotas: TenantQuotas } {
    const tenant = this.directory.get(principal.tenantId);
    if (!tenant) {
      throw new SubscriptionError("forbidden", `tenant '${principal.tenantId}' is not provisioned`, {
        action,
      });
    }
    if (tenant.disabled) {
      throw new SubscriptionError("tenant_disabled", `tenant '${tenant.tenantId}' is disabled`, { action });
    }
    return { tenantId: tenant.tenantId, quotas: tenant.quotas };
  }

  private own(tenantId: string, endpointId: string): WebhookEndpoint {
    const endpoint = this.store.getEndpointForTenant(endpointId, tenantId);
    if (!endpoint) {
      throw new SubscriptionError("not_found", `subscription '${endpointId}' not found`, { endpoint_id: endpointId });
    }
    return endpoint;
  }

  private async assertPublicDestination(url: string, tenantId: string): Promise<void> {
    const result = await this.validateUrl(url);
    if (!result.safe) {
      this.audit("reject_ssrf", { tenantId, keyId: "subscribe", authenticated: true }, {
        url,
        code: "ssrf_rejected",
      });
      throw new SubscriptionError("ssrf_rejected", `subscription URL rejected: ${result.reason ?? "unsafe destination"}`, {
        url: sanitizeWebhookUrl(url),
        reason: result.reason,
      });
    }
  }

  private assertSecretShape(secret: string): void {
    if (this.requireEncryption && !this.store.encryptionEnabled) {
      throw new SubscriptionError(
        "encryption_required",
        "WEBHOOK_SECRET_ENCRYPTION_KEY is required but not configured"
      );
    }
    if (secret.length < 32) {
      throw new SubscriptionError("invalid_secret", "signing secret must carry at least 32 characters", {
        length: secret.length,
      });
    }
  }

  private toView(endpoint: WebhookEndpoint): WebhookSubscriptionView {
    return {
      id: endpoint.id,
      tenant_id: endpoint.tenant_id,
      url: endpoint.url,
      events: endpoint.events,
      status: endpoint.status,
      secret_fingerprint:
        endpoint.secret_fingerprint ?? SecretCipher.fingerprint(endpoint.secret),
      rotation_expires_at: endpoint.previous_secret_expires_at ?? null,
      created_at: endpoint.created_at,
      updated_at: endpoint.updated_at,
    };
  }

  private audit(
    action: string,
    principal: Principal,
    fields: { endpointId?: string; url?: string; events?: string[]; fingerprint?: string; code?: SubscriptionErrorCode }
  ): void {
    this.onAudit({
      action,
      tenantId: principal.tenantId,
      keyId: principal.keyId,
      endpointId: fields.endpointId,
      url: fields.url === undefined ? undefined : sanitizeWebhookUrl(fields.url),
      events: fields.events,
      fingerprint: fields.fingerprint,
      code: fields.code,
      at: this.now(),
    });
  }
}
