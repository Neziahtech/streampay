# ⚡ StreamPay Integrator & Operations Runbook

Comprehensive operational runbook and troubleshooting decision tree for StreamPay integrators, payroll operations teams, and on-call engineers.

This runbook carries an end-to-end worked example of onboarding a **50-employee payroll** onto Stellar Testnet, operating continuous streams through a full monthly cycle, and diagnosing issues across the contract, CLI, indexer, and RPC stack.

---

## Quick Reference: Alerts & Severities

| Alert Name                         | Severity          | Service        | Soak Baseline (Issue #27)                  | Runbook Link                                                         |
| ---------------------------------- | ----------------- | -------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| `IndexerEventLagHigh`              | Warning (P2)      | Indexer        | P95 lag ≤ 8.2s (normal ~5s ledger)         | §4 decision tree                                                     |
| `IndexerEventLagCritical`          | Critical (P1)     | Indexer        | P99 lag ≤ 12.4s (max transient 25s)        | §4 decision tree                                                     |
| `IndexerLedgerLagCritical`         | Critical (P1)     | Indexer        | Steady-state lag ≤ 1 ledger                | §4 decision tree                                                     |
| `IndexerDBDepthGrowing`            | Warning (P2)      | Indexer        | Queue drains < 50 items/batch              | §4 decision tree                                                     |
| `IndexerDBDepthCritical`           | Critical (P1)     | Indexer        | Max burst depth observed = 120             | §4 decision tree                                                     |
| `SorobanRPCErrorRateHigh`          | Warning (P2)      | RPC Client     | Normal baseline error rate = 0.04%         | §4 decision tree                                                     |
| `SorobanRPCErrorRateCritical`      | Critical (P1)     | RPC Client     | Rate limit / node outage threshold > 20%   | §4 decision tree                                                     |
| `ReconciliationDivergenceDetected` | **Critical (P0)** | Reconciler     | **0 divergences** across 10,000 txs        | §4 decision tree                                                     |
| `ReconcilerJobStalled`             | Critical (P1)     | Reconciler     | Scheduled run interval = 60s               | §4 decision tree                                                     |
| `IndexerOutboxDepthDiverging`      | Critical (P1)     | Indexer Outbox | 10k-intent backlog drains in ~3.5s         | [#indexeroutboxdepthdiverging](#indexeroutboxdepthdiverging)         |
| `IndexerOutboxDeliveryLagHigh`     | Warning (P2)      | Indexer Outbox | Oldest pending intent < 5s at steady state | [#indexeroutboxdeliverylaghigh](#indexeroutboxdeliverylaghigh)       |
| `IndexerOutboxDeadLetterRateHigh`  | Warning (P2)      | Indexer Outbox | 0 dead letters for healthy endpoints       | [#indexeroutboxdeadletterratehigh](#indexeroutboxdeadletterratehigh) |
| `IndexerOutboxBackpressured`       | Warning (P2)      | Indexer Outbox | Never engages at soak ingestion rates      | [#indexeroutboxbackpressured](#indexeroutboxbackpressured)           |
| `IndexerAnomalyCriticalIncidentOpen` | Critical (P1)   | Indexer Anomaly | 0 critical detections per rule per window  | [#indexeranomalycriticalincidentopen](#indexeranomalycriticalincidentopen) |
| `IndexerAnomalyReplayMismatch`     | Critical (P1)     | Indexer Anomaly | 0 mismatches — replay is operator-driven   | [#indexeranomalyreplaymismatch](#indexeranomalyreplaymismatch)       |
| `IndexerAnomalyRuleUnreliable`     | Warning (P2)      | Indexer Anomaly | < 30% false positives over a day of reviews | [#indexeranomalyruleunreliable](#indexeranomalyruleunreliable)       |
| `IndexerAnomalySuppressionFlood`   | Warning (P2)      | Indexer Anomaly | Suppression skips ~0 evaluations/hour      | [#indexeranomalysuppressionflood](#indexeranomalysuppressionflood)   |
| `IndexerWebhookSlaBreached`        | Warning (P2)      | Indexer Webhooks | ≤ 1% of window over `WEBHOOK_SLA_MS`      | [#indexerwebhookslabreached](#indexerwebhookslabreached)             |
| `IndexerWebhookTenantSlaBreached`  | Warning (P2)      | Indexer Webhooks | Every tenant window under budget          | [#indexerwebhooktenantslabreached](#indexerwebhooktenantslabreached) |
| `IndexerWebhookSlaBreachedSustained` | Critical (P1)   | Indexer Webhooks | Breach cleared inside one retry cohort    | [#indexerwebhookslabreachedsustained](#indexerwebhookslabreachedsustained) |
| `IndexerWebhookBacklogAging`       | Warning (P2)      | Indexer Webhooks | Oldest pending delivery < 60s at steady state | [#indexerwebhookbacklogaging](#indexerwebhookbacklogaging)       |
| `IndexerAnalyticsStalenessBreach` | Warning (P2)      | Indexer Analytics | Each view inside configured event-time SLO    | [#indexeranalyticsstalenessbreach](#indexeranalyticsstalenessbreach) |
| `IndexerAnalyticsStalenessCritical` | Critical (P1)   | Indexer Analytics | SLO violation = 0s                           | [#indexeranalyticsstalenesscritical](#indexeranalyticsstalenesscritical) |
| `IndexerAnalyticsDirty`            | Critical (P1)     | Indexer Analytics | Rebuild completes on next refresh tick        | [#indexeranalyticsdirty](#indexeranalyticsdirty)               |
| `IndexerAnalyticsRefreshErrors`    | Warning (P2)      | Indexer Analytics | 0 failed refresh transactions                | [#indexeranalyticsrefresherrors](#indexeranalyticsrefresherrors)   |
| `IndexerAnalyticsThroughputShortfall` | Warning (P2)  | Indexer Analytics | Refresh sustains 500 events/s in budget test | [#indexeranalyticsthroughputshortfall](#indexeranalyticsthroughputshortfall) |
| `IndexerAnalyticsGatedReadFailures` | Warning (P2)    | Indexer Analytics | 0 timed-out gated reads                      | [#indexeranalyticsgatedreadfailures](#indexeranalyticsgatedreadfailures) |

## Table of Contents

1. [Executive Overview & Operational Model](#1-executive-overview--operational-model)
2. [50-Employee Payroll Migration Walkthrough](#2-50-employee-payroll-migration-walkthrough)
   - [Step 1: Ingesting & Validating Payroll CSV](#step-1-ingesting--validating-payroll-csv)
   - [Step 2: SAC Token Allowance Approval](#step-2-sac-token-allowance-approval)
   - [Step 3: Batch Stream Creation](#step-3-batch-stream-creation)
   - [Step 4: Real-Time Accrual & Verification](#step-4-real-time-accrual--verification)
3. [Month-of-Production Lifecycle Operations](#3-month-of-production-lifecycle-operations)
   - [Day 7: Mid-Month Recipient Withdrawal](#day-7-mid-month-recipient-withdrawal)
   - [Day 14: Employee Offboarding & Pro-Rata Cancellation](#day-14-employee-offboarding--pro-rata-cancellation)
   - [Day 21: Performance Promotion & Stream Top-Up](#day-21-performance-promotion--stream-top-up)
   - [Day 30: Final Settlement & Batch Claim](#day-30-final-settlement--batch-claim)
4. [Troubleshooting Decision Tree](#4-troubleshooting-decision-tree)
   - [Node A: Validation Rejections](#node-a-validation-rejections)
   - [Node B: Wallet & Signature Failures](#node-b-wallet--signature-failures)
   - [Node C: TTL & Storage Expiry Surprises](#node-c-ttl--storage-expiry-surprises)
   - [Node D: Index Discovery Gaps](#node-d-index-discovery-gaps)
   - [Node E: Refund & Partial-State Confusion](#node-e-refund--partial-state-confusion)
   - [Node F: RPC Degradation & Throttling](#node-f-rpc-degradation--throttling)
5. [Incident Escalation & Security Policy](#5-incident-escalation--security-policy)
6. [Observability & Service Alerts Reference](#6-observability--service-alerts-reference)
7. [TTL-Sentinel Expiry Alert Triage](#7-ttl-sentinel-expiry-alert-triage)
   - [7.1 Decision tree](#71-decision-tree)
   - [7.2 Step 1: Verify the ledger view](#72-step-1--verify-the-ledger-view)
   - [7.3 Step 2: Re-scan and compare](#73-step-2--re-scan-and-compare)
   - [7.4 Step 3: Check for a recent extension](#74-step-3--check-for-a-recent-extension)
   - [7.5 Step 4: Recompute the rent estimate](#75-step-4--recompute-the-rent-estimate)
   - [7.6 Step 5: Escalate only on confirmed risk](#76-step-5--escalate-only-on-confirmed-risk)
   - [7.7 Worked example A: false positive](#77-worked-example-a--false-positive-stream-already-extended)
   - [7.8 Worked example B: real positive](#78-worked-example-b--real-positive-counter-near-its-4095-ledger-cliff)
8. [Anomaly Detection Alert Triage](#8-anomaly-detection-alert-triage)
   - [8.1 First, read the detection, not the alert](#81-first-read-the-detection-not-the-alert)
   - [`IndexerAnomalyCriticalIncidentOpen`](#indexeranomalycriticalincidentopen)
   - [`IndexerAnomalyReplayMismatch`](#indexeranomalyreplaymismatch)
   - [`IndexerAnomalyRuleUnreliable`](#indexeranomalyruleunreliable)
   - [`IndexerAnomalySuppressionFlood`](#indexeranomalysuppressionflood)
9. [Webhook Delivery SLA Alert Triage](#9-webhook-delivery-sla-alert-triage)
   - [9.1 Fleet breach vs one tenant](#91-fleet-breach-vs-one-tenant)
   - [`IndexerWebhookSlaBreached`](#indexerwebhookslabreached)
   - [`IndexerWebhookTenantSlaBreached`](#indexerwebhooktenantslabreached)
   - [`IndexerWebhookSlaBreachedSustained`](#indexerwebhookslabreachedsustained)
   - [`IndexerWebhookBacklogAging`](#indexerwebhookbacklogaging)
10. [Materialized Analytics Alert Triage](#10-materialized-analytics-alert-triage)
   - [10.1 Establish whether the writer is moving](#101-establish-whether-the-writer-is-moving)
   - [`IndexerAnalyticsStalenessBreach`](#indexeranalyticsstalenessbreach)
   - [`IndexerAnalyticsStalenessCritical`](#indexeranalyticsstalenesscritical)
   - [`IndexerAnalyticsDirty`](#indexeranalyticsdirty)
   - [`IndexerAnalyticsRefreshErrors`](#indexeranalyticsrefresherrors)
   - [`IndexerAnalyticsThroughputShortfall`](#indexeranalyticsthroughputshortfall)
   - [`IndexerAnalyticsGatedReadFailures`](#indexeranalyticsgatedreadfailures)

---

## 1. Executive Overview & Operational Model

StreamPay replaces traditional bi-weekly or monthly payroll lump-sum transfers with continuous, per-second streaming payments escrowed inside Soroban smart contracts on the Stellar network.

```text
 ┌──────────────────────┐      1. Approve SAC Allowance       ┌──────────────────────┐
 │  Employer Treasury   │ ─────────────────────────────────>  │ Stellar Asset (SAC)  │
 │ (GD3K5V2X6M7N...DEMO)│                                     │ (CDLZFC3SYJYD...SC)  │
 └──────────┬───────────┘                                     └──────────┬───────────┘
            │                                                            │
            │ 2. create_stream(recipient, deposit, duration)             │ Pulls deposit
            ▼                                                            ▼
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │                     StreamPay Smart Contract (CA3D52RZ...ZA)                     │
 │  - Accrual math: streamed(t) = deposit * (now - start) / (end - start)           │
 │  - Escrow invariant: contract_balance >= sum(deposit - withdrawn)               │
 └──────────────────────┬───────────────────────────────────┬───────────────────────┘
                        │                                   │
       3. withdraw(stream_id, amount)      4. cancel_stream(caller, stream_id)
                        ▼                                   ▼
 ┌──────────────────────────────┐          ┌────────────────────────────────────────┐
 │ Employee (GBSNPDOVQIS...ODT) │          │ Pro-Rata Split:                        │
 │ Accrued funds claimable 24/7 │          │  - Recipient <- accrued balance        │
 └──────────────────────────────┘          │  - Sender    <- unaccrued remainder    │
                                           └────────────────────────────────────────┘
```

### Core Invariants Guaranteed by Contract

Every payroll operation is subject to formal verification invariants:

1. **Per-Stream Invariant**: `0 <= withdrawn <= streamed <= deposit` at every ledger sequence.
2. **Conservation of Funds Invariant**: Contract token balance $\ge \sum (\text{deposit} - \text{withdrawn})$ across all active streams.
3. **Deterministic CEI Ordering**: All payouts follow strict Checks-Effects-Interactions (CEI) to preclude reentrancy windows.
4. **No Silent Panics**: All operational rejections emit explicit `StreamError` codes (1..48) defined in [`docs/ERROR_SURFACE.md`](./ERROR_SURFACE.md) and [`frontend/lib/errors.ts`](../frontend/lib/errors.ts).

---

## 2. 50-Employee Payroll Migration Walkthrough

This walkthrough demonstrates the exact operational procedure for onboarding 50 employees using the synthetic payroll dataset located at [`docs/runbook/payroll_50_employees.csv`](runbook/payroll_50_employees.csv).

All operations are reproducible against Stellar Testnet using the headless [`tools/streampay-cli`](../tools/streampay-cli) or `stellar contract invoke`.

### Step 1: Ingesting & Validating Payroll CSV

Before submitting any transactions, the operations team runs preflight linting on the input CSV:

```bash
# Validate format, addresses, and sum payroll deposit units
./docs/runbook/batch_payroll_migration.sh docs/runbook/payroll_50_employees.csv
```

#### Verification Checklist

- [x] All 50 employee public keys conform to StrKey format (`G` followed by 55 characters in Base32 alphabet `[A-Z2-7]`).
- [x] No duplicate Stellar public keys exist within the batch.
- [x] Deposit amounts are positive integers expressed in 7-decimal smallest units ($1.00\text{ USDC} = 10{,}000{,}000\text{ units}$).
- [x] Duration is 30 days ($2{,}592{,}000\text{ seconds}$).
- [x] Total payroll deposit equals $458{,}000.00\text{ USDC}$ ($4{,}580{,}000{,}000{,}000\text{ units}$).

### Step 2: SAC Token Allowance Approval

StreamPay contracts pull funds during `create_stream`. The employer treasury account must approve an allowance to the StreamPay contract:

```bash
# Set environment signer
export STREAMPAY_SECRET_KEY="S..."
export CONTRACT_ID="CA3D52RZWTGQ7DCU5E7JNKDMXY5L4N6ZQRJ4V7W5KLMNOPTUVWXYZA"
export TOKEN_ID="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"

# Check employer USDC balance
stellar contract invoke \
  --id "$TOKEN_ID" \
  --source env \
  --network testnet \
  -- balance --id "GD3K5V2X6M7NJJ4L6N6A6W43I7KVU55M7A4PY2K6QZ8W5N3T7R1QDEMO"

# Approve StreamPay contract as spender for total payroll batch (4,580,000.00 USDC)
stellar contract invoke \
  --id "$TOKEN_ID" \
  --source env \
  --network testnet \
  -- approve \
  --from "GD3K5V2X6M7NJJ4L6N6A6W43I7KVU55M7A4PY2K6QZ8W5N3T7R1QDEMO" \
  --spender "$CONTRACT_ID" \
  --amount 4580000000000 \
  --expiration_ledger 10552000
```

### Step 3: Batch Stream Creation

Execute the batch migration script or iterate records using `streampay create`:

```bash
# Example single invocation for Employee #1 (Alex Chen)
streampay --contract "$CONTRACT_ID" --signer env create \
  --token "$TOKEN_ID" \
  --recipient "GBSNPDOVQISUCBYWYQCZUYDZDJNT2Q3HGYR2Q4WO367PRQANI32INODT" \
  --deposit 50000000000 \
  --days 30 \
  --cancelable
```

The migration harness submits the batch throttled at 2 transactions per ledger close to avoid sequence number collisions. Output is recorded in [`docs/runbook/migration_manifest.json`](runbook/migration_manifest.json) and [`docs/runbook/testnet_migration_execution.log`](runbook/testnet_migration_execution.log).

### Step 4: Real-Time Accrual & Verification

Once created, verify that continuous accrual is functioning on-chain:

```bash
# Query stream metadata for Stream #101
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source env \
  --network testnet \
  -- get_stream --stream_id 101

# Inspect available accrued balance in real time
streampay --contract "$CONTRACT_ID" --signer env --dry-run --json \
  withdraw --stream-id 101 --amount 1000
```

---

## 3. Month-of-Production Lifecycle Operations

Continuous payment streams introduce mid-cycle interactions not present in batch payroll. This section details operational handling for events during the 30-day period.

### Day 7: Mid-Month Recipient Withdrawal

Employees can withdraw accrued wages on demand at any time without HR intervention:

```bash
# Recipient executes withdrawal of accrued wages
streampay --contract "$CONTRACT_ID" --signer env withdraw \
  --stream-id 101 \
  --amount 10000000000
```

**Diagnostic Audit:**

- The contract verifies: `amount <= available(stream_id)`.
- Updates internal state: `withdrawn = withdrawn + amount`.
- Transfers tokens from contract to recipient.

### Day 14: Employee Offboarding & Pro-Rata Cancellation

When an employee departs mid-month (e.g. EMP-007, George Clark, on Day 14), either the employer or employee can cancel the stream. The contract atomically splits the balance:

```bash
# Execute pro-rata cancellation
streampay --contract "$CONTRACT_ID" --signer env cancel \
  --stream-id 107
```

**Mathematical Split (Day 14 / Day 30):**

- Total Deposit: $8{,}500.00\text{ USDC}$
- Elapsed Time: $1{,}209{,}600\text{ s}$ out of $2{,}592{,}000\text{ s}$ ($46.67\%$)
- Accrued to Employee: $3{,}966.67\text{ USDC}$ (transferred to recipient immediately)
- Unaccrued Refund to Employer: $4{,}533.33\text{ USDC}$ (refunded to employer immediately)
- Stream Status: Transitioned from `Active` to `Cancelled`.

### Day 21: Performance Promotion & Stream Top-Up

If an employee receives a salary adjustment or bonus mid-stream (e.g. EMP-010, Julia Roberts, $+2{,}500.00\text{ USDC}$):

```bash
# Top up existing active stream
streampay --contract "$CONTRACT_ID" --signer env top-up \
  --stream-id 110 \
  --amount 25000000000
```

**Contract Behavior:**

- Employer must have approved SAC allowance for top-up amount.
- `deposit = deposit + amount`.
- Remaining duration recalculated; stream rate per second increases proportionally to ensure new total is fully released by `end_time`.

### Day 30: Final Settlement & Batch Claim

At $t \ge \text{end\_time}$, accrual reaches 100%. Employees or aggregators can sweep all remaining balances using `claim-all`:

```bash
# Batch claim all mature recipient balances
streampay --contract "$CONTRACT_ID" --signer env claim-all
```

---

### State snapshots: `streampay-state verify`

Before and after an upgrade or migration, export the contract's storage with the
`streampay-state` tool and verify the snapshot's invariants. Scripts and drills
should read its machine-readable report (`verify --format json`) rather than the
text output: the report shape is a versioned contract, with a published JSON
Schema and an additive-only compatibility policy, documented in
[`tools/streampay-state/README.md`](../tools/streampay-state/README.md).

## 4. Troubleshooting Decision Tree

When an operational failure occurs, engineers and operators must follow this decision tree. Every symptom is mapped to diagnostic commands, root causes, exact fixes, and escalation paths.

```text
                                 [ OPERATIONAL SYMPTOM DETECTED ]
                                                │
         ┌──────────────────┬───────────────────┼───────────────────┬──────────────────┐
         ▼                  ▼                   ▼                   ▼                  ▼
    [Validation]         [Wallet /]          [TTL /]             [Index /]          [Refund /]
     Rejection           Signature           Storage             Discovery          Partial
    (Error 1..46)         Failure            Surprise              Gap               State
         │                  │                   │                   │                  │
      Node A              Node B              Node C              Node D             Node E
```

---

### Node A: Validation Rejections

| Symptom / Error Code                 | Diagnostic Command                                                                          | Root Cause                                                   | Immediate Fix                                                     | Escalation             |
| ------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------- |
| **Code 4: `DepositZero`**            | Inspect CSV `deposit_units` column                                                          | Deposit amount passed was 0 or negative                      | Set deposit to positive integer $> 0$.                            | Public issue / Ops fix |
| **Code 5: `InvalidDuration`**        | Inspect start/end parameters                                                                | Duration $< 60\text{ s}$ or $> 5\text{ years}$               | Adjust `days` parameter to valid range.                           | Public issue / Ops fix |
| **Code 6: `StartTimePast`**          | `date +%s` vs `start_time`                                                                  | Start timestamp is $> 300\text{ s}$ before ledger time       | Use CLI default (now $+ 60\text{ s}$).                            | Public issue / Ops fix |
| **Code 16: `InsufficientAllowance`** | `stellar contract invoke --id $TOKEN_ID -- allowance --from $SENDER --spender $CONTRACT_ID` | SAC token allowance lower than deposit                       | Execute `Token.approve` with sufficient amount and expiry ledger. | Ops fix                |
| **Code 22: `StreamNotActive`**       | `stellar contract invoke --id $CONTRACT_ID -- get_stream --stream_id $ID`                   | Attempted withdrawal/top-up on cancelled or completed stream | Confirm stream ID. Stream is immutable once finalized.            | Ops fix                |

---

### Node B: Wallet & Signature Failures

| Symptom                                    | Diagnostic Command                                                                                                        | Root Cause                                                    | Immediate Fix                                                                  | Escalation            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------- |
| **`txBAD_SEQ` (Sequence Number Mismatch)** | `curl -s -X POST "$RPC_URL" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}'` | Concurrent transactions submitted from same account           | Re-fetch source account sequence from Horizon/RPC before building transaction. | Ops retry             |
| **Simulation Rejection (HostError)**       | `streampay --contract $CONTRACT_ID --signer env --dry-run --json create ...`                                              | Soroban host rejected call during `simulateTransaction`       | Inspect `eventXdr` and simulation report error code.                           | Check Node A          |
| **Hardware Wallet Payload Mismatch**       | Compare `unsignedXdr` hash vs device prompt                                                                               | Signer mode `ledger` generated XDR modified before submission | Never modify unsigned XDR envelope. Submit raw signed XDR via `--signed-xdr`.  | Hardware wallet guide |
| **Missing Signer Permission**              | `stellar keys address env` vs contract governor                                                                           | Caller is neither sender, recipient, nor contract governor    | Switch signer to the authorized account address for that specific stream.      | Security boundary     |

---

### Node C: TTL & Storage Expiry Surprises

A TTL alert is a prediction from one RPC read, not proof of imminent expiry: before paging, work the [§7 TTL-sentinel triage decision tree](#7-ttl-sentinel-expiry-alert-triage).

Soroban state entries require rent maintenance. If an entry reaches its TTL cliff without renewal, reads fail. Preview the exact write-free extension plan with `node infra/ttl-sentinel/dist/src/cli.js extend --dry-run --json`; see the [sentinel README](../infra/ttl-sentinel/README.md#dry-run-report-mode).

| Symptom                                         | Diagnostic Command                                                                      | Root Cause                                          | Immediate Fix                                                                                   | Escalation          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------- |
| **`MissingValue` on active stream ID**          | `stellar contract invoke --id $CONTRACT_ID -- get_stream --stream_id $ID`               | Data entry TTL expired due to sentinel gap          | Run `extend_footprint` on contract instance and entry key via TTL sentinel.                     | On-call P1          |
| **Sentinel Budget Alert (`BurnExceedsBudget`)** | `curl -s http://localhost:9095/metrics \| grep streampay_sentinel_burn_vs_budget_ratio` | Network rent surge or sudden influx of live streams | Increase sentinel treasury allocation or enable `expire-demo-first` degradation policy.         | Infrastructure Lead |
| **Poison Account in Renewal Queue**             | Check sentinel log: `Account quarantined`                                               | Deleted or malformed key blocking renewal batch     | Sentinel quarantines poison key automatically without stalling queue. Verify in health surface. | Issue #219 planner  |

---

### Node D: Index Discovery Gaps

| Symptom                                     | Diagnostic Command                                                                                                             | Root Cause                                       | Immediate Fix                                                           | Escalation      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------- | --------------- |
| **Stream exists on-chain but absent in UI** | 1. `stellar contract invoke --id $CONTRACT_ID -- get_stream --stream_id $ID`<br>2. `curl -s http://localhost:9090/streams/$ID` | Indexer event poller has lagged behind chain tip | Query `IndexerEventLag` metric; check if indexer cursor is advancing.   | Indexer Ops     |
| **Indexer cursor stalled > 5 ledgers**      | `curl -s http://localhost:9090/health`                                                                                         | Unhandled RPC exception or network disconnect    | Restart indexer daemon: `docker compose restart indexer`.               | Ops runbook § 1 |
| **SQLite DB locked (`SQLITE_BUSY`)**        | `lsof \| grep indexer.db`                                                                                                      | High-volume write contention without WAL mode    | Enable WAL mode: `sqlite3 /data/indexer.db "PRAGMA journal_mode=WAL;"`. | Ops runbook § 1 |

---

### Node E: Refund & Partial-State Confusion

| Symptom                                                       | Diagnostic Command                                                                                                                         | Root Cause                                              | Immediate Fix                                                                                                   | Escalation         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------ |
| **"Employee claimed they did not get full salary on cancel"** | Inspect contract events for `StreamCancelled` topic                                                                                        | Unaccrued remainder correctly refunded to employer      | Check accrual elapsed ratio: recipient receives `streamed - withdrawn`; unstreamed portion returns to employer. | Expected behavior  |
| **Contract balance mismatch (`ReconciliationDivergence`)**    | Run reconciler verification scan: `stellar contract invoke --id $CONTRACT_ID -- verify_treasury --token $TOKEN_ID --start_id 1 --limit 50` | Divergence between off-chain database and Soroban state | Soroban state is immutable source of truth. Re-index affected ledger range.                                     | **P0 Alert** (§ 5) |

---

### Node F: RPC Degradation & Throttling

| Symptom                           | Diagnostic Command                                          | Root Cause                                              | Immediate Fix                                                                          | Escalation           |
| --------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------- |
| **HTTP 429 Too Many Requests**    | Check response headers: `Retry-After`                       | Public Soroban RPC rate limit exceeded                  | Configure private RPC endpoint or increase backoff interval (`POLL_INTERVAL_MS=3000`). | Infra / RPC provider |
| **HTTP 503 / 502 Bad Gateway**    | `curl -I https://soroban-testnet.stellar.org`               | RPC node experiencing infrastructure downtime           | Failover to secondary RPC node provider.                                               | Infra failover       |
| **Transaction inclusion timeout** | `streampay --contract $CONTRACT_ID ...` returns exit code 5 | Ledger surge; transaction did not include in 10 ledgers | Query transaction status by hash before resubmitting to avoid duplicate creation.      | Soroban timeout      |

---

## 5. Incident Escalation & Security Policy

Escalation boundaries are strictly wired to [`SECURITY.md`](../SECURITY.md):

```text
 ┌─────────────────────────────────────────────────────────────────────────────────┐
 │                            INCIDENT CLASSIFICATION                              │
 └────────────────────────┬───────────────────────────────────────┬────────────────┘
                          │                                       │
                CRITICAL / SECURITY RISK               NON-EXPLOITABLE / OPERATIONAL
                          │                                       │
                          ▼                                       ▼
             [ PRIVATE DISCLOSURE ONLY ]                 [ PUBLIC ISSUE TRACKER ]
             - Potential funds movement bug              - Documentation drift / typos
             - Invariant violation (balance coverage)    - CLI usability improvements
             - Authentication / authorization bypass     - Public security report form
             - Reentrancy / CEI sequence flaw            - Routine RPC node maintenance
                          │                                       │
                          ▼                                       ▼
             GitHub Private Security Advisory             GitHub Issues / Discussions
             Direct maintainer escalation                 Standard sprint triage
```

The script will:

1. Boot mock indexer and reconciler endpoints exposing Prometheus `/metrics`.
2. Inject each simulated fault:
   - High event lag (`P95 > 30s`)
   - Queue depth surge (`depth = 1200`)
   - RPC error burst (`error_rate = 25%`)
   - State divergence (`stream_balance divergence detected`)
3. Validate alert trigger criteria and verify metrics exposition syntax.
4. Reset faults and assert recovery.

---

## 5. Transactional Outbox Alerts

These alerts cover the transactional outbox inside the production indexer
(`GET /metrics` on the indexer port, spec in [docs/OUTBOX.md](./OUTBOX.md)).
Delivery intents are never lost — an alarm here means consumers are receiving
events late, duplicating, or dead-lettering, not that data is gone.

### `IndexerOutboxDepthDiverging`

- **Severity**: Critical (P1)
- **Condition**: `streampay_outbox_divergence_alarm == 1` for > 1 minute — total outbox depth has grown strictly monotonically across every tick sample above `OUTBOX_ALARM_MIN_DEPTH`.
- **User Impact**: Replay feeds (`GET /streams/:id/events?after=`) and push consumers fall progressively further behind chain truth. Nothing is lost (intents are durable), but staleness is unbounded until it is addressed.

#### Diagnosis

1. See which state is accumulating:
   ```bash
   curl -s http://localhost:8787/api/outbox/stats
   ```
2. Check per-consumer health and rate budgets:
   ```bash
   curl -s http://localhost:8787/api/outbox/consumers
   curl -s http://localhost:8787/api/outbox/intents?state=dead
   ```
3. Confirm the dispatcher is alive (`streampay_outbox_dispatch_total` must advance).

#### Remediation

1. Disable the failing consumer channel so healthy ones drain:
   `POST /api/outbox/consumers/:id/status {"status":"disabled"}`.
2. Raise dispatcher throughput (`OUTBOX_BATCH_SIZE`, `OUTBOX_TICK_MS`) or scale the consumer.
3. After endpoint recovery, replay dead letters: `POST /api/outbox/intents/:id/replay`.
4. If ingestion itself outran drain durably, replay pull consumers from their cursors — the journal retains everything.

### `IndexerOutboxDeliveryLagHigh`

- **Severity**: Warning (P2)
- **Condition**: Oldest pending intent older than 60s for > 3 minutes.
- **Diagnosis / Remediation**: Same sequence as above; typically one slow endpoint or an over-throttled `rate_limit_per_sec`. Force a catch-up tick with `POST /api/outbox/flush`.

### `IndexerOutboxDeadLetterRateHigh`

- **Severity**: Warning (P2)
- **Condition**: > 50 intents dead-lettered within 10 minutes.
- **Diagnosis / Remediation**: Inspect `dead_reason` on the DLQ rows (`max_attempts` vs `reorg_retracted`). Reorg retractions are expected after a chain reorg coordinated by the reconciler — verify `streampay_outbox_retracted_total` matches the reconciler's divergence report before replaying anything. Consumer endpoint failures require fixing the endpoint first, then batch-replaying dead intents.

### `IndexerOutboxBackpressured`

- **Severity**: Warning (P2)
- **Condition**: Any `rejected_backpressure` dispatch outcome within 5 minutes.
- **Diagnosis / Remediation**: `OUTBOX_MAX_DEPTH` engaged intentionally to protect a degraded downstream. Confirm which consumer is degraded, clear it, and depth will drain at ~2,900 intents/sec. If the threshold is chronically low for your ingestion rate, raise `OUTBOX_MAX_DEPTH`.

### Absolute Rules

1. **Never open a public issue** for any bug that could misplace funds or break contract accounting invariants.
2. **Use GitHub Private Vulnerability Reporting** to reach core maintainers under confidential disclosure.
3. **Pre-v1.0 Unsupported Boundary**: Mainnet deployments prior to the v1.0 audited release are unsupported. All live operations must remain on Stellar Testnet.

---

## 6. Observability & Service Alerts Reference

Every Prometheus alert configured in `infra/observability/prometheus/rules/alerts.yml` links to a specific diagnosis and remediation procedure below:

| Alert Name                         | Severity          | Service    | Baseline Soak Target                | Immediate Action                                            |
| ---------------------------------- | ----------------- | ---------- | ----------------------------------- | ----------------------------------------------------------- |
| `IndexerEventLagHigh`              | Warning (P2)      | Indexer    | P95 lag $\le 8.2\text{ s}$          | Check RPC responsiveness; inspect SQLite write queue        |
| `IndexerEventLagCritical`          | Critical (P1)     | Indexer    | P99 lag $\le 12.4\text{ s}$         | Inspect indexer logs; restart container if poller stalled   |
| `IndexerLedgerLagCritical`         | Critical (P1)     | Indexer    | Cursor delta $\le 1$ ledger         | Re-fetch Soroban RPC cursor; restart indexer                |
| `IndexerDBDepthGrowing`            | Warning (P2)      | Indexer    | Queue drains $< 50$ items/batch     | Ensure WAL mode active; allocate faster storage volume      |
| `IndexerDBDepthCritical`           | Critical (P1)     | Indexer    | Max burst depth observed $= 120$    | Force queue sync; follow `docs/INCIDENT_RUNBOOK.md`         |
| `SorobanRPCErrorRateHigh`          | Warning (P2)      | RPC Client | Error rate $\le 0.04\%$             | If 429, adjust backoff; rotate RPC keys                     |
| `SorobanRPCErrorRateCritical`      | Critical (P1)     | RPC Client | Error rate $> 20\%$                 | Total network disruption; failover to secondary RPC         |
| `ReconciliationDivergenceDetected` | **Critical (P0)** | Reconciler | **0 divergences** across 10,000 txs | **Immediate containment**: Soroban state is truth; re-index |
| `ReconcilerJobStalled`             | Critical (P1)     | Reconciler | Run interval $= 60\text{ s}$        | Restart reconciler daemon container                         |

---

## 7. TTL-Sentinel Expiry Alert Triage

The TTL sentinel ([`infra/ttl-sentinel/`](../infra/ttl-sentinel/README.md)) alerts on
severity *transitions* per storage-entry class. Every alert is a projection from
one `getLedgerEntries` read, so it can be wrong in five specific ways: the RPC
view was stale, the entry was extended after the read, another writer (a
contract write, or any operator's `ExtendFootprintTTL`) already did the work, the
rent model used the wrong fee curve, or the entry really is about to archive.
Work the tree in order and escalate only at step 5.

| Class | Worst-case cliff | Warn | Crit | Why the cliff is what it is |
|---|---:|---:|---:|---|
| `stream` / `index` | 200,000 ledgers | 150,000 | 60,000 | The contract extends on write with `extend_ttl(200_000, 500_000)`; a write at exactly the 200,000 threshold leaves exactly the cliff |
| `counter` / `instance` / `code` | 4,095 ledgers | 3,000 | 1,200 | `DataKey::NextStreamId`, the contract instance and the Wasm code entry are never extended on-chain, so they keep `min_persistent_entry_ttl - 1` |

At the 5 s protocol target the never-extended cliff is ≈5.7 hours, which is why
counter/instance/code alerts are the ones that matter most and also the ones
most often mis-attributed. The full derivation (and the 1 s/ledger worst-case
scan-gap margins) is in the sentinel README, "The math: true worst-case cliffs".

### 7.1 Decision tree

```text
TTL alert (console / JSONL / webhook)
   │
   ├─ 1. Is the ledger view current? ────────────────── no → stale RPC view:
   │      getLatestLedger advances; get_stream answers         false positive, stop
   │
   ├─ 2. Re-scan: is remainingLedgers still below the threshold? ─ no → already resolved:
   │      compare two scans ≥1 scan interval apart                       record and close
   │
   ├─ 3. Did something extend this entry since the alert? ──────── yes → false positive:
   │      remaining rose ~300k; observed cliff ≈500k;                 note who/when
   │      Horizon shows extend_footprint_ttl or an invoke
   │
   ├─ 4. Does the rent estimate match the planner's fee curve? ─── no → rent-model drift:
   │      compare scan --json .rent with `rent --streams N`               fix state size / sizes,
   │      at the configured state size                                    re-check; not an expiry risk
   │
   └─ 5. Remaining still below crit, no extension, reads still work → REAL RISK: escalate P1
```

### 7.2 Step 1 — Verify the ledger view

A cached or rate-limited RPC can serve an old `getLatestLedger`, which makes every
ETA and every "remaining" figure look worse than it is. Two reads must advance,
and the contract must answer a read call.

```bash
export RPC_URL="${TTL_SENTINEL_RPC_URL:-https://soroban-rpc.stellar.org}"
export CONTRACT_ID="${STREAMPAY_CONTRACT_ID:?export STREAMPAY_CONTRACT_ID first}"

# Two reads ten seconds apart: a frozen sequence means the view is stale.
for i in 1 2; do
  curl -s -X POST "$RPC_URL" -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' | jq -r '.result.sequence'
  sleep 10
done

# Prove the contract answers at all; a missing entry is the archive case, not a TTL warning.
stellar contract invoke --id "$CONTRACT_ID" --source "$STELLAR_SOURCE" --network testnet \
  -- get_stream --stream_id "${STREAM_ID:?export STREAM_ID first}"
```

If the sequence is frozen, fix the RPC path (see the RPC row in
[OPERATIONS.md](./OPERATIONS.md#32-ordered-failure-table-what-breaks-what)) and
re-run the sentinel before treating the alert as real. Do not escalate on a
stale view.

### 7.3 Step 2 — Re-scan and compare

Run the sentinel yourself, twice. It reads the same entries the alert did and
prints the exact fields the alert was built from.

```bash
cd infra/ttl-sentinel
npm ci
npm run build
node dist/src/cli.js scan --contract "$CONTRACT_ID" --rpc "$RPC_URL" --json > /tmp/ttl-scan-1.json

# Non-ok projections: the alerted entry, its class and the observed cliff per entry.
jq '.projections[] | select(.severity != "ok")
    | {id, cls, severity, remainingLedgers, observedCliffLedgers}' /tmp/ttl-scan-1.json

# Was the counter readable? A fallback scan cannot see streams created during downtime.
jq '{atLedger, usedCounterFallback: .report.usedCounterFallback, counterLive: .report.counter.present}' \
  /tmp/ttl-scan-1.json

sleep 60
node dist/src/cli.js scan --contract "$CONTRACT_ID" --rpc "$RPC_URL" --json > /tmp/ttl-scan-2.json

# remainingLedgers must fall by exactly (ledger2 - ledger1). A rise is an extension.
jq -s '[.[] | {atLedger, worst: (.projections | sort_by(.remainingLedgers) | first
    | {id, cls, severity, remainingLedgers, observedCliffLedgers})}]' \
  /tmp/ttl-scan-1.json /tmp/ttl-scan-2.json
```

Read the pair like this:

- **Fell by the ledger delta** — the projection is true; continue to step 3.
- **Rose, or `observedCliffLedgers` jumped from ≈200,000 to ≈500,000** — the entry
  was extended between scans. False positive; record what extended it and close.
- **`usedCounterFallback: true`** — the counter entry was unreadable, so the scan
  cannot enumerate streams created while it was down. Treat the count as a lower
  bound and check the counter entry itself before escalating.

### 7.4 Step 3 — Check for a recent extension

Two different things extend an entry, and only one of them is a Soroban
operation:

- a **contract write** (`create_stream`, `withdraw`, `top_up`, `cancel_stream`)
  calls `extend_ttl` internally — it appears on Horizon as `invoke_host_function`,
  and in the sentinel output as a higher `observedCliffLedgers`;
- an **out-of-band `ExtendFootprintTTL`** from any account (the protocol allows
  anyone to extend anyone's entry) — it appears as `extend_footprint_ttl`.

```bash
# Out-of-band extensions in the alert window. Horizon keeps roughly 24 h of history.
curl -s "https://horizon-testnet.stellar.org/operations?type=extend_footprint_ttl&order=desc&limit=200" \
  | jq --argjson since "$(($(date +%s) - 7200))" \
    '[._embedded.records[] | select((.created_at | fromdateiso8601) >= $since)
      | {created_at, source_account, extend_to, transaction_hash}]'

# Confirm the storage itself is intact and readable. Export is simulation-only; it signs nothing.
cargo run -q -p streampay-state -- export \
  --rpc "$RPC_URL" --contract "$CONTRACT_ID" --out /tmp/streampay-state.json
cargo run -q -p streampay-state -- verify --snapshot /tmp/streampay-state.json
jq '{latest_ledger, streams: (.streams | length), contract_frozen}' /tmp/streampay-state.json
```

If an extension landed for the alerted entry, this is a false positive: the
alert was true when it fired and was resolved by the extension. Nothing to
page. If `streampay-state verify` fails, that is a storage-consistency incident,
not a TTL one — follow [INCIDENT_RUNBOOK.md](./INCIDENT_RUNBOOK.md) instead.

### 7.5 Step 4 — Recompute the rent estimate

The alert answers "how long", not "how much". Rent only enters triage when the
budget alarm (`streampay_sentinel_burn_vs_budget_ratio`) or a `BurnExceedsBudget`
alert is in play, because a stale fee curve makes the planner look over budget
when it is not.

The model is the one in [`infra/ttl-sentinel/src/rent.ts`](../infra/ttl-sentinel/src/rent.ts)
(`rs-soroban-env` `fees.rs`, CAP-0066/protocol-23 values):

```text
rent_stroops = ceil(size_bytes × fee_per_1kb × ledgers / (1024 × 1215))
```

`fee_per_1kb` is 1,000 stroops on the floor, rises linearly to 10,000 at the 3 GB
live-state target, then grows 5× faster; code entries pay one third. Sizes are
measured, not guessed: 504 B per `Stream` entry, 92 B counter, 96 B instance,
136 + 12 × ids per index entry, and the Wasm size for the code entry. Those come
from `src/sizes.ts`; [`FOOTPRINT.md`](./FOOTPRINT.md) records the same entry at
484 B of ledger footprint (444 B value + 40 B key) — the sentinel measures the
whole `LedgerEntryData`, envelope included, which is why it prices at 504 B.
Both agree the `Stream` entry dominates per-stream cost.

[`src/planner.ts`](../infra/ttl-sentinel/src/planner.ts) turns that into a
schedule: candidates below `thresholdLedgers`, grouped by account, ≤ 50 keys per
transaction, priced as `rentStroops(size, extendTo - remaining, feePer1Kb)` plus
one `extensionOverheadStroops()` per key (the 48-byte TTL entry write), against a
600-ledger window, a 1,000 XLM treasury, a 50 XLM/day burn limit and an 85 %
alarm threshold. Rent is linear per ledger, so steady-state monthly upkeep is
`rent(size, ledgers in a month)` — it does not compound.

```bash
cd infra/ttl-sentinel

# Offline projection at the state size you believe the network is at.
node dist/src/cli.js rent --streams "${STREAM_COUNT:-1000}" \
  --state-size "${SOROBAN_STATE_BYTES:-0}" --json \
  | jq '{feePer1KbAtState: .rent.feePer1KbAtState, totalXlmAtState: .rent.totalXlmAtState,
         perStream: .rent.perStreamMonthlyXlmAtState}'

# What the last scan actually measured and priced.
jq '{feePer1KbAtState: .rent.feePer1KbAtState, rows: .rent.rows,
     totalXlmAtState: .rent.totalXlmAtState}' /tmp/ttl-scan-1.json
```

How to read the result:

- `feePer1KbAtState: 1000` is the floor. That is correct while live Soroban state
  is under ~2 GB, and it is what the README's 0.021 XLM/stream/month figure
  assumes.
- If the two runs disagree, the `sorobanStateSizeBytes` input is stale (or was
  taken from a different network). Fix the config and re-run; this is model
  drift, not an expiry risk. Do not raise the budget to match a stale curve.
- If the projection and the scan agree and burn still exceeds the monthly cap,
  the risk is financial, not archival: use the `expire-demo-first` degradation
  policy and the budget meter (`.spender.json`) instead of extending everything.

### 7.6 Step 5 — Escalate only on confirmed risk

Escalate when all of the following hold:

- the ledger view advances (step 1);
- two scans show `remainingLedgers` falling by exactly the ledger delta, below
  the class `critLedgers` (step 2);
- no extension landed in the window and `observedCliffLedgers` still equals the
  class cliff (step 3);
- the contract still answers reads, but the next write would fail once the entry
  archives.

That is a P1 by the [OPERATIONS escalation ladder](./OPERATIONS.md#42-escalation-hierarchy)
when the entry is `counter`, `instance` or `code` (< 1,200 ledgers), and a P2 for
a `stream`/`index` warning with days of runway. Attach both scan JSON files, the
Horizon window and the `streampay-state` snapshot to the incident.

Remediation is a TTL extension, not a rollback and not a redeploy:

```bash
cd infra/ttl-sentinel

# Dry run: prints the plan and submits nothing (extender.enabled=true in config).
node dist/src/cli.js extend --config ./ttl-sentinel.config.json --json

# Submit only after the plan looks right, with the funded key in the env var named
# by extender.secretKeyEnv (default TTL_SENTINEL_EXTENDER_SECRET).
node dist/src/cli.js extend --config ./ttl-sentinel.config.json --execute --json

# The instance and code entries have no storage key; extend them directly.
stellar contract extend --id "$CONTRACT_ID" --source-account "$STELLAR_SOURCE" \
  --network testnet --ledgers-to-extend 500000

# Only if the entry already archived: restore it first, then extend.
stellar contract restore --id "$CONTRACT_ID" --source-account "$STELLAR_SOURCE" \
  --network testnet
```

### 7.7 Worked example A — false positive (stream already extended)

The sentinel alerted on a stream, and a `withdraw` extended it before the
operator looked. Console output of the alert:

```text
[2026-11-18T09:12:04Z] FIRED WARN stream/stream:1841 remaining=149600 (~2.5d fastest) observed-cliff=200000 — below warn threshold: 149600 ledgers remain (live until 1479600)
  contract=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC ledger=1330000
```

Step 2's second scan, eight ledgers after the first (≈40 s at 5 s/ledger):

```text
[2026-11-18T09:37:10Z] RESOLVED OK stream/stream:1841 remaining=499840 (~28.9d fastest) observed-cliff=500000 — monitoring: 499840 ledgers remain (live until 1829840)
  contract=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC ledger=1330008
```

`remaining` rose by 350,240 and `observed-cliff` moved from 200,000 to 500,000:
the entry was written while the alert was in flight, so `extend_ttl` bumped it to
the 500,000-ledger target. Step 3 found the corresponding contract write and no
out-of-band extension. False positive; the sentinel's own `RESOLVED` transition
is the record. No page, no extension, no budget spend.

### 7.8 Worked example B — real positive (counter near its 4,095-ledger cliff)

The counter entry is never extended on-chain, so its whole life is 4,095 ledgers
from creation. A critical alert:

```text
[2026-11-19T02:40:11Z] FIRED CRIT counter/counter remaining=1180 (~98m fastest) observed-cliff=4095 — below critical threshold: 1180 ledgers remain (live until 451180)
  contract=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC ledger=450000
```

Step 2, 5 minutes (60 ledgers) later:

```text
[2026-11-19T02:45:20Z] RE-ALERT CRIT counter/counter remaining=1120 (~93m fastest) observed-cliff=4095 — below critical threshold: 1120 ledgers remain (live until 451180)
  contract=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC ledger=450060
```

`remaining` fell by exactly 60, `observed-cliff` is still 4,095, step 3 found no
extension, and `get_stream` still answers. The projection is true. Once this
entry archives, `create_stream` fails until it is restored — a P1. Dry-run the
extender, then extend; the send raises the cliff to the configured `extendTo`
(500,000), and the next scan emits the matching `RESOLVED` transition.

---

## 8. Anomaly Detection Alert Triage

These alerts come from the heuristic detector inside the indexer
(`indexer/src/anomaly/`, design in [docs/ANOMALY.md](./ANOMALY.md)). A
detection is never a verdict: it is a recorded claim — "rule X, at version V,
saw this shape over ledgers A–B" — that an operator can re-derive from the
journal. So triage here has two halves that must not be confused:

- **Is the pattern real for this account?** (fraud/operations question)
- **Does the alert still reproduce from its own citation?** (integrity question)

Every route below needs the same credential the webhook registry uses, and is
tenant-scoped: a detection belonging to another tenant answers `404`, never
`403`.

```bash
export KEY="x-streampay-webhook-key: $ANOMALY_WEBHOOK_KEY"
export BASE=http://localhost:8787
```

### 8.1 First, read the detection, not the alert

The alert annotation names a rule id; the detection carries the evidence.

```bash
curl -s -H "$KEY" "$BASE/api/anomaly/detections?mode=enforce&limit=20"
curl -s -H "$KEY" "$BASE/api/anomaly/rules"
curl -s -H "$KEY" "$BASE/api/anomaly/incidents"
```

`mode=enforce` is the set that actually paged a human — a `shadow` detection
looks identical in the list but was recorded to be reviewed, not escalated.
Redaction is applied at this boundary: subjects are 8-character address
prefixes and `amount`/balance attributes are dropped, so the evidence you read
here cites structure (counts, distinct payees, direction of flow), never
balances. The raw values stay in the store precisely so replay can re-derive
them.

Then replay it. This is the step that decides whether the rest of the triage is
about a customer or about the detector:

```bash
curl -s -X POST -H "$KEY" "$BASE/api/anomaly/detections/<id>/replay"
```

`verified` means the cited ledger range still produces the same numbers under
the thresholds recorded on the detection. Anything else is the alert-specific
path below.

### `IndexerAnomalyCriticalIncidentOpen`

- **Severity**: Critical (P1)
- **Condition**: `increase(streampay_anomaly_detections_by_severity_total{severity="critical"}[10m]) > 0` for 5 minutes.
- **User impact**: `circular_flow` is the only critical rule today — streams created in both directions between the same pair of addresses, which is the shape a layering or self-dealing payout produces. Nothing has been lost on-chain; an escrowed stream is still settling while the pattern is unresolved.

#### Diagnosis

1. Identify the rule and the subject from the alert labels, then read its
   detections and the open incident (`subject` is a redacted pair key).
2. Replay the detection (§8.1). Three outcomes split the work:
   - `verified` — the pattern is real; continue on-chain.
   - `not_reproduced` — the range no longer holds the claimed events. Do not
     escalate to the customer yet: treat it as
     [`IndexerAnomalyReplayMismatch`](#indexeranomalyreplaymismatch).
   - `range_too_large` / `citation_incomplete` / `rule_version_unavailable` —
     the detector cannot self-verify; the alert stands but is unconfirmed, and
     the reason tells you which knob (`ANOMALY_REPLAY_MAX_EVENTS`, retention) is
     responsible.
3. Check the two accounts against the ledger truth rather than the detector's
   opinion:
   ```bash
   curl -s "$BASE/streams?recipient=<address>"                     # both directions
   stellar contract invoke --id $CONTRACT_ID -- get_stream --stream_id $ID
   ```
4. Confirm whether this is genuinely new traffic or a re-notification of a
   long-open incident: `streampay_anomaly_alerts_total{type="raised"}` advancing
   with `streampay_anomaly_incidents_open` unchanged means the same subject is
   still firing (the flap window re-notifies; it does not duplicate the
   incident).

#### Remediation

1. Real pattern: this is a funds-movement question, not a paging question.
   Follow §5 — pause the streams (`pause_stream`), and escalate to the tenant's
   payroll owner. A cancellation splits pro-rata; pausing does not move money, so
   pause first.
2. False positive: record the review, because the false-positive budget is what
   keeps this rule from waking anyone next time.
   ```bash
   curl -s -X POST -H "$KEY" -d '{"label":"false_positive","note":"in and out were two currencies of one settlement"}' \
     "$BASE/api/anomaly/detections/<id>/feedback"
   ```
   That call also suppresses the subject for `ANOMALY_SUPPRESSION_TTL_MS`. A
   second, contradictory review is rejected with `409 already_reviewed` — the
   budget must not depend on who looked last.
3. Mis-tuned rule: raise the threshold or set it back to shadow for that tenant
   only (`POST /api/anomaly/rules/circular_flow/override`), never by editing
   `ANOMALY_RULES_JSON` on a running fleet.
4. Record the verdict in the incident channel with the detection fingerprint
   (`sha256:…`), not the alert's timestamp — the fingerprint is what replay and
   a later audit both agree on.

### `IndexerAnomalyReplayMismatch`

- **Severity**: Critical (P1)
- **Condition**: `increase(streampay_anomaly_replay_total{outcome="mismatch"}[30m]) > 0`.
- **User impact**: none directly. This is the detector disagreeing with its own
  past statement, which is worse than a false positive: an alert that will not
  reproduce cannot be defended to a customer or an auditor.

#### Diagnosis

Replay is only ever run deliberately, so this alert fires because *you* (or a
verifier) pressed the button and the numbers moved. Read `detail` in the replay
response first — it distinguishes the three ways a claim can rot:

1. **The evidence changed.** The journal rows for `citation.from_ledger..to_ledger`
   were retracted or rewritten — almost always a chain reorg the reconciler
   handled. Compare the cited range against the reconciler's divergence report
   and `streampay_outbox_retracted_total` for the same window.
2. **The rule changed under the detection.** `rule_version` on the detection vs
   `version` in `GET /api/anomaly/rules`. A version bump without the old
   thresholds still resolvable yields `rule_version_unavailable`; a mismatch
   after a same-version edit means someone overrode a param and expected replay
   to be unaffected.
3. **The count came from outside the range.** Replay re-derives only the
   subject's own observations inside the citation (scope-filtered), while the
   live engine saw a sliding event-time window. A small `events_read` difference
   with matching shape is this; a large one is (1).

#### Remediation

1. Stop trusting the rule, not the account: demote it to shadow for every tenant
   that has it in enforce, until the mismatch is explained. Shadow detections
   still record and still replay; they page nobody.
   ```bash
   curl -s -X POST -H "$KEY" -d '{"mode":"shadow"}' \
     "$BASE/api/anomaly/rules/<rule_id>/override"
   ```
2. If the cause is a reorg, the alert is correct behaviour and the detection was
   a true statement about a retractable history. Note it on the incident, keep
   the detection (it is the record), and add the ledger range to the reconciler's
   next audit pass.
3. If the cause is (2) or (3), file it as a detector defect with the
   fingerprint, both `rule_version` values and the replay `detail`. Do not
   "fix" it by re-running the engine over the range: replay exists precisely so
   that the answer does not depend on live state.
4. Once fixed, replay the detection again; `verified` is the only closing
   condition.

### `IndexerAnomalyRuleUnreliable`

- **Severity**: Warning (P2)
- **Condition**: false positives exceed 30% of a rule's reviews over 1 day, sustained 6 hours.
- **User impact**: alert fatigue for the tenant's operations team. Every
  paged detection from this rule is currently two-thirds likely to be ordinary
  traffic.

#### Diagnosis

1. Compare the alert's view with the gate the tenant actually runs under — the
   gate is stricter and per tenant:
   ```bash
   curl -s -H "$KEY" "$BASE/api/anomaly/promotion"
   ```
   `reports[].false_positive_rate` vs `false_positive_budget`, plus `reviewed`
   against `min_reviews`.
2. Read the reviews that produced the rate (`GET /api/anomaly/detections/<id>`
   carries the full feedback history with notes). The notes are the cheapest
   tuning information in the system: they say *why* a human disagreed.
3. Check whether the rule is firing on volume rather than shape — usually
   `burst_creation` and `dust_spam` thresholds calibrated against a small
   tenant's payroll and applied to a large one.

#### Remediation

1. Tune for that tenant only, within the declared param ranges
   (`POST /api/anomaly/rules/<rule_id>/override`). An out-of-range number is a
   `400`, not a silent clamp — the range you hit is the range the catalog
   documents.
2. If the mode is `enforce` and the rate stays over budget, demote to shadow and
   let the review evidence re-accumulate; promotion is refused with `409
   promotion_not_ready` and machine-readable `reasons` for exactly this case.
3. Un-tune entirely when the tenant wants defaults back:
   `DELETE /api/anomaly/rules/<rule_id>/override`.
4. Suppressions from these reviews are expected and good, but watch
   `suppressed` in `GET /api/anomaly/incidents` — that is the input to
   [`IndexerAnomalySuppressionFlood`](#indexeranomalysuppressionflood).

### `IndexerAnomalySuppressionFlood`

- **Severity**: Warning (P2)
- **Condition**: `increase(streampay_anomaly_suppressed_total[1h]) > 1000` for 1 hour.
- **User impact**: detections are being skipped. Suppression means the
  evaluation was not run for a subject a human marked as noise — so if the
  suppressed subject turns out to be a real pattern, this rule is blind to it.

#### Diagnosis

1. Which rule, and how broad? Per-rule skip counts:
   `streampay_anomaly_suppressed_total{rule_id="…"}`.
2. What is suppressed, for whom:
   ```bash
   curl -s -H "$KEY" "$BASE/api/anomaly/incidents"   # suppressions[] with subject + expires_at_ms
   ```
3. Two shapes explain almost every flood: one suppression applied to a
   high-throughput subject (a payroll provider's shared sender account), or
   repeated reviews of the same subject that keep extending it because the
   pattern really is persistent.
4. Confirm the TTL is what you think it is: `ANOMALY_SUPPRESSION_TTL_MS` is the
   deployment default and a suppression records its own expiry, so old rows are
   not affected by a recent change.

#### Remediation

1. Clear what no longer applies — the list is the audit trail, so remove
   suppressions by reviewing the underlying detection, not by deleting store
   rows.
2. If a genuinely broad subject must stay quiet, narrow the rule instead
   (`scope`/params via the tenant override) rather than stacking suppressions.
3. If the flood is one very active suppressed account, re-examine the original
   `false_positive` review. Suppression has no "confirmed fraud" counterpart, so
   a wrong label is the only way a real pattern gets muted.
4. When in doubt, let it expire: suppression is a TTL, not a ban. The next
   window after `expires_at_ms` evaluates the subject again and the incident
   dedup will re-notify on a sustained pattern.

---

## 9. Webhook Delivery SLA Alert Triage

These alerts cover the multi-tenant webhook registry inside the indexer
(spec in [docs/WEBHOOKS.md §7](./WEBHOOKS.md)). They sit above the outbox
alerts in §5: the outbox guarantees an intent exists and is durable, this layer
guarantees the intent reached a *specific subscriber inside the latency the
subscriber was sold* — `WEBHOOK_SLA_MS`, measured over a sliding window with at
least `WEBHOOK_SLA_MIN_SAMPLES` attempts.

The single most important distinction in this section (§9.1): **fleet breach vs
one tenant breach.** `streampay_webhook_sla_breach_alarm` is the deployment's
budget (`WEBHOOK_SLA_BREACH_BUDGET` of attempts over objective);
`streampay_webhook_sla_breached_by_tenant` is one subscriber's own window. The
first is an outage, the second is an account conversation.

### 9.1 Fleet breach vs one tenant

Both gauges answer the same question — what fraction of a sliding window of
delivery attempts missed `WEBHOOK_SLA_MS` — over different populations, and
they are deliberately not allowed to substitute for each other:

| Signal                                     | Population it measures      | What it means when it is 1                       | Who owns it         |
| ------------------------------------------ | --------------------------- | ------------------------------------------------ | ------------------- |
| `streampay_webhook_sla_breach_alarm`       | every attempt, all tenants  | the platform is missing the number it sells      | Indexer on-call     |
| `streampay_webhook_sla_breached_by_tenant` | one tenant's attempts       | one integrator's endpoint, or a quota discussion | That tenant's owner |

A fleet alarm with no tenant series behind it is possible for exactly one
reason, and it is worth knowing before you name a subscriber in a ticket: the
per-tenant window must also hold `WEBHOOK_SLA_MIN_SAMPLES` attempts before it
may engage. A dozen tenants with a handful of slow deliveries each are under
every tenant's own sample floor but over the fleet's, so the aggregate pages
while no individual account does. That is platform tuning, not an account
problem — and it is why `IndexerWebhookSlaBreached` pages the fleet while
`IndexerWebhookTenantSlaBreached` stays a ticket.

```bash
curl -s -H "$KEY" "$BASE/api/webhooks/sla"       # this caller's measured window
curl -s -H "$KEY" "$BASE/api/webhooks/quota"     # subscriptions / events / rotations budget
curl -s -H "$KEY" "$BASE/api/webhooks/deliveries?limit=50"
curl -s -H "$KEY" "$BASE/api/webhooks/dlq"
```

With no `WEBHOOK_TENANT_KEYS` configured the registry is single-tenant and the
registry-only routes (`/sla`, `/quota`) answer `503` — in that deployment these
alerts still fire, but read them as "the one subscriber is us".

### `IndexerWebhookSlaBreached`

- **Severity**: Warning (P2)
- **Condition**: `streampay_webhook_sla_breach_alarm == 1` for 5 minutes — i.e. `streampay_webhook_sla_breach_ratio` is over `WEBHOOK_SLA_BREACH_BUDGET` of the sliding window, which only starts reporting once the window holds `WEBHOOK_SLA_MIN_SAMPLES` attempts.
- **User impact**: subscribers are receiving events outside the latency commitment in their contract. Nothing is lost — undelivered work is retried on the published schedule and lands in the DLQ only after it exhausts.

#### Diagnosis

1. Confirm the objective and the measurement agree:
   `streampay_webhook_sla_objective_seconds` must equal `WEBHOOK_SLA_MS`. If it
   does not, the deployment's env and the SLA the endpoints were registered
   under have diverged, and every number below is against the wrong bar.
2. Find whose deliveries are slow, not just how slow:
   ```bash
   curl -s -H "$KEY" "$BASE/api/webhooks/deliveries?limit=50"
   ```
   Latency per attempt is in `streampay_webhook_delivery_latency_seconds_bucket`;
   the P50/P95/P99 quantiles are already graphed in the "Webhook Delivery SLA &
   Tenancy" dashboard row.
3. Separate the three causes by the outcome labels on
   `streampay_webhook_dispatch_total`:
   - `retry` rising, `delivered` still advancing → one endpoint is slow but
     recovering. Not an outage.
   - `dead_letter` rising → the endpoint is failing hard; see §5
     `IndexerOutboxDeadLetterRateHigh`.
   - `blocked_ssrf` → a subscriber repointed its URL at a private address. This
     is a rejection, not a latency problem, and it will never self-heal.
4. Check the dispatcher is being starved rather than the endpoint being slow:
   `streampay_webhook_oldest_pending_seconds` climbing while per-attempt
   latency stays low means the tick budget, not the subscriber.

#### Remediation

1. Slow endpoint, healthy platform: lower that subscription's event types
   (`PATCH /api/webhooks/endpoints/:id`) or disable it so the shared budget goes
   to everyone else, then re-enable once the subscriber fixes their handler.
2. Starved dispatcher: raise throughput (`OUTBOX_BATCH_SIZE`, tick interval) —
   the webhook fan-out draws from the same durable intents §5 describes.
3. Repointed/blocked URL: ask the subscriber for a public HTTPS target. Do not
   widen the SSRF guard for one tenant.
4. Anything that reached the DLQ is replayable after the endpoint recovers:
   `POST /api/webhooks/dlq/:id/retry`. Replay is idempotent by delivery id, so
   re-driving a whole backlog is safe even if the subscriber already saw some of
   it.

### `IndexerWebhookTenantSlaBreached`

- **Severity**: Warning (P2)
- **Condition**: `streampay_webhook_sla_breached_by_tenant == 1` for 5 minutes.
- **User impact**: exactly one integrator is outside their commitment. The fleet is fine — that is the entire reason the per-tenant series exists.

#### Diagnosis

1. The alert label carries `tenant_id`; that is the whole scope of the incident.
   Ask for that tenant's own view:
   ```bash
   curl -s -H "$KEY" "$BASE/api/webhooks/sla"
   ```
   (as the tenant's credential — the route is scoped, and another tenant's key
   cannot read it).
2. Compare their endpoints: `GET /api/webhooks/endpoints` shows target URL,
   subscribed event types, and enabled state. A tenant with one endpoint
   subscribed to everything is the usual shape.
3. Confirm it is their endpoint and not their quota: `GET /api/webhooks/quota`
   reports subscription/event/rotation budgets, and a throttled tenant looks
   identical to a slow one from the outside.

#### Remediation

1. Name the subscriber in the incident and hand them the per-attempt evidence —
   never the signing secret. Reads carry `secret_fingerprint` for exactly this
   reason.
2. If their traffic simply outgrew one endpoint, they should add one per event
   family rather than have you raise the objective.
3. Retire dead subscriptions: `PATCH /api/webhooks/endpoints/:id` to disable
   (keeps history) instead of `DELETE` (removes the subscription) whenever the
   account may come back.

### `IndexerWebhookSlaBreachedSustained`

- **Severity**: Critical (P1)
- **Condition**: `streampay_webhook_sla_breach_alarm == 1` for 20 minutes.
- **User impact**: the breach has outlived the first retry cohort (attempt 3 of the ~51-minute schedule), so deliveries are now accumulating dead letters and subscriber state is drifting away from chain truth.

#### Diagnosis

1. Treat this as §5 `IndexerOutboxDepthDiverging`'s push-consumer twin: check
   outbox depth and `streampay_outbox_dispatch_total` advancing first. If the
   outbox is also diverging, the webhook layer is a symptom, not the fault.
2. Count how much is now unrecoverable without a replay: `GET
   /api/webhooks/dlq` and `streampay_webhook_sla_breaches_total`.
3. Ask whether the objective moved: a `WEBHOOK_SLA_MS` lowered mid-incident
   makes a healthy platform suddenly "breaching". The gauge is measured against
   the objective at sample time.

#### Remediation

1. Contain the fan-out before the cause: disable the slowest consumer channel so
   healthy tenants drain, exactly as in §5.
2. If the platform was down rather than the subscriber, reconcile before
   replaying: a subscriber that missed 20 minutes of events needs the pull feed
   (`GET /streams/:id/events?after=`) re-synced, because replaying every queued
   intent will not repair a hole it never had a chance to fill.
3. Replay dead letters only after the endpoint answers 2xx on a test fire —
   `POST /api/webhooks/endpoints/:id/test`, which emits a `stream_ping` —
   otherwise you are re-filling the same DLQ.
4. Post-incident: record the measured breach ratio, not the alert time, so the
   subscriber conversation is about the number they were promised.

### `IndexerWebhookBacklogAging`

- **Severity**: Warning (P2)
- **Condition**: `streampay_webhook_oldest_pending_seconds > 300` for 5 minutes.
- **User impact**: at least one delivery is past its first retry. This is the earliest webhook signal there is — it fires while the work is still pending, before any of it becomes a dead letter.

#### Diagnosis

1. Decide whether one endpoint is blocking the queue or the whole platform is
   stalled. Dispatch is a single sequential loop — up to 25 due deliveries per
   tick, each awaited in turn — so **one slow subscriber does age everyone
   else's backlog** (head-of-line blocking inside the tick). The tell is whose
   attempts are missing: if only one tenant's series is over objective while the
   dispatch counter keeps advancing at its normal rate, that tenant's handler is
   eating the tick budget. If `streampay_webhook_dispatch_total` is flat, the
   dispatcher itself is not running.
2. Confirm the dispatcher loop is alive: `streampay_webhook_dispatch_total` must
   advance between scrapes. Flat counter + rising age = stalled tick.
3. Check for a retry stampede: after an endpoint outage ends, every queued
   attempt becomes due at once and the oldest-pending gauge can stay high while
   throughput is actually at its maximum.

#### Remediation

1. Stalled tick: restart the indexer (the outbox and webhook dispatch share its
   loop) and verify the cursor advances; durable intents mean no event is lost.
2. Stampede: let it drain. Raising throughput here trades a 5-minute-old
   pending item for a subscriber receiving its whole backlog at once.
3. One persistently slow subscriber: disable its endpoint
   (`PATCH /api/webhooks/endpoints/:id`). Because the dispatch tick is shared,
   leaving it active taxes every other tenant's latency budget — throttling the
   fan-out globally would only make the whole fleet slower in the same way.
4. If aging is chronic at healthy volume, the retry schedule is fighting the
   dispatch budget — revisit `WEBHOOK_SLA_MIN_SAMPLES` only so the SLA gauge
   starts reporting sooner, never to make this alert quieter.

---

## 10. Materialized Analytics Alert Triage

These alerts cover the outbox-driven portfolio views specified in
[docs/ANALYTICS.md](./ANALYTICS.md). A stale view is not necessarily lost data:
the journal remains the source of truth, the watermark identifies the last
committed fold position, and an atomic rebuild can recover it. It is, however,
unsafe to present the view as current.

### 10.1 Establish whether the writer is moving

1. Read `GET /api/analytics/views` or scrape `streampay_analytics_lag_events`,
   `streampay_analytics_staleness_seconds`, and `streampay_analytics_dirty`.
   Separate **event lag** (unfolded journal rows) from **event-time age** (how
   old the watermark event is). A quiet chain can age a view without lag.
2. Read `GET /api/analytics/refresh/stats`. Check `errors`, `last_error`,
   `watermark_seq`, `journal_seq`, `events_per_second`, and the worker's
   `capped_ticks`. Two scrapes with an advancing watermark mean the writer is
   healthy but behind; a flat watermark with rising lag means it is stalled.
3. Check the shared indexer ingestion and SQLite health. Analytics uses the same
   process/database as ingestion and the outbox. Do not restart repeatedly while
   a transaction is still committing.
4. Preserve freshness gates. Never answer `stale_view` with ungated rows just to
   clear a dashboard alarm; that hides the consistency failure from clients.
5. If startup refuses a pre-existing database with a complete-history error,
   stop ingestion, set `START_LEDGER` before the contract's first event, and
   reindex into a fresh database. Older outbox rows lack newly subscribed events;
   do not set the marker by hand or append a historical backfill at the journal
   tail.

### `IndexerAnalyticsStalenessBreach`

- **Severity**: Warning (P2)
- **Condition**: any `streampay_analytics_slo_breach{view}` is `1` for 5 minutes.
- **User impact**: a view is older than `ANALYTICS_SLO_MS` or more than one
  `ANALYTICS_BATCH_SIZE` behind. Clients requesting freshness can time out.

#### Diagnosis and remediation

1. If lag is rising, compare `events_per_second` with
   `streampay_analytics_budget_events_per_second` and sustained ingestion. Follow
   the throughput-shortfall procedure below.
2. If lag is zero but age is rising, check the ledger timestamp of the journal
   head and the configured SLO. On a halted chain this is expected aging, not a
   fold bug; do not trigger endless rebuilds.
3. If a bucket-width change preceded the incident, run one manual rebuild and
   verify parity. Bucket configuration is not a live semantic switch.
4. If only one view is dirty, treat it as reorg recovery and follow the dirty
   procedure. All four views normally share one fold watermark.

### `IndexerAnalyticsStalenessCritical`

- **Severity**: Critical (P1)
- **Condition**: `streampay_analytics_slo_violation_seconds > 60` for 5 minutes.
- **User impact**: sustained, material loss of freshness beyond the promised SLO.

Stop serving the affected dashboard as current, preserve the journal, and fix
the writer bottleneck before rebuilding. After watermarks catch up, compare
`GET /api/analytics/assets` with a naive scan over the same journal range and
record both the lag and the duration of the breach. Raising the SLO is not a
remediation unless the product commitment is deliberately being changed.

### `IndexerAnalyticsDirty`

- **Severity**: Critical (P1)
- **Condition**: `streampay_analytics_dirty == 1` for 2 minutes.
- **User impact**: a retraction made previously applied events untrue; gated
  reads are blocked until a rebuild publishes the surviving journal.

1. Confirm the reorg through the outbox retraction record and reconciler. Do not
   clear the marker or edit view rows by hand.
2. Inspect `last_error`. A failed rebuild leaves the views at their previous
   complete fold position; restore database/storage health first.
3. The next worker tick normally rebuilds automatically. If the journal is
   stable and storage is healthy, call `POST /api/analytics/rebuild` with an
   incident reason and verify `dirty` becomes `0`.
4. Confirm the watermark does not pass retracted rows and spot-check funded,
   claimed, settled, and refunded totals before reopening gated reads.

### `IndexerAnalyticsRefreshErrors`

- **Severity**: Warning (P2)
- **Condition**: `increase(streampay_analytics_errors_total[5m]) > 0`.
- **User impact**: one or more folds rolled back. The previous watermark is
  still truthful, but the backlog or dirty state may now violate the SLO.

Use `last_error` to distinguish SQLite/storage failure from an invalid fold
input. Refresh writes measures, dimensions, and watermark in one transaction,
so a crash does not leave a partially applied batch. Retrying is safe: either
the original transaction committed and its watermark advanced, or it rolled
back and the same rows are eligible again. Repeated failures with a flat
watermark require storage diagnosis, not a rebuild loop.

### `IndexerAnalyticsThroughputShortfall`

- **Severity**: Warning (P2)
- **Condition**: journal lag is nonzero while the latest batch sustains less
  than 80% of `ANALYTICS_THROUGHPUT_BUDGET_EPS` for 10 minutes.
- **User impact**: catch-up is slower than the configured capacity promise and
  will eventually breach freshness.

1. Rule out an idle or tiny batch before changing capacity; the alert already
   requires outstanding rows, but the last-batch rate is still a coarse gauge.
2. Check `capped_ticks`. Frequent caps with an advancing watermark mean the
   budget is protecting ingestion as intended; size the budget for sustained
   ingest plus recovery headroom.
3. Check SQLite lock duration and disk latency. Increase `ANALYTICS_BATCH_SIZE`
   only if larger transactions do not starve ingestion; increasing it does not
   raise the events/second budget by itself.
4. After changing capacity, verify `lag_events` trends down and gated-read
   failures clear. Do not disable the worker to relieve write contention.

### `IndexerAnalyticsGatedReadFailures`

- **Severity**: Warning (P2)
- **Condition**: more than 5% of gated reads time out over ten minutes.
- **User impact**: callers cannot obtain a portfolio at their requested ledger
  or event lag.

Correlate the failures with SLO and throughput alerts. If all views are behind,
fix the writer. If one caller alone requests an impossible `min_ledger`, correct
the caller rather than relaxing the fleet's gates. `wait_ms` is capped by
`ANALYTICS_MAX_WAIT_MS`; increasing either only masks a slow writer and consumes
request capacity. Once healthy, verify a request at the current ledger succeeds
and reports `waited_ms` consistent with actual catch-up.
