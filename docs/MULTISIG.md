# ⚡ Multisig Sender & Recipient Architecture

StreamPay supports payment streams created, funded, managed, and claimed by K-of-N multisig signer sets without requiring special-case logic inside the core streaming payments contract.

This document details the architectural evaluation, the reference multisig contract (`streampay-multisig`), authorization flows, economic/fee implications, and replay protection guarantees.

---

## 1. Architectural Evaluation: Reusable Multisig vs. Bring-Your-Own

Stellar Soroban provides native account abstraction: any deployed smart contract address (`C...`) is a first-class `Address` equivalent to standard ed25519 account keys (`G...`).

When evaluating how to enable multisig senders and recipients, two primary architectural paths were analyzed:

| Consideration | Embedded / Special-Cased in StreamPay | Reusable Reference Multisig (Decoupled) |
| :--- | :--- | :--- |
| **Contract Scope & Complexity** | Increases StreamPay contract size, adds signer state, voting logic, and threshold storage. | Keeps StreamPay lightweight, minimal, and laser-focused solely on payment streaming. |
| **Upgradeability & Governance** | Upgrading multisig logic requires upgrading the entire StreamPay contract. | Multisig instances can be upgraded, replaced, or configured independently. |
| **DAO & Account Abstraction** | Locks users into StreamPay's custom multisig model. | Works natively with any DAO governor, smart contract wallet, or external multisig. |
| **Audit Surface** | Expands audit scope of funds-handling contract with governance state machines. | Separates funds-streaming logic from signature aggregation logic. |

### Decision: Reusable Reference Implementation with Zero Special-Casing

We deliver a reference K-of-N multisig contract in `contracts/multisig/` (`streampay-multisig`) while keeping `contracts/streaming-payments/` completely agnostic of multisig mechanics.

Whenever a multisig contract calls StreamPay via `env.invoke_contract(&streaming_id, ...)`:
1. Soroban recognizes the multisig contract itself as the caller.
2. `sender.require_auth()` in `contracts/streaming-payments` succeeds natively because the invocation originates from the contract's own execution context.
3. Neither `create_stream`, `top_up`, nor `cancel_stream` require special handling for multisig entities.

---

## 2. Reference Multisig Contract (`streampay-multisig`)

The reference contract implements a proposal-approval-execution lifecycle:

```text
 1. Propose
    Signer A calls propose(target, function, args, title)
    Multisig contract stores Proposal; auto-approves for Signer A
              │
 2. Approve
    Signer B calls approve(proposal_id)
    Multisig contract records approval; verifies signer membership
              │
 3. Execute
    Signer (or any caller) calls execute(proposal_id)
    Multisig verifies approvals >= threshold against current active signers
    Multisig marks proposal as executed (CEI pattern)
    Multisig invokes target contract: env.invoke_contract(target, function, args)
```

### Supported Entrypoints

- `init(admin, signers, threshold)`: Initializes the multisig with a valid threshold ($1 \le K \le N$) and unique signer set.
- `propose(caller, target, function, args, title)`: Submits a new execution proposal and records the proposer's approval.
- `approve(caller, proposal_id)`: Approves a pending proposal.
- `revoke_approval(caller, proposal_id)`: Revokes a previously submitted approval before proposal execution.
- `revoke_proposal(caller, proposal_id)`: Allows the original proposer to revoke a pending proposal before execution.
- `execute(caller, proposal_id)`: Validates threshold against active signers and dispatches cross-contract invocation.
- `add_signer(caller, new_signer)`: Governance action to add a new signer.
- `remove_signer(caller, signer)`: Governance action to remove a signer (verifies $N \ge \text{threshold}$).
- `set_threshold(caller, new_threshold)`: Governance action to modify threshold ($1 \le \text{threshold} \le N$).

---

## 3. Fee Implications & Economic Analysis

Operating multisig accounts on Soroban involves different cost structures compared to classic Stellar accounts.

### Cost Breakdown: Per-Signer Transactions vs. Account-Level Signatures

```text
Classic Stellar Account Multisig:
[Tx Envelope with K Signatures] ──> Single submission, 1 network fee

Soroban Contract-Based Multisig:
1. Propose Tx     ──> Proposer pays gas & fee
2. Signer 2 Appr  ──> Signer 2 pays gas & fee
3. Signer K Appr  ──> Signer K pays gas & fee
4. Execute Tx     ──> Executor pays invocation gas & cross-contract fees
```

### Key Economic Trade-offs

1. **Per-Signer On-Chain Fees**:
   - Each approval is an independent on-chain transaction.
   - For a 2-of-3 multisig: 1 proposal tx + 1 approval tx + 1 execution tx = 3 transactions.
   - Benefit: Complete on-chain audit trail, timestamped approvals, and individual accountability.
   - Cost: Higher aggregate network fee and gas consumption than a single multi-signature transaction.

2. **Ledger Storage Rent (TTL)**:
   - Pending proposals occupy contract instance storage.
   - Ledger rent fees apply while proposals remain stored.
   - Executed proposals maintain state to prevent replay, but obsolete proposals can be cleaned or archived if needed.

3. **Cross-Contract Execution Overhead**:
   - The `execute` call incurs CPU and memory metering for the multisig contract plus the destination contract call (`contracts/streaming-payments`).

---

## 4. Cross-Chain & Cross-Network Replay Protection

Security against transaction replay is critical across Stellar networks (Public, Testnet, Futurenet, Local):

1. **Network Passphrase Binding**:
   - Every transaction signed by a multisig member is bound to the Stellar network passphrase (e.g., `Public Global Stellar Network ; September 2015` vs `Test SDF Network ; September 2015`).
   - Soroban RPC nodes and validators reject transactions signed with a different network passphrase.

2. **Contract ID Determinism & Isolation**:
   - Soroban contract addresses (`C...`) are derived from the deployer account and deployment salt, hashed with the network ID.
   - A multisig contract deployed on Testnet has a different contract ID than one deployed on Mainnet, preventing cross-network cross-contract confusion.

3. **Sequential Monotonic Nonce**:
   - The reference multisig maintains an incrementing `u64` proposal counter.
   - Each proposal receives a unique proposal ID.
   - Executed proposals are flagged `executed = true` prior to dispatch (Checks-Effects-Interactions), preventing intra-contract replay attacks or reentrancy loops.

---

## 5. Threshold Edge Cases Handled

The reference multisig contract and test suite explicitly enforce:

| Edge Case | Contract Enforcement | Error Code |
| :--- | :--- | :--- |
| **Duplicate Approvals** | A signer cannot approve the same proposal more than once. | `MultisigError::AlreadyApproved` |
| **Revoked Approvals** | A signer can revoke approval; approvals count decreases. | Validated in test suite |
| **Revoked Proposals** | Proposer can cancel proposal before threshold execution. | `MultisigError::ProposalRevoked` |
| **Member Removal Mid-Proposal** | Approvals are re-verified against the active signer set at execution time. Votes from removed signers are invalidated. | `MultisigError::ThresholdNotMet` |
| **Threshold Invariant** | Threshold cannot exceed signer count ($K \le N$) and cannot be zero ($K \ge 1$). | `MultisigError::InvalidThreshold` |
| **Signer Removal Floor** | Cannot remove signers if remaining count would drop below threshold ($N - 1 < K$). | `MultisigError::CannotRemoveBelowThreshold` |

---

## 6. StreamPay Integration Testing Summary

The integration tests in `contracts/multisig/src/integration_test.rs` verify end-to-end flows:

1. **2-of-3 Multisig Stream Creation**:
   - Multisig approves SAC token allowance for StreamPay.
   - Multisig proposes `create_stream` with deposit, start, end, and cancelable flags.
   - Second signer approves; execution successfully creates Stream #1.
2. **Authorization Boundary Validation**:
   - Individual signer attempting to directly call `cancel_stream` on StreamPay is rejected by Soroban host auth (`HostError / unauthorized`).
3. **2-of-3 Multisig Stream Cancellation**:
   - Multisig proposes `cancel_stream` on StreamPay.
   - Second signer approves; execution triggers pro-rata split (accrued tokens to recipient, remaining tokens refunded to multisig sender).
4. **2-of-3 Multisig as Recipient**:
   - Multisig deployed as stream recipient.
   - Time advances; multisig proposes `withdraw_max` on StreamPay.
   - Second signer approves; execution pulls accrued funds to the multisig recipient contract.
