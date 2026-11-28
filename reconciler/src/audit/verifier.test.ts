import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_POLICY, type AuditPolicy } from "./canonical.js";
import { mutableReader, record, side } from "./fixtures.js";
import { ContinuousAuditor, FileAuditSink, type AuditArtifact } from "./publication.js";
import type { AuditReport } from "./auditor.js";
import type { ProofBundle } from "./proofs.js";
import { verify, main } from "./verifier.js";

function policy(epsilon: string): AuditPolicy {
  return { ...DEFAULT_POLICY, tolerance: { epsilon, comparison: "floor_div" } };
}

async function publish(options: {
  divergent: boolean;
  policyValue?: string;
}): Promise<{ dir: string; sink: FileAuditSink }> {
  const dir = await mkdtemp(join(tmpdir(), "streampay-audit-"));
  const records = [1, 2, 3, 4].map((id) => record(id));
  const readers = {
    onchain: mutableReader(side(700, records)),
    projected: mutableReader(
      side(
        700,
        options.divergent
          ? [record(1), record(2, { deposit: "404" }), record(3, { withdrawn: "255" }), record(4)]
          : records
      )
    ),
  };
  const sink = new FileAuditSink(dir);
  const auditor = new ContinuousAuditor(readers, sink, {
    intervalMs: 1_000,
    artifactRecordLimit: 100,
    policy: policy(options.policyValue ?? "10"),
  });
  await auditor.runCycle(1_700_000_000_000);
  return { dir, sink };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    out,
    err,
    restore: () => {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    },
  };
}

describe("public verifier", () => {
  it("reproduces a divergence from the published bundle alone", async () => {
    const { dir } = await publish({ divergent: true });
    const bundle = await readJson<ProofBundle>(join(dir, "audit-bundle.json"));

    const result = await verify({ bundlePath: join(dir, "audit-bundle.json") });
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.sections.map((section) => section.ok),
      [true]
    );
    const failed = result.sections[0]!.checks.filter((check) => !check.ok);
    assert.deepEqual(failed, [], "every published check must reproduce");
    assert.ok(bundle.witnesses.length >= 2);
  });

  it("recomputes all four roots from the artifact and agrees with the report", async () => {
    const { dir } = await publish({ divergent: true });
    const result = await verify({
      reportPath: join(dir, "audit-report.json"),
      artifactPath: join(dir, "audit-artifact.json"),
    });
    assert.equal(result.ok, true);
    const names = result.sections[0]!.checks.map((check) => check.name);
    assert.deepEqual(
      names.filter((name) => name.startsWith("root/")),
      ["root/onchain_raw", "root/projected_raw", "root/onchain_quantized", "root/projected_quantized"]
    );
    assert.ok(names.includes("verdict"));
    assert.ok(names.includes("ledger_binding"));
  });

  it("verifies both artifacts in one run", async () => {
    const { dir } = await publish({ divergent: true });
    const result = await verify({
      bundlePath: join(dir, "audit-bundle.json"),
      reportPath: join(dir, "audit-report.json"),
      artifactPath: join(dir, "audit-artifact.json"),
    });
    assert.equal(result.ok, true);
    assert.equal(result.sections.length, 2);
  });

  it("reproduces a clean audit with no bundle published", async () => {
    const { dir } = await publish({ divergent: false });
    const files = (await readdir(dir)).sort();
    assert.deepEqual(files, ["audit-artifact.json", "audit-checkpoint.json", "audit-report.json"]);
    await assert.rejects(
      () => verify({ bundlePath: join(dir, "audit-bundle.json") }),
      /ENOENT/
    );
    const result = await verify({
      reportPath: join(dir, "audit-report.json"),
      artifactPath: join(dir, "audit-artifact.json"),
    });
    assert.equal(result.ok, true);
  });

  it("reproduces a set difference from its exclusion proofs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "streampay-audit-"));
    const records = [1, 2, 3, 4].map((id) => record(id));
    const sink = new FileAuditSink(dir);
    const auditor = new ContinuousAuditor(
      {
        onchain: mutableReader(side(80, records)),
        projected: mutableReader(side(80, records.filter((r) => r.streamId !== "3"))),
      },
      sink,
      { intervalMs: 1_000, artifactRecordLimit: 50 }
    );
    await auditor.runCycle(2_000);

    const result = await verify({ bundlePath: join(dir, "audit-bundle.json") });
    assert.equal(result.ok, true);
    const bundle = await readJson<ProofBundle>(join(dir, "audit-bundle.json"));
    assert.deepEqual(bundle.witnesses.map((w) => [w.stream_id, w.kind]), [["3", "missing_projected"]]);
    assert.ok(
      result.sections[0]!.checks.some((check) => check.name === "missing_projected/3/exclusion_root" && check.ok),
      "the absence itself has to be provable"
    );
  });

  it("rejects a bundle whose published root was tampered with", async () => {
    const { dir } = await publish({ divergent: true });
    const path = join(dir, "audit-bundle.json");
    const bundle = await readJson<ProofBundle>(path);
    const tampered: ProofBundle = {
      ...bundle,
      roots: { ...bundle.roots, onchain_raw: "f".repeat(64) },
    };
    await writeFile(path, JSON.stringify(tampered), "utf8");

    const result = await verify({ bundlePath: path });
    assert.equal(result.ok, false);
    const failed = result.sections[0]!.checks.filter((check) => !check.ok).map((check) => check.name);
    assert.ok(failed.some((name) => name.includes("inclusion_root")), failed.join(","));
  });

  it("rejects a witness whose record was swapped for another stream", async () => {
    const { dir } = await publish({ divergent: true });
    const path = join(dir, "audit-bundle.json");
    const bundle = await readJson<ProofBundle>(path);
    const witness = bundle.witnesses.find((w) => w.kind === "value");
    assert.ok(witness !== undefined);
    const forged: ProofBundle = {
      ...bundle,
      witnesses: bundle.witnesses.map((w) =>
        w === witness ? { ...w, projected: { ...w.projected!, record: [...w.onchain!.record] } } : w
      ),
    };
    await writeFile(path, JSON.stringify(forged), "utf8");

    const result = await verify({ bundlePath: path });
    assert.equal(result.ok, false);
    const failed = result.sections[0]!.checks.filter((check) => !check.ok).map((check) => check.name);
    assert.ok(failed.some((name) => name.endsWith("leaves_differ")), failed.join(","));
  });

  it("rejects a bundle published under a policy that does not match its digest", async () => {
    const { dir } = await publish({ divergent: true, policyValue: "10" });
    const path = join(dir, "audit-bundle.json");
    const bundle = await readJson<ProofBundle>(path);
    await writeFile(
      path,
      JSON.stringify({ ...bundle, policy: { ...bundle.policy, tolerance: { epsilon: "999999", comparison: "floor_div" } } }),
      "utf8"
    );
    const result = await verify({ bundlePath: path });
    assert.equal(result.ok, false);
    assert.ok(
      result.sections[0]!.checks.some((check) => check.name === "policy_digest" && !check.ok),
      "the policy the proofs were computed under must be the published one"
    );
  });

  it("rejects an artifact that does not hash to the published roots", async () => {
    const { dir } = await publish({ divergent: true });
    const reportPath = join(dir, "audit-report.json");
    const artifactPath = join(dir, "audit-artifact.json");
    const artifact = await readJson<AuditArtifact>(artifactPath);
    const edited: AuditArtifact = {
      ...artifact,
      onchain: artifact.onchain.map((tuple, index) => (index === 0 ? [...tuple.slice(0, 4), "1", ...tuple.slice(5)] : tuple)),
    };
    await writeFile(artifactPath, JSON.stringify(edited), "utf8");

    const result = await verify({ reportPath, artifactPath });
    assert.equal(result.ok, false);
    const failed = result.sections[0]!.checks.filter((check) => !check.ok).map((check) => check.name);
    assert.deepEqual(
      failed,
      ["root/onchain_raw", "root/onchain_quantized"],
      "only the tampered side fails; the rest still reproduce"
    );
    assert.ok(
      result.sections[0]!.checks.some((check) => check.name === "root/projected_raw" && check.ok),
      "verification reports every check, not just the first failure"
    );
  });

  it("reports every failing check instead of stopping at the first", async () => {
    const { dir } = await publish({ divergent: true });
    const artifactPath = join(dir, "audit-artifact.json");
    const artifact = await readJson<AuditArtifact>(artifactPath);
    await writeFile(artifactPath, JSON.stringify({ ...artifact, ledger: { onchain: 1, projected: 2 } }), "utf8");

    const result = await verify({ reportPath: join(dir, "audit-report.json"), artifactPath });
    assert.equal(result.ok, false);
    const failed = result.sections[0]!.checks.filter((check) => !check.ok).map((check) => check.name);
    assert.deepEqual(failed, ["ledger_binding"]);
    assert.ok(result.sections[0]!.checks.length >= 10);
  });

  it("needs both a report and an artifact", async () => {
    const { dir } = await publish({ divergent: true });
    await assert.rejects(() => verify({ reportPath: join(dir, "audit-report.json") }), /supplied together/);
    await assert.rejects(() => verify({ artifactPath: join(dir, "audit-artifact.json") }), /supplied together/);
    await assert.rejects(() => verify({}), /nothing to verify/);
  });

  it("exits 0 for a reproducing artifact and 1 for a tampered one", async () => {
    const { dir } = await publish({ divergent: true });
    const bundlePath = join(dir, "audit-bundle.json");

    const good = capture();
    try {
      assert.equal(await main(["--bundle", bundlePath]), 0);
      assert.match(good.out.join(""), /VERIFIED/);
      assert.ok(good.out.join("").includes("PASS"));
    } finally {
      good.restore();
    }

    const report = await readJson<AuditReport>(join(dir, "audit-report.json"));
    await writeFile(bundlePath, JSON.stringify({ ...await readJson<ProofBundle>(bundlePath), verdict: "clean" }), "utf8");
    const bad = capture();
    try {
      assert.equal(await main(["--bundle", bundlePath]), 1);
      assert.match(bad.out.join(""), /DIVERGENT \/ NOT REPRODUCIBLE/);
    } finally {
      bad.restore();
    }
    assert.equal(report.verdict, "fault");
  });

  it("exits 2 on unusable arguments or an unreadable artifact", async () => {
    const bad = capture();
    try {
      assert.equal(await main(["--bundle"]), 2, "a flag with no value");
      assert.equal(await main(["--wat"]), 2, "an unknown flag");
      assert.equal(await main([]), 2, "nothing to verify");
      assert.equal(await main(["--bundle", join(tmpdir(), "nope-does-not-exist.json")]), 2);
      assert.match(bad.err.join(""), /usage:/);
    } finally {
      bad.restore();
    }
  });

  it("prints machine-readable output for automation", async () => {
    const { dir } = await publish({ divergent: true });
    const out = capture();
    try {
      assert.equal(await main(["--bundle", join(dir, "audit-bundle.json"), "--json"]), 0);
    } finally {
      out.restore();
    }
    const parsed = JSON.parse(out.out.join("")) as { ok: boolean; sections: unknown[] };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.sections.length, 1);
  });

  it("reproduces the committed publication in testdata", async () => {
    // The publication CI gates on: a rounding witness, a value witness and a
    // set difference, all of which a third party must be able to re-derive.
    const dir = join(fileURLToPath(import.meta.url), "..", "..", "..", "testdata");
    const result = await verify({
      bundlePath: join(dir, "audit-bundle.json"),
      reportPath: join(dir, "audit-report.json"),
      artifactPath: join(dir, "audit-artifact.json"),
    });
    assert.equal(result.ok, true);
    const bundle = await readJson<ProofBundle>(join(dir, "audit-bundle.json"));
    assert.deepEqual(
      bundle.witnesses.map((witness) => witness.kind),
      ["rounding", "value", "missing_projected"]
    );
    assert.equal(bundle.verdict, "fault");
    const failed = result.sections.flatMap((section) => section.checks.filter((check) => !check.ok));
    assert.deepEqual(failed, []);
  });
});
