import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Limits a single tenant is allowed to consume, all of them per-tenant. */
export interface TenantQuotas {
  /** Subscriptions a tenant may hold at once. */
  maxSubscriptions: number;
  /** Event names one subscription may select. */
  maxEventsPerSubscription: number;
  /** Secret rotations allowed per rolling hour, per subscription. */
  maxRotationsPerHour: number;
}

export const DEFAULT_QUOTAS: TenantQuotas = {
  maxSubscriptions: 20,
  maxEventsPerSubscription: 24,
  maxRotationsPerHour: 6,
};

export interface TenantRecord {
  tenantId: string;
  label: string;
  quotas: TenantQuotas;
  disabled: boolean;
}

/** Who the caller has been identified as. */
export interface Principal {
  tenantId: string;
  keyId: string;
  /** False only for the synthetic single-tenant principal a deployment without
   *  configured keys gets, where the transport is trusted instead. */
  authenticated: boolean;
}

/** Env var holding `tenant:keyId:secretKey` triples. */
export const TENANT_KEYS_ENV = "WEBHOOK_TENANT_KEYS";

const TENANT_ID = /^[a-z0-9][a-z0-9._-]{1,62}$/;
const KEY_ID = /^[a-zA-Z0-9_]{1,32}$/;

function digest(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

interface KeyEntry {
  tenantId: string;
  keyId: string;
}

export class UnknownTenantError extends Error {
  constructor(tenantId: string) {
    super(`unknown tenant '${tenantId}'`);
    this.name = "UnknownTenantError";
  }
}

/**
 * Provisioned tenant identities and their quotas.
 *
 * Keys are held only as SHA-256 digests: a directory dump, a crashed heap or a
 * copied database can never hand back a usable credential. The lookup is by
 * digest rather than a scan-and-compare, so a wrong key costs the same as a
 * right one and reveals nothing about which tenants exist.
 */
export class TenantDirectory {
  private readonly tenants = new Map<string, TenantRecord>();
  private readonly keys = new Map<string, KeyEntry>();
  private readonly defaults: TenantQuotas;

  constructor(opts: { quotas?: Partial<TenantQuotas>; tenants?: TenantRecord[] } = {}) {
    this.defaults = { ...DEFAULT_QUOTAS, ...opts.quotas };
    for (const tenant of opts.tenants ?? []) this.upsert(tenant);
  }

  upsert(tenant: string | {
    tenantId: string;
    label?: string;
    quotas?: Partial<TenantQuotas>;
    disabled?: boolean;
  }): TenantRecord {
    const input = typeof tenant === "string" ? { tenantId: tenant } : tenant;
    if (!TENANT_ID.test(input.tenantId)) {
      throw new Error(`tenant id '${input.tenantId}' must match ${TENANT_ID}`);
    }
    const existing = this.tenants.get(input.tenantId);
    const record: TenantRecord = {
      tenantId: input.tenantId,
      label: input.label ?? existing?.label ?? input.tenantId,
      quotas: { ...this.defaults, ...(existing?.quotas ?? {}), ...(input.quotas ?? {}) },
      disabled: input.disabled ?? existing?.disabled ?? false,
    };
    this.tenants.set(record.tenantId, record);
    return record;
  }

  /**
   * Attaches a credential to a tenant and returns the key exactly once — the
   * directory keeps nothing reversible afterwards.
   */
  registerKey(tenantId: string, keyId?: string, key?: string): { keyId: string; key: string } {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) throw new UnknownTenantError(tenantId);
    const id = keyId ?? `k${randomBytes(4).toString("hex")}`;
    if (!KEY_ID.test(id)) throw new Error(`key id '${id}' must match ${KEY_ID}`);
    const secret = key ?? `stdp_whk_${randomBytes(20).toString("hex")}`;
    if (secret.length < 24) throw new Error("tenant key must carry at least 24 characters of entropy");
    for (const entry of this.keys.values()) {
      if (entry.tenantId === tenantId && entry.keyId === id) {
        throw new Error(`key id '${id}' already registered for tenant '${tenantId}'`);
      }
    }
    this.keys.set(digest(secret), { tenantId, keyId: id });
    return { keyId: id, key: secret };
  }

  /** Resolve a presented key. Never distinguishes "no such tenant" from "wrong key". */
  resolveKey(key: string | undefined | null): Principal | null {
    if (!key) return null;
    const entry = this.keys.get(digest(key));
    if (!entry) return null;
    const tenant = this.tenants.get(entry.tenantId);
    if (!tenant || tenant.disabled) return null;
    return { tenantId: entry.tenantId, keyId: entry.keyId, authenticated: true };
  }

  /**
   * The principal used when a deployment has provisioned no keys at all: one
   * tenant, named by `WEBHOOK_DEFAULT_TENANT_ID`, with the transport (a private
   * network or a front-ingress that already authenticated the caller) trusted.
   */
  principalFor(tenantId: string): Principal {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) throw new UnknownTenantError(tenantId);
    if (tenant.disabled) throw new UnknownTenantError(tenantId);
    return { tenantId, keyId: "unauthenticated", authenticated: false };
  }

  has(tenantId: string): boolean {
    return this.tenants.has(tenantId);
  }

  get(tenantId: string): TenantRecord | undefined {
    return this.tenants.get(tenantId);
  }

  require(tenantId: string): TenantRecord {
    const tenant = this.tenants.get(tenantId);
    if (!tenant || tenant.disabled) throw new UnknownTenantError(tenantId);
    return tenant;
  }

  quotasFor(tenantId: string): TenantQuotas {
    return this.require(tenantId).quotas;
  }

  /** Tenants and quotas, without any credential material. */
  list(): Array<{ tenantId: string; label: string; quotas: TenantQuotas; disabled: boolean; keyCount: number }> {
    const counts = new Map<string, number>();
    for (const entry of this.keys.values()) {
      counts.set(entry.tenantId, (counts.get(entry.tenantId) ?? 0) + 1);
    }
    return [...this.tenants.values()].map((t) => ({ ...t, keyCount: counts.get(t.tenantId) ?? 0 }));
  }

  get keyCount(): number {
    return this.keys.size;
  }

  /** True when the deployment has provisioned credentials to check against. */
  get enforcesAuthentication(): boolean {
    return this.keys.size > 0;
  }

  /** Constant-time check that `key` is the credential for `tenantId`/`keyId`. */
  verify(tenantId: string, keyId: string, key: string): boolean {
    const principal = this.resolveKey(key);
    if (!principal) return false;
    const expected = Buffer.from(`${principal.tenantId}/${principal.keyId}`, "utf8");
    const actual = Buffer.from(`${tenantId}/${keyId}`, "utf8");
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }
}

/**
 * Build a directory from the environment.
 *
 * `WEBHOOK_TENANT_KEYS` is a comma-separated list of
 * `tenantId:keyId:secret` triples. Quota env vars set the defaults every
 * tenant inherits; a tenant listed with `~maxSubscriptions=N` overrides inline.
 */
export function directoryFromEnv(env: NodeJS.ProcessEnv = process.env): {
  directory: TenantDirectory;
  defaultTenantId: string;
} {
  const directory = new TenantDirectory({
    quotas: {
      maxSubscriptions: positiveInt("WEBHOOK_TENANT_QUOTA_SUBSCRIPTIONS", env.WEBHOOK_TENANT_QUOTA_SUBSCRIPTIONS, DEFAULT_QUOTAS.maxSubscriptions),
      maxEventsPerSubscription: positiveInt("WEBHOOK_TENANT_QUOTA_EVENTS", env.WEBHOOK_TENANT_QUOTA_EVENTS, DEFAULT_QUOTAS.maxEventsPerSubscription),
      maxRotationsPerHour: positiveInt("WEBHOOK_TENANT_QUOTA_ROTATIONS", env.WEBHOOK_TENANT_QUOTA_ROTATIONS, DEFAULT_QUOTAS.maxRotationsPerHour),
    },
  });

  const raw = env[TENANT_KEYS_ENV] ?? "";
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const parts = entry.split(":");
    if (parts.length !== 3 || parts.some((p) => p === "")) {
      throw new Error(`${TENANT_KEYS_ENV} entries must be 'tenantId:keyId:secret', got '${entry}'`);
    }
    const [tenantId, keyId, key] = parts;
    directory.upsert(tenantId);
    directory.registerKey(tenantId, keyId, key);
  }

  const defaultTenantId = (env.WEBHOOK_DEFAULT_TENANT_ID ?? "default").trim() || "default";
  if (!directory.has(defaultTenantId)) directory.upsert(defaultTenantId);
  return { directory, defaultTenantId };
}
