# StreamPay Reconciliation Service

Pinned **three-way** reconciliation service. It reads the same stream set from
**Soroban RPC**, **Horizon**, and the **indexer projection**, aligns them to one
as-of ledger, applies rounding and ledger-lag tolerance, and attributes every
divergence to a layer so it routes to the right owner. Missing or stale
sources degrade the report with caveats; they never produce a false clean bill.

It also emits governance-gated **heal proposals**: typed, dry-run previewed,
timelocked and scoped, with fail-closed execution. A continuous merkleized
state audit publishes reproducible roots and divergence proofs. Integrates with
the **Issue #2 indexer dashboard withdrawal panel** via webhook dispatch.

---

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Horizon       │     │   Soroban RPC   │     │  Reconciliation │
│   Reader        │     │   Reader        │     │   Engine        │
│   (effects)     │     │   (contract     │     │   (diff.ts)     │
│                 │     │    state)       │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  Alerting Module         │
                    │  (Structured Logs +      │
                    │   Webhook Dispatch)      │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  Indexer Dashboard       │
                    │  (Issue #2 - webhook)    │
                    └──────────────────────────┘
```

### Components

| Component | File | Responsibility |
|-----------|------|----------------|
| Horizon Reader | `src/readers/horizon.ts` | Polls Horizon API for classic-bridge effects and stream state |
| Soroban RPC Reader | `src/readers/soroban.ts` | Queries Soroban RPC `getContractData` for current contract storage state |
| Projection Reader | `src/readers/projection.js` | Reads the indexer's `/health` and `/streams/:id` projection |
| Pinned source adapters | `src/sources/pinned.js` | Collects one aligned snapshot per source; failures become `available:false` |
| Tolerance + as-of | `src/engine/tolerance.js` | Rounding (absolute/ppm), status normalization, as-of alignment, ledger pinning |
| Three-way engine | `src/engine/threeway.js` | Pairwise comparison, layer attribution, confidence, dedup/flap suppression |
| Dual-read diff engine | `src/engine/diff.ts` | Two-way consistency-window comparison used by `runCycle` |
| Suppression | `src/engine/suppression.js` | Cooldown dedup and recurring-flap suppression |
| Alerting Service | `src/alerting.ts` | Structured JSON logging, per-divergence alert dedup/flap suppression, and diagnosis webhook dispatch to the indexer dashboard |
| Heal proposals | `src/heal/proposals.js` | Typed proposals, governance approvals, timelock/TTL/veto, idempotent scoped execution |
| Dry-run + merkle | `src/heal/dryrun.js`, `src/heal/merkle.js` | Exact change preview and before/after state roots |
| Canonical records | `src/audit/canonical.ts` | The one `StreamEntry`-shaped encoding both sides are merkleized through |
| Merkle tree | `src/audit/merkle.ts` | Sorted tree with inclusion and exclusion proofs, odd nodes promoted |
| State auditor | `src/audit/auditor.ts` | Merkleizes both reads, classifies each difference, emits witnesses |
| Publication | `src/audit/publication.ts` | Checkpointed, rate-bounded continuous loop writing roots + proofs |
| Public verifier | `src/audit/verifier.ts` | Recomputes everything from published artifacts alone |

## Three-way reconciliation

One cycle reads the configured `STREAM_IDS` from all three sources at a pinned
ledger, excludes sources that are unavailable or farther behind than
`AS_OF_MAX_LAG_LEDGERS`, and compares every present pair:

| Disagreeing pair | Suspected layer | Routed owner |
|---|---|---|
| rpc↔horizon | `chain_read_rpc` / `chain_read_horizon` (whichever is odd) | `rpc-operator` / `horizon-operator` |
| rpc↔projection | `projection` when the chain sources agree, else the odd chain read | `indexer-projection` / chain operator |
| horizon↔projection | `projection` when the chain sources agree, else the odd chain read | `indexer-projection` / chain operator |
| missing record while the other two agree | `ingestion` when only the projection lacks it; a chain-read layer otherwise | `indexer-ingest` / chain operator |
| all three differ | `unknown` | `on-call-triage` |

Each diagnosis carries the record id, disagreeing pairs, suspected layer,
owner, confidence, as-of ledger, mode, tolerance, per-source evidence and the
rule that fired. The report (`schema: streampay-reconciliation-report/v1`)
contains `mode` (`three_way`, `degraded_two_way`, `insufficient_sources`),
`coverage`, `caveats`, `verdict` (`clean`, `clean_degraded`, `divergent`,
`insufficient_coverage`), summary counters and suppressed diagnoses.

**No false clean bill.** A clean verdict requires all three sources available,
aligned and compared. A missing source degrades to two-way with a caveat; fewer
than two aligned sources produces `insufficient_coverage`, `clean: false`, and
an explicit `unavailableReason`. `degraded_two_way` disagreements cannot be
attributed to the missing source, so their confidence is capped at `low`.

Supported tolerance knobs: `ROUNDING_TOLERANCE_ABSOLUTE`/`PPM` on 7-decimal
amounts, `AS_OF_MAX_LAG_LEDGERS` for ledger lag, and status vocabulary
normalization (`Active`/`active`, `Cancelled`/`canceled`, `Paused`/`paused`).
Identical diagnoses are deduplicated for `SUPPRESSION_COOLDOWN_MS` and a
diagnosis that recurs `FLAP_THRESHOLD` times is suppressed as flapping until it
clears; agreement on a stream clears its suppression state.

Divergence webhooks (`stream_divergence`) are de-duplicated per stream and
divergence key by `AlertingService`. A violation must be observed in
`ALERT_CONFIRM_PASSES` consecutive reconciliation passes before the first page,
so a value oscillating around the tolerance boundary never alerts. Once open it
pages once and then re-pages only every `ALERT_REMINDER_MS` (`0` disables
reminders). It resolves — and its state is dropped — after
`ALERT_RESOLVE_PASSES` consecutive clean passes, so a resolved-then-reopened
divergence is a new alert rather than a suppressed duplicate. The webhook
payload is unchanged: only when an alert is sent changes, never its shape.

## Governance-gated heal proposals

A divergence whose evidence identifies the projection as the wrong layer
produces a typed proposal. Each proposal contains:

* the diagnosis id, stream scope, tolerance used, and the exact evidence
  targets (the chain-backed record wins over the projection);
* a **dry-run preview** listing every record that would change and the
  resulting merkle state root (`beforeRoot`/`afterRoot`/`previewHash`);
* `governance`: required signatures, timelock (`executableAt`), expiry, veto
  state, and the approving governance action.

Execution is **fail-closed**: an unapproved, vetoed, expired, forged,
duplicate-signature or unauthorized approval never executes; `HEAL_SIGNERS`
must list the trusted ed25519 public keys (PEM) for each approver, and a
malformed value aborts startup. The timelock must have elapsed. Execution is
scoped to the preview (never a blanket rebuild), checkpointed per stream so a
partial failure resumes without rewriting already-committed records, idempotent
on re-execution, and rejects a stale preview (`STALE_PREVIEW`) when the
projection moved after the dry run. It writes before/after roots and the
approving governance action to the audit log and de-duplicates repeated runs.
`HEAL_MAX_SCOPE` and `HEAL_MAX_LEDGER_RANGE` bound proposal scope.

---

## Environment Variables

Create a `.env` file in `reconciler/` (copy from `.env.example`):

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HORIZON_URL` | Yes | `https://horizon-testnet.stellar.org` | Horizon API endpoint |
| `HORIZON_API_TOKEN` | No | — | Optional Horizon API token |
| `SOROBAN_RPC_URL` | Yes | `https://soroban-testnet.stellar.org/rpc` | Soroban RPC endpoint |
| `SOROBAN_RPC_TOKEN` | No | — | Optional Soroban RPC token |
| `WEBHOOK_URL` | Yes | `http://localhost:8080/webhooks/reconciler` | Indexer dashboard webhook endpoint (Issue #2) |
| `CONSISTENCY_WINDOW_MS` | No | `30000` | Maximum acceptable lag between Horizon and Soroban data (ms) |
| `POLL_INTERVAL_MS` | No | `5000` | Delay between reconciliation polls (ms) |
| `LOG_LEVEL` | No | `INFO` | `DEBUG\|INFO\|WARN\|ERROR` |
| `ENVIRONMENT` | No | `testnet` | Deployment environment tag |
| `RECONCILER_ID` | No | `primary-001` | Unique instance identifier for multi-instance deployments |
| `CONTRACT_ID` | No | — | StreamPay Soroban contract ID |
| `STREAM_IDS` | No | — | Comma-separated stream IDs to monitor |
| `INDEXER_URL` | No | — | Indexer API base URL; its projection is the third source |
| `INDEXER_API_TOKEN` | No | — | Optional bearer token for the indexer API |
| `AS_OF_MAX_LAG_LEDGERS` | No | `5` | Maximum ledger lag for a source to join the pinned comparison |
| `ROUNDING_TOLERANCE_ABSOLUTE` | No | `0` | Absolute amount tolerance in stroops (7-decimal tokens) |
| `ROUNDING_TOLERANCE_PPM` | No | `0` | Relative amount tolerance in parts per million |
| `SUPPRESSION_COOLDOWN_MS` | No | `300000` | Dedup window for an identical diagnosis |
| `FLAP_THRESHOLD` | No | `3` | Recurrences before a diagnosis is suppressed as flapping |
| `ALERT_CONFIRM_PASSES` | No | `2` | Consecutive passes a divergence must persist before the first alert |
| `ALERT_RESOLVE_PASSES` | No | `2` | Consecutive clean passes before an open divergence resolves |
| `ALERT_REMINDER_MS` | No | `1800000` | Reminder cadence for an open divergence (`0` disables reminders) |
| `HEAL_PROPOSALS_ENABLED` | No | `true` | Generate and execute governance-gated heal proposals |
| `HEAL_TIMELOCK_MS` | No | `86400000` | Delay between approval and earliest execution |
| `HEAL_TTL_MS` | No | `172800000` | Proposal expiry after creation |
| `HEAL_REQUIRED_SIGNATURES` | No | `2` | Distinct trusted approvals required |
| `HEAL_SIGNERS` | No | `[]` | JSON array/object of approver names to ed25519 PEM public keys |
| `HEAL_MAX_SCOPE` | No | `25` | Maximum stream records in one proposal |
| `HEAL_MAX_LEDGER_RANGE` | No | `1000` | Maximum as-of ledger range covered by a proposal |
| `AUDIT_DIR` | No | `audit-out` | Where report/bundle/artifact/checkpoint files are written |
| `AUDIT_INTERVAL_MS` | No | `60000` | Minimum spacing between audit cycles |
| `AUDIT_ARTIFACT_LIMIT` | No | `2000` | Publish the full record set as an artifact when each side has at most this many records (`0` disables it) |
| `AUDIT_TOLERANCE_EPSILON` | No | `1` | Amount tolerance grid; `1` tolerates nothing, `10` treats sub-10-unit accrual as rounding |
| `AUDIT_FLAP_WINDOW_MS` | No | `120000` | How long a key must hold one state before a transition pages anyone |

---

## Continuous merkleized state audit

Every cycle the auditor merkleizes **both** sides of the read — the contract
state and its own projection — and publishes the four roots together with the
ledger sequence they describe. A root difference is then explained, not
asserted: each divergent record gets a witness carrying its canonical tuple
plus an inclusion proof on the side that has it and an exclusion proof on the
side that does not.

| Verdict | Meaning |
|---------|---------|
| `clean` | Both raw roots are identical |
| `rounding_only` | Amounts differ but every difference lands on the same `AUDIT_TOLERANCE_EPSILON` grid point |
| `fault` | A value differs beyond tolerance, or a record exists on one side only |

Cycles are checkpointed (`AUDIT_DIR/<reconciler-id>-checkpoint.json`), so a
restart resumes the incident table instead of re-paging, and rate-bounded by
`AUDIT_INTERVAL_MS`. Alerts are de-duplicated: a persisting divergence is one
incident, and a key that flickers inside `AUDIT_FLAP_WINDOW_MS` does not page.

```bash
npm run audit            # one cycle, writes report + bundle + artifact
node dist/index.js audit # continuous audit loop
```

### Verifying a publication without trusting the auditor

The verifier reads only published files — no readers, no credentials:

```bash
node dist/audit/verifier.js --bundle  audit-out/primary-001-bundle.json
node dist/audit/verifier.js --report  audit-out/primary-001-report.json \
                              --artifact audit-out/primary-001-artifact.json
```

It re-derives every leaf hash from the witness tuples, folds every Merkle path
against the published roots, re-runs the tolerance classification from the
bundle's own policy digest, and recomputes the verdict. Exit code 0 means the
whole artifact reproduced; 1 means something published does not recompute.
`testdata/` holds a committed divergent publication that CI re-verifies on
every pull request; regenerate it with `npm run testdata` only when the
canonical encoding, the tree shape or the verdict rules change on purpose.

---

## Consistency Lag Window Behavior

The reconciliation engine applies a **consistency lag window** to tolerate temporary asynchrony between Horizon and Soroban RPC:

| Scenario | Behavior |
|----------|----------|
| Both sources agree | No alert; logged as `INFO` |
| Sources disagree, but timestamps within `CONSISTENCY_WINDOW_MS` | Treated as expected lag; logged as `WARN`, no webhook |
| Sources disagree, timestamps outside `CONSISTENCY_WINDOW_MS` | Divergence detected; logged as `ERROR`; webhook dispatched |
| Stream missing from Horizon only | Warning (likely indexing delay) |
| Stream missing from Soroban only | Critical (potential index corruption) |

Default `CONSISTENCY_WINDOW_MS=30000` (30 seconds) reflects typical Horizon indexing lag on Stellar testnet.

---

## Structured Log Format

All logs are emitted as JSON to stderr:

```json
{
  "timestamp": "2026-10-16T16:20:32.123Z",
  "service": "streampay-reconciler",
  "level": "ERROR",
  "message": "Stream 123 divergence detected",
  "details": {
    "streamId": "123",
    "checkType": "stream_balance",
    "indexedValue": {"deposit": "1000", "withdrawn": "200"},
    "onChainValue": {"deposit": "1000", "withdrawn": "500"},
    "lagMs": 45000,
    "webhookSent": true,
    "webhookResponse": {"status": 200, "message": "Alert delivered"}
  }
}
```

Fields: `timestamp`, `service`, `level`, `message`, `details`.

---

## Webhook Payload

Webhooks are dispatched to `WEBHOOK_URL` when a **critical** divergence is detected:

```json
{
  "alert": {
    "type": "stream_divergence",
    "severity": "critical",
    "timestamp": "2026-10-16T16:20:32.123Z",
    "source": "reconciler",
    "data": {
      "streamId": "123",
      "divergenceType": "stream_balance",
      "horizonState": {"deposit": "1000", "withdrawn": "200"},
      "sorobanState": {"deposit": "1000", "withdrawn": "500"},
      "lagMs": 45000,
      "consequence": "index_corruption"
    }
  },
  "metadata": {
    "version": "1.0.0",
    "environment": "testnet",
    "reconcilerId": "primary-001"
  }
}
```

This feeds into the **Issue #2 indexer dashboard withdrawal panel** for operator visibility.

Three-way cycles also dispatch `type: "reconciliation_diagnosis"` alerts with
`recordId`, `disagreeingPairs`, `suspectedLayer`, `owner`, `confidence`,
`asOfLedger`, `mode`, `caveats` and the per-source evidence, so the dashboard
can route by owner instead of paging every divergence to on-call.

---

## Setup Commands

### Local Development

```bash
# Install dependencies
cd reconciler
npm install

# Copy environment template
cp .env.example .env
# Edit .env with your Horizon URL, Soroban RPC URL, and webhook target

# Typecheck
npm run typecheck

# Run unit tests
npm test

# Run the service
npm start

# Run the soak test (injects stale RPC data to trigger divergence alarm)
npm run soak
```

### Docker Deployment

```bash
# Start reconciler and indexer
docker compose up -d

# View logs
docker compose logs -f reconciler

# Stop
docker compose down
```

---

## Testing

### Audit and TypeScript Tests (`src/audit/*.test.ts`, `src/engine/diff.test.ts`, `src/index.test.ts`)

### Fixture tests (`tests/threeway.test.js`, `tests/heal.test.js`)

Run without external services:

```bash
npm run test:fixtures
```

The three-way suite covers one fixture per pairwise class (RPC↔Horizon,
RPC↔projection, Horizon↔projection), missing-record attribution, all-three
disagreement, rounding tolerance, within-lag results, stale/missing sources
(`degraded_two_way` and `insufficient_coverage`), cooldown dedup and flapping.

The heal suite covers proposal generation with dry run, dedup, chain-read
fail-closed behaviour, unapproved/timelock/forged/duplicate/unauthorized/
expired/veto rejection, scoped execution reproducing the dry-run root, audit
before/after roots, governance action logging, idempotent re-execution, stale
preview rejection, tampered approval re-verification, partial-failure resume
and scope violations.

### Unit Tests (`tests/*.test.js` and compiled TypeScript tests)

The suite runs on the compiled output (`npm test` builds first) and covers:

| File | What it pins down |
|------|-------------------|
| `audit/canonical.test.ts` | the field set/order mirrors `StreamEntry`, tamper-sensitive bytes |
| `audit/merkle.test.ts` | inclusion + exclusion proofs, promoted odd nodes, forged-path rejection |
| `audit/tolerance.test.ts` | rounding grid vs a real divergence, non-amount fields never tolerated |
| `audit/auditor.test.ts` | divergence injection pinpoints the exact record and its proofs verify |
| `audit/dedup.test.ts` | one incident per divergence, flap suppression, restart resume |
| `audit/continuous.test.ts` | checkpointing, rate bounding, ledger-advance skip, failure budget |
| `audit/verifier.test.ts` | a publication recomputes from files alone; tampering is caught |
| `engine/diff.test.ts` | dual-read lag/divergence classification and the alert gate |
| `index.test.ts` | merged upstream/audit configuration defaults and validation |
| `tests/diff.test.js` | accrual-floor rounding, amount helpers and dual-read divergence behavior |
| `tests/alerting.test.js` | confirmation, reminder, resolution and rounding-suppressed metrics |
| `tests/horizon.cursor.test.js` | cursor pagination, retry/resume and retryable HTTP failures |
| `tests/threeway.test.js` | pairwise diagnosis, degraded coverage, dedup and flapping |
| `tests/heal.test.js` | governance-gated, scoped and idempotent heal execution |

Regenerate the committed publication with `npm run testdata` when a canonical
rule changes deliberately — CI then requires `npm run verify:published` to
still reproduce it.

```bash
npm test
npm run verify:published
```

### Soak Harness (`src/tools/soak.ts`)

Deliberately injects stale Soroban RPC and Horizon responses to trigger real
divergence alarms, then runs one merkleized audit cycle and prints a PR-ready
report.

```bash
npm run soak
```

Expected scenarios:
- Baseline: both sources fresh and in sync → no divergences
- Soroban delay within window (15s) → no divergences (expected lag)
- Soroban delay outside window (45s) → divergence detected
- Horizon delay causing apparent divergence → divergence detected
- Both sources equally delayed and in agreement → no divergences

---

## Docker Compose

`reconciler/docker-compose.yml` deploys:
- **reconciler** — the dual-read reconciliation daemon (port 9092)
- **indexer** — the webhook target (port 8080, Issue #2 integration)

### Health Checks

The reconciler service includes an HTTP health check at `/health` (configured in docker-compose).

### Networks

All services communicate over the `streampay` bridge network.

---

## Integration Points

- **Horizon API**: `HORIZON_URL` — classic-bridge effects polling
- **Soroban RPC**: `SOROBAN_RPC_URL` — `getContractData` queries
- **Indexer Dashboard (Issue #2)**: `WEBHOOK_URL` — divergence alert delivery
- **Prometheus/Grafana**: via `infra/observability/` — metrics and dashboards

---

## License

Apache-2.0 — see LICENSE at repository root.