# StreamPay Event Indexer

> **Running this against testnet or mainnet?** The development notes below are
> not an operations runbook. Configuration (every env var), initial backfill from
> a chosen ledger, catch-up after downtime, outbox replay and shutdown semantics
> are in [docs/INDEXER_OPERATIONS.md](../docs/INDEXER_OPERATIONS.md).

The StreamPay Event Indexer is a standalone TypeScript Node.js service that polls Soroban RPC `getEvents` for StreamPay smart contract events, decodes the contract's typed XDR event payloads using `@stellar/stellar-sdk`, persists stream metadata and an append-only event log in SQLite, maintains cursor persistence, and serves a lightweight HTTP query API.

The service indexes stream lifecycle, withdrawal, rate-change, ownership, refund-target, and batch-summary event topics. Unknown topics are filtered out at RPC. It also maintains incremental portfolio analytics over the transactional outbox journal; see [docs/ANALYTICS.md](../docs/ANALYTICS.md).

---

## 1. Prerequisites

- **Node.js**: `v22.0.0` or higher
- **npm**: `v10+` or `v11+`

### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `RPC_URL` | `https://soroban-testnet.stellar.org` | Stellar Soroban RPC URL |
| `CONTRACT_ID` | Required | StreamPay contract address (`C...`) |
| `POLL_INTERVAL_MS` | `5000` | Delay between polls (minimum 250 ms) |
| `PORT` | `8787` | HTTP listen port |
| `DATABASE_PATH` | `./data/streampay.sqlite` | SQLite database file |
| `START_LEDGER` | Latest RPC ledger | Initial ledger sequence if starting fresh without a saved cursor; required before the contract's first event when analytics is enabled |
| `GRPC_PORT` | `8788` | gRPC (HTTP/2) listen port; `0` disables the gRPC transport |
| `GRPC_MAX_SUBSCRIPTIONS_PER_TENANT` | `5` | Max concurrent gRPC subscriptions per tenant |
| `GRPC_MAX_EVENTS_PER_SECOND_PER_TENANT` | `100` | Per-tenant gRPC rate budget (token bucket, events/second) |
| `GRPC_MAX_QUEUE_PER_SUBSCRIPTION` | `100` | Bounded per-subscription gRPC queue (events) |
| `OUTBOX_TICK_MS` | `1000` | Transactional-outbox dispatcher poll interval |
| `OUTBOX_BATCH_SIZE` | `200` | Max intent claims per consumer per tick (cap 1000) |
| `OUTBOX_CLAIM_TIMEOUT_MS` | `60000` | Stale-claim reclaim threshold (crash recovery) |
| `OUTBOX_MAX_DEPTH` | off | Global backpressure threshold for pending+in-flight intents |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | off | 64-hex (or passphrase) AES-256-GCM key that seals signing secrets at rest |
| `WEBHOOK_REQUIRE_ENCRYPTION` | off | `1` refuses plaintext secret storage; creations answer `503` without a key |
| `WEBHOOK_TENANT_KEYS` | off | `tenantId:keyId:secret` triples, comma-separated (only digests are kept) |
| `WEBHOOK_DEFAULT_TENANT_ID` | `default` | Tenant used when no directory is configured |
| `WEBHOOK_TENANT_QUOTA_SUBSCRIPTIONS` | `20` | Subscriptions a tenant may hold |
| `WEBHOOK_TENANT_QUOTA_EVENTS` | `24` | Event names one subscription may select |
| `WEBHOOK_TENANT_QUOTA_ROTATIONS` | `6` | Secret rotations per rolling hour, per subscription |
| `WEBHOOK_SECRET_ROTATION_OVERLAP_MS` | `86400000` | How long a rotated-out secret keeps verifying |
| `WEBHOOK_SLA_MS` | `5000` | Per-attempt delivery commitment |
| `WEBHOOK_SLA_BREACH_BUDGET` | `0.01` | Fraction of the window allowed to miss the SLA |
| `WEBHOOK_SLA_MIN_SAMPLES` | `20` | Window depth required before the breach alarm engages |
| `ANOMALY_RULES_JSON` | off | Deployment-wide rule config, `{ "<rule_id>": { mode, severity, params, ... } }`; malformed or unknown knobs fail the boot |
| `ANOMALY_MODE` | `shadow` | Mode for rules nobody has named. `shadow` records detections and pages nobody |
| `ANOMALY_FLAP_WINDOW_MS` | `120000` | How long an incident must hold one state before the transition is reported |
| `ANOMALY_RENOTIFY_AFTER_MS` | `0` | Re-raise a still-open incident after this long; `0` disables heartbeats |
| `ANOMALY_HYDRATE_LEDGERS` | `2880` | Ledgers rebuilt into the sliding windows at boot; `0` skips hydration |
| `ANOMALY_HYDRATE_MAX_EVENTS` | `50000` | Rows one boot may read while hydrating; a truncated range is logged |
| `ANOMALY_SUPPRESSION_TTL_MS` | `86400000` | How long a `false_positive` review suppresses its subject (clamped to 30 days) |
| `ANOMALY_REPLAY_MAX_EVENTS` | `50000` | Rows one replay may read, so a citation cannot become a DoS |
| `ANOMALY_WEBHOOK_ALERTS` | on | `0` keeps anomaly alerts in the log instead of fanning out `anomaly_alert` deliveries |
| `ANALYTICS_ENABLED` | on | `0` disables the analytics worker and operational API |
| `ANALYTICS_BUCKET_MS` | `3600000` | Accrual/rate-ladder bucket width |
| `ANALYTICS_REFRESH_MS` | `1000` | Incremental analytics refresh cadence |
| `ANALYTICS_BATCH_SIZE` | `500` | Journal rows folded per transaction |
| `ANALYTICS_SLO_MS` | `30000` | Maximum view event-time age (and one batch of lag) |
| `ANALYTICS_MAX_WAIT_MS` | `5000` | Maximum wait for a freshness-gated read |
| `ANALYTICS_WAIT_POLL_MS` | `50` | Poll interval for a waiting read |
| `ANALYTICS_THROUGHPUT_BUDGET_EPS` | `500` | Refresh throughput budget in journal events/second |
| `ANALYTICS_API_TOKEN` | unset | Bearer token for every analytics route; required in production |
| `ANALYTICS_MUTATION_RATE_PER_SEC` | `5` | Per-client refresh/rebuild request budget per second |
| `TRUST_PROXY_HOPS` | `0` | Exact trusted reverse-proxy depth for client-IP attribution; keep `0` when directly exposed |
| `SHUTDOWN_DRAIN_MS` | `10000` | On SIGTERM/SIGINT, how long in-flight ingest and outbox dispatch may finish before the process exits (exit code `0` if drained, `1` if the window expired). Keep it below your orchestrator's kill grace period |
| `WASM_PLUGIN_TIMEOUT_MS` | `500` | Per-invocation wall-clock budget for a WASM plugin transform, in milliseconds (max 5000). A plugin that exceeds it is killed and the subscription falls back to the raw stream |
| `WASM_REDACTION_ENABLED` | unset (off) | Set to `1` to truncate full Stellar addresses in delivered event data to the 8-character prefix. Redaction runs after plugin transforms, never before |

This table is the short version. [docs/INDEXER_OPERATIONS.md §1](../docs/INDEXER_OPERATIONS.md#1-configuration) explains each variable's behaviour, its validation, the ingest/RPC knobs read by the config code (`INGEST_*`, `RPC_MAX_RPS`, `RPC_URL_FALLBACK_n`), and deployment profiles.

---

## 2. How to Run Locally

### Installation & Build

```bash
cd indexer
npm install
npm run typecheck
npm test
npm run build
npm start
```

### Running with Environment Variables

The service reads `.env` when your shell/environment loader provides it; Node does not load `.env` automatically. For example, on PowerShell:

```powershell
$env:RPC_URL = "https://soroban-testnet.stellar.org"
$env:CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4"
$env:PORT = "8787"
npm start
```

Or on Linux / macOS:

```bash
export RPC_URL="https://soroban-testnet.stellar.org"
export CONTRACT_ID="<YOUR_TESTNET_CONTRACT_ADDRESS>"
npm start
```

---

## 3. Database Persistence & Restarts

The SQLite database stores:
- **`streams` table**: Latest materialized state per stream (`stream_id`, `sender`, `recipient`, `deposit`, `withdrawn`, `status`, cancel amounts).
- **`events` table**: Append-only log of every received event (`id`, `stream_id`, `name`, `ledger`, `ledger_closed_at`, `payload`).
- **`indexer_state` table**: Persisted `cursor` and `lastLedger`.
- **Outbox and analytics tables**: Durable journal sequence, per-consumer delivery intents, materialized aggregate views, stream dimensions, watermarks, and recovery counters.

Repeated events are safe and idempotent: event IDs are unique, preventing double-counting across service restarts.

---

## 4. HTTP API Reference

### Machine-readable spec (OpenAPI 3.1)

The read surface is described by [`openapi.json`](openapi.json) (OpenAPI 3.1). It
covers every `GET` route the server registers — health, stream queries, the
outbox replay feed, signed proofs, webhook/outbox/WASM admin reads, the SSE
stream, the persisted-query GraphQL reads and `/metrics`. Mutating routes
(`POST`/`DELETE`) are intentionally out of scope.

The document is not hand-waved: `src/contract/openapi.test.ts` (wired into
`npm test`) checks the component schemas against the `Stream`,
`StreamServerEvent` and `RpcEvent` interfaces in `src/types.ts` using the
TypeScript compiler API, then calls every documented operation against a real
`createApp` server and validates the actual response body against the schema for
that status code. Adding a path to the spec without exercising it fails the
suite. A response that gains, loses or retypes a field fails with the JSON path
that drifted.

```bash
npm test              # full suite, includes the contract tests
npm run spec:check    # just the spec + contract tests
```

The validator (`src/contract/validate.ts`) implements the small JSON Schema
subset the spec uses, so no extra dependency was added.

Documented wire/type mismatch: `StreamServerEvent.streamId` is typed `string`,
but the SSE endpoint emits `null` for events the registry binds to no stream.
`openapi.json` describes the wire behaviour (`string | null`) and the contract
test allow-lists that one field; the type itself is unchanged here.

### Health Check
`GET /health`

```json
{
  "ok": true,
  "status": "ok",
  "lastLedger": "123456",
  "cursor": "0000000123456"
}
```

### Real-Time Event Stream (Server-Sent Events)
`GET /events/stream[?address=<address>][&streamId=<id>][&lastEventId=<id>]`

Streams live contract events as Server-Sent Events (`text/event-stream`). Supports address scoping, specific stream filtering, and resumption via `Last-Event-ID` header or query parameter. Emits heartbeat `: ping\n\n` frames every 15s.

```http
id: 0000000123456-00001
event: stream_created
data: {"id":"0000000123456-00001","streamId":"1","eventType":"stream_created","ledger":123456,"data":{...},"stream":{...}}
```

### Recipient Stream Query (Frontend discovery)
`GET /streams?recipient=<address>`

Returns all streams for the given recipient address. Returns `[]` if none found.

```json
[
  {
    "streamId": "1",
    "id": "1",
    "sender": "G...",
    "recipient": "G...",
    "token": "C...",
    "deposit": "1000000",
    "withdrawn": "250000",
    "status": "active"
  }
]
```

### Stream Event History
`GET /streams/:id/history`

Returns the full event log for a stream ID in ledger sequence order. Returns `[]` if not found.

```json
[
  {
    "id": "event-1",
    "stream_id": "1",
    "event_type": "stream_created",
    "ledger": 100,
    "payload": { ... }
  },
  {
    "id": "event-2",
    "stream_id": "1",
    "event_type": "withdrawn",
    "ledger": 105,
    "payload": { ... }
  }
]
```

### Stream Details by ID
`GET /streams/:id`

Returns the latest indexed projection, or `404` if not found:

```json
{
  "streamId": "7",
  "sender": "G...",
  "recipient": "G...",
  "token": "C...",
  "deposit": "1000000",
  "withdrawn": "250000",
  "status": "active",
  "lastLedger": 123456,
  "updatedAt": "2026-01-01T00:00:00Z"
}
```

### Streams by Address
`GET /address/:addr/streams`

Returns streams where the address is sender or recipient:

```json
{
  "address": "G...",
  "count": 1,
  "streams": [...]
}
```

---

### gRPC Streaming Transport (issue #579)

A binary, multiplexed alternative to REST polling / SSE, on HTTP/2
(`node:http2`, no new dependency). Proto definitions live in
[`src/grpc/events.proto`](src/grpc/events.proto); the hand-written
protobuf codec is [`src/grpc/codec.ts`](src/grpc/codec.ts) and the server
is [`src/grpc/server.ts`](src/grpc/server.ts).

- **Endpoint:** `POST /streampay.indexer.v1.StreamPayIndexer/Subscribe`
  on `GRPC_PORT` (default `8788`, cleartext h2c), plus the unary
  `POST /streampay.indexer.v1.StreamPayIndexer/Ack`.
  `Subscribe` is server-streaming: one request message, then a stream of
  `StreamEvent` messages (`seq`, `event_id`, `stream_id`, `name`,
  `ledger`, `ledger_closed_at`, `payload_json`, `idempotency_key`,
  `cursor`, `redacted`). `payload_json` is the same JSON the REST
  endpoints return for the same event, so a gRPC payload decodes to the
  same record as `GET /streams/:id/events` and `GET /streams/:id/history`
  (see `src/grpc.test.ts`).
- **Replay / resume:** a subscription replays the transactional outbox
  from `SubscribeRequest.cursor` (an outbox `seq`; `0` = from the start
  for that stream), then streams live events as they are ingested.
  Delivery is at-least-once. Ack seqs with the `Ack` RPC
  (`subscription_id` comes back in the `x-subscription-id` response
  metadata, or ack by `tenant` + `stream_id`); on reconnect, send the
  last acked seq as `cursor` and the server replays from `seq > cursor`.
  Unacked events are redelivered — dedup client-side by `seq` (or
  `event_id`), which is unique per event.
- **Flow control / backpressure:** three layers — HTTP/2 flow control
  (the server pauses when the stream's `write()` returns false and
  resumes on `drain`), application-level credit (`initial_credit`,
  topped up by `Ack` messages; default 100), and a bounded
  per-subscription queue (default 100 events). A slow consumer pauses
  only its own subscription: its undelivered seq stays un-advanced, so
  the next drain replays the same outbox rows, and ingestion and other
  subscribers are never blocked.
- **Limits:** at most `GRPC_MAX_SUBSCRIPTIONS_PER_TENANT` (default 5)
  concurrent subscriptions per tenant (excess gets
  `RESOURCE_EXHAUSTED` / grpc-status `8`), and a per-tenant token-bucket
  rate budget of `GRPC_MAX_EVENTS_PER_SECOND_PER_TENANT` (default 100
  events/second). A throttled subscription is delayed, never dropped.
  The tenant comes from `SubscribeRequest.tenant` or the `x-tenant-id`
  metadata (default `"default"`).
- **Privacy redaction:** with `redact_addresses: true`, Stellar
  addresses in `payload_json` are truncated to their 8-character prefix
  via the shared helper in `src/redaction.ts` (`sanitizeAddress`), and
  `redacted` is set on the message. With it off the payload is
  byte-identical to REST.
- **Freshness gate:** the `EventName` enum in `events.proto` mirrors the
  canonical registry (`schemas/events/registry.json`, #213) and
  `src/generated/events.ts` exactly. `src/grpc.test.ts` parses the proto
  and fails on any drift between the proto, the registry and the
  generated table — when the registry gains an event, add its enum value
  here (alphabetical order) and regenerate the table.

### GraphQL Read API (persisted queries only)
`POST /graphql` — body `{ "queryId": "<id>", "variables": { ... }, "tenant": "<tenant>" }`.
Only allowlisted persisted queries run; ad-hoc `query` text, unknown
`queryId`s and `GET /graphql` are rejected with `400`. Responses are
GraphQL-shaped `{ "data": { ... } }` (or `{ "data": null, "errors": [...] }`).

`GET /graphql/schema` — returns the schema SDL as plain text.

Available persisted queries (`indexer/src/graphql/persisted.ts`):

| queryId | What it returns |
|---|---|
| `GetStream` | One stream by id (all scalar fields) |
| `GetStreamWithForecast` | Stream + `forecast(at)` |
| `GetStreamWithRelations` | Stream + sender/recipient `Address` nodes + first 10 events |
| `GetStreamHistory` | `streamHistory` event connection (offset cursor) |
| `GetStreamEvents` | `streamEvents` outbox connection (reuses the outbox `seq` cursor from `GET /streams/:id/events`) |
| `GetStreamsByRecipient` | Streams for a recipient (cursor connection) |
| `GetAddressStreams` | `Address` node with its streams |
| `GetForecast` | `Forecast` for one stream at a time |
| `ListWebhookSubscriptions` | Webhook endpoints (never includes the secret) |

Types: `Stream` (with `senderAddress`/`recipientAddress` relations, `events`,
`forecast`), `Address`, `Event`, `Forecast` (linear streamed accrual:
`accrued = deposit * elapsed / duration`, floored — the same math as
`frontend/lib/analytics.ts`), `WebhookSubscription`, and cursor connections
(`edges { node cursor }`, `pageInfo { hasNextPage nextCursor }`).

Limits: query depth ≤ 5, complexity ≤ 80 (checked at boot — an allowlisted
query that exceeds them fails startup), per-tenant token-bucket rate budget
(default 600 complexity units/minute; exhaustion returns `429` with
`retryAfter`). Privacy redaction (#487) is shared with REST via
`src/redaction.ts`: set `GRAPHQL_REDACT_ADDRESSES=1` (or pass
`redactAddresses: true` to `createApp`) and Stellar addresses are truncated
to their 8-character prefix on the GraphQL path exactly as the helper does
for REST rows; webhook URLs are masked and secrets are never exposed.

To add a persisted query: add an entry to `PERSISTED_QUERIES` in
`src/graphql/persisted.ts`, keep it inside the depth/complexity limits, and
add a contract test in `src/graphql.test.ts` asserting it matches the REST
response for the same fixture. The freshness-gate test asserts every
`Stream` field in the SDL exists on the `Stream` projection, so schema
drift fails CI.

```bash
curl -X POST localhost:8787/graphql \
  -H 'Content-Type: application/json' \
  -d '{"queryId":"GetStream","variables":{"id":"1"}}'
```

---

### Transactional Outbox

Every ingested event is journalled with a monotonic `seq` and per-consumer
delivery intents inside the same database transaction, giving consumers a
replayable, dedupe-able, at-least-once event feed. Full contract and
guarantees: [docs/OUTBOX.md](../docs/OUTBOX.md).

- `GET /streams/:id/events?after=<seq>&limit=<n>` — cursor-based replay (`next_cursor` included)
- `GET/POST /api/outbox/consumers` — push/pull channel registry
- `GET /api/outbox/intents?state=dead` — outbox dead-letter queue
- `POST /api/outbox/intents/:id/replay` — resurrect a dead intent
- `POST /api/outbox/retract` — reorg retraction hook (reconciler)
- `GET /api/outbox/stats` — depth by state and replay high-water
- `GET /metrics` — Prometheus exposition (`streampay_outbox_*`)

---

### Webhook Subscriptions (shared, tenant-isolated)

One indexer serves many integrators. Subscriptions are managed through the
registry in `src/webhooks/`, which adds an identity, a quota and a measured
delivery commitment to the existing dispatcher, HMAC, SSRF guard, retry
schedule and DLQ. Full contract:
[docs/WEBHOOKS.md §7](../docs/WEBHOOKS.md).

- `GET/POST /api/webhooks/endpoints` — list the caller's subscriptions; create
  one. The `201` body is the only place the signing secret is ever disclosed.
- `GET/PATCH/DELETE /api/webhooks/endpoints/:id` — read, retarget, disable or
  remove. Reads carry `secret_fingerprint`, never the secret.
- `POST /api/webhooks/endpoints/:id/rotate-secret` — new secret, outgoing key
  keeps verifying for the overlap window (dual signatures).
- `GET /api/webhooks/endpoints/:id/rotations` — rotation history by fingerprint.
- `GET /api/webhooks/quota` · `GET /api/webhooks/sla` — the caller's budget and
  measured delivery SLA.
- `GET /api/webhooks/deliveries` · `GET /api/webhooks/dlq` ·
  `POST /api/webhooks/dlq/:id/retry` — scoped to the caller's subscriptions.
- `POST /api/webhooks/rotations/expire` — retire elapsed overlap windows.

Credentials go in `x-streampay-webhook-key` (or `Authorization: Bearer …`).
Another tenant's id answers `404`, never `403`, so the API cannot be used to
enumerate who else subscribes. With no `WEBHOOK_TENANT_KEYS` configured the
routes keep their historical single-tenant behaviour and the registry-only
routes answer `503`.

---

### Anomaly Detection (rules, detections, replay)

The indexer evaluates heuristic fraud patterns over the events it ingests and
records each hit as a detection that cites the ledger range it came from. Rules
are per-tenant configuration, detections are evidence, and a rule only pages
once an operator has reviewed enough of its shadow detections. Full design:
[docs/ANOMALY.md](../docs/ANOMALY.md).

- `GET /api/anomaly/rules` — the catalog as this tenant runs it: mode, severity,
  version, and each knob's default, range and description.
- `POST/DELETE /api/anomaly/rules/:ruleId/override` — tune or un-tune one rule.
  An unknown rule is `404 unknown_rule`; an unknown param, an out-of-range
  number or a bad mode is `400` with the accepted set. Nothing silently falls
  back to a default.
- `GET /api/anomaly/detections` · `GET /api/anomaly/detections/:id` — this
  tenant's detections, redacted (8-character address prefixes, no amounts), the
  second with its review history.
- `POST /api/anomaly/detections/:id/replay` — re-derive the claim from its cited
  ledger range using the thresholds recorded on the detection. Answers
  `verified` or why not (`citation_incomplete`, `range_too_large`,
  `rule_version_unavailable`, `not_reproduced`, …).
- `POST /api/anomaly/detections/:id/feedback` — `true_positive` or
  `false_positive`; a false positive also suppresses that subject for
  `ANOMALY_SUPPRESSION_TTL_MS`. A contradictory second review is `409`, because
  the false-positive budget must not depend on who looked last.
- `GET /api/anomaly/promotion` · `POST /api/anomaly/rules/:ruleId/promote` —
  shadow → `enforce`, licensed only by the review evidence; `409` carries the
  reasons.
- `GET /api/anomaly/incidents` — open incidents, tracked subject counts, and
  active suppressions.

Authentication and tenant isolation are the webhook registry's: the same
`x-streampay-webhook-key` credentials, and another tenant's detection id is
`404`. The routes are absent entirely when the deployment runs no detector.

---

### Materialized Analytics

The indexer incrementally folds its transactional outbox into per-address,
per-asset, time-bucketed accrual, and rate-ladder views. Every view has a durable
journal/ledger watermark; consistency lag and SLO state are exposed at
`/metrics`. Reads can require `min_ledger` or `max_lag_events` and wait up to
`wait_ms`, otherwise receiving `503 stale_view`. Full design and configuration:
[docs/ANALYTICS.md](../docs/ANALYTICS.md).

- `GET /api/analytics/views` — definitions, watermarks, lag, SLO and dirty state.
- `GET /api/analytics/addresses/:address` — totals by `sender`, `recipient`, or
  `refund` role; optional `token`.
- `GET /api/analytics/assets` — per-token totals; optional `token`.
- `GET /api/analytics/accrual` — event-time buckets; optional `token`, `from_ms`,
  `to_ms`, and `limit`.
- `GET /api/analytics/forecast` — rate-ladder projection; requires `token`,
  accepts `at_ms` and `horizon_ms`.
- `POST /api/analytics/refresh` — run one budgeted fold tick.
- `POST /api/analytics/rebuild` — atomically rebuild from the surviving journal;
  accepts an optional JSON `reason`.
- `GET /api/analytics/refresh/stats` — store and worker counters.

Responses have `{ view, data, staleness, waited_ms }`; all amounts are decimal
strings to preserve `i128` precision. Aggregates expose neither stream ids nor
per-stream amounts, and metric labels carry no addresses or tokens. In production,
set `ANALYTICS_API_TOKEN` and send it as a bearer token on every analytics request;
the token covers the whole portfolio. Refresh/rebuild mutations are rate-limited
per client and excess requests receive `429`. Behind a reverse proxy, set
`TRUST_PROXY_HOPS` to the exact proxy-chain depth; `0` keeps direct deployments
from trusting forwarding headers, while an overstated depth allows spoofing.

Analytics startup requires `START_LEDGER` before the contract's first event so a
fresh database cannot silently begin at the chain tip. Upgrading an existing
indexer database requires a fresh-database reindex because older outbox history
lacks newly subscribed rate, ownership, and sender-transfer events. Analytics
fails closed rather than serving incomplete history; see the
[upgrade requirement](../docs/ANALYTICS.md#upgrade-history-requirement).

---

### Event Shapes Come From the Schema Registry

The names and fields this indexer decodes are not hand-maintained here: they
are generated from the contract's `#[contractevent]` structs into
`src/generated/events.ts` by `npm run generated:events` (source of truth:
[`schemas/events/`](../schemas/events/README.md), issue
[#213](https://github.com/Neziahtech/streampay/issues/213)).

- `decodeEvent` validates every registry-known event: the positional topic
  count must match the registry and each declared data field must be present,
  so a contract/registry drift surfaces as a decode error naming the schema
  file instead of silently indexing a half-shaped stream row.
- Extra data keys are tolerated — the registry evolves additively, and old
  indexers keep working against a newly upgraded contract.
- `src/registry.test.ts` asserts the generated table matches the committed
  `schemas/events/registry.json` field-for-field.

---

### WASM plugin filters (issue #580)

Integrators can upload small WASM filter/transform plugins that run
sandboxed per subscription, shaping the event stream server-side (field
projection, predicate filtering, enrichment) without a custom indexer
fork. Full specification: [`src/wasm/README.md`](src/wasm/README.md).

- **ABI**: a plugin is a WASM module with no imports, exporting `memory`
  and `transform(inputPtr, inputLen) -> outputLen`. The host writes the
  event JSON at offset 0; the plugin writes its JSON reply at offset
  32768 and returns its length, or `-1` to drop the event. The reply's
  `data` becomes the event's new data; envelope fields (id, ledger, name,
  stream id) are always taken from the input, so a plugin cannot rewrite
  an event's identity.
- **Approval flow**: register a plugin (`POST /api/wasm/plugins` with the
  base64 bytes and a version — the plugin id is the SHA-256 of the bytes),
  approve that exact digest per tenant
  (`POST /api/wasm/plugins/:digest/approve`), then bind it to a
  subscription (`POST /api/wasm/subscriptions`). An unapproved plugin can
  never run. Approvals and plugin bytes persist in SQLite
  (`wasm_plugins`, `wasm_plugin_approvals`).
- **Limits**: no host imports at all (WASI/`env` imports are rejected by
  name); memory maximum 4 pages, enforced at validation; input/output
  capped at 32 KiB each; per-invocation wall-clock budget
  (`WASM_PLUGIN_TIMEOUT_MS`, default 500 ms) enforced by running the
  transform in a worker thread that is terminated on expiry. V8 exposes
  no instruction fuel counter, so the wall-clock + memory + size caps are
  the fuel proxy — documented as such in `src/wasm/abi.ts`.
- **Fallback behaviour**: a plugin that traps, times out, is killed, or
  replies with garbage never stalls ingestion — the subscription falls
  back to the raw stream and a fallback alert is recorded
  (`GET /api/wasm/fallbacks`, and a warning log line). A plugin that
  returns `-1` drops the event for that subscription.
- **Determinism**: same input + same plugin digest yields the same
  output; `src/wasm/conformance-vectors.json` is the vector suite run by
  `wasm.test.ts`.
- **Privacy redaction runs after plugin transforms**: with
  `WASM_REDACTION_ENABLED=1`, full Stellar addresses in delivered event
  data are truncated to the 8-character prefix (`sanitizeAddress`) on the
  way out — on transformed, passthrough and fallback paths alike — so a
  plugin cannot un-redact a protected field.
- **Delivery**: `GET /events/stream?tenant=<tenant>&plugin=<digest>`
  runs a connection's live and replayed events through the tenant's
  approved plugin, in journal order. Without those query params, SSE is
  unchanged.

---

## 5. Testing

Run all unit, decoder, database, and integration tests:

```bash
npm test
```

---

## 6. Horizontal Sharding (issue #578)

The indexer can partition ingestion and projections by stream-id range so
throughput scales beyond a single node. The implementation lives in
`src/sharding/` (`ShardMap`, `ShardedStore`, `ShardRebalancer`, metrics)
and is covered by `src/sharding.test.ts`. The single-node `StreamStore` is
unchanged: one shard *is* a `StreamStore`, and all of its guarantees
(duplicate detection by event id, monotonic projection, transactional
outbox) are reused per shard.

### Shard map

Stream ids are numeric (`u64`, e.g. `"7"`). The id space is cut into
contiguous blocks of `rangeSize` ids (default 1000) — `[0, 1000)`,
`[1000, 2000)`, … — assigned round-robin to shards: block `k` belongs to
shard `k % shardCount` by default. A block is the unit of movement, and a
single stream id belongs to exactly one block, so a shard boundary can
never split a single stream's event order.

```ts
import { ShardedStore } from "./sharding/index.js";
const store = new ShardedStore({ shardCount: 4, rangeSize: 1000 });
// or one SQLite file per shard:
const fileStore = new ShardedStore({ shardCount: 4, basePath: "./data/shard" });
//   -> ./data/shard-shard-0.sqlite, ./data/shard-shard-1.sqlite, …
```

- **Routing:** every event is routed by its stream id; a stream's events
  always land in the same shard, in ledger order. `ShardedStore` keeps one
  `IngestSequencer` (seeded from the merged `maxLedgerByStream()` of all
  shards) so per-stream ordering and ledger-gap detection (#117 / #483)
  are reported across shards, exactly as on a single node.
- **Stream-less events** (`streamId === null`) go to the designated shard
  0 (`STREAMLESS_SHARD`); they touch no projection, as before.
- **Non-numeric stream ids** (e.g. `batch_withdraw_summary`, published
  keyed by a recipient address) are placed by an FNV-1a hash of the id, so
  they are still deterministic and still land on exactly one shard.
- **Global state:** `ShardedStore` implements the pipeline's `IngestSink`
  (`ingestPage`, `getState`, `setState`, `maxLedgerByStream`), so
  `IngestPipeline` runs unchanged on top of it. Global keys (`cursor`,
  `lastLedger`, `ingest_ledger`) live on shard 0, the coordinator shard.

### Cross-shard reads

Single-stream reads (`getStream`, `getStreamHistory`, per-stream outbox
replay) route to exactly one shard. Address portfolios (`listAddress`,
`listStreamsByRecipient`, `listAllStreams`) fan out to all shards, dedup
by stream id (keeping the highest `lastLedger`), and merge in one stable
order: numeric stream ids ascending, then non-numeric ids
lexicographically. `getEventsAfter` merges the per-shard journals in
`(ledger, id)` order and dedups by event id.

`listAddressPaged(address, { limit, cursor })` pages that same total
order, so a cursor handed out before a rebalance still addresses the same
position afterwards, and re-reading a cursor returns the same page.

Exactly-once outbox (#212) holds per shard (journal + intents in the same
transaction, `idempotency_key` unique) and across shards: merged outbox
reads (`listOutboxEvents`) dedup by `idempotency_key`, so a row a rebalance
transiently leaves on two shards is delivered once.

### Rebalancer

```ts
import { ShardRebalancer } from "./sharding/index.js";
const rebalancer = new ShardRebalancer(store);
// Move the block [1000, 2000) to shard 2, checkpointing every 5 streams.
rebalancer.startMove(1000n, 2, { batchSize: 5 });
// After a crash, resume every incomplete move from its checkpoint:
rebalancer.resumeAllIncomplete();
```

A move runs in five steps: **copy** the block's streams, events, outbox
journal rows and outbox intents to the target in batches (all copies
idempotent — `INSERT OR IGNORE` / monotonic upsert, and outbox intents are
re-pointed at the target's own `seq` values); **catch-up** re-copy passes
until a pass inserts nothing new; **verify** stream ids, event ids and
per-stream `lastLedger` match between source and target (on mismatch the
move fails *without* switching the map, so the source stays
authoritative); **switch** the shard-map override for the block (the
commit point); **delete** the source copy.

Checkpoints are durable: after every batch the move's checkpoint
(`shard_move:<moveId>` in shard 0's `indexer_state` table) records the
last copied stream id, streams/events copied, and totals. A crash at any
point — including a full node loss and reopen of file-backed databases —
resumes from that checkpoint: already-copied streams are skipped, the
move proceeds to switch/delete, and the result has no lost or duplicated
streams or events (`sharding.test.ts` covers this end to end, including a
close + reopen mid-move).

The move runs synchronously in one JS turn, so no ingestion can interleave
between verify and switch in-process. Known limitations, see below.

### Metrics

```ts
import { collectShardingMetrics, renderShardingMetricsPrometheus } from "./sharding/index.js";
const metrics = collectShardingMetrics(store, { tipLedger: latestLedger });
renderShardingMetricsPrometheus(metrics);
```

Per shard: stream/event/outbox counts, `lastLedger` (highest projected
ledger on that shard), and `lag` (`tipLedger - lastLedger`, when a tip is
supplied). Prometheus gauges: `streampay_shard_streams`,
`streampay_shard_events`, `streampay_shard_last_ledger`,
`streampay_shard_lag_ledgers`, plus `streampay_rebalance_events_copied` /
`streampay_rebalance_streams_copied` per move. `ShardRebalancer.progress(moveId)`
reports ranges moved/total, events/streams copied, and the current
checkpoint for an in-flight move.

### Limitations / follow-ups

- **Webhook deliveries are not moved.** They are per-endpoint dispatch
  state, not projections; moving them would risk duplicate sends and
  deleting them would lose pending deliveries. They stay on the source
  shard. If a moved stream's pending webhook deliveries must follow it,
  that needs a dispatch-aware migration.
- **Multi-process write fence.** In-process the synchronous move makes
  verify → switch → delete atomic w.r.t. ingestion. A deployment with
  several indexer processes writing the same shard databases would need a
  distributed lock / write fence for the moving range during that window.
- **No HTTP wiring yet.** The sharding layer is a library (`ShardedStore`
  as the pipeline sink); the HTTP server in `src/index.ts` still uses a
  single `StreamStore`, and there is no `/metrics` sharding endpoint or
  operator CLI for moves yet. Wiring those up is the natural follow-up.

## 7. Deterministic Replay (issue #584)

`src/replay/` rebuilds the `streams` projection from the journal without
re-emitting anything: `ReplayEngine` reads ledger ranges, upcasts each payload to
the schema version the projections expect, redacts addresses exactly as the read
paths do, and projects through `StreamStore.projectEvent` — no outbox intent and
no webhook delivery is queued.

- **Upcasters** (`src/replay/upcasters.ts`): per-event chains `vN -> vN+1`,
  registered next to the canonical registry. A chain may only name an event the
  registry declares, and `assertUpcastersMatchSchemaRegistry()` checks that at
  module load. A missing step, an unknown version, or a payload written by a
  newer contract (`MissingUpcasterError`, `UnknownEventSchemaError`,
  `FutureSchemaVersionError`) aborts the replay instead of being projected
  as-is. The shipped chains read pre-registry (`v0`) `stream_created`,
  `withdrawn` and `stream_topped_up` payloads into v1.
- **Parallel, ordered, resumable** (`src/replay/engine.ts`): ranges of
  `rangeSize` ledgers are read and upcast concurrently (`concurrency`), then
  applied in ascending ledger order, so a stream's events always reach the
  projection in chain order. After each applied range the engine writes
  `replay_checkpoints(job, watermark, state_root)`; rerunning the job resumes at
  the watermark and skips the ranges that already landed.
- **State root**: `computeReplayStateRoot` hashes one domain-separated leaf per
  projected stream (fixed field order, stream-id sort) and folds them with the
  same Merkle builder as the checkpoint proofs, so a replay is reproducible
  across machines and range layouts.
- **CI gate**: `src/replay/corpus.test.ts` replays
  [`fixtures/replay-corpus.json`](fixtures/replay-corpus.json) — pinned
  historical rows, three of them pre-registry — and asserts its golden
  `stateRoot`. A change to projection semantics, an upcaster or the corpus fails
  the gate; regenerate the pin deliberately when a projection change is meant.
- **Fail closed**: malformed or truncated payloads (`ReplayFixtureError`),
  including the #486 decoder fixtures, abort the range before it is
  checkpointed, so a partial replay never looks like a completed one.

## 8. Multi-region active-active (issue #583)

`src/multiregion/` runs several fully independent regions — each polls RPC,
projects and serves reads — instead of a primary with replicas. Deployment
manifests live in [`infra/multiregion`](../infra/multiregion/README.md).

- **Watermarks and lag** (`watermarks.ts`): every region reports
  `(watermark, health)`; `streampay_region_ledger_watermark`,
  `streampay_region_consistency_lag_ledgers` and `streampay_region_healthy` are
  derived from those reports. Watermarks are monotonic per region, and the lag is
  measured against the highest watermark reported anywhere.
- **Freshness-based reads** (`router.ts`): `FreshnessReadRouter` picks the
  freshest healthy region (lowest lag, then priority, then id — deterministic),
  never a region further behind than `maxLagLedgers`, and `routeFor(ledger)`
  enforces read-your-writes. With no qualifying region it throws
  `NoFreshRegionError` rather than serving stale state.
- **Deterministic convergence** (`convergence.ts`): `foldStream` folds a stream's
  journal in `(ledger, id)` order into the reference row; `compareRegions`
  reports the streams that disagree, and `reconcileRegion` repairs them
  idempotently. A late event dropped by the monotonic guard is still journalled,
  so convergence is a fold, not a merge of histories.
- **One fenced delivery leader** (`leader.ts`): `delivery_leases` holds one epoch
  per subscription. A takeover increments the epoch and `assertLeader` /
  `runFenced` reject the stale leader, so failover cannot double-deliver an
  outbox intent (the intent claim token is a second guard).

`src/multiregion/regions.test.ts` covers the region-loss chaos cases: divergent
arrival orders converge, a region dying mid-ingest loses nothing committed, and
a stalled delivery leader is fenced out with every event delivered exactly once.
