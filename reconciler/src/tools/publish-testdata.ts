#!/usr/bin/env node
//! Regenerates `testdata/`, the committed publication the public verifier is
//! gated against in CI. Run `npm run testdata` after changing the canonical
//! encoding, the tree shape or the verdict rules — and only then.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_POLICY } from "../audit/canonical.js";
import { record, side } from "../audit/fixtures.js";
import { ContinuousAuditor, FileAuditSink } from "../audit/publication.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "..", "testdata");

const onchain = [1, 2, 3, 4, 5].map((id) => record(id));
const projected = [
  record(1),
  record(2, { withdrawn: "255" }), // inside the tolerance grid: rounding
  record(3, { deposit: "1750" }), // beyond it: a value fault
  record(4),
  // 5 is missing here: an absence, provable with an exclusion witness
];

const auditor = new ContinuousAuditor(
  {
    onchain: { read: async () => side(421_000, onchain) },
    projected: { read: async () => side(421_000, projected) },
  },
  new FileAuditSink(OUT, "audit"),
  {
    intervalMs: 60_000,
    artifactRecordLimit: 100,
    policy: { ...DEFAULT_POLICY, tolerance: { epsilon: "10", comparison: "floor_div" } },
  }
);

const outcome = await auditor.runCycle(Date.parse("2026-11-20T00:00:00.000Z"));
process.stdout.write(
  `wrote testdata/audit-report.json, audit-bundle.json, audit-artifact.json, audit-checkpoint.json\n` +
    `verdict=${outcome.report?.verdict} witnesses=${outcome.report?.witnesses.map((w) => w.kind).join(",")}\n`
);
