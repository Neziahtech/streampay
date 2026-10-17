import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAlert, alertText, emitAlert } from "../src/alert.ts";
import { BackendError } from "../src/errors.ts";
import { runLifecycle, type LifecycleOutcome } from "../src/lifecycle.ts";
import { buildReport, type CanaryReport } from "../src/report.ts";
import type { CanaryConfig } from "../src/config.ts";
import type { GitInfo } from "../src/types.ts";
import { FakeBackend } from "./fake-backend.ts";

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM";
const DEPOSIT = 1_000_000n;

const GIT: GitInfo = {
  sha: "abcdef1234567890",
  subject: "feat: stream accrual",
  author: "dev",
  date: "2026-10-17T00:00:00Z",
  pullRequest: 42,
  contract: {
    sha: "1234567890abcdef",
    subject: "fix: accrual rounding",
    author: "dev",
    date: "2026-10-16T00:00:00Z",
    pullRequest: 41,
  },
  frontendOps: {
    sha: "fedcba0987654321",
    subject: "refactor: share contract ops",
    author: "dev",
    date: "2026-10-15T00:00:00Z",
    pullRequest: 40,
  },
};

function config(): CanaryConfig {
  return {
    dryRun: false,
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    friendbotUrl: "https://friendbot.stellar.org",
    contractId: CONTRACT,
    tokenId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    deposit: DEPOSIT,
    windowSeconds: 120,
    pollIntervalMs: 1000,
    waitTimeoutMs: 5000,
    reportPath: "canary-report.json",
    run: {
      workflow: "canary",
      job: "canary",
      runId: "123",
      runUrl: "https://github.com/Neziahtech/streampay/actions/runs/123",
      actor: "scheduler",
      sha: GIT.sha,
      ref: "refs/heads/main",
      repository: "Neziahtech/streampay",
      eventName: "schedule",
      attempt: "1",
    },
  };
}

async function run(
  fake: FakeBackend,
  forceFailAt?: string
): Promise<LifecycleOutcome> {
  return runLifecycle({
    backend: fake,
    deposit: DEPOSIT,
    windowSeconds: 120,
    waitTimeoutMs: 5_000,
    pollIntervalMs: 1_000,
    nowSeconds: () => fake.clock,
    sleep: fake.sleep,
    forceFailAt,
  });
}

function reportFor(outcome: LifecycleOutcome): CanaryReport {
  return buildReport({
    startedAt: "2026-10-17T00:00:00.000Z",
    finishedAt: "2026-10-17T00:00:10.000Z",
    config: config(),
    git: GIT,
    outcome,
  });
}

test("the full lifecycle passes and records every step", async () => {
  const fake = new FakeBackend();
  const outcome = await run(fake);

  assert.equal(outcome.failure, null);
  assert.deepEqual(
    outcome.steps.map((step) => step.name),
    [
      "prepare",
      "create-stream",
      "wait-accrual",
      "withdraw-partial",
      "wait-accrual-2",
      "withdraw-max",
      "cancel",
      "verify",
    ]
  );
  assert.ok(outcome.steps.every((step) => step.status === "passed"));
  assert.equal(outcome.finalStream?.status, "Cancelled");
  assert.ok(outcome.steps.every((step) => step.durationMs >= 0));
  assert.ok(
    outcome.steps.filter((step) => step.txHash !== undefined).length >= 4,
    "prepare/create/withdraw/cancel should record tx hashes"
  );

  const report = reportFor(outcome);
  assert.equal(report.status, "success");
  assert.equal(report.stream?.id, "1");
  assert.equal(report.forcedFailure, false);
});

test("a forced failure names the step and carries the alert payload", async () => {
  const fake = new FakeBackend();
  const outcome = await run(fake, "withdraw-partial");
  const report = reportFor(outcome);
  const alert = buildAlert(report);

  assert.equal(report.status, "failure");
  assert.equal(report.forcedFailure, true);
  assert.equal(outcome.failure?.step, "withdraw-partial");
  assert.equal(outcome.failure?.failureClass, "simulation");
  assert.ok(alert);
  assert.equal(alert.step.name, "withdraw-partial");
  assert.equal(alert.step.index, 3);
  assert.equal(alert.rpc.method, "simulateTransaction");
  assert.match(alert.rpc.excerpt ?? "", /forced by --force-fail-at/);
  assert.match(alert.xdr.transactionEnvelope ?? "", /FORCED-TRANSACTION-XDR/);
  assert.match(alert.step.hint, /simulation/i);
  assert.match(alertText(alert), /withdraw-partial/);
});

test("a contract simulation error is classified with its code and XDR", async () => {
  const fake = new FakeBackend();
  fake.failAt.withdraw = new BackendError(
    "simulation",
    "HostError: Error(Contract, #10)",
    {
      rpcMethod: "simulateTransaction",
      rpcExcerpt: "HostError: Error(Contract, #10) AmountExceedsAvailable",
      transactionXdr: "AAAA-WITHDRAW-ENVELOPE",
    }
  );

  const outcome = await run(fake);
  assert.equal(outcome.failure?.step, "withdraw-partial");
  assert.equal(outcome.failure?.failureClass, "simulation");

  const alert = buildAlert(reportFor(outcome));
  assert.ok(alert);
  assert.equal(alert.rpc.method, "simulateTransaction");
  assert.match(alert.rpc.excerpt ?? "", /#10/);
  assert.equal(alert.xdr.transactionEnvelope, "AAAA-WITHDRAW-ENVELOPE");
  assert.equal(alert.stream?.id, "1");
});

test("a wrong post-condition is an assertion failure, not a transport error", async () => {
  const fake = new FakeBackend();
  fake.tamperWithdrawn = true;
  const outcome = await run(fake);

  assert.equal(outcome.failure?.step, "withdraw-max");
  assert.equal(outcome.failure?.failureClass, "assertion");
  assert.match(outcome.failure?.message ?? "", /withdrawn total equals partial \+ max/);
});

test("alerts post to a webhook and never fail the run", async () => {
  const fake = new FakeBackend();
  const alert = buildAlert(reportFor(await run(fake, "create-stream")));
  assert.ok(alert);

  const calls: Array<{ url: string; body: unknown }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  await emitAlert(alert, {
    webhook: "https://hooks.slack.com/services/T/B/X",
    githubActions: false,
    fetchImpl: fakeFetch,
  });

  assert.equal(calls.length, 1);
  const body = calls[0]!.body as { text: string };
  assert.match(body.text, /create-stream/);
  assert.match(body.text, /simulation/);

  const failingFetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  await emitAlert(alert, { webhook: "https://example.test/hook", fetchImpl: failingFetch });
});
