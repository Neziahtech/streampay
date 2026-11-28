# Anomaly detection

The indexer watches its own event stream for patterns that look like abuse of
streamed payroll: an account that creates forty streams in a minute, dust
balances spread across fresh payees, money that flows in a circle between two
addresses, or a sender that creates streams and cancels most of them before the
first payout.

None of those patterns is a protocol violation — the contract rejects what it
can reject, and these it cannot. They are, however, the shapes fraud takes, so
the detector's job is not to stop them. It is to produce an *evidence-backed
claim* an operator can check, act on, and disprove.

Everything lives in [`indexer/src/anomaly/`](../indexer/src/anomaly) and runs
inside the indexer process, fed by the same `store.on("event")` fan-out the SSE
feed and the webhook dispatcher use.

## 1. Two properties decide the design

**Reproducible.** Rules measure *event time* — `ledgerClosedAt`, never
`Date.now()`. A window is therefore a ledger range, not "the last five minutes
of this process", and a detection cites the range it came from. Another build,
or a verifier with only the journal, can re-derive the same numbers from the
same blocks.

**Bounded.** Per subject the engine keeps only the observations the widest
configured window can still reach, and drops subjects idle past that horizon.
A long-lived indexer does not accumulate a second copy of the ledger.

A corollary: the detector never blocks ingestion. It is a listener, and a
throwing listener cannot roll the ingestion transaction back (see
[`docs/INDEXER_INGEST.md`](INDEXER_INGEST.md)).

## 2. Rule catalog

Four rules ship in version 1. Each is declarative: a scope, a severity, a set
of named thresholds with hard ranges, and a pure evaluation over the
observations in the window ([`rules.ts`](../indexer/src/anomaly/rules.ts)).

| Rule | Scope | Fires when | Tunable knobs (default) |
|---|---|---|---|
| `burst_creation` | sender | one address creates at least `threshold` streams inside `window_ms` | `window_ms` (60 s), `threshold` (20) |
| `dust_spam` | sender | at least `threshold` creations of at most `dust_ceiling` base units, spread over at least `min_payees` distinct payees | `window_ms` (5 min), `threshold` (10), `dust_ceiling` (1 000), `min_payees` (5) |
| `circular_flow` | pair | streams are created in *both* directions between the same two addresses, `min_flows` each way | `window_ms` (1 h), `min_flows` (2) |
| `create_cancel_churn` | sender | at least `min_creations` creations and `cancelled / created ≥ cancel_ratio` | `window_ms` (1 h), `min_creations` (5), `cancel_ratio` (0.5) |

Scope decides what a subject is: an address for `sender`, an unordered
`address|address` pair for `circular_flow`. `circular_flow` is `critical`;
the rest are `warning`.

Three details are load-bearing:

- **A batch counts once.** `create_streams` emits a single `streams_created`
  event carrying `stream_ids`, so `burst_creation` adds `stream_ids.length` to
  the sender's total rather than treating the batch as N events.
- **A cancel belongs to who cancelled it.** `create_cancel_churn` attributes a
  `stream_cancelled` event to its `cancelled_by` field rather than re-reading a
  stream projection, so replay of an old range attributes it identically even
  if the stream has since been mutated.
- **Threshold names obey the privacy line.** `dust_ceiling`, `min_payees` and
  `distinct_payees` are named that way on purpose: the telemetry policy drops
  any attribute whose key reads as a financial amount (`amount`, `deposit`,
  `withdrawn`, `balance`), so `dust_amount` or `min_recipients` would vanish
  from the alert and leave an alert that could not explain itself.

## 3. Configuration

Rules are configuration, and configuration is per tenant. Resolution order:

1. catalog defaults;
2. the deployment-wide base (`ANOMALY_RULES_JSON`);
3. that tenant's own override (set through the API).

`params` merge per key, so a tenant that tunes one threshold does not discard
the deployment's others. An unknown rule id, an unknown param name, or a number
outside the param's range is a hard error (`RuleConfigError`) rather than a
silent default: a typo in a threshold file must not read as "the rule is tuned"
while it runs on defaults. Ranges are enforced in both `ANOMALY_RULES_JSON` and
`POST /api/anomaly/rules/:ruleId/override`, so the same typo fails the same way
in a manifest and in a curl.

```json
{
  "burst_creation": { "mode": "shadow", "params": { "threshold": 40, "window_ms": 120000 } },
  "dust_spam": { "params": { "dust_ceiling": 5000 }, "min_reviews": 20 }
}
```

`ANOMALY_MODE` sets the mode for every rule nobody has named. It defaults to
`shadow`: a rule this deployment has never measured pages nobody.

Resolved configuration is cached for `DEFAULT_CONFIG_CACHE_MS` (30 s) because
the engine asks for every tenant on every event, and invalidated the moment the
API writes an override.

## 4. Detections, citations and replay

A detection is a claim about a ledger range:

```json
{
  "id": "anm_3f1d…",
  "rule_id": "burst_creation",
  "rule_version": 1,
  "tenant_id": "acme",
  "severity": "warning",
  "mode": "enforce",
  "subject": "GA5ZSEJY…",
  "citation": {
    "from_ledger": 450012, "to_ledger": 450041,
    "first_event_id": "450012-0", "last_event_id": "450041-3",
    "start_ms": 1793491155000, "end_ms": 1793491215000
  },
  "evidence": { "created": 6, "threshold": 5, "window_ms": 60000 },
  "params": { "threshold": 5, "window_ms": 60000 },
  "fingerprint": "sha256:…"
}
```

The fingerprint is `sha256` over the canonical replay input:
`rule@version`, tenant, subject, citation bounds, the metrics the rule
reported, and the parameters it used. Cited event *ids* are recorded (up to
`MAX_CITED_EVENTS`) but not hashed, so a rule that trips on the same window
content fingerprints the same regardless of how many events the window happened
to hold. Widen the citation and the fingerprint changes: a broader claim is a
different claim.

Two consequences:

- **`params` are recorded on the detection.** Replay re-derives with the
  thresholds that fired, not today's config. An operator who retunes a rule
  after an alert does not retroactively invalidate the alert — or get to keep
  it either, if the numbers no longer hold.
- **Replay is not a re-run of the engine.** Incident state, the recording
  throttle and routing all depend on what the process had already seen, which a
  verifier cannot reproduce. What is checkable is the claim: read
  `from_ledger..to_ledger` from the journal, keep the subject's own
  observations inside `end_ms - window_ms < atMs ≤ end_ms`, evaluate the rule,
  recompute the fingerprint. `POST /api/anomaly/detections/:id/replay` returns
  one of `verified`, `rule_unavailable`, `rule_version_unavailable`,
  `rule_config_invalid`, `citation_incomplete`, `range_too_large`,
  `not_reproduced` — and refuses a range larger than `ANOMALY_REPLAY_MAX_EVENTS`
  so that a citation can never be turned into a denial of service against the
  node holding the journal.

A detection whose cited events have aged out of the journal reports
`citation_incomplete`, which is a statement about retention, not about the
pattern.

## 5. Incidents, dedup and flap suppression

Detections accrue per event; alerts do not.

- **One detection per subject per window.** A sustained pattern writes one row,
  not one per block, so the review queue stays a queue rather than becoming a
  second ledger.
- **An incident is `rule/tenant/subject`.** It is raised the first time it is
  seen and, per the policy shared with the reconciler's divergence deduper
  ([#492](https://github.com/Neziahtech/streampay/issues/492)), transitions are
  reported only once the state has held for `ANOMALY_FLAP_WINDOW_MS` (120 s).
  A subject that flickers active/clear produces `suppressed` events and no
  pages.
- **Heartbeats are opt-in.** `ANOMALY_RENOTIFY_AFTER_MS` (0 = off) re-raises a
  still-open incident, which is the only way an unacknowledged page resurfaces.
- **The incident table is durable** (`indexer_state` key `anomaly.incidents`),
  and boot hydrates the sliding windows from the last
  `ANOMALY_HYDRATE_LEDGERS` ledgers through `hydrate()`, which mutes sweeping
  until the range is restored. A restart therefore neither re-pages an incident
  it already raised nor resolves one that is still firing.
- **Suppression removes the work, not just the page.** A subject an operator
  called a false positive is skipped before the rule is evaluated.

## 6. Shadow mode and earning the right to page

`shadow` runs the rule, records the detection, and records the alert it *would*
have sent (`anomaly_alerts` with `routed = 0`, `reason = "shadow_mode"`).
`enforce` routes it.

A rule graduates only when `GET /api/anomaly/promotion` says it may, and that
report requires both halves of the evidence:

```
ready = reviewed ≥ min_reviews
        AND detections > 0
        AND false_positive_rate ≤ false_positive_budget
```

`min_reviews` defaults to 10 and the budget to 5%. "No false positives out of
three reviews" is not evidence, and a rule that has never fired has proven
nothing either — both are refusals with reasons in the report, not silent
`ready: false`. `POST /api/anomaly/rules/:ruleId/promote` answers `409` with the
report while the rule is unvalidated, and otherwise writes exactly the override
the report licensed (`mode: "enforce"`, thresholds unchanged).

Reviews are `POST /api/anomaly/detections/:id/feedback` with `true_positive` or
`false_positive`. A `false_positive` review also suppresses that subject for
`ANOMALY_SUPPRESSION_TTL_MS` (24 h, clamped to 30 days by a request's
`suppress_ms`). A second, contradictory review of the same detection is `409`:
if the budget were a function of who looked last, it would measure the reviewers
rather than the rule. Repeating the same label is idempotent.

## 7. Where alerts go

`FanOutAlertSink` ([`alerts.ts`](../indexer/src/anomaly/alerts.ts)) delivers each
routed alert to:

- **log** — one JSON line per alert, already redacted;
- **webhook** — the `anomaly_alert` event type, queued through the tenant's own
  subscriptions, so anomaly delivery inherits the retries, DLQ and per-tenant
  isolation of every other delivery ([#585](https://github.com/Neziahtech/streampay/issues/585)).
  Set `ANOMALY_WEBHOOK_ALERTS=0` to keep alerts in-process only.

A sink that throws is isolated: one broken destination cannot stop the others or
take the detector down. Prometheus and Grafana are the operator's view of the
detector itself — see §9.

`anomaly_alert` is a reserved event name: it never comes from the contract, so
the subscription registry accepts it without a schema entry.

## 8. Privacy of evidence

The telemetry privacy line
([`docs/PRIVACY.md`](PRIVACY.md)) is enforced at the alert boundary:

- identifiers keep an 8-character prefix (`GA5ZSEJY…`), including both halves of
  a pair subject;
- anything the policy calls financial is dropped, not masked;
- counts, thresholds, window bounds, cited event ids and the fingerprint travel.

The *stored* detection keeps its raw citation and actors so replay can
re-derive it; redaction applies to what leaves the process — the alert, the HTTP
detection view, and the log line. A detection read over the API never carries a
full address.

## 9. HTTP surface and metrics

Every route is tenant-key authenticated with `x-streampay-webhook-key` (the same
credentials as the webhook registry), and a detection belonging to another tenant
is `404`, not `403`: an id that leaks existence is a leak.

| Route | Purpose |
|---|---|
| `GET /api/anomaly/rules` | the catalog as this tenant runs it, with each knob's default, range and description |
| `POST /api/anomaly/rules/:ruleId/override` | tune one rule (validated) |
| `DELETE /api/anomaly/rules/:ruleId/override` | fall back to the deployment default |
| `GET /api/anomaly/detections` | this tenant's detections, redacted, filtered by `rule` / `mode` |
| `GET /api/anomaly/detections/:id` | one detection plus its reviews |
| `POST /api/anomaly/detections/:id/replay` | re-derive it from the cited ledger range |
| `POST /api/anomaly/detections/:id/feedback` | review it; a false positive also suppresses the subject |
| `GET /api/anomaly/promotion` | the readiness report per rule |
| `POST /api/anomaly/rules/:ruleId/promote` | shadow → enforce, once the report allows it |
| `GET /api/anomaly/incidents` | open incidents, tracked subjects, active suppressions |

Series on `/metrics` (all labelled):

| Series | Meaning |
|---|---|
| `streampay_anomaly_detections_total{rule_id,mode}` | detections by mode; `shadow` growth is evidence being gathered, not pages |
| `streampay_anomaly_detections_by_severity_total{rule_id,severity}` | the same by severity |
| `streampay_anomaly_suppressed_total{rule_id}` | evaluations skipped for suppressed subjects |
| `streampay_anomaly_alerts_total{rule_id,type}` | transitions an operator was told about |
| `streampay_anomaly_feedback_total{rule_id,label}` | operator reviews, the denominator of the budget |
| `streampay_anomaly_incidents_open{rule_id}` | currently-open incidents |
| `streampay_anomaly_promotion_ready{rule_id,tenant_id}` | 1 when the shadow evidence clears its budget |
| `streampay_anomaly_replay_total{outcome}` | replay results; any `mismatch` is an integrity problem, see the runbook |

Alert rules live in
[`infra/observability/prometheus/rules/alerts.yml`](../infra/observability/prometheus/rules/alerts.yml)
under `streampay_anomaly_alerts`, and the triage procedure for each is
[`docs/RUNBOOK.md#8-anomaly-detection-alert-triage`](RUNBOOK.md).

## 10. Testing

```bash
cd indexer && npm test          # includes dist/anomaly/anomaly.test.js
```

The suite is organized the way the feature is: rule semantics (including the
negative case for every threshold, so a rule cannot pass by being always-on),
replay of every rule from its citation, dedup and flap policy, restart hydration,
the shadow/budget gate, tenant isolation, the privacy line, and the HTTP surface.

## 11. Limits

- Rules read the events the indexer decodes, so a pattern whose events were
  never ingested is invisible. Detection rows depend on journal retention for
  replay.
- `circular_flow` is a two-address cycle. Longer rings, or cycles through
  intermediaries, need a graph rule and are not implemented.
- Thresholds are absolute counts, not per-account baselines. A merchant that
  legitimately creates two hundred streams an hour will trip `burst_creation`
  until its tenant tunes it — which is what shadow mode and the review loop are
  for.
- The detector is heuristic. It produces claims to check, never automatic
  enforcement; nothing here cancels a stream or freezes an account.
