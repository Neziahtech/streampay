# StreamPay architecture

How StreamPay works internally: the storage model, the accrual math, auth and
reentrancy, TTL strategy, and the design decisions behind the v1 API. Read the
[README](../README.md) first for the overview.

## 1. Components

```text
┌────────────────────────────────────────────────────────────────────┐
│                        StreamingPayments                           │
│                                                                    │
│  lib.rs      entrypoints: create_stream / withdraw / withdraw_max / │
│              cancel_stream / top_up / raise_dispute /              │
│              resolve_dispute / expire_dispute / get_stream /       │
│              available / get_dispute / required_dispute_bond /     │
│              recipient_streams / sender_streams                    │
│  stream.rs   Stream type, storage, checked accrual math            │
│  dispute.rs  Dispute state, escalating bond math, expiry split     │
│  errors.rs   StreamError — stable numeric codes, append-only       │
│  events.rs   StreamCreated / Withdrawn / StreamCancelled /         │
│              StreamToppedUp / DisputeRaised / DisputeResolved /    │
│              DisputeExpired (stream_id as topic)                   │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ token interface (SAC-compatible)
                           ▼
              Stellar Asset Contract / custom token
```

## 2. Storage model

| Key | Value | Purpose |
|---|---|---|
| `DataKey::NextStreamId` | `u64` | monotonic id counter (ids start at 1) |
| `DataKey::Stream(id)` | `Stream` | full per-stream state |
| `DataKey::RecipientStreams(addr)` | `Vec<u64>` | append-only ids where `addr` receives |
| `DataKey::SenderStreams(addr)` | `Vec<u64>` | append-only ids created by `addr` |
| `DisputeKey::Active(id)` | `Dispute` | the open dispute on `id` (bond, window) — its presence *is* the freeze flag |
| `DisputeKey::Count(id)` | `u32` | disputes ever raised on `id`; persists across resolution, drives the escalating bond |

Streams live in **persistent** storage. Every mutating entrypoint that touches
a stream extends its TTL (`TTL_THRESHOLD_LEDGERS = 200_000`, extend to
`500_000` ≈ 29 days), so a stream that is being used never goes cold, while
abandoned streams naturally archive to off-chain recovery — the Soroban-native
way to bound state bloat without penalizing active users. Index entries get
the same TTL treatment on write *and* on read, so an actively-queried address
stays hot.

There is still **no global registry** of all streams (no contract-wide
`Vec<u64>`): that would make `create_stream` cost grow with total stream count.
Instead, discovery is **per-address**: `create_stream` appends the new id to
the sender's and the recipient's own index lists — each bounded by that one
user's activity, written only at creation, and paginated on read
(`recipient_streams` / `sender_streams`, `limit` clamped to
`MAX_PAGE_SIZE = 50`). The indexes are *advisory*: never authorize against
them; the `Stream` entry is the source of truth, and `StreamCreated` events
remain the complete audit trail (an external indexer can still rebuild or
cross-check the lists).

## 3. Accrual math

Everything reduces to one pure function (`stream.rs`):

```rust
streamed_at(deposit: i128, duration: u64, elapsed: u64) -> Result<i128, StreamError>
```

- `elapsed == 0` (before `start_time`) → `0`
- `elapsed >= duration` (at/after `end_time`) → `deposit`
- otherwise → `deposit * elapsed / duration`, floored

Safety properties:

1. **Capacity pre-check at creation/top-up.** `validate_capacity` requires
   `deposit ≤ u128::MAX / duration`, so the worst-case product can never
   overflow *later* — turning per-call overflow handling into a one-time
   admission check.
2. **Widened products.** The product is computed in `u128`; a result is capped
   at `deposit` before narrowing back to `i128` (safe: `deposit ≤ i128::MAX`
   was checked on admission).
3. **Checked everywhere.** All `+`/`-` on user-relevant amounts use
   `checked_add` / `checked_sub` and map failure to
   `StreamError::MathOverflow`. No arithmetic operator in the contract can
   panic.
4. **Rounding never benefits the sender.** Floor division means a partial
   second is *never* counted as streamed; over the full window
   `streamed(duration) = deposit` exactly, so the recipient is always made
   whole by the end. The floor dust accumulates to the recipient, not the
   sender — verified by the property test (partial withdrawals ≤ full-window
   accrual).

The window is **half-open** `[start_time, end_time)`: at `now == start_time`
nothing has accrued, at `now ≥ end_time` the full duration has elapsed.

## 4. Auth model

| Action | who may call | auth consumed |
|---|---|---|
| `create_stream` | anyone; `sender` must authorize | sender |
| `withdraw` | recipient only | recipient |
| `cancel_stream` | sender always; recipient iff `cancelable` | caller |
| `top_up` | sender only | sender |

The `cancelable` flag is chosen per stream at creation: payroll senders often
want sender-only cancellation, while vesting recipients may want the right to
walk away with what they've earned.

`require_auth()` is called *before* any state reads that depend on the caller's
identity, and errors use `StreamError` codes rather than SDK auth panics where
the condition is a business rule (e.g. `NotAuthorized` for a stranger calling
`cancel_stream`).

## 5. Reentrancy: checks-effects-interactions

Every entrypoint follows CEI ordering — all storage writes and event emissions
happen **before** the token transfers:

- `withdraw`: mark `withdrawn += amount`, set `Depleted` if fully drained,
  emit `Withdrawn`, *then* `token.transfer`.
- `cancel_stream`: set `Cancelled`, record the payout as withdrawn, emit
  `StreamCancelled`, *then* the two transfers.
- `create_stream` / `top_up`: pull tokens first, persist after — if a
  reentrant callback abused the transfer-in, the persisted state still
  reconciles with the balance (invariant below).

Additionally, `withdraw` and `cancel_stream` re-read `status` after auth: a
malicious token contract that reenters `withdraw` during its own transfer
callback finds `withdrawn` already updated, and `available_amount` reverts to
the *post-write* (smaller or zero) value. The suite contains a
malicious-token test that attempts exactly this reentry.

The dispute paths follow the same ordering: `resolve_dispute` deletes the
`Dispute` entry and (on accept) finalizes the `Stream` **before** any of the
bond/settlement transfers; `expire_dispute` deletes the entry before paying
the split. A reentrant token callback during a bond transfer therefore never
sees a half-closed dispute — and the freeze checks in `cancel_stream` /
`top_up` re-read the dispute entry rather than trusting a caller-supplied
state.

**Balance invariant:** the contract's token balance is always
`≥ Σ (deposit − withdrawn)` across live (non-cancelled) streams, **plus the
sum of the outstanding dispute bonds**. Funds enter only via
`create_stream`/`top_up`/`raise_dispute` and leave only via
`withdraw`/`cancel_stream`/`resolve_dispute`/`expire_dispute`, and every exit
is bounded by the invariant `0 ≤ withdrawn ≤ streamed ≤ deposit`. A random
scenario property test re-checks this exact equality after every operation
(`property_contract_balance_equals_locks_plus_outstanding_bonds`).

## 6. Lifecycle states

```text
            create_stream
                 │
                 ▼
              Active ──── cancel_stream ────▶ Cancelled (terminal)
                 │        (pro-rata split:
                 │         recipient ← available,
                 │         sender ← deposit − streamed)
                 │
                 ├─ withdrawn == deposit ──▶ Depleted (terminal)
                 │
                 └─ top_up allowed while Active (even after end_time:
                    funds become fully accrued → recipient withdraws)
```

- Cancelling a `Depleted` stream reverts (`StreamNotActive`) — there is
  nothing left to split.
- Cancelling a not-yet-started stream is a 100 % refund to the sender.
- `top_up` on a cancelled/depleted stream reverts.

### Disputed: an overlay, not a status

A dispute never changes `StreamStatus`. It is an orthogonal *overlay* — the
existence of a `DisputeKey::Active(id)` entry — layered on top of `Active`:

```text
 Active ──raise_dispute(bond)──▶ Active + Dispute ──resolve(accept=false)──▶ Active (bond → sender)
    │                                 │     │
    │                                 │     ├─resolve(accept=true)──▶ Cancelled (pro-rata unwind,
    │                                 │     │                         bond → recipient)
    │                                 │     └─expire_dispute (after 7 d)──▶ Active
    │                                 │                                    (bond split 50/50)
    │                                 └── withdraw / accrual keep working ──▶ (possibly Depleted)
```

While disputed: `cancel_stream` and `top_up` revert with `DisputeActive`;
`withdraw`, `withdraw_max`, and accrual are unaffected. A stream *can* reach
`Depleted` underneath an open dispute (the recipient withdrew everything);
resolution then only settles the bond. `Depleted` and `Cancelled` streams can
never be disputed (`StreamNotActive`).

## 7. Error surface

`StreamError` variants carry explicit numeric codes (`contracterror`), part of
the public interface:

| Code | Variant | Raised when |
|---|---|---|
| 1 | `StreamNotFound` | no stream with this id |
| 2–3 | `NotStreamSender` / `NotStreamRecipient` | reserved role checks |
| 4 | `StreamNotCancellable` | recipient cancels a non-cancelable stream |
| 5 | `StreamNotActive` | cancelled/depleted stream mutated |
| 6 | `StartTimeInPast` | `start_time` before current ledger timestamp |
| 7 | `InvalidTimeRange` | `end_time ≤ start_time` (zero duration) |
| 8 | `DurationTooLong` | window exceeds `MAX_DURATION_SECONDS` (100 y) |
| 9 | `ZeroAmount` | deposit / withdrawal / top-up `≤ 0` |
| 10 | `AmountExceedsAvailable` | withdrawal above accrued balance |
| 11 | `MathOverflow` | a checked computation would overflow |
| 12 | `NotAuthorized` | caller is neither sender nor (cancelable) recipient |
| 13 | `NothingToWithdraw` | `withdraw_max` with an empty accrued balance |
| 14 | `DisputeActive` | cancel/top-up attempted while a dispute is open (also: second `raise_dispute`) |
| 15 | `DisputeNotFound` | resolve/expire/get a stream without an open dispute |
| 16 | `DisputeNotExpired` | `expire_dispute` called before the timelock elapsed |

Codes are **append-only**: never renumber or reuse a variant. Codes 2
(`NotStreamSender`) and 3 (`NotStreamRecipient`) are **retired**: they were
reserved role checks that no entrypoint ever produced, so they are kept (never
renumbered or reused) but marked unreachable.

The authoritative, machine-generated view of this surface lives in
[`docs/ERRORS.md`](./ERRORS.md): a per-branch table mapping every
`(entrypoint, condition)` decision to its code, emitted from the contract's own
instrumentation (`src/surface.rs`) by `cargo run -p streampay-contract --example
error_surface_doc`, with a CI step that regenerates it and fails on drift. Each
rejection site calls `surface::reject(Branch::…)` instead of returning a raw
code, so the mapping is generated rather than hand-maintained; the
`error_surface_test.rs` matrix proves every reachable branch fires its declared
code, and the coverage test fails CI on any error code with zero reachable
branches (unless explicitly retired) or any branch that lacks a code.

## 8. Design decisions (and rejected alternatives)

**Wall-clock accrual (`timestamp`), not per-ledger counters.** Streams are
expressed in seconds so a stream behaves identically on testnet, mainnet, and
in tests. On mainnet ledgers are ~5 s, so granularity is bounded by the
ledger cadence; the floor division in `streamed_at` makes under-granular
ledger boundaries always conservative.

**Sender pulls via `transfer_from` (approval), not first-class
`TokenInterface::approve`+escrow flows.** One approval + one create tx; the
contract is the escrow. This matches SAC semantics (`transfer_from` consumes a
real allowance) and keeps `create_stream` atomic.

**Top-up does not extend `end_time`.** Extending would re-baseline accrual and
can retroactively *reduce* the recipient's available balance (the extra funds
spread over a longer window). v1 keeps top-up strictly additive — accrued
amounts only grow. If demand exists, a `create_stream` from the remainder of a
fully-streamed stream is the clean composition (roadmap).

**No global stream registry; per-address append-only indexes instead.** See
§2. A contract-wide id vector couples `create_stream` cost to total adoption
and re-reads everything on every query; per-address lists keep writes O(1)
for the one user involved and reads paginated. Discovery remains safe because
the indexes are advisory only — auth and payouts always read the `Stream`
entry itself.

**Terminal states are terminal.** No reactivation, no partial cancellation.
Simplicity is a security feature; richer flows belong in composing contracts
or off-chain UX.

**Recipient-initiated disputes: freeze the lifecycle, never the earnings.**
The recipient can flag an active stream (wrong address, coerced creation),
which freezes `cancel_stream` and `top_up` for up to one timelock window.
What the freeze *excludes* is deliberate: accrual keeps running and the
recipient keeps full access to `withdraw` / `withdraw_max`. Reasoning — (a)
accrued funds are property the recipient already earned by the stream's own
rules; seizing them during a dispute the recipient initiated would punish
the party we are trying to protect, and would make "coerced creation"
strictly worse for the victim; (b) the dispute is a *hold on mutations*, not
a clawback: the sender's funds keep flowing exactly as scheduled, so nothing
about the stream's economics changes while the parties sort things out; (c)
freezing withdrawals would also freeze the only action a disputed recipient
can use to mitigate harm. A dispute is stored as a separate `Dispute` entry
rather than a fourth `StreamStatus`, which keeps existing stream
serialization stable and makes the withdraw path provably untouched.

**Disputes are economically bounded, never free.** A free flag lets a
recipient grief any sender — so raising pulls a bond via `transfer_from`:
`bondₙ = max(1 unit, 5 % of deposit × n)`, where `n` is the dispute count on
*that stream* (persisted in `DisputeKey::Count`). Outcomes: sender rejects
(bad faith) → the bond is slashed to the sender as compensation for the
frozen window and the stream resumes; sender accepts → the bond is refunded
and the stream unwinds with the normal pro-rata cancel split; timelock
expires with no verdict → the bond is **split 50/50** (sender rounds up).

*Griefing-threshold math* (cost per blocked hour vs stream value `D`,
timelock `T` = 7 days = 168 h, base bond `b` = 5 %·D):

- Cheapest attack — the sender stays passive and every dispute dies at
  expiry: the attacker loses `ceil(n·b/2)` per blocked week, i.e.
  `n·b/(2·168) ≈ 0.0149 %·D·n` **per blocked hour** on round `n`.
- Cumulative attacker cost after `k` griefing weeks:
  `Σ n·b/2 = b·k(k+1)/4 ≈ 1.25 %·D·k²`. It crosses the *entire stream value*
  at `k = 2·√(D/b) ≈ 9` weeks — after ~9 rounds the attacker has burned more
  than the stream is worth, while the beneficiary (the recipient) has
  meanwhile withdrawn everything accrued anyway.
- If the sender instead actively rejects each dispute, the cost doubles
  (full bond `n·b`, not half), crossing `D` after ≈ 6 rounds. The sender's
  defense is therefore either one cheap transaction (`resolve_dispute`) or
  simply waiting — both put the escalating cost on the attacker.
- The passive-sender half-slashed expiry is the compromise that keeps the
  legitimate case bounded too: a genuine victim whose coercer never responds
  loses only half an escalating bond per window and always keeps accrued
  funds; rejecting to zero (full refund at expiry) would make serial disputes
  free, and full slashing at expiry would over-punish legitimate recipients
  of unresponsive senders.

Rejected alternatives: a fixed non-escalating bond (serial griefing settles
into a constant hourly price); disputes as a `StreamStatus` variant (breaks
"withdrawals always work" or requires special-casing the status enum);
recipient-initiated *bond withdrawal* before expiry (turns the bond into a
free option: freeze the stream, refund yourself, repeat); on-chain
arbitration committees (out of scope — a dispute hold only needs to be long
enough for the sender to choose: accept and unwind at the normal pro-rata
cost, or reject and put the conflict on record while collecting the bond).

## 9. Testing strategy

- **Unit tests** (`test.rs`) cover every spec edge case: withdraw before
  start / at / after end, sequential partial withdrawals, cancel before start
  / fully-withdrawn / not-cancelable, top-up after end, zero-duration and
  zero-amount rejection, `i128::MAX`-scale checked math, event emission
  (typed, per-contract-filtered), and a malicious-token reentrancy attempt.
- **Property test**: random `(deposit, duration)` — for random sample points
  `t ≤ duration`, the sum of payouts up to `t` never exceeds
  `streamed_at(deposit, duration, t)`, and `streamed_at(..., duration) ==
  deposit` exactly.
- **Rate math is pure** (`streamed_at` takes no `Env`), so the `cargo-fuzz`
  target in [`fuzz/`](../fuzz/fuzz_targets/streamed_at.rs) hammers it without
  a Soroban host: bounds, exact floor-ratio reference comparison,
  monotonicity, and "errors are only ever genuine `MathOverflow`". CI runs a
  scheduled session (`fuzz.yml`, non-blocking); any crash becomes a regression
  unit test.
- **Error surface** (`error_surface_test.rs`): the branch registry in
  `surface.rs` is walked by generated tests — one probe per branch asserts the
  exact branch fires its declared code — plus coverage tests proving no code is
  dead and no branch uncoded. `docs/ERRORS.md` is generated from the same table
  and diffed in CI.
- **`withdraw_max`** shares the `withdraw` payout tail (`pay_out`) so both
  paths inherit the same CEI ordering and reentrancy proof; index pagination
  and TTL behavior have dedicated tests in `test.rs`.
- **Disputes** are covered end to end in `test.rs`: the freeze policy
  (cancel/top-up blocked, withdrawals and accrual alive), auth, double-raise
  rejection, both resolution outcomes with exact bond accounting, expiry
  timing and the odd-bond split, serial-griefing bond escalation, expiry on
  a stream the recipient drained mid-dispute, and the event payloads. The
  balance invariant is re-asserted after every step of a seeded random
  operation script — `sum(deposit − withdrawn)` over live streams plus the
  outstanding dispute bonds.
- **Dispute-bond math is pure** (`required_bond`, `bond_shares` take no
  `Env`), so the `dispute_bond` `cargo-fuzz` target
  ([`fuzz/`](../fuzz/fuzz_targets/dispute_bond.rs)) fuzzes the anti-griefing
  core: the floor, monotonic escalation in rounds and deposit, genuine
  `MathOverflow` only, and the expiry split's conservation
  (`sender + recipient == bond`).

## 10. Open problems / roadmap hooks

- `pause_stream` (sender-initiated temporary hold) — needs a fourth status and
  careful `cancel_amounts` treatment; drafted as a good-first-issue.
- Multi-token batch creation — one tx, N streams; watch the instruction
  budget, likely `try_create_batch` with per-item results.
- Gas optimization pass on storage reads — `cancel_stream` does one
  read-modify-write; a `Stream` split into hot/cold fields could shave bytes.
- Event indexer service — TypeScript worker polling `getEvents` per topic
  `stream_id`, materializing stream history for the UI.
