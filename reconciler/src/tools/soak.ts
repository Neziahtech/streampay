#!/usr/bin/env node
//! Soak harness for the reconciler: drives the dual-read engine through lag
//! scenarios, then one merkleized audit cycle, and prints a report section
//! suitable for the PR description.

import { ReconciliationEngine, type AlertTransport } from "../engine/diff.js";
import { DEFAULT_POLICY } from "../audit/canonical.js";
import { ContinuousAuditor, type AuditSink, type StateReader } from "../audit/publication.js";
import type { StreamState } from "../types.js";
import type { AuditRecord } from "../audit/canonical.js";

interface CapturedAlerting extends AlertTransport {
  logs: Array<{ level: string; message: string; details: Record<string, unknown> }>;
  webhooks: unknown[];
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

interface Reader {
  pollStreams(ids: string[]): Promise<StreamState[]>;
  healthCheck(): Promise<{ healthy: boolean; error?: string }>;
}

/** Reads the same stream, optionally as of `delayMs` in the past. */
function reader(delayMs: number, withdrawn: string): Reader {
  return {
    async pollStreams(streamIds) {
      const at = Date.now() - delayMs;
      return streamIds.map((id) => ({
        streamId: id,
        ledger: Math.floor(at / 1000),
        timestamp: new Date(at).toISOString(),
        data: { deposit: "1000", withdrawn, status: "Active" as const },
      }));
    },
    async healthCheck() {
      return { healthy: true };
    },
  };
}

interface Scenario {
  name: string;
  horizonDelayMs: number;
  sorobanDelayMs: number;
  expectedDivergences: number;
}

const SCENARIOS: Scenario[] = [
  { name: "Baseline: both sources fresh and in sync", horizonDelayMs: 0, sorobanDelayMs: 0, expectedDivergences: 0 },
  { name: "Soroban RPC delay within the consistency window", horizonDelayMs: 0, sorobanDelayMs: 15_000, expectedDivergences: 0 },
  { name: "Soroban RPC delay outside the consistency window", horizonDelayMs: 0, sorobanDelayMs: 45_000, expectedDivergences: 1 },
  { name: "Horizon delay causing apparent divergence", horizonDelayMs: 45_000, sorobanDelayMs: 0, expectedDivergences: 1 },
  { name: "Both sources delayed but in agreement", horizonDelayMs: 45_000, sorobanDelayMs: 45_000, expectedDivergences: 0 },
];

interface ScenarioResult {
  scenario: Scenario;
  detected: number;
  dispatched: number;
  passed: boolean;
}

async function runScenarios(): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];

  for (const scenario of SCENARIOS) {
    const service = alerting();
    const dual = new ReconciliationEngine({ consistencyWindowMs: 30_000, alertingService: service });
    const streamId = "soak-stream-001";
    const [horizonStates, sorobanStates] = await Promise.all([
      reader(scenario.horizonDelayMs, "750").pollStreams([streamId]),
      reader(scenario.sorobanDelayMs, "500").pollStreams([streamId]),
    ]);
    const outcome = await dual.reconcile(horizonStates, sorobanStates);
    const detected = outcome.divergences.length;
    results.push({
      scenario,
      detected,
      dispatched: service.webhooks.length,
      passed: detected === scenario.expectedDivergences,
    });
    process.stdout.write(
      `${detected === scenario.expectedDivergences ? "PASS" : "FAIL"}  ${scenario.name}` +
        ` (divergences ${detected}, expected ${scenario.expectedDivergences}, dispatched ${service.webhooks.length})\n`
    );
  }
  return results;
}

/** One in-memory sink, so the audit cycle can be inspected after it ran. */
class CollectingSink implements AuditSink {
  published: unknown[] = [];
  checkpoints: unknown[] = [];
  async publish(envelope: unknown): Promise<void> {
    this.published.push(envelope);
  }
  async loadCheckpoint(): Promise<null> {
    return null;
  }
  async saveCheckpoint(checkpoint: unknown): Promise<void> {
    this.checkpoints.push(checkpoint);
  }
}

function auditRecord(id: string, withdrawn: string): AuditRecord {
  return {
    streamId: id,
    sender: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    recipient: "SBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    token: "CT7777777777777777777777777777777777777777777777777777",
    deposit: "1000",
    withdrawn,
    startTime: "1000",
    endTime: "2000",
    cancelable: true,
    status: "Active",
  };
}

async function runAuditCycle(): Promise<string> {
  const onchain: StateReader = { read: async () => ({ ledger: 500, records: [auditRecord("1", "750"), auditRecord("2", "100")] }) };
  const projected: StateReader = { read: async () => ({ ledger: 500, records: [auditRecord("1", "755"), auditRecord("2", "900")] }) };

  const sink = new CollectingSink();
  const auditor = new ContinuousAuditor({ onchain, projected }, sink, {
    intervalMs: 60_000,
    artifactRecordLimit: 50,
    policy: { ...DEFAULT_POLICY, tolerance: { epsilon: "10", comparison: "floor_div" } },
  });
  const outcome = await auditor.runCycle(Date.now());
  const report = outcome.report;
  if (report === null) throw new Error("the soak audit produced no report");
  const kinds = report.witnesses.map((witness) => `${witness.stream_id}:${witness.kind}`).join(", ");
  process.stdout.write(
    `\naudit cycle ${outcome.cycle}: verdict ${report.verdict} on ledger ${report.ledger.onchain}` +
      `\n  onchain root  ${report.roots.onchain_raw}\n  projected root ${report.roots.projected_raw}` +
      `\n  witnesses: ${kinds || "none"}\n  alerts: ${outcome.alerts.map((a) => a.type).join(", ") || "none"}\n`
  );
  return report.verdict;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  process.stdout.write("reconciler soak\n".toUpperCase());
  const results = await runScenarios();
  const verdict = await runAuditCycle();
  const failed = results.filter((result) => !result.passed).length;

  process.stdout.write("\n```markdown\n## Soak results\n\n");
  process.stdout.write("| Scenario | Expected | Actual | Status |\n|---|---|---|---|\n");
  for (const result of results) {
    process.stdout.write(
      `| ${result.scenario.name} | ${result.scenario.expectedDivergences} | ${result.detected} | ${result.passed ? "PASS" : "FAIL"} |\n`
    );
  }
  process.stdout.write(`\nMerkleized audit cycle verdict: \`${verdict}\`.\n`);
  process.stdout.write(`\n${results.length - failed}/${results.length} scenarios reproduced in ${Date.now() - startedAt}ms\n`);
  process.stdout.write("```\n");
  if (failed > 0) process.exitCode = 1;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("soak.js")) {
  await main();
}
