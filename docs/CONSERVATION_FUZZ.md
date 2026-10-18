# Value-Conservation Property Fuzzing

StreamPay enforces strict economic and balance conservation guarantees across all state transitions.
Every state-mutating entrypoint must satisfy the invariant that funds locked in the contract
exactly account for active stream obligations and protocol treasury fee reserves, without any leakage,
rounding slippage, or unauthorized balance drift.

---

## 1. Value Conservation Invariant Formulation

### 1.1 Per-Stream Invariant
For every stream $s$ registered in the contract:
$$\text{deposit}(s) = \text{withdrawn}(s) + \text{available\_recipient}(s, t) + \text{refundable\_sender}(s, t)$$

Where:
- $\text{deposit}(s)$: Total tokens locked for stream $s$ (initial deposit plus all subsequent top-ups).
- $\text{withdrawn}(s)$: Cumulative tokens paid out to the recipient via `withdraw` or `withdraw_max`.
- $\text{available\_recipient}(s, t)$: Accrued tokens redeemable by the recipient at timestamp $t$:
  $$\text{available}(s, t) = \min(\text{streamed}(s, t), \text{deposit}(s)) - \text{withdrawn}(s)$$
- $\text{refundable\_sender}(s, t)$: Unaccrued escrow refundable to the sender if cancelled at timestamp $t$:
  $$\text{refundable}(s, t) = \begin{cases}
  \text{deposit}(s) - \min(\text{streamed}(s, t), \text{deposit}(s)) & \text{if } s \text{ is Active} \\
  0 & \text{if } s \text{ is Depleted or Cancelled}
  \end{cases}$$

The remaining active escrow obligation for stream $s$ is:
$$\text{escrow}(s) = \text{deposit}(s) - \text{withdrawn}(s) = \text{available\_recipient}(s, t) + \text{refundable\_sender}(s, t)$$

### 1.2 Contract-Wide Balance Conservation
For every token asset $T$ (Native XLM, Stellar Asset Contract tokens):
$$\text{Balance}_{\text{contract}}(T) = \sum_{s \in \text{Streams}(T),\, s \text{ is Active}} \big(\text{deposit}(s) - \text{withdrawn}(s)\big) + \text{TreasuryFeesRetained}(T)$$

Where:
$$\text{TreasuryFeesRetained}(T) = \text{treasury\_status}(T).\text{charged\_total} - \text{treasury\_status}(T).\text{withdrawn\_total} = \text{treasury\_status}(T).\text{collectible}$$

No operation may violate this equality at any point in time.

---

## 2. Tested Entrypoints

The property fuzz campaign targets all 7 state-mutating entrypoints and ledger time:
1. `create_stream`: Opens a single stream, pulls deposit from sender, collects protocol fee.
2. `create_streams`: Atomically opens a batch of streams with mixed recipients/assets, grouping token pulls and fees.
3. `withdraw`: Recipient claims a specific accrued amount $\le \text{available}$.
4. `withdraw_max`: Recipient atomically claims all currently available tokens.
5. `top_up`: Sender deposits additional tokens into an ongoing stream, extending duration/payout.
6. `cancel_stream`: Sender or recipient (if `cancelable`) terminates stream; recipient receives accrued funds, sender receives pro-rata refund.
7. `withdraw_treasury`: Governor withdraws accumulated fee revenue to vault address.
8. `advance_time`: Advances ledger timestamps arbitrarily across start, mid-flight, end, and post-duration bounds.

---

## 3. Running the Fuzz Campaign

### Prerequisites
Install nightly Rust toolchain and `cargo-fuzz`:
```bash
rustup toolchain install nightly --profile minimal
cargo +nightly install cargo-fuzz
```

### Local Execution
To execute the value-conservation fuzz campaign:
```bash
cd fuzz
cargo +nightly fuzz run conservation -- -max_total_time=300 -rss_limit_mb=4096
```

For a continuous, deep overnight run:
```bash
cargo +nightly fuzz run conservation -- -max_total_time=1800 -rss_limit_mb=4096
```

---

## 4. Shrinker Reproduction Path

When libFuzzer encounters an invariant violation or unexpected failure, it writes a raw crash artifact to `fuzz/artifacts/conservation/crash-<hash>`.

### 4.1 Minimizing the Failure Sequence (libFuzzer `tmin`)
Run libFuzzer's testcase minimizer to reduce the failure input to the minimal sequence of actions:
```bash
cd fuzz
cargo +nightly fuzz tmin conservation artifacts/conservation/crash-<hash> -artifact_prefix=artifacts/conservation/minimized-
```
The resulting minimized file `minimized-<hash>` isolates the exact minimal set of transactions needed to trigger the regression.

### 4.2 Replaying a Crash Artifact
To reproduce and step through a specific failure in a debugger or test run:
```bash
cd fuzz
cargo +nightly fuzz run conservation artifacts/conservation/crash-<hash>
```

### 4.3 Converting to Unit Regression Test
When filing a bug or adding a permanent regression test:
1. Decode the binary artifact into the human-readable `ConservationCampaign` action list.
2. Add a deterministic test case to `contracts/streaming-payments/src/test.rs` under `property_value_conservation_multi_token_state_machine`.
3. Verify via `cargo test property_value_conservation`.
