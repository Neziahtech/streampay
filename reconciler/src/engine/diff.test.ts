import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ReconciliationEngine, type AlertTransport } from "./diff.js";
import type { DivergenceRecord, StreamState, StreamStatus } from "../types.js";

interface CapturedAlerting extends AlertTransport {
  logs: Array<{ level: string; message: string; details: Record<string, unknown> }>;
  webhooks: DivergenceRecord[];
}

function alerting(): CapturedAlerting {
  return {
    logs: [],
    webhooks: [],
    log(level, message, details = {}) {
      this.logs.push({ level, message, details });
    },
    async dispatchWebhook(divergence) {
      this.webhooks.push(divergence);
      return { success: true, status: 200 };
    },
  };
}

function state(
  streamId: string,
  options: { deposit?: string; withdrawn?: string; status?: StreamStatus; ledger?: number } = {}
): StreamState {
  const ledger = options.ledger ?? 100_000;
  return {
    streamId,
    ledger,
    timestamp: new Date(Date.now() - ledger * 1000).toISOString(),
    data: {
      deposit: options.deposit ?? "1000",
      withdrawn: options.withdrawn ?? "100",
      status: options.status ?? "Active",
    },
  };
}

function engine(
  consistencyWindowMs = 30_000,
  service: AlertTransport = alerting(),
  alertGate?: (keys: string[], atMs: number) => string[]
): ReconciliationEngine {
  return new ReconciliationEngine({ consistencyWindowMs, alertingService: service, alertGate });
}

describe("reconciliation engine", () => {
  it("counts perfectly matching reads as in sync", async () => {
    const a = state("1", { withdrawn: "250" });
    const b = state("2", { deposit: "5000", withdrawn: "1500" });
    const result = await engine().reconcile([a, b], [a, b]);
    assert.equal(result.totalChecked, 2);
    assert.equal(result.inSync, 2);
    assert.equal(result.withinLagWindow, 0);
    assert.deepEqual(result.divergences, []);
  });

  it("treats a difference still propagating as lag, not divergence", async () => {
    const result = await engine().reconcile(
      [state("1", { withdrawn: "200", ledger: 100_000 })],
      [state("1", { withdrawn: "210", ledger: 100_001 })]
    );
    assert.equal(result.inSync, 0);
    assert.equal(result.withinLagWindow, 1);
    assert.deepEqual(result.divergences, []);
  });

  it("flags a stale read outside the consistency window", async () => {
    const service = alerting();
    const result = await engine(30_000, service).reconcile(
      [state("1", { withdrawn: "500", ledger: 90_000 })],
      [state("1", { withdrawn: "200", ledger: 100_000 })]
    );
    assert.equal(result.divergences.length, 1);
    const divergence = result.divergences[0]!;
    assert.equal(divergence.streamId, "1");
    assert.equal(divergence.checkType, "stream_balance");
    assert.equal(divergence.severity, "critical");
    assert.equal(service.webhooks.length, 1);
  });

  it("classifies a status-only difference as a warning and does not page", async () => {
    const service = alerting();
    const result = await engine(30_000, service).reconcile(
      [state("1", { status: "Active", ledger: 1 })],
      [state("1", { status: "Cancelled", ledger: 100_000 })]
    );
    assert.equal(result.divergences[0]?.checkType, "stream_status");
    assert.equal(result.divergences[0]?.severity, "warning");
    assert.deepEqual(service.webhooks, [], "only critical divergences dispatch");
  });

  it("reports a record present on only one side", async () => {
    const missingOnChain = await engine().reconcile([state("1")], []);
    assert.equal(missingOnChain.divergences[0]?.checkType, "missing_record");
    assert.equal(missingOnChain.divergences[0]?.severity, "critical");

    const missingInIndex = await engine().reconcile([], [state("1")]);
    assert.equal(missingInIndex.divergences[0]?.checkType, "missing_record");
    assert.equal(missingInIndex.divergences[0]?.severity, "warning");
  });

  it("measures the ledger gap between the two reads", async () => {
    const result = await engine().reconcile(
      [state("1", { ledger: 100_000 }), state("2", { ledger: 99_000 })],
      []
    );
    assert.ok(result.ledgerGap >= 999);
    assert.equal(result.totalChecked, 2);
  });

  it("stamps the result from the cycle time it was given", async () => {
    const at = Date.parse("2026-11-20T00:00:00.000Z");
    const result = await engine().reconcile([state("1")], [state("1")], at);
    assert.equal(result.timestamp, new Date(at).toISOString());
  });

  it("logs a machine-readable summary every cycle", async () => {
    const service = alerting();
    await engine(30_000, service).reconcile([state("1")], [state("1")]);
    const summary = service.logs.find((entry) => entry.message === "Reconciliation complete");
    assert.ok(summary !== undefined);
    assert.equal(summary.details.totalChecked, 1);
    assert.equal(summary.details.divergences, 0);
    assert.equal(summary.details.dispatched, 0);
  });

  it("routes divergent keys through the alert gate so a flapping incident is not re-paged", async () => {
    const service = alerting();
    const seen: string[][] = [];
    const gated = engine(30_000, service, (keys, atMs) => {
      seen.push([...keys]);
      assert.equal(typeof atMs, "number");
      // Suppress everything after the first sighting, as the deduper would.
      return keys.slice(0, 1);
    });

    const a = [state("1", { withdrawn: "500", ledger: 1 }), state("2", { withdrawn: "500", ledger: 1 })];
    const b = [state("1", { withdrawn: "200", ledger: 100_000 }), state("2", { withdrawn: "200", ledger: 100_000 })];
    const result = await gated.reconcile(a, b, 1_000);
    assert.equal(result.divergences.length, 2);
    assert.deepEqual(seen, [["1", "2"]]);
    assert.equal(service.webhooks.length, 1, "only the gate's first key dispatches");
    assert.equal(service.webhooks[0]?.streamId, "1");
  });

  it("dispatches every critical divergence when no gate is configured", async () => {
    const service = alerting();
    const stale = ["1", "2", "3"].map((id) => state(id, { withdrawn: "500", ledger: 1 }));
    const fresh = ["1", "2", "3"].map((id) => state(id, { withdrawn: "100", ledger: 100_000 }));
    await engine(30_000, service).reconcile(stale, fresh);
    assert.deepEqual(service.webhooks.map((w) => w.streamId), ["1", "2", "3"]);
  });

  it("polls readers until it is asked to stop", async () => {
    const service = alerting();
    const horizonPolls: string[] = [];
    const sorobanPolls: string[] = [];
    const reader = (log: string[]) => ({
      pollStreams: async (ids: string[]) => {
        log.push(ids.join(","));
        return ids.map((id) => state(id));
      },
      healthCheck: async () => ({ healthy: true }),
    });
    await engine(1, service).startContinuousReconciliation(
      reader(horizonPolls),
      reader(sorobanPolls),
      ["1", "2"],
      {
        maxCycles: 5,
        shouldStop: () => horizonPolls.length >= 1,
        onError: () => {},
      }
    );
    assert.deepEqual(horizonPolls, ["1,2"], "shouldStop is checked before the next poll");
    assert.deepEqual(sorobanPolls, ["1,2"]);
  });

  it("reports reader failures through onError and keeps going", async () => {
    const service = alerting();
    const errors: unknown[] = [];
    let calls = 0;
    const failing = {
      pollStreams: async () => {
        calls += 1;
        throw new Error("rpc unavailable");
      },
      healthCheck: async () => ({ healthy: false, error: "down" }),
    };
    const healthy = {
      pollStreams: async (ids: string[]) => ids.map((id) => state(id)),
      healthCheck: async () => ({ healthy: true }),
    };
    await engine(1, service).startContinuousReconciliation(failing, healthy, ["1"], {
      maxCycles: 1,
      onError: (error) => errors.push(error),
    });
    assert.equal(calls, 1);
    assert.match(String(errors[0]), /rpc unavailable/);
  });
});
