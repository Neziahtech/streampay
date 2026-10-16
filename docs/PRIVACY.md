# Privacy Analysis: Commit-Reveal Claim Amounts in StreamPay

## Executive Summary

StreamPay introduces an opt-in **commit-reveal privacy mode** for claims (`commit_claim`, `reveal_claim`, and `expire_reveal`). In standard streaming payments, every recipient claim emits a `Withdrawn` event disclosing the exact withdrawn amount in real time on the public ledger. Under commit-reveal privacy mode, a recipient submits a cryptographic commitment (SHA-256 hash) along with an incentive deposit. Only upon the subsequent reveal transaction (or expiration safety-valve) is the claim settled.

This document provides an honest, rigorous assessment of what is hidden, from whom, for how long, and what an observer on-chain can still infer.

---

## 1. Threat Model & Security Properties

### What is Hidden?
- **Exact batch claim amounts at claim time**: When a recipient claims funds, they submit `hash = SHA256(stream_id, recipient, claim_amount, salt)`. Neither the claim amount nor the salt is published or visible on the ledger during the commitment window.

### From Whom?
- **Public ledger observers**: External network participants, third-party indexers, and blockchain analytics observers watching transaction calldata and events cannot determine the quantity of tokens being claimed while the commitment is unrevealed.

### For How Long?
- **Duration of the reveal window**: The exact claim amount remains hidden from the moment `commit_claim` is executed until:
  1. The recipient invokes `reveal_claim(commitment_id, claim_amount, salt)` within the reveal deadline, OR
  2. The reveal window expires (`now > reveal_deadline`) without reveal.

---

## 2. Honest Assessment: On-Chain Streaming Leakage

Public on-chain streaming contracts have inherent informational leakage. It is critical to recognize that commit-reveal **does not provide full zero-knowledge or untraceable transactions**. Specifically:

### What an Observer Can Still Infer:
1. **Accrual Rate & Boundaries**:
   - The stream creation parameters (`deposit`, `start_time`, `end_time`, and `token`) are public immutable records on ledger.
   - Anyone can compute the maximum accrued balance at second $t$:
     $$\text{accrued}(t) = \min\left(\text{deposit}, \frac{\text{deposit} \times (t - \text{start\_time})}{\text{end\_time} - \text{start\_time}}\right)$$
   - Therefore, any claim amount $A$ is strictly bounded: $0 < A \le \text{accrued}(t) - \text{withdrawn}_{\text{prior}}$.

2. **Transaction Timing & Cadence**:
   - The timestamp of `commit_claim` reveals *when* a recipient initiated a settlement. Observers know that the recipient accrued at least non-zero tokens by that time.

3. **Reveal Incentive Deposit**:
   - The commitment requires an incentive deposit to prevent griefing/spam commitments. The deposit size is public and visible in `ClaimCommitted` events.

4. **Eventual Settlement Transparency**:
   - Once `reveal_claim` is submitted, the token transfer executes on Soroban and transfers tokens to the recipient. The exact amount is settled and the contract balance drops by `claim_amount`, updating `withdrawn`. Observers observing ledger state deltas or `Withdrawn` events post-reveal learn the historical claim amount.
   - If the recipient never reveals, `expire_reveal` forfeits the deposit to the sender, leaking that the claim was aborted or expired.

---

## 3. Incentive Alignment & Safety Valve

Commitment schemes without collateral risk funds being locked or griefed by uncooperative parties. StreamPay guarantees:

1. **Reveal Deposit (Incentive)**:
   - A recipient posting a claim commitment must lock an incentive deposit.
   - Upon successful reveal, the deposit is refunded 100% to the recipient alongside their claim.
2. **Safety Valve (No Stuck Funds)**:
   - If the recipient fails to reveal before `reveal_deadline`, `expire_reveal` allows the deposit to be liquidated and refunded to the stream sender as compensation/penalty.
   - The unrevealed amount remains unwithdrawn in the stream deposit, ensuring that stream funds are never burned or permanently locked.
