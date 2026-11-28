import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_POLICY, computePolicyDigest } from "./audit/canonical.js";
import { auditPolicyFromConfig, getMonitoredStreamIds, loadConfig } from "./index.js";

const AUDIT_ENV = [
  "HORIZON_URL",
  "SOROBAN_RPC_URL",
  "WEBHOOK_URL",
  "LOG_LEVEL",
  "ENVIRONMENT",
  "RECONCILER_ID",
  "CONSISTENCY_WINDOW_MS",
  "POLL_INTERVAL_MS",
  "STREAM_IDS",
  "AUDIT_DIR",
  "AUDIT_INTERVAL_MS",
  "AUDIT_ARTIFACT_LIMIT",
  "AUDIT_TOLERANCE_EPSILON",
  "AUDIT_FLAP_WINDOW_MS",
] as const;

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const saved = AUDIT_ENV.map((name) => [name, process.env[name]] as const);
  for (const name of AUDIT_ENV) delete process.env[name];
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) process.env[name] = value;
  }
  try {
    run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("reconciler configuration", () => {
  afterEach(() => {
    for (const name of AUDIT_ENV) delete process.env[name];
  });

  it("falls back to testnet defaults with a strict audit", () => {
    withEnv({}, () => {
      const config = loadConfig();
      assert.equal(config.horizonUrl, "https://horizon-testnet.stellar.org");
      assert.equal(config.consistencyWindowMs, 30_000);
      assert.equal(config.audit.directory, "audit-out");
      assert.equal(config.audit.intervalMs, 60_000);
      assert.equal(config.audit.flapWindowMs, 120_000);
      assert.equal(auditPolicyFromConfig(config).tolerance.epsilon, DEFAULT_POLICY.tolerance.epsilon);
      assert.deepEqual(getMonitoredStreamIds(), []);
    });
  });

  it("carries the tolerance epsilon into the policy that hashes the roots", () => {
    withEnv({ AUDIT_TOLERANCE_EPSILON: "10" }, () => {
      const policy = auditPolicyFromConfig(loadConfig());
      assert.deepEqual(policy.tolerance, { epsilon: "10", comparison: "floor_div" });
      assert.equal(policy.version, 1);
      assert.notEqual(computePolicyDigest(policy), computePolicyDigest(DEFAULT_POLICY));
    });
  });

  it("rejects an unusable number rather than auditing at zero interval", () => {
    withEnv({ AUDIT_INTERVAL_MS: "-1" }, () => {
      assert.throws(() => loadConfig(), /AUDIT_INTERVAL_MS must be a non-negative integer/);
    });
    withEnv({ POLL_INTERVAL_MS: "often" }, () => {
      assert.throws(() => loadConfig(), /POLL_INTERVAL_MS/);
    });
    withEnv({ LOG_LEVEL: "SHOUT" }, () => {
      assert.throws(() => loadConfig(), /LOG_LEVEL/);
    });
  });

  it("accepts an empty value as the default", () => {
    withEnv({ AUDIT_ARTIFACT_LIMIT: "", AUDIT_DIR: "/srv/audit" }, () => {
      const config = loadConfig();
      assert.equal(config.audit.artifactRecordLimit, 2_000);
      assert.equal(config.audit.directory, "/srv/audit");
    });
  });

  it("parses the monitored stream list defensively", () => {
    withEnv({ STREAM_IDS: " 7 , 8,, 9 " }, () => {
      assert.deepEqual(getMonitoredStreamIds(), ["7", "8", "9"]);
    });
  });
});
