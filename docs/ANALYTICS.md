# Materialized Analytics

The indexer maintains four SQLite materialized views over its transactional
outbox journal. Dashboards read these aggregates instead of scanning `streams`.
The design and recovery contract for issue #581 live here; operational triage is
in [RUNBOOK §10](RUNBOOK.md#10-materialized-analytics-alert-triage).

## Views

| View | Key | Measures |
|---|---|---|
| `address_totals` | address, role, token | streams created/active, funded, claimed, settled, refunded, nominal scheduled rate |
| `asset_totals` | token | the same portfolio measures and summed nominal scheduled rate, plus remaining escrow |
| `accrual_buckets` | token, event-time bucket | realized flows, creations, cancellations, withdrawals |
| `rate_ladder` | token, bucket | signed changes to nominal, fixed-point, and active-span rates |

Address and asset `rate_per_second` is the nominal floor rate of nonterminal
streams, updated by lifecycle events rather than wall-clock time. It can remain
nonzero after a stream's scheduled end until a terminal event arrives; use the
rate ladder or forecast for time-aware projections. Address reads do not expose
`escrow_remaining`: role-attributed historical flows cannot reconstruct a valid
per-address liability. Only asset reads provide that portfolio aggregate.

Address roles are `sender`, `recipient`, and `refund`. A cancellation's
unstreamed remainder is credited to the configured refund target, which can be
different from the sender. `escrow_remaining` is a portfolio-level aggregate on
asset reads; do not sum per-address values to reconstruct it.

Amounts are signed decimal strings in JSON and decimal `TEXT` in SQLite. The
writer adds them with `BigInt`: SQLite arithmetic on `TEXT` would coerce to
IEEE-754 and lose precision for Soroban `i128` values. Reads and Prometheus
metrics expose no stream identifiers or per-stream amounts. Address and token
filters belong on authenticated/authorized API queries, never metric labels.

## Fold and accounting

`src/analytics/fold.ts` is the sole event-to-delta implementation. Incremental
refresh and full rebuild call the same fold, so they cannot disagree about event
semantics. Journal `seq` is the cursor; ledger numbers are watermarks for
freshness, not ordering keys.

- Creation funds escrow and starts a rate span at the scheduled start, including
  elapsed accrual when scheduled execution arrives late.
- Top-ups fund escrow and reprice the original window for an unrenegotiated
  stream, or only the renegotiated tail after an accepted rate change. The payer
  receives the funded amount even when someone other than the current sender
  tops up.
- Withdrawals claim escrow and do not reduce the original deposit. A withdrawal
  of the full deposit marks the stream depleted and stops future accrual.
- Cancellation settles the recipient's accrued amount, refunds the remainder,
  closes active counts, and stops the nominal rate.
- Pause/resume and accepted rate changes persist piecewise rate schedules and
  edit the rate ladder at their effective stream times. Resume shifts the stream
  window and starts visibility at the resumed stream time, so paused wall time
  cannot accrue. Negative rate-change adjustments refund the current sender.
- Ownership acceptance moves role attribution without changing token accounting.
  Sender transfers explicitly pin or move refund rights; refund-target changes
  alter later cancellation routing. Cancellation recovers the effective stop
  from the recipient payout rather than assuming ledger close time.
- `batch_withdraw_summary` and `streams_created` are counted but never priced:
  their constituent per-stream events already carry the money.

Unknown journal event names advance the watermark and increment
`events_skipped_unknown`; they do not invent zero-valued financial facts.

## Refresh, watermarks, and recovery

A refresh transaction folds at most `ANALYTICS_BATCH_SIZE` rows, accumulates
view deltas, persists changed stream dimensions, and advances all watermarks.
Either all of that commits or none of it does. Replaying a journal page cannot
apply it twice because the durable watermark is the only cursor.

The worker derives each tick's event budget from
`ANALYTICS_THROUGHPUT_BUDGET_EPS × refresh interval`. A capped tick leaves the
remaining rows for the next tick, bounding write-lock occupancy during
backfill. Rebuilds are deliberately unbudgeted: a reorg recovery must publish a
complete journal fold atomically.

`POST /api/analytics/rebuild` folds the entire surviving journal in memory and
then replaces the live tables and watermarks in one transaction. Readers see
the old complete state or the new complete state, never an empty intermediate
state. The outbox reorg retraction hook marks analytics dirty in the same
transaction as the tombstones. The marker survives restart; gated reads refuse
dirty data and the next worker tick rebuilds it. A failed rebuild leaves the
dirty marker set.

Before the first fold, staleness uses the journal head's event time, so a fresh
process with a backlog cannot advertise an empty view as current. The SLO is in
chain event time: a quiet chain can age a view without any new event arriving.

### Upgrade history requirement

Analytics prices `rate_change_accepted`, `ownership_accepted`, and
`sender_transferred` as well as the original lifecycle events. Older outbox rows
do not contain those newly subscribed event names, and appending a backfill at
the journal tail would violate sequence order.

When analytics is enabled, startup therefore requires `START_LEDGER` to name a
ledger before the contract's first event. The same value initializes ingestion
and is recorded with a durable complete-history marker; later starts must match
that recorded value or startup fails closed. An empty event table is
not proof of complete history: an advanced `cursor`, `ingest_ledger`, or other
ingestion state without the marker also fails closed. Starting at the latest
ledger remains available only with analytics disabled.

Opening a pre-existing indexer database without the marker fails closed with a
fresh-database reindex instruction. Reindex from the certified start ledger into
a new database; do not fabricate the marker or append historical rows manually.
A deployment may open an old database with analytics disabled, but it cannot
later enable analytics on that uncertified history without a fresh reindex.

## Configuration

| Variable | Default | Meaning |
|---|---:|---|
| `ANALYTICS_ENABLED` | `1` | `0` disables the worker and makes operational routes answer `503 analytics_disabled` |
| `START_LEDGER` | required | First ledger to ingest; must precede the contract's first event when analytics is enabled |
| `ANALYTICS_BUCKET_MS` | `3600000` | Accrual and ladder bucket width |
| `ANALYTICS_REFRESH_MS` | `1000` | Worker cadence |
| `ANALYTICS_BATCH_SIZE` | `500` | Maximum journal rows per refresh transaction |
| `ANALYTICS_SLO_MS` | `30000` | Maximum event-time age; lag must also be no more than one batch |
| `ANALYTICS_MAX_WAIT_MS` | `5000` | Hard cap on a gated read's wait |
| `ANALYTICS_WAIT_POLL_MS` | `50` | Poll interval while a gated read waits |
| `ANALYTICS_THROUGHPUT_BUDGET_EPS` | `500` | Sustained refresh budget in journal events/second |
| `ANALYTICS_API_TOKEN` | unset | Bearer token required by every `/api/analytics/*` route when set; required in production |
| `ANALYTICS_MUTATION_RATE_PER_SEC` | `5` | Per-client fixed-window budget for refresh/rebuild requests; excess requests receive `429` |
| `TRUST_PROXY_HOPS` | `0` | Exact reverse-proxy depth trusted for client-IP attribution; keep `0` when directly exposed |

Changing bucket width changes the meaning of existing bucket rows. Run a manual
rebuild after changing it. Keep the throughput budget above sustained ingestion
or lag will grow even when every individual tick succeeds.

## HTTP API

All view responses have `{ view, data, staleness, waited_ms }`. Amounts are JSON
strings. The freshness query parameters are shared by address, asset, accrual,
and forecast reads:

- `min_ledger`: minimum acceptable applied ledger.
- `max_lag_events`: maximum acceptable journal rows behind the head.
- `wait_ms`: how long the read may wait, capped by `ANALYTICS_MAX_WAIT_MS`.

An unmet gate answers `503` with `code: "stale_view"`, the watermark, lag, and
wait duration. Reads never perform a fold themselves.

Set `ANALYTICS_API_TOKEN` in production and send `Authorization: Bearer <token>`
on every analytics request. Missing or incorrect credentials receive `401` with
`WWW-Authenticate: Bearer`. Leaving it unset preserves local/open development
behavior; it is not a production authorization mode. This token grants access to
the whole portfolio, not tenant-scoped access, so multi-user deployments should
also enforce user authorization at the ingress. `/metrics` is a separate surface
and must be protected by the deployment's scrape-network policy.

Refresh and rebuild share a per-client fixed-window mutation budget. Requests
over `ANALYTICS_MUTATION_RATE_PER_SEC` receive `429` with
`code: "rate_limited"`; reads and the background worker are not throttled. Behind
a reverse proxy, set `TRUST_PROXY_HOPS` to the exact number of trusted proxies in
the chain so clients receive separate budgets. Leaving it at `0` is safe for a
directly exposed service but groups every proxied client under the proxy address;
overstating the depth trusts spoofable forwarding headers.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/analytics/views` | View definitions, watermarks, lag, SLO and dirty state |
| `GET` | `/api/analytics/addresses/:address` | Address totals; optional `role`, `token`, and gate parameters |
| `GET` | `/api/analytics/assets` | Asset totals; optional `token` and gate parameters |
| `GET` | `/api/analytics/accrual` | Buckets; optional `token`, `from_ms`, `to_ms`, `limit` (1–10000), and gates |
| `GET` | `/api/analytics/forecast` | Rate-ladder projection; requires `token`, optional `at_ms`, `horizon_ms`, and gates |
| `POST` | `/api/analytics/refresh` | Run one budgeted worker tick |
| `POST` | `/api/analytics/rebuild` | Atomically rebuild; optional JSON `{ "reason": "..." }` |
| `GET` | `/api/analytics/refresh/stats` | Durable store counters and worker counters |

Forecasts integrate materialized rates, not stream rows. The public ladder keeps
net changes per bucket, while an internal exact-effective-time table retains
changes that would otherwise cancel inside one bucket. Cumulative ladder columns
seed history with one indexed lookup; only exact events in the current bucket and
requested horizon are scanned. Each response bucket is integrated segment by
segment using the contract's whole-second accrual ticks, and `rate_per_second`
reports its opening live rate. Fixed-point rates retain fractions below one
unit/second. Responses include `total_projected`, per-bucket points, and `max_error_per_bucket`, which conservatively bounds
fixed-point residue, per-span floor rounding, and bucket-boundary quantization.
Requests are limited to 10,000 points and reject timestamps whose horizon exceeds
JavaScript's safe integer range.

## Metrics and alerts

`GET /metrics` includes `streampay_analytics_*` series. The primary consistency
signals are:

- `streampay_analytics_watermark_seq{view}` and
  `streampay_analytics_watermark_ledger{view}`;
- `streampay_analytics_lag_events{view}` and
  `streampay_analytics_staleness_seconds{view}`;
- `streampay_analytics_slo_breach{view}` and
  `streampay_analytics_slo_violation_seconds`;
- `streampay_analytics_dirty`, `streampay_analytics_errors_total`, and
  `streampay_analytics_refresh_events_per_second`.

Alert rules and a Grafana row cover sustained SLO breach, an unrecovered reorg,
refresh errors, insufficient throughput, and gated-read failures. No address,
token, stream id, or amount is a metric label.

## Verification

`indexer/src/analytics/analytics.test.ts` covers independent naive cash-flow
parity, exact `i128` accumulation, incremental/rebuild parity, idempotent replay,
transaction rollback, cross-connection refresh/rebuild locking, durable reorg
invalidation across restart, batch-summary de-duplication, top-up repricing,
pause/resume visibility and batch boundaries, paused top-ups, full-withdrawal
depletion, cancellation-stop recovery, refund routing and transfer rights,
fractional, expired, and same-bucket forecasts, complete-history upgrade refusal,
SLO and blocking gates, non-default worker budgets, privacy, bearer denial,
mutation throttling, and HTTP request bounds.

```bash
cd indexer
npm run typecheck
npm run build
node --test dist/analytics/analytics.test.js
npm test
```
