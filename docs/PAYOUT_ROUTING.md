# Payout routing

Closes the design for issue #80: a recipient binds an alternate payout address
(an exchange deposit account, an anchor-connected account) so claims land
there. All authorization stays with the recipient's original key.

Code: `contracts/payout-router` (crate `streampay-payout-router`).

## What it does

1. The recipient calls `propose(stream_id, payout)`. This starts a 24 hour delay
   and emits `PayoutBound`. Nothing is routed yet.
2. After the delay, the recipient calls `confirm(stream_id)`. The binding is now
   active and `PayoutActive` is emitted.
3. From then on, `withdraw`, `withdraw_max` and `withdraw_many` on that stream
   forward each claim from the recipient to `payout`.
4. The recipient can call `cancel(stream_id)` at any time. This clears the
   pending and the active binding (`PayoutCleared`) and claims land at the
   recipient again. There is no delay on `cancel`: leaving a binding is always
   instant.

## Why a second contract

The streaming contract is at the Soroban Wasm size wall (see
[WASM_SIZE.md](WASM_SIZE.md), section "The wall"):

| Item | Bytes |
|---|---|
| Streaming contract Wasm (pinned stellar-cli 28.1.0, as recorded in WASM_SIZE.md when this design was written) | 129,742 |
| CI budget `WASM_SIZE_BUDGET_KB=127` | 130,048 |
| Headroom under the budget | 306 |
| Protocol limit | 131,072 |
| Cost of one more entrypoint | about 680 |
| Payout router Wasm | 7,712 |

For current figures, see [WASM_SIZE.md](WASM_SIZE.md).

No new entrypoint fits in the streaming contract; splitting it into more
contracts is the declared route (#441). The router is a first such split and
changes no streaming source: the streaming contract's Wasm is byte-identical
with and without this change. It uses
the streaming contract's existing per-stream callback hook (`register_hook`),
which calls `selector(stream_id, amount)` from inside the payout on
`withdraw`, `withdraw_max` and `withdraw_many`.

The router does not link the streaming crate. It reads `get_stream` and
`get_advance` with `invoke_contract` and decodes the stream as a symbol-keyed
map, reading only `recipient`, `token` and `status`. Fields added to `Stream`
later cannot break it. The streaming crate is a dev-dependency only, so the
tests run against the real contract.

## State machine

```text
              propose                    confirm (now >= activates_at)
   none ------------------> pending ------------------------------> active
     ^                      |  ^  |                                 |  |
     |   cancel             |  |  '-- propose: replaces pending,    |  |
     '----------------------'  |      restarts the 24 h delay       |  |
     ^                         '-------------------------------------'  |
     '------------------------ cancel --------------------------------'
```

- `propose` while a binding is active leaves the active binding routing until
  the new one is confirmed.
- Only the active binding routes. A pending binding never moves funds, even
  long after its delay has passed.
- `confirm` before `activates_at` fails with `BindingNotReady`.
- Pending and active bindings use separate persistent keys
  (`DataKey::Pending(id)`, `DataKey::Active(id)`), so the delay window has its
  own storage entry and TTL.

## Delay tradeoff and threat model

Chosen: a 24 hour delay between `propose` and `confirm`, with instant `cancel`.

| Scenario | What happens |
|---|---|
| Stolen key, no delay | The thief rebinds in one transaction. Every future claim, including the owner's own scheduled claims, lands at the thief at once. The owner may not notice until funds have already moved. |
| Stolen key, 24 h delay | `PayoutBound` is public for 24 hours. The owner (or a watcher) sees it, calls `cancel`, and can move funds. The thief's rebind never activates silently. |
| Stolen key, either way | A thief holding the key can always call `withdraw` directly and send the funds anywhere. The delay does not stop that. It only stops silent, persistent re-routing. |
| Thief re-proposes just before the owner cancels | The owner's `cancel` is instant and clears pending and active together. |

Residual risk: the delay only helps if someone watches `PayoutBound` events and
the owner can sign within 24 hours. A thief with the key can also call `cancel`
and `propose` themselves; the owner's only recourse is to move the stream
(ownership transfer) or drain it. Without the delay, rebinding amplifies a key
theft into a permanent redirect; with it, the redirect is visible first.

Why 24 hours: long enough for a human or alert to react, short enough that a
legitimate change (a new exchange account) is not a burden. The value is the
constant `BIND_DELAY_SECS`.

Granularity: the ledger clock is the only time source. A binding becomes
confirmable at the first ledger whose close time is `>= activates_at`,
typically within about 5 seconds of the exact deadline. `confirm` at
`activates_at - 1` fails; at `activates_at` it succeeds.

## Security properties

- `propose`, `confirm`, `cancel` require the recipient's authorization.
  `cancel` accepts the stored recipient, or the current stream recipient if
  the stream changed hands.
- `on_withdraw` requires the streaming contract's own authorization, so only a
  direct call from the streaming contract passes. Nobody else can trigger a
  forward.
- The recipient's signature on the withdraw transaction covers the nested
  `token.transfer(recipient, payout, amount)` (Soroban auth tree: withdraw
  then token transfer). No second signature is needed. The test
  `recipient_signature_covers_the_nested_transfer` proves this with real auth.
- `payout` may not be the recipient, the streaming contract, or the router.
- A stream that is not active cannot be bound. `confirm` rechecks that the
  stream is still active and the recipient is unchanged.
- TTL: every write extends the entry. Reads extend only after `has()` returns
  true, because `extend_ttl` on a missing key traps (existence-check-before-
  extend). A test reads and clears bindings for ids that were never bound.

## How to wire it

1. Deploy the router with the streaming contract address as constructor
   argument.
2. As the recipient, register the hook once per stream:

```text
streaming.register_hook(
    caller = <recipient>,
    stream_id = <id>,
    event_class = Withdraw,
    callback_contract = <router>,
    selector = "on_withdraw",
    failure_policy = Revert)
```

3. `router.propose(id, payout)`, wait 24 hours, `router.confirm(id)`.

Use `Revert`. If the forward fails (for example the recipient changed, see
below), the whole claim reverts rather than leaving funds half routed. With
`EmitAndContinue` a failed forward would leave the claim at the recipient and
only emit `HookFailed`. The recipient can always call `unregister_hook`.

## Known limits (documented, not fixed)

- `cancel_stream` payouts and `withdraw_all`'s aggregated transfer do not call
  the Withdraw hook, so they land at the recipient's own address.
- Receivables advances: the hook amount is the gross claim, while a lender
  intercept pays part of it to the lender. `propose` and `confirm` reject a
  stream with an open advance (`AdvanceActive`). Clear the binding before
  taking an advance. The router cannot check during a claim (the streaming
  contract cannot be re-entered from its own hook). If an advance is drawn
  after binding, the forward of the gross amount can fail for lack of funds
  and, with `Revert`, the claim reverts until the binding is cleared.
- Recipient change: after an ownership transfer the stored recipient no longer
  signs, so the forward fails and (with `Revert`) claims revert until the new
  recipient calls `cancel` on the router (or `unregister_hook`). `confirm`
  refuses a pending binding whose recipient changed (`RecipientChanged`).
- The payout address must be able to receive the stream's token (trustline,
  for classic assets). The router does not check this.

## Errors

| Code | Name | Meaning |
|---|---|---|
| 1 | StreamUnavailable | Stream not found or unreadable |
| 2 | StreamNotActive | Stream is cancelled or depleted |
| 3 | PayoutIsRecipient | Payout equals the recipient |
| 4 | PayoutIsStreaming | Payout equals the streaming contract |
| 5 | PayoutIsRouter | Payout equals the router |
| 6 | AdvanceActive | Stream has an open receivables advance |
| 7 | NoPending | Nothing to confirm |
| 8 | BindingNotReady | Delay has not passed |
| 9 | NoBinding | Nothing to cancel |
| 10 | RecipientChanged | Stream recipient differs from the binding |

Codes are append-only.
