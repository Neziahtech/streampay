# StreamPay testnet canary

Scheduled synthetic monitoring for the deployed contract **and** the
frontend's call construction. A throwaway wallet opens a stream, waits for
accrual, claims half, claims the rest, then cancels — asserting contract state
at every step. Any failure produces a report with the exact step, failure
class, RPC excerpt, and XDR, so it is actionable without shell access to the
runner.

```text
prepare ──▶ create-stream ──▶ wait-accrual ──▶ withdraw-partial
   ▲                                                │
   │                                                ▼
 verify ◀── cancel ◀── withdraw-max ◀────── wait-accrual-2
```

## Why it also tests the frontend

`src/backend.ts` does not build transactions itself: it imports
`frontend/lib/contract-ops.ts`, the same pure builders the UI uses. If the
frontend's argument order, units, or method names drift from the deployed
contract, the canary's simulation fails and the alert says which step.

## Setup

1. Deploy the contract to testnet (`scripts/deploy_testnet.sh`) and set the
   repository variable **`CANARY_CONTRACT_ID`**.
2. Optional repository variables: `CANARY_TOKEN_ID` (defaults to the testnet
   native XLM SAC), `CANARY_DEPOSIT` (default `1000000` stroops),
   `CANARY_STREAM_SECONDS` (default `120`), `CANARY_RPC_URL`.
3. Optional secrets:
   * `CANARY_SENDER_SECRET` / `CANARY_RECIPIENT_SECRET` — stable bot keys.
     Without them, fresh keys are generated and friendbot-funded every run,
     which is the recommended self-healing mode.
   * `CANARY_ALERT_WEBHOOK` — Slack incoming webhook (or any endpoint that
     accepts JSON). Alerts are also emitted as GitHub annotations.
4. Keep bot keys testnet-only and empty. The canary refuses to run unless
   `CANARY_NETWORK` is `testnet`, and the workflow has no mainnet secret.

## Running

```bash
# from the repo root, once:
npm ci --prefix frontend
npm ci --prefix tools/canary

# validate config without touching the network:
CANARY_CONTRACT_ID=C... npm run --prefix tools/canary dry-run

# full lifecycle against testnet:
CANARY_CONTRACT_ID=C... npm run --prefix tools/canary canary

# alert-path demo (no testnet failure needed):
CANARY_CONTRACT_ID=C... \
  npm run --prefix tools/canary canary -- --force-fail-at=withdraw-partial
```

The report is written to `canary-report.json` (`CANARY_REPORT_PATH`/`--report`
override). A success looks like:

```json
{
  "schema": "streampay-canary/v1",
  "status": "success",
  "steps": [
    { "name": "prepare", "status": "passed", "txHash": "…" },
    { "name": "create-stream", "status": "passed", "txHash": "…" },
    { "name": "wait-accrual", "status": "passed" },
    { "name": "withdraw-partial", "status": "passed", "txHash": "…" },
    { "name": "wait-accrual-2", "status": "passed" },
    { "name": "withdraw-max", "status": "passed", "txHash": "…" },
    { "name": "cancel", "status": "passed", "txHash": "…" },
    { "name": "verify", "status": "passed" }
  ]
}
```

## Failure classes

| class | meaning | what the alert includes |
|---|---|---|
| `simulation` | the call was rejected during preflight | contract error code, simulation excerpt, unsigned XDR |
| `submission` | RPC refused the signed transaction | `sendTransaction` excerpt, signed XDR |
| `inclusion` | included but failed | `resultXdr`, signed XDR |
| `assertion` | contract responded with unexpected state | expected vs actual, stream id |
| `timeout` | accrual/inclusion did not progress | last RPC response, elapsed budget |
| `funding` | friendbot failed | HTTP status + body |
| `transport` | RPC unreachable/invalid | method + excerpt |
| `config` | missing/invalid configuration | the variable name and fix |

The failure report embeds an `alert` payload:

```json
{
  "schema": "streampay-canary-alert/v1",
  "title": "StreamPay testnet canary failed at withdraw-partial (simulation)",
  "step": { "name": "withdraw-partial", "failureClass": "simulation" },
  "rpc": { "method": "simulateTransaction", "excerpt": "HostError: Error(Contract, #10)…" },
  "xdr": { "transactionEnvelope": "AAAA…", "result": "…" },
  "git": { "sha": "…", "contract": { "sha": "…", "pullRequest": 41 } },
  "forced": false
}
```

Slack receives a readable version of the same content. GitHub runs get an
`::error::` annotation and a job summary.

## CI

`.github/workflows/canary.yml` runs every 30 minutes and on manual dispatch
(with an optional `force_fail_at` input that injects a classified failure so
the alert path stays exercised).

* Checkout uses full history; the report records the head commit, plus the
  last commit (and PR number) that touched `contracts/streaming-payments` and
  `frontend/lib/contract-ops.ts`. A scheduled regression therefore points at
  the merge that likely caused it.
* The report is uploaded as the `canary-report` artifact on **every** run,
  including failures and forced failures.
* Each run resets state from scratch: fresh keys, fresh friendbot funding, a
  new stream. Nothing from a previous run is trusted.

## Tests

```bash
npm ci --prefix frontend && npm ci --prefix tools/canary
npm test --prefix tools/canary
```

Tests use an in-memory contract backend with the same accrual/withdrawal
semantics, so they need no network or funded account. They cover the full
happy path, simulation vs assertion classification, the alert payload
(step/class/excerpt/XDR), webhook emission, and that the shared frontend
builders survive the canary transaction pipeline.

A live testnet run requires a deployed contract and friendbot access; the
scheduled workflow is the place for that. The `--force-fail-at` flag is the
deterministic way to demonstrate the failure alert.
