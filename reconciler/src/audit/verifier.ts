//! Standalone public verifier.
//!
//! Reads published artifacts and re-derives the divergence verdict:
//!
//!   node dist/audit/verifier.js --bundle bundle.json
//!   node dist/audit/verifier.js --report report.json --artifact artifact.json
//!
//! Exit code 0 means every published root, proof and verdict line reproduced.
//! It deliberately imports no reader and holds no credentials — the artifacts
//! alone have to be enough, which is what makes the proofs public.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import type { AuditReport } from "./auditor.js";
import type { AuditArtifact } from "./publication.js";
import type { ProofBundle } from "./proofs.js";
import { checkReportAgainstArtifact } from "./roots.js";
import { verifyBundle } from "./proofs.js";

export interface VerifyOptions {
  bundlePath?: string;
  reportPath?: string;
  artifactPath?: string;
  json?: boolean;
}

export interface VerifyResult {
  ok: boolean;
  sections: Array<{ source: string; ok: boolean; checks: Array<{ name: string; ok: boolean; detail?: string }> }>;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function verify(options: VerifyOptions): Promise<VerifyResult> {
  const sections: VerifyResult["sections"] = [];

  if (options.bundlePath !== undefined) {
    const bundle = await readJson<ProofBundle>(options.bundlePath);
    const summary = verifyBundle(bundle);
    sections.push({ source: options.bundlePath, ok: summary.ok, checks: summary.checks });
  }

  if (options.reportPath !== undefined || options.artifactPath !== undefined) {
    if (options.reportPath === undefined || options.artifactPath === undefined) {
      throw new Error("--report and --artifact must be supplied together");
    }
    const report = await readJson<AuditReport>(options.reportPath);
    const artifact = await readJson<AuditArtifact>(options.artifactPath);
    const outcome = checkReportAgainstArtifact(report, artifact);
    sections.push({ source: options.artifactPath, ok: outcome.ok, checks: outcome.checks });
  }

  if (sections.length === 0) {
    throw new Error("nothing to verify: pass --bundle, or --report with --artifact");
  }

  return { ok: sections.every((section) => section.ok), sections };
}

const USAGE = `usage: streampay-reconciler-verify [options]

  --bundle <path>    verify a divergence proof bundle (roots + witnesses)
  --report <path>    audit report, paired with --artifact
  --artifact <path>  published record set, paired with --report
  --json             machine-readable output
  --help             show this message

Recomputes every published root, folds every Merkle proof in each witness and
re-runs the tolerance classification from the bundle's own policy. Exits 0 only
when the whole artifact reproduces.`;

function parseArgs(argv: string[]): VerifyOptions {
  const options: VerifyOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--bundle":
        options.bundlePath = next();
        break;
      case "--report":
        options.reportPath = next();
        break;
      case "--artifact":
        options.artifactPath = next();
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(`${USAGE}\n`);
        process.exit(0);
      default:
        throw new Error(`unknown argument '${arg}'`);
    }
  }
  return options;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let options: VerifyOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    return 2;
  }

  let result: VerifyResult;
  try {
    result = await verify(options);
  } catch (error) {
    process.stderr.write(`verifier could not run: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }

  for (const section of result.sections) {
    process.stdout.write(`\n${section.source}\n`);
    for (const check of section.checks) {
      const mark = check.ok ? "PASS" : "FAIL";
      const detail = check.ok || check.detail === undefined ? "" : ` — ${check.detail}`;
      process.stdout.write(`  ${mark}  ${check.name}${detail}\n`);
    }
    const failed = section.checks.filter((check) => !check.ok).length;
    process.stdout.write(`  ${section.checks.length - failed}/${section.checks.length} checks reproduced\n`);
  }

  process.stdout.write(`\n${result.ok ? "VERIFIED" : "DIVERGENT / NOT REPRODUCIBLE"}\n`);
  return result.ok ? 0 : 1;
}

// Only the CLI entry point executes; importing `main()` stays side-effect free.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
