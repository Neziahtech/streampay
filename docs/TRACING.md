# StreamPay Distributed Tracing & OpenTelemetry Architecture

This document details the OpenTelemetry (OTel) distributed tracing instrumentation across the entire StreamPay stack — covering the complete lifecycle from browser user action through server routes, Soroban RPC calls, ledger block events, indexer ingestion, and downstream push notifications.

---

## 1. End-to-End Claim Lifecycle Architecture

When a user initiates an on-chain action such as **Claim** (`withdraw_max` / `withdraw`), the trace traverses synchronous network boundaries and asynchronous blockchain ledger seams:

```
[BROWSER UI]
   │  User clicks "Claim" on stream #42
   │  Span: browser.claim_click (Trace A)
   │  W3C Propagation: traceparent: 00-{TraceA}-{Span1}-01
   ▼
[NEXT.JS SERVER ROUTE] (POST /api/claim)
   │  Span: POST /api/claim (Child of browser.claim_click, Trace A)
   │  Validates stream & coordinates claim preparation
   ▼
[SOROBAN RPC]
   │  Span: soroban.rpc.call (Child of POST /api/claim, Trace A)
   │  Simulates / submits transaction; captures public tx_hash
   │  Registers correlation: tx_hash ──> Trace A Context
   ▼
══════════════════════════════════════════════════════════════════════════════
 ⛓️  THE HARD ASYNC SEAM: Blockchain Consensus & Ledger Delay (~5-10 seconds)
══════════════════════════════════════════════════════════════════════════════
   │
   │  Contract emits event: `withdrawn` (stream_id, recipient, amount, tx_hash)
   ▼
[STREAMPLAY INDEXER]
   │  Span: indexer.ingest_event (Trace B - New process trace!)
   │  🔗 SPAN LINK: Points to Trace A (POST /api/claim)
   │     Attributes: link.relationship = "ledger_event_continuation"
   │                 soroban.tx_hash = "0x..."
   │                 ledger.sequence = 10505
   ├──> Child Span: indexer.db_write (SQLite state persistence)
   └──> Child Span: push.dispatch (Trace B)
            ▼
[PUSH NOTIFICATIONS]
         Span: push.deliver_webhook (Child of push.dispatch, Trace B)
         Attributes: destination: "https://merchant.example.com/***"
         Outbound Header: traceparent: 00-{TraceB}-{SpanWebhook}-01
```

---

## 2. The Hard Seams: Cross-Process Continuation via Span Links

### Why Span Links Instead of Parent-Child Spans?

In distributed systems, work that is decoupled in time, across batches, or across blockchain consensus rounds poses a fundamental challenge for naive parent-child tracing:

1. **Duration Distortion**: Block inclusion on Stellar takes 5–10 seconds (or longer during congestion). If the indexer ingestion were modeled as a child span of the synchronous server route, the server route would either appear to hang open for 10 seconds (falsifying API response latency metrics) or the child span would start long after the parent had already ended, breaking trace timeline visualizations.
2. **Batch Processing**: The indexer polls events in pages of up to 1,000 events across multiple ledgers. A single indexer batch ingests events originating from hundreds of distinct user transactions. Modeling all these as children of a single trace is hierarchically impossible.
3. **OpenTelemetry Semantic Specification**: The OpenTelemetry specification explicitly mandates **Span Links** for asynchronous, message-driven, or decoupled work.

### SpanLink Design

When the indexer encounters an event, it creates a new span (`indexer.ingest_event`) and binds a `SpanLink`:

```typescript
const ingestSpan = tracer.startSpan("indexer.ingest_event", {
  kind: "CONSUMER",
  attributes: {
    "event.name": "withdrawn",
    "ledger.sequence": event.ledger,
    "soroban.tx_hash": event.txHash,
  },
});

// Event Seam: Link back to the initiating transaction trace
if (originatingTraceContext) {
  ingestSpan.addLink({
    context: originatingTraceContext,
    attributes: {
      "link.relationship": "ledger_event_continuation",
      "ledger.sequence": event.ledger,
      "soroban.tx_hash": event.txHash,
    },
  });
}
```

In Jaeger and Tempo, clicking on the **Span Link** allows seamless navigation from the off-chain indexer/push trace directly back into the originating browser claim trace, while preserving independent duration and error boundaries.

---

## 3. Sampling Strategy: Never Drop Error Traces

To ensure operational debuggability without drowning in trace volume, sampling is enforced via **Tail-Based Sampling** in the OpenTelemetry Collector (`infra/observability/otel-collector-config.yaml`):

```yaml
processors:
  tail_sampling:
    decision_wait: 3s
    num_traces: 10000
    expected_new_traces_per_sec: 2000
    policies:
      # Rule 1: 100% retention on span status_code = ERROR
      - name: error-status-filter
        type: status_code
        status_code: { status_codes: [ERROR] }

      # Rule 2: 100% retention on error boolean attribute
      - name: error-attribute-filter
        type: string_attribute
        string_attribute: { key: error, values: ["true", "True", "1"] }

      # Rule 3: 100% retention on HTTP errors (4xx / 5xx)
      - name: http-error-filter
        type: numeric_attribute
        numeric_attribute: { key: http.status_code, min_value: 400, max_value: 599 }

      # Rule 4: 100% retention on exceptions
      - name: exception-event-filter
        type: string_attribute
        string_attribute: { key: exception.type, values: [".*"], enabled_regex_matching: true }

      # Rule 5: Probabilistic sample for healthy traces (100% in local/testnet, tunable in prod)
      - name: healthy-trace-sample
        type: probabilistic
        probabilistic: { sampling_percentage: 100.0 }
```

### Why Tail-Based Sampling?
Head-based sampling (sampling at trace start) cannot know whether a downstream Soroban RPC call will revert or if the indexer will fail during database commit. Tail-based sampling waits for all spans in a trace to arrive, inspects them, and guarantees that **any trace containing an error is never dropped**.

---

## 4. The Privacy Line: What Identifiers Enter Traces

To protect user wallet confidentiality and prevent telemetry sinks from acting as deanonymization vectors, strict sanitization is enforced:

1. **Stellar Addresses**: Truncated to 8-character prefix + ellipsis (`addr.slice(0, 8) + "..."`). Full 56-character addresses are prohibited.
2. **Secrets & Signatures**: Secret keys (`S...`), seed phrases, and private signatures are strictly redacted (`[REDACTED_SECRET_KEY]`).
3. **Webhook Destinations**: Masked to origin only (`https://api.merchant.com/***`). Paths, query tokens, and auth headers are stripped.
4. **Emails & Chat IDs**: Masked to domain (`***@streampay.org`) and chat suffix (`chat_***4321`).
5. **Transaction Hashes & Stream IDs**: Permitted in full (immutable public on-chain identifiers).

See [`docs/PRIVACY.md`](./PRIVACY.md) for the complete specification.

---

## 5. Compose Bundle Deployment

The complete observability stack with OpenTelemetry Collector and Jaeger is containerized under `infra/observability/docker-compose.yml`:

```bash
cd infra/observability
docker compose up -d
```

### Services & Endpoints:
- **Jaeger Query UI**: `http://localhost:16686`
- **OpenTelemetry Collector OTLP gRPC**: `localhost:4317`
- **OpenTelemetry Collector OTLP HTTP**: `localhost:4318`
- **Grafana Dashboards**: `http://localhost:3001` (admin / admin)
- **Prometheus**: `http://localhost:9092`
- **Alertmanager**: `http://localhost:9093`

### Dashboards Link Traces:
- Grafana dashboard (`streampay-overview.json`) provisions a direct link to Jaeger distributed traces.
- Panels include trace ingestion throughput and tail-sampled error trace metrics.
- Prometheus datasource configures `derivedFields` mapping trace IDs directly to Jaeger trace visualizations.

---

## 6. Running the Trace Verification Demo

To simulate an end-to-end claim trace and print the visual graph:

```bash
node infra/observability/scripts/e2e_claim_trace_demo.mjs
```
