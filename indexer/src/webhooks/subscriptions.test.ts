import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import Database from "better-sqlite3";

import { StreamStore } from "../store.js";
import { createApp, type WebhookApiConfig } from "../index.js";
import { WebhookStore, DEFAULT_ROTATION_OVERLAP_MS } from "./store.js";
import { WebhookDispatcher } from "./dispatcher.js";
import { WebhookSubscriptionRegistry, SubscriptionError, RESERVED_EVENT_NAMES } from "./registry.js";
import { TenantDirectory, directoryFromEnv, type Principal } from "./tenants.js";
import { SecretCipher } from "./secrets.js";
import { WebhookMetrics, slaIncidentId } from "./metrics.js";
import { canonicalizeJson, verifySignatureHeader } from "./hmac.js";
import { validateWebhookUrl, type DnsLookupFunction, type SsrfCheckResult } from "./ssrf.js";
import { SSRF_BYPASS_FIXTURES } from "./ssrf-fixtures.js";
import { ALL_CONTRACT_EVENT_NAMES } from "../generated/events.js";

const PUBLIC_URL = "https://93.184.216.34/hook";
const HEX_KEY = "0f1e2d3c4b5a69788796a5b4c3d2e1f0f1e2d3c4b5a69788796a5b4c3d2e1f0";

function cipher(): SecretCipher {
  return SecretCipher.fromPassphrase(HEX_KEY);
}

class Clock {
  constructor(public at = 1_700_000_000_000) {}
  now = (): number => this.at;
  advance(ms: number): number {
    this.at += ms;
    return this.at;
  }
}

/** The subscribe-time check is exercised on its own below; the rest of the
 *  suite must not depend on live DNS, so the default stub admits a public host. */
const publicDestination = async (): Promise<SsrfCheckResult> => ({
  safe: true,
  resolvedIp: "93.184.216.34",
});

interface Harness {
  db: Database.Database;
  store: WebhookStore;
  directory: TenantDirectory;
  registry: WebhookSubscriptionRegistry;
  metrics: WebhookMetrics;
  clock: Clock;
  audits: Array<{ action: string; url?: string; fingerprint?: string; tenantId: string }>;
  principal(tenantId: string): Principal;
}

function harness(options: {
  cipher?: SecretCipher | null;
  quotas?: Record<string, Partial<import("./tenants.js").TenantQuotas>>;
  tenants?: string[];
  requireEncryption?: boolean;
  slaMs?: number;
  validateUrl?: (url: string) => Promise<SsrfCheckResult>;
} = {}): Harness {
  const db = new Database(":memory:");
  const clock = new Clock();
  const store = new WebhookStore(db, { cipher: options.cipher, now: clock.now });
  const directory = new TenantDirectory();
  for (const tenantId of options.tenants ?? ["acme", "globex"]) {
    directory.upsert({ tenantId, quotas: options.quotas?.[tenantId] });
  }
  const metrics = new WebhookMetrics({ slaMs: options.slaMs, minSamples: 3, windowSize: 10 });
  const audits: Harness["audits"] = [];
  const registry = new WebhookSubscriptionRegistry({
    store,
    directory,
    metrics,
    now: clock.now,
    validateUrl: options.validateUrl ?? publicDestination,
    requireEncryption: options.requireEncryption,
    onAudit: (event) => audits.push(event),
  });
  return {
    db,
    store,
    directory,
    registry,
    metrics,
    clock,
    audits,
    principal: (tenantId: string) => directory.principalFor(tenantId),
  };
}

function rawColumn(db: Database.Database, id: string, column: string): string {
  const row = db.prepare(`SELECT ${column} AS value FROM webhook_endpoints WHERE id = ?`).get(id) as {
    value: string;
  };
  return row.value;
}

function expectCode(code: string, fn: () => unknown): SubscriptionError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof SubscriptionError, `expected a SubscriptionError, got ${String(err)}`);
    assert.equal(err.code, code);
    return err;
  }
  assert.fail(`expected ${code} to be rejected`);
}

async function expectCodeAsync(code: string, fn: () => Promise<unknown>): Promise<SubscriptionError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof SubscriptionError, `expected a SubscriptionError, got ${String(err)}`);
    assert.equal(err.code, code);
    return err as SubscriptionError;
  }
  assert.fail(`expected ${code} to be rejected`);
}

describe("Webhook subscription registry", () => {
  describe("Secrets at rest", () => {
    it("never writes the signing secret to the column it is read from", async () => {
      const h = harness({ cipher: cipher() });
      const created = await h.registry.create(h.principal("acme"), { url: PUBLIC_URL });

      assert.match(created.secret_once, /^whsec_/);
      const stored = rawColumn(h.db, created.subscription.id, "secret");
      assert.ok(stored.startsWith("spwsec:v1:"), "column holds a sealed envelope");
      assert.ok(!stored.includes("whsec_"), "no plaintext secret in the row");
      assert.equal(h.store.getEndpoint(created.subscription.id)?.secret, created.secret_once);
    });

    it("binds an envelope to its own tenant and subscription", async () => {
      const c = cipher();
      const sealed = c.encrypt("whsec_for_another_row", "tenant=acme;endpoint=wh_other");
      assert.throws(
        () => c.decrypt(sealed, "tenant=globex;endpoint=wh_other"),
        /failed authentication/
      );
      assert.throws(
        () => c.decrypt(sealed, "tenant=acme;endpoint=wh_another"),
        /failed authentication/
      );
      assert.equal(c.decrypt(sealed, "tenant=acme;endpoint=wh_other"), "whsec_for_another_row");
    });

    it("reads a pre-encryption row without rewriting it", async () => {
      const h = harness({ cipher: cipher() });
      const legacy = h.store.createEndpoint({ url: PUBLIC_URL, events: ["*"], secret: "whsec_legacy_plaintext" });
      // A row written by a build that had no cipher: plaintext in the column.
      h.db
        .prepare("UPDATE webhook_endpoints SET secret = ?, secret_fingerprint = NULL WHERE id = ?")
        .run("whsec_legacy_plaintext", legacy.id);

      assert.equal(rawColumn(h.db, legacy.id, "secret"), "whsec_legacy_plaintext");
      assert.equal(h.store.getEndpoint(legacy.id)?.secret, "whsec_legacy_plaintext");
      assert.equal(h.store.activeSigningSecrets(legacy).length, 1);
      // Reading it back did not rewrite it.
      assert.equal(rawColumn(h.db, legacy.id, "secret"), "whsec_legacy_plaintext");
    });

    it("refuses to hold secrets in the clear when the deployment demands encryption", async () => {
      const h = harness({ cipher: null, requireEncryption: true });
      await expectCodeAsync("encryption_required", () =>
        h.registry.create(h.principal("acme"), { url: PUBLIC_URL })
      );
    });

    it("derives a key from a passphrase and rejects an empty one", () => {
      const fromPassphrase = SecretCipher.fromPassphrase("correct horse battery staple");
      const sealed = fromPassphrase.encrypt("whsec_x", "tenant=a;endpoint=b");
      assert.equal(fromPassphrase.decrypt(sealed, "tenant=a;endpoint=b"), "whsec_x");
      // The hex and passphrase forms reach the cipher through the same path.
      assert.equal(SecretCipher.fromPassphrase(HEX_KEY).isManaged(sealed), true);
      assert.throws(() => new SecretCipher(Buffer.alloc(16)), /must be 32 bytes/);
      assert.equal(SecretCipher.fromEnv({}), null);
      assert.equal(SecretCipher.fromEnv({ WEBHOOK_SECRET_ENCRYPTION_KEY: "   " }), null);
      assert.ok(SecretCipher.fromEnv({ WEBHOOK_SECRET_ENCRYPTION_KEY: HEX_KEY }));
      assert.throws(() => SecretCipher.fromPassphrase("   "), /is empty/);
    });
  });

  describe("Tenant isolation", () => {
    it("hides another tenant's subscription from every operation", async () => {
      const h = harness();
      const created = await h.registry.create(h.principal("acme"), { url: PUBLIC_URL, events: ["withdrawn"] });
      const id = created.subscription.id;
      const other = h.principal("globex");

      assert.deepEqual(
        h.registry.list(other).subscriptions.map((s) => s.id),
        []
      );
      expectCode("not_found", () => h.registry.get(other, id));
      expectCode("not_found", () => h.registry.rotateSecret(other, id));
      expectCode("not_found", () => h.registry.remove(other, id));
      expectCode("not_found", () => h.registry.rotationHistory(other, id));
      await expectCodeAsync("not_found", () => h.registry.update(other, id, { status: "disabled" }));

      // And the owner still sees everything.
      assert.equal(h.registry.get(h.principal("acme"), id).id, id);
    });

    it("lists and replays only the caller's deliveries and dead letters", async () => {
      const h = harness();
      const mine = await h.registry.create(h.principal("acme"), { url: PUBLIC_URL, events: ["withdrawn"] });
      const theirs = await h.registry.create(h.principal("globex"), { url: PUBLIC_URL, events: ["withdrawn"] });

      h.store.queueDeliveriesForEvent({
        id: "evt_1",
        name: "withdrawn",
        streamId: "7",
        ledgerClosedAt: new Date(h.clock.at).toISOString(),
        data: { amount: "100" },
      });
      const deliveries = h.store.listDeliveries(10);
      assert.equal(deliveries.length, 2, "both tenants are subscribed to the event");

      for (const delivery of deliveries) h.store.recordDeliveryFailure(delivery.id, 500, "boom", 12);
      // Four more failures push each to the terminal attempt.
      for (let attempt = 2; attempt <= 5; attempt++) {
        for (const delivery of h.store.listDeliveries(10)) {
          if (delivery.attempt === attempt) h.store.recordDeliveryFailure(delivery.id, 500, "boom", 12);
        }
      }

      const acmeDlq = h.registry.dlq(h.principal("acme"), 10);
      const globexDlq = h.registry.dlq(h.principal("globex"), 10);
      assert.ok(acmeDlq.length >= 1 && globexDlq.length >= 1);
      assert.ok(acmeDlq.every((item) => item.endpoint_id === mine.subscription.id));
      assert.ok(globexDlq.every((item) => item.endpoint_id === theirs.subscription.id));

      const foreign = globexDlq[0];
      expectCode("not_found", () => h.registry.replayDlq(h.principal("acme"), foreign.id));
      assert.equal(h.registry.dlq(h.principal("acme"), 10).length, acmeDlq.length, "nothing replayed");

      assert.deepEqual(h.registry.replayDlq(h.principal("globex"), foreign.id), { ok: true, replayed: true });
      const acmeDeliveries = h.registry.deliveries(h.principal("acme"), 50);
      assert.ok(acmeDeliveries.length > 0);
      assert.ok(
        acmeDeliveries.every((d) => d.endpoint_id === mine.subscription.id),
        "acme's listing never carries globex's rows"
      );
      assert.ok(
        h.registry.deliveries(h.principal("globex"), 50).every((d) => d.endpoint_id === theirs.subscription.id)
      );
    });

    it("rejects an unprovisioned tenant rather than defaulting it", async () => {
      const h = harness();
      const stranger: Principal = { tenantId: "not-a-tenant", keyId: "k1", authenticated: true };
      const err = expectCode("forbidden", () => h.registry.list(stranger));
      assert.equal(err.status, 403);
    });

    it("refuses a disabled tenant outright", () => {
      const directory = new TenantDirectory();
      directory.upsert({ tenantId: "acme", disabled: true });
      assert.throws(() => directory.principalFor("acme"));
      assert.equal(directory.resolveKey(directory.registerKey("acme").key), null);
    });

    it("resolves a key only through its digest", () => {
      const directory = new TenantDirectory();
      directory.upsert({ tenantId: "acme" });
      const issued = directory.registerKey("acme", "k1", "stdp_whk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      assert.deepEqual(directory.resolveKey("stdp_whk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), {
        tenantId: "acme",
        keyId: "k1",
        authenticated: true,
      });
      assert.equal(directory.resolveKey("stdp_whk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab"), null);
      assert.equal(directory.resolveKey(""), null);
      assert.equal(directory.enforcesAuthentication, true);
      assert.equal(JSON.stringify(directory.list()).includes("aaaaaaaa"), false, "no key material in listings");
      assert.equal(issued.keyId, "k1");
    });
  });

  describe("Quotas", () => {
    it("caps subscriptions per tenant, independently", async () => {
      const h = harness({ quotas: { acme: { maxSubscriptions: 2 } } });
      await h.registry.create(h.principal("acme"), { url: PUBLIC_URL });
      await h.registry.create(h.principal("acme"), { url: "https://93.184.216.35/hook" });

      const err = await expectCodeAsync("quota_subscriptions", () =>
        h.registry.create(h.principal("acme"), { url: "https://93.184.216.36/hook" })
      );
      assert.equal(err.status, 403);
      // A different tenant is unaffected by acme's ceiling.
      const other = await h.registry.create(h.principal("globex"), { url: PUBLIC_URL });
      assert.equal(other.subscription.tenant_id, "globex");
      assert.deepEqual(h.registry.list(h.principal("acme")).quota, { maxSubscriptions: 2, used: 2 });
    });

    it("caps how many events one subscription may select", async () => {
      const h = harness({ quotas: { acme: { maxEventsPerSubscription: 2 } } });
      await expectCodeAsync("quota_events", () =>
        h.registry.create(h.principal("acme"), {
          url: PUBLIC_URL,
          events: ["withdrawn", "stream_created", "stream_cancelled"],
        })
      );
      const ok = await h.registry.create(h.principal("acme"), {
        url: PUBLIC_URL,
        events: ["withdrawn", "stream_cancelled"],
      });
      assert.deepEqual(ok.subscription.events, ["withdrawn", "stream_cancelled"]);
    });

    it("rates secret rotations per hour", async () => {
      const h = harness({ quotas: { acme: { maxRotationsPerHour: 2 } } });
      const created = await h.registry.create(h.principal("acme"), { url: PUBLIC_URL });
      const id = created.subscription.id;
      h.registry.rotateSecret(h.principal("acme"), id);
      h.clock.advance(60_000);
      h.registry.rotateSecret(h.principal("acme"), id);
      const err = expectCode("quota_rotations", () => h.registry.rotateSecret(h.principal("acme"), id));
      assert.equal(err.status, 429);
      assert.ok(typeof err.details.retry_after_ms === "number");

      // The window rolls over.
      h.clock.advance(60 * 60 * 1000);
      assert.ok(h.registry.rotateSecret(h.principal("acme"), id).secret_once.startsWith("whsec_"));
    });

    it("validates event selections against the contract catalog", async () => {
      const h = harness();
      await expectCodeAsync("invalid_events", () =>
        h.registry.create(h.principal("acme"), { url: PUBLIC_URL, events: ["not_an_event"] })
      );
      await expectCodeAsync("invalid_events", () =>
        h.registry.create(h.principal("acme"), { url: PUBLIC_URL, events: ["*", "withdrawn"] })
      );
      await expectCodeAsync("invalid_events", () =>
        h.registry.create(h.principal("acme"), { url: PUBLIC_URL, events: [""] })
      );
      const wildcard = await h.registry.create(h.principal("acme"), { url: PUBLIC_URL, events: [] });
      assert.deepEqual(wildcard.subscription.events, ["*"]);
      assert.ok(RESERVED_EVENT_NAMES.includes("stream_ping"));
      assert.ok(ALL_CONTRACT_EVENT_NAMES.length > 40);
    });

    it("rejects malformed URLs before touching the store", async () => {
      const h = harness();
      await expectCodeAsync("invalid_url", () => h.registry.create(h.principal("acme"), { url: "" }));
      await expectCodeAsync("invalid_url", () => h.registry.create(h.principal("acme"), { url: "not a url" }));
      await expectCodeAsync("invalid_url", () =>
        h.registry.create(h.principal("acme"), { url: "ftp://93.184.216.34/hook" })
      );
      await expectCodeAsync("invalid_url", () =>
        h.registry.create(h.principal("acme"), { url: "https://user:pass@93.184.216.34/hook" })
      );
      await expectCodeAsync("invalid_secret", () =>
        h.registry.create(h.principal("acme"), { url: PUBLIC_URL, secret: "short" })
      );
      assert.equal(h.store.countEndpoints("acme"), 0);
    });
  });

  describe("Subscribe-time SSRF rejection", () => {
    const simulated: DnsLookupFunction = async (hostname) => {
      if (hostname === "example.com") return [{ address: "93.184.216.34", family: 4 }];
      return [{ address: "93.184.216.34", family: 4 }];
    };

    function withRecords(records: Array<{ address: string; family: number }>): DnsLookupFunction {
      return async () => records;
    }

    it("refuses every recorded bypass vector at subscribe time", async () => {
      const h = harness();
      const registry = new WebhookSubscriptionRegistry({
        store: h.store,
        directory: h.directory,
        validateUrl: (url) => validateWebhookUrl(url, withRecords([{ address: "127.0.0.1", family: 4 }])),
        now: h.clock.now,
        onAudit: (event) => h.audits.push(event),
      });
      // A resolver that always returns loopback must not admit any target.
      let rejected = 0;
      for (const fixture of SSRF_BYPASS_FIXTURES.filter((f) => !f.expectedSafe)) {
        await expectCodeAsync("ssrf_rejected", () => registry.create(h.principal("acme"), { url: fixture.target }));
        rejected += 1;
      }
      assert.equal(rejected, SSRF_BYPASS_FIXTURES.filter((f) => !f.expectedSafe).length);
      assert.equal(h.store.countEndpoints("acme"), 0, "no unsafe row was stored");
      assert.ok(
        h.audits.some((a) => a.action === "reject_ssrf"),
        "the rejection is auditable"
      );
    });

    it("keeps public destinations subscribable, fixture by fixture", async () => {
      const h = harness();
      for (const fixture of SSRF_BYPASS_FIXTURES.filter((f) => f.expectedSafe)) {
        const registry = new WebhookSubscriptionRegistry({
          store: h.store,
          directory: h.directory,
          validateUrl: (url) =>
            validateWebhookUrl(url, fixture.simulatedDnsRecords ? withRecords(fixture.simulatedDnsRecords) : simulated),
          now: h.clock.now,
        });
        const created = await registry.create(h.principal("acme"), { url: fixture.target });
        assert.equal(created.subscription.url, fixture.target, fixture.description);
      }
      assert.equal(h.store.countEndpoints("acme"), SSRF_BYPASS_FIXTURES.filter((f) => f.expectedSafe).length);
    });

    it("re-checks SSRF when a subscription's URL is moved", async () => {
      const h = harness();
      const created = await h.registry.create(h.principal("acme"), { url: PUBLIC_URL });
      const moving = new WebhookSubscriptionRegistry({
        store: h.store,
        directory: h.directory,
        validateUrl: () => Promise.resolve({ safe: false, reason: "resolved to loopback" }),
        now: h.clock.now,
      });
      await expectCodeAsync("ssrf_rejected", () =>
        moving.update(h.principal("acme"), created.subscription.id, { url: "http://127.0.0.1/hook" })
      );
      assert.equal(h.store.getEndpoint(created.subscription.id)?.url, PUBLIC_URL, "the row was not rewritten");
    });
  });

  describe("Zero-downtime rotation", () => {
    interface Captured {
      header: string;
      body: string;
    }

    function captureFetch(captures: Captured[]): void {
      globalThis.fetch = (async (_url: string | URL | undefined, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        captures.push({
          header: headers["Streampay-Signature"],
          body: String(init?.body),
        });
        return new Response("", { status: 200 });
      }) as typeof globalThis.fetch;
    }

    it("signs with both keys inside the window and only the new one after it", async () => {
      const h = harness({ cipher: cipher() });
      const created = await h.registry.create(h.principal("acme"), { url: PUBLIC_URL });
      const endpointId = created.subscription.id;
      const original = created.secret_once;

      const dispatcher = new WebhookDispatcher(h.store, 2000, { now: h.clock.now });
      const captures: Captured[] = [];
      const realFetch = globalThis.fetch;
      captureFetch(captures);
      try {
        const queueAndDispatch = async (): Promise<void> => {
          h.store.queueDeliveriesForEvent({
            id: `evt_${h.clock.at}`,
            name: "withdrawn",
            streamId: "1",
            ledgerClosedAt: new Date(h.clock.at).toISOString(),
            data: { amount: "10" },
          });
          await dispatcher.dispatchDueDeliveries();
        };

        await queueAndDispatch();
        assert.equal(captures.length, 1);

        // A consumer that holds only the original secret verifies.
        const rotate = h.registry.rotateSecret(h.principal("acme"), endpointId, { overlapMs: 1_000 });
        const replacement = rotate.secret_once;
        assert.notEqual(replacement, original);

        await queueAndDispatch();
        const mid = captures[1];
        assert.ok(verifySignatureHeader(mid.header, [replacement], mid.body).valid, "new key verifies");
        assert.ok(verifySignatureHeader(mid.header, [original], mid.body).valid, "old key still verifies");

        h.clock.advance(1_001);
        await queueAndDispatch();
        const after = captures[2];
        assert.ok(verifySignatureHeader(after.header, [replacement], after.body).valid);
        assert.equal(verifySignatureHeader(after.header, [original], after.body).valid, false);
        assert.equal(h.store.getEndpoint(endpointId)?.previous_secret, null, "overlap secret retired");
        assert.equal(verifySignatureHeader(captures[1].header, [replacement], captures[1].body).valid, true);
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it("expires a default-window rotation only after the window", async () => {
      const h = harness({ cipher: cipher() });
      const created = await h.registry.create(h.principal("acme"), { url: PUBLIC_URL });
      const rotated = h.registry.rotateSecret(h.principal("acme"), created.subscription.id);
      assert.equal(rotated.expires_at, h.clock.at + DEFAULT_ROTATION_OVERLAP_MS);
      assert.equal(h.store.activeSigningSecrets(h.store.getEndpoint(created.subscription.id)!).length, 2);
      assert.equal(h.registry.retireExpiredRotations(h.clock.at + DEFAULT_ROTATION_OVERLAP_MS).cleared, 1);
      assert.equal(h.store.activeSigningSecrets(h.store.getEndpoint(created.subscription.id)!).length, 1);
      assert.equal(h.registry.retireExpiredRotations(h.clock.at).cleared, 0, "idempotent");
    });

    it("keeps a rotation history that names no secret", async () => {
      const h = harness({ cipher: cipher() });
      const created = await h.registry.create(h.principal("acme"), { url: PUBLIC_URL });
      const first = h.registry.rotateSecret(h.principal("acme"), created.subscription.id);
      h.clock.advance(1000);
      const second = h.registry.rotateSecret(h.principal("acme"), created.subscription.id);

      const history = h.registry.rotationHistory(h.principal("acme"), created.subscription.id);
      assert.equal(history.length, 2);
      assert.equal(history[0].fingerprint, second.fingerprint);
      assert.equal(history[0].previous_fingerprint, first.fingerprint);
      const serialized = JSON.stringify(history);
      assert.ok(!serialized.includes(first.secret_once));
      assert.ok(!serialized.includes(second.secret_once));
      assert.ok(!serialized.includes("whsec_"));
    });
  });

  describe("Delivery SLA", () => {
    it("reports quantiles, breach rate and the alarm once the budget is blown", () => {
      const metrics = new WebhookMetrics({ slaMs: 1_000, minSamples: 3, breachBudget: 0.2, windowSize: 10 });
      for (const ms of [100, 200, 300, 400]) metrics.observeDelivery({ outcome: "delivered", latencyMs: ms, tenantId: "acme" });
      let snapshot = metrics.snapshot("acme");
      assert.equal(snapshot.samples, 4);
      assert.equal(snapshot.breaches, 0);
      assert.equal(snapshot.breached, false);

      metrics.observeDelivery({ outcome: "delivered", latencyMs: 2_000, tenantId: "acme" });
      metrics.observeDelivery({ outcome: "delivered", latencyMs: 3_000, tenantId: "acme" });
      metrics.observeDelivery({ outcome: "retry", latencyMs: 5_000, tenantId: "acme" });
      snapshot = metrics.snapshot("acme");
      assert.equal(snapshot.breaches, 3);
      assert.equal(snapshot.breachRate, 3 / 7);
      assert.equal(snapshot.breached, true, "3 of 7 over a 0.2 budget is a breach");
      assert.ok(snapshot.p50Ms >= 300 && snapshot.p50Ms <= 2_000);
      assert.ok(snapshot.p95Ms >= snapshot.p50Ms);
      assert.ok(snapshot.p99Ms >= snapshot.p95Ms);
      assert.equal(snapshot.maxMs, 5_000);
      assert.equal(metrics.isAlarmActive("acme"), true);
      assert.equal(metrics.snapshot("globex").samples, 0, "another tenant's budget is untouched");
    });

    it("does not alarm on a single blip below the sample floor", () => {
      const metrics = new WebhookMetrics({ slaMs: 100, minSamples: 5, breachBudget: 0.01 });
      metrics.observeDelivery({ outcome: "delivered", latencyMs: 10_000, tenantId: "acme" });
      assert.equal(metrics.snapshot("acme").breached, false, "one sample cannot prove a breach rate");
    });

    it("exposes the SLA per tenant through the registry", async () => {
      const h = harness({ slaMs: 500 });
      await h.registry.create(h.principal("acme"), { url: PUBLIC_URL });
      h.metrics.observeDelivery({ outcome: "delivered", latencyMs: 120, tenantId: "acme" });
      h.metrics.observeDelivery({ outcome: "delivered", latencyMs: 900, tenantId: "acme" });

      const report = h.registry.sla(h.principal("acme"));
      assert.equal(report.tenant_id, "acme");
      assert.equal(report.quota.used, 1);
      assert.equal(report.delivery?.breaches, 1);
      assert.equal(report.delivery?.samples, 2);
      assert.deepEqual(h.registry.breaches().map((b) => b.tenant_id), ["acme"]);

      const withoutMetrics = new WebhookSubscriptionRegistry({ store: h.store, directory: h.directory });
      assert.equal(withoutMetrics.sla(h.principal("acme")).delivery, null);
    });

    it("renders the exposition a dashboard scrapes", () => {
      const metrics = new WebhookMetrics({ slaMs: 1_000 });
      metrics.observeDelivery({ outcome: "delivered", latencyMs: 250, tenantId: "acme" });
      metrics.observeDelivery({ outcome: "dead_letter", latencyMs: 4_000, tenantId: "acme" });
      metrics.observeSubscription("active", 3);
      const body = metrics.render({ byState: { pending: 2, delivered: 1, dead_letter: 1 }, oldestPendingAgeMs: 9_000 });

      assert.match(body, /# TYPE streampay_webhook_delivery_latency_seconds_bucket histogram/);
      assert.match(body, /streampay_webhook_delivery_latency_seconds_bucket\{le="1"\} 1/);
      assert.match(body, /streampay_webhook_delivery_latency_seconds_bucket\{le="\+Inf"\} 2/);
      assert.match(body, /streampay_webhook_delivery_latency_seconds_count 2/);
      assert.match(body, /streampay_webhook_delivery_latency_seconds_sum 4\.25/);
      assert.match(body, /streampay_webhook_dispatch_total\{outcome="delivered"\} 1/);
      assert.match(body, /streampay_webhook_sla_breaches_total 1/);
      assert.match(body, /streampay_webhook_sla_objective_seconds 1/);
      assert.match(body, /streampay_webhook_sla_breach_alarm 0/);
      assert.match(body, /streampay_webhook_oldest_pending_seconds 9/);
      assert.match(body, /streampay_webhook_subscriptions\{status="active"\} 3/);
      assert.match(body, /streampay_webhook_sla_breached_by_tenant\{tenant_id="acme"\} 0/);
    });

    it("names one incident per tenant, endpoint and window", () => {
      assert.equal(slaIncidentId("acme", "wh_1", 1_000), slaIncidentId("acme", "wh_1", 1_000));
      assert.notEqual(slaIncidentId("acme", "wh_1", 1_000), slaIncidentId("globex", "wh_1", 1_000));
      assert.match(slaIncidentId("acme", "wh_1", 1_000), /^sla_[0-9a-f]{16}$/);
    });
  });

  describe("Redaction", () => {
    it("audits actions without secret material and with the URL masked", async () => {
      const h = harness({ cipher: cipher() });
      const created = await h.registry.create(h.principal("acme"), {
        url: "https://hooks.example.com/tenants/acme?token=supersecret",
        events: ["withdrawn"],
      });
      h.registry.rotateSecret(h.principal("acme"), created.subscription.id);

      const serialized = JSON.stringify(h.audits);
      assert.ok(!serialized.includes(created.secret_once), "no secret in the audit trail");
      assert.ok(!serialized.includes("supersecret"), "query credentials are stripped");
      assert.ok(!serialized.includes("hooks.example.com/tenants"), "path is stripped too");
      assert.match(serialized, /hooks\.example\.com\/\*\*\*/);
      assert.ok(h.audits.every((a) => a.url === undefined || a.url.endsWith("/***")));
      assert.ok(h.audits.some((a) => a.fingerprint?.startsWith("sha256:")));
    });

    it("never returns a secret on a read path", async () => {
      const h = harness({ cipher: cipher() });
      const created = await h.registry.create(h.principal("acme"), { url: PUBLIC_URL });
      const views = [
        h.registry.list(h.principal("acme")).subscriptions,
        [h.registry.get(h.principal("acme"), created.subscription.id)],
        h.registry.deliveries(h.principal("acme")),
        h.registry.dlq(h.principal("acme")),
      ];
      for (const view of views) {
        const serialized = JSON.stringify(view);
        assert.ok(!serialized.includes("whsec_"), serialized.slice(0, 120));
        assert.ok(!serialized.includes('"secret"'));
      }
      const subscription = h.registry.get(h.principal("acme"), created.subscription.id);
      assert.equal(
        Object.keys(subscription).sort().join(","),
        "created_at,events,id,rotation_expires_at,secret_fingerprint,status,tenant_id,updated_at,url"
      );
    });

    it("keeps tenant keys out of the directory after issue", () => {
      const directory = new TenantDirectory();
      directory.upsert({ tenantId: "acme" });
      const { key } = directory.registerKey("acme");
      assert.ok(!JSON.stringify(directory.list()).includes(key));
      assert.equal(directory.resolveKey(key)!.tenantId, "acme");
    });
  });

  describe("Configuration", () => {
    it("builds a directory from the environment and rejects malformed entries", () => {
      const { directory, defaultTenantId } = directoryFromEnv({
        WEBHOOK_TENANT_KEYS: "acme:k1:stdp_whk_0123456789abcdefg,globex:k2:stdp_whk_9876543210fedcba---",
        WEBHOOK_DEFAULT_TENANT_ID: "acme",
        WEBHOOK_TENANT_QUOTA_SUBSCRIPTIONS: "3",
      });
      assert.equal(defaultTenantId, "acme");
      assert.equal(directory.list().length, 2);
      assert.equal(directory.quotasFor("globex").maxSubscriptions, 3);
      assert.ok(directory.resolveKey("stdp_whk_0123456789abcdefg"));
      assert.throws(() => directoryFromEnv({ WEBHOOK_TENANT_KEYS: "acme:onlytwo" }), /tenantId:keyId:secret/);
      assert.throws(() => directoryFromEnv({ WEBHOOK_TENANT_QUOTA_SUBSCRIPTIONS: "-2" }), /non-negative/);
      assert.equal(directoryFromEnv({}).directory.enforcesAuthentication, false);
      assert.equal(directoryFromEnv({}).defaultTenantId, "default");
    });

    it("validates tenant and key identifiers", () => {
      const directory = new TenantDirectory();
      assert.throws(() => directory.upsert("Acme Corp"), /must match/);
      directory.upsert("acme");
      assert.throws(() => directory.registerKey("acme", "bad key id"), /must match/);
      assert.throws(() => directory.registerKey("nobody"), /unknown tenant/);
      assert.throws(() => directory.registerKey("acme", "k1", "short"), /entropy/);
      directory.registerKey("acme", "k1", "stdp_whk_aaaaaaaaaaaaaaaaaaaa");
      assert.throws(() => directory.registerKey("acme", "k1", "stdp_whk_bbbbbbbbbbbbbbbbbbbb"), /already registered/);
    });

    it("updates a subscription's selection and status", async () => {
      const h = harness();
      const created = await h.registry.create(h.principal("acme"), { url: PUBLIC_URL });
      const updated = await h.registry.update(h.principal("acme"), created.subscription.id, {
        events: ["stream_created", "withdrawn"],
        status: "disabled",
      });
      assert.deepEqual(updated.events, ["stream_created", "withdrawn"]);
      assert.equal(updated.status, "disabled");
      assert.equal(h.registry.get(h.principal("acme"), created.subscription.id).status, "disabled");
      // A disabled subscription stops receiving fan-out.
      h.store.queueDeliveriesForEvent({
        id: "evt_disabled",
        name: "withdrawn",
        streamId: "1",
        ledgerClosedAt: new Date(h.clock.at).toISOString(),
        data: {},
      });
      assert.equal(h.store.listDeliveriesForTenant("acme", 10).length, 0);
    });
  });

  describe("HTTP surface", () => {
    interface Session {
      baseUrl: string;
      acmeKey: string;
      globexKey: string;
      store: StreamStore;
      registry: WebhookSubscriptionRegistry;
      metrics: WebhookMetrics;
    }

    async function withApi(
      fn: (session: Session) => Promise<void>,
      options: { validateUrl?: (url: string) => Promise<SsrfCheckResult> } = {}
    ): Promise<void> {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "streampay-webhook-tenants-"));
      const dbPath = path.join(dir, "indexer.sqlite");
      const store = new StreamStore(dbPath, { webhookCipher: cipher() });
      try {
        const directory = new TenantDirectory();
        directory.upsert({ tenantId: "acme" });
        directory.upsert({ tenantId: "globex" });
        const acmeKey = directory.registerKey("acme", "k1").key;
        const globexKey = directory.registerKey("globex", "k1").key;
        const metrics = new WebhookMetrics({ slaMs: 500, minSamples: 3, windowSize: 10 });
        const registry = new WebhookSubscriptionRegistry({
          store: store.webhooks,
          directory,
          metrics,
          validateUrl: options.validateUrl ?? publicDestination,
        });
        const api: WebhookApiConfig = { directory, registry, metrics, defaultTenantId: "acme" };
        const app = createApp(store, undefined, undefined, undefined, undefined, undefined, undefined, api);
        const server = http.createServer(app);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const { port } = server.address() as { port: number };
        try {
          await fn({ baseUrl: `http://127.0.0.1:${port}`, acmeKey, globexKey, store, registry, metrics });
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    async function call(
      baseUrl: string,
      method: string,
      route: string,
      options: { key?: string; body?: unknown } = {}
    ): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
      const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(options.key === undefined ? {} : { "x-streampay-webhook-key": options.key }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const text = await response.text();
      let json: Record<string, unknown> = {};
      try {
        json = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
      } catch {}
      return { status: response.status, text, json };
    }

    it("refuses every registry route without a tenant key", async () => {
      await withApi(async (session) => {
        for (const [method, route] of [
          ["GET", "/api/webhooks/endpoints"],
          ["POST", "/api/webhooks/endpoints"],
          ["GET", "/api/webhooks/quota"],
          ["GET", "/api/webhooks/sla"],
        ] as const) {
          const response = await call(session.baseUrl, method, route, {
            body: method === "POST" ? { url: PUBLIC_URL } : undefined,
          });
          assert.equal(response.status, 401, `${method} ${route}`);
          assert.equal(response.json.code, "unauthenticated");
        }
        // A key that belongs to nobody is answered the same way.
        const wrong = await call(session.baseUrl, "GET", "/api/webhooks/endpoints", {
          key: "stdp_whk_not_a_real_key_at_all",
        });
        assert.equal(wrong.status, 401);
      });
    });

    it("discloses the signing secret on creation and never again", async () => {
      await withApi(async (session) => {
        const created = await call(session.baseUrl, "POST", "/api/webhooks/endpoints", {
          key: session.acmeKey,
          body: { url: PUBLIC_URL, events: ["withdrawn"] },
        });
        assert.equal(created.status, 201);
        assert.equal(typeof created.json.id, "string");
        assert.match(String(created.json.secret), /^whsec_/);
        assert.match(String(created.json.secret_fingerprint), /^sha256:[0-9a-f]{16}$/);
        const id = String(created.json.id);
        const secret = String(created.json.secret);

        for (const route of [
          `/api/webhooks/endpoints/${id}`,
          "/api/webhooks/endpoints",
          "/api/webhooks/quota",
          "/api/webhooks/deliveries",
        ]) {
          const read = await call(session.baseUrl, "GET", route, { key: session.acmeKey });
          assert.equal(read.status, 200, route);
          assert.ok(!read.text.includes(secret), `${route} returned the secret`);
          assert.ok(!read.text.includes("whsec_"), `${route} returned secret material`);
          assert.ok(!read.text.includes('"secret"'), `${route} returned a secret field`);
        }

        const rotation = await call(session.baseUrl, "POST", `/api/webhooks/endpoints/${id}/rotate-secret`, {
          key: session.acmeKey,
        });
        assert.equal(rotation.status, 200);
        assert.match(String(rotation.json.secret), /^whsec_/);
        assert.equal(rotation.json.previous_secret, null);
        const history = await call(session.baseUrl, "GET", `/api/webhooks/endpoints/${id}/rotations`, {
          key: session.acmeKey,
        });
        assert.equal(history.status, 200);
        assert.ok(!history.text.includes(String(rotation.json.secret)));

        const deleted = await call(session.baseUrl, "DELETE", `/api/webhooks/endpoints/${id}`, {
          key: session.acmeKey,
        });
        assert.deepEqual(deleted.json, { ok: true });
      });
    });

    it("answers a foreign tenant's id with 404 and no details", async () => {
      await withApi(async (session) => {
        const created = await call(session.baseUrl, "POST", "/api/webhooks/endpoints", {
          key: session.acmeKey,
          body: { url: "https://93.184.216.35/hook" },
        });
        const id = String(created.json.id);

        for (const [method, route] of [
          ["GET", `/api/webhooks/endpoints/${id}`],
          ["PATCH", `/api/webhooks/endpoints/${id}`],
          ["DELETE", `/api/webhooks/endpoints/${id}`],
          ["POST", `/api/webhooks/endpoints/${id}/rotate-secret`],
          ["GET", `/api/webhooks/endpoints/${id}/rotations`],
        ] as const) {
          const response = await call(session.baseUrl, method, route, {
            key: session.globexKey,
            body: method === "PATCH" ? { status: "disabled" } : undefined,
          });
          assert.equal(response.status, 404, `${method} ${route}`);
          assert.equal(response.json.code, "not_found");
          assert.ok(!response.text.includes("93.184.216.35"), "the row is not described");
        }

        // The owner is untouched.
        const owner = await call(session.baseUrl, "GET", `/api/webhooks/endpoints/${id}`, {
          key: session.acmeKey,
        });
        assert.equal(owner.status, 200);
        assert.equal(owner.json.tenant_id, "acme");
      });
    });

    it("reports quota, SLA and the scraped metrics for the caller's tenant", async () => {
      await withApi(async (session) => {
        const created = await call(session.baseUrl, "POST", "/api/webhooks/endpoints", {
          key: session.acmeKey,
          body: { url: PUBLIC_URL },
        });
        assert.equal(created.status, 201);
        session.metrics.observeDelivery({ outcome: "delivered", latencyMs: 120, tenantId: "acme" });
        session.metrics.observeDelivery({ outcome: "retry", latencyMs: 900, tenantId: "acme" });

        const quota = await call(session.baseUrl, "GET", "/api/webhooks/quota", { key: session.acmeKey });
        assert.deepEqual(quota.json, { maxSubscriptions: 20, used: 1 });

        const sla = await call(session.baseUrl, "GET", "/api/webhooks/sla", { key: session.acmeKey });
        assert.equal(sla.json.tenant_id, "acme");
        const delivery = sla.json.delivery as Record<string, unknown>;
        assert.equal(delivery.samples, 2);
        assert.equal(delivery.breaches, 1);
        assert.equal(delivery.slaMs, 500);

        const other = await call(session.baseUrl, "GET", "/api/webhooks/sla", { key: session.globexKey });
        assert.equal((other.json.delivery as Record<string, unknown>).samples, 0);

        const scrape = await fetch(`${session.baseUrl}/metrics`);
        assert.equal(scrape.status, 200);
        const body = await scrape.text();
        assert.match(body, /streampay_webhook_subscriptions\{status="active"\} 1/);
        assert.match(body, /streampay_webhook_sla_objective_seconds 0\.5/);
        assert.match(body, /streampay_webhook_delivery_latency_seconds_count 2/);
        assert.match(body, /streampay_webhook_sla_breached_by_tenant\{tenant_id="acme"\} 0/);
        assert.ok(!body.includes("whsec_"), "the scrape carries no secret material");

        const expired = await call(session.baseUrl, "POST", "/api/webhooks/rotations/expire", {
          key: session.acmeKey,
        });
        assert.deepEqual(expired.json, { cleared: 0 });
      });
    });

    it("keeps the single-tenant deployment working without a registry", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "streampay-webhook-legacy-"));
      const store = new StreamStore(path.join(dir, "legacy.sqlite"));
      const server = http.createServer(createApp(store));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${port}`;
      try {
        const created = await call(baseUrl, "POST", "/api/webhooks/endpoints", {
          body: { url: PUBLIC_URL, events: ["withdrawn"] },
        });
        assert.equal(created.status, 200);
        assert.match(String(created.json.secret), /^whsec_/);

        const list = await call(baseUrl, "GET", "/api/webhooks/endpoints");
        assert.equal(list.status, 200);
        assert.equal((list.json as unknown as unknown[]).length, 1);

        // Registry-only routes are the ones a legacy deployment cannot answer.
        for (const route of ["/api/webhooks/quota", "/api/webhooks/sla"]) {
          const response = await call(baseUrl, "GET", route);
          assert.equal(response.status, 503, route);
          assert.equal(response.json.code, "registry_unavailable");
        }
        const moved = await call(baseUrl, "PATCH", `/api/webhooks/endpoints/${String(created.json.id)}`, {
          body: { status: "disabled" },
        });
        assert.equal(moved.status, 503);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("rejects an unsafe subscription URL at the HTTP boundary", async () => {
      await withApi(
        async (session) => {
          const response = await call(session.baseUrl, "POST", "/api/webhooks/endpoints", {
            key: session.acmeKey,
            body: { url: "http://127.0.0.1:9000/hook" },
          });
          assert.equal(response.status, 400);
          assert.equal(response.json.code, "ssrf_rejected");
          const details = response.json.details as Record<string, unknown>;
          assert.equal(details.url, "http://127.0.0.1:9000/***", "the rejection is redacted");
          const list = await call(session.baseUrl, "GET", "/api/webhooks/endpoints", { key: session.acmeKey });
          assert.equal((list.json as unknown as unknown[]).length, 0);
        },
        // The boundary check is the real one: an IP literal needs no resolver.
        { validateUrl: (url: string) => validateWebhookUrl(url) }
      );
    });
  });
});
