# Portfolio tax-lot export

The dashboard can export incoming StreamPay withdrawals as versioned CSV or JSON
tax-lot components. Generation and download happen in the browser; export rows are
never POSTed to StreamPay or a third party.

## Exactness and supported histories

Each withdrawal is reconstructed from the indexer's paginated event feed. The
ledger close timestamp on the event is the only clock used. For an immutable
linear stream, cumulative accrual is the contract's `streamed_at` formula:

```text
min(deposit, floor(deposit * clamp(ledger_time - start_time, 0, duration) / duration))
```

Newly accrued quantity becomes an acquisition lot. FIFO consumes the oldest lot
first. Average cost pools the remaining acquired quantity and uses its
amount-weighted accrual window. A withdrawal can therefore produce multiple CSV
rows or JSON objects; `withdrawal_event_id` and `component_index` identify them.
Cancellation payouts (`StreamCancelled.recipient_amount`) are included.

The exporter blocks, rather than approximates, when any of these is true:

- `stream_created` is absent or does not match the current on-chain stream;
- the stream uses oracle time;
- a stored segmented rate schedule exists;
- a top-up, pause, resume, or accepted rate change appears in the history;
- a payout exceeds accrued quantity or `withdrawn_total` is inconsistent;
- ledger timestamps or event cursors are invalid;
- exported quantity differs from current on-chain `withdrawn` by more than one
  smallest token base unit.

The one-base-unit threshold matches reconciler #490. Exact matches are
`reconciled`; a one-unit difference is `rounding_within_epsilon`; larger
differences are `value_mismatch` and block completion.

## Cost basis

On-chain events contain token quantities, not fiat acquisition prices. The UI's
**Unit cost basis** is a user-supplied valuation per whole token and **Valuation
currency** labels that valuation. The default `1` expresses token-denominated
basis. Cost is rounded half-up to eight decimal valuation units per component:

```text
cost_basis = round_half_up(amount_base_units / 10^decimals * unit_cost_basis, 8)
```

This export is a record-generation aid, not tax advice.

## Schema `1.0.0`

CSV has one header row. JSON is an array of objects. Every row/object contains:

| Field | Meaning |
| --- | --- |
| `schema_version` | `1.0.0` |
| `lot_id` | Deterministic stream/event/method/component identifier |
| `withdrawal_event_id` | Indexer event id |
| `component_index` | One-based component within the withdrawal |
| `stream_id` | StreamPay stream id |
| `asset` | Token symbol when available |
| `asset_contract` | Stellar token contract address |
| `amount` | Unsigned quantity in smallest token base units |
| `amount_display` | Quantity formatted with token decimals |
| `decimals` | Token decimal precision |
| `accrual_start_time` | Unix seconds at the start of the source accrual window |
| `accrual_end_time` | Unix seconds at the end of the source accrual window |
| `accrual_period_seconds` | Window length; average-cost rows use the pooled window |
| `ledger` | Ledger containing the withdrawal |
| `ledger_closed_at` | Authoritative ledger close timestamp |
| `tx_hash` | Transaction hash when supplied by the indexer |
| `cost_basis_method` | `fifo` or `average` |
| `cost_basis` | Component valuation at eight-decimal output precision |
| `unit_cost_basis` | User-supplied valuation per whole token |
| `valuation_currency` | User-supplied currency label |

## Privacy and large portfolios

Rows include the connected wallet's incoming stream ids, asset contract
addresses, ledger timestamps, and transaction hashes. They do not include secret
keys, seeds, signatures, authentication tokens, or telemetry payloads. Treat the
downloaded file as sensitive financial data.

Stream ids, stream reads, and event pages are processed incrementally. Only one
stream's reconciled lot components are retained at a time. Browsers with File
System Access write serialized chunks directly to the selected file. Other
browsers use an 8 MiB safety cap and report that a streaming-capable browser or a
narrower export is required.
