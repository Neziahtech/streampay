import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { renderAlert } from "../alert.mjs";
import { deriveRecipientKeypair } from "../runner.ts";

const runnerPath = fileURLToPath(new URL("../runner.ts", import.meta.url));
const packagePath = fileURLToPath(new URL("..", import.meta.url));

test("recipient keypair is stable and distinct from the bot keypair", () => {
  const sender = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(7));
  const first = deriveRecipientKeypair(sender);
  const second = deriveRecipientKeypair(sender);

  assert.equal(first.publicKey(), second.publicKey());
  assert.notEqual(first.publicKey(), sender.publicKey());
});

test("forced failure writes alert-ready XDR evidence without network access", () => {
  const evidencePath = join(tmpdir(), `streampay-canary-${process.pid}-${Date.now()}.json`);
  try {
    const execution = spawnSync(
      process.execPath,
      ["--experimental-strip-types", runnerPath],
      {
        cwd: packagePath,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          STREAMPAY_CANARY_FORCE_FAILURE: "1",
          STREAMPAY_CANARY_EVIDENCE_PATH: evidencePath,
          GITHUB_SHA: "abc123",
          GITHUB_ACTOR: "canary-test",
          GITHUB_REPOSITORY: "example/streampay",
          GITHUB_RUN_ID: "42",
        },
      }
    );
    assert.equal(execution.status, 1, execution.stderr || execution.stdout);

    const result = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.equal(result.failure.step, "forced failure: create stream simulation");
    assert.equal(result.failure.failureClass, "simulation");
    assert.ok(result.failure.operationXdr);
    assert.match(renderAlert(result), /Commit: abc123/);
    assert.match(renderAlert(result), /actions\/runs\/42/);
    assert.match(renderAlert(result), /Operation XDR:/);
  } finally {
    try {
      unlinkSync(evidencePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
});
