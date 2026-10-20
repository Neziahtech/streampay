# Multi-Signature (Multisig) Sender & Recipient Architecture

This document evaluates, specifies, and documents the multi-signature (K-of-N) architecture for StreamPay on Stellar Soroban, delivering a reference multisig implementation (`contracts/multisig`), stream lifecycle integration, fee analysis, and security considerations.

---

## 1. Architectural Evaluation: Reusable Multisig Contract vs. Bring-Your-Own

When enabling multi-signature streams, two primary approaches exist:

### Approach A: Dedicated Smart Contract Multisig Module (Implemented)
A deployed Soroban smart contract (`contracts/multisig`) with its own contract `Address` acts as the sender or recipient of streams. Signers interact asynchronously on-chain via a propose-approve-execute lifecycle.

* **Advantages**:
  - **Asynchronous coordination**: Signers do not need to assemble an off-chain multi-signature transaction envelope simultaneously or run a trusted coordination relayer.
  - **Granular role policies**: Can configure a standard `K-of-N` threshold for spending/creating streams while enabling a lower `cancel_threshold` (e.g., `1-of-N`) for emergency cancellation.
  - **Auditability**: Complete on-chain history of proposals, approvals, revokes, and executions.
  - **Zero streaming contract coupling**: The core `StreamingPayments` contract requires **no custom multisig logic or special casing**. The multisig contract simply passes `env.current_contract_address()` as the sender or recipient and satisfies standard Soroban `require_auth()` checks.

### Approach B: Account Abstraction (`CustomAccountInterface` / `__check_auth`) or Native Stellar Multisig
Users bring their own smart account or multi-sign Stellar account (`G...`). A single transaction carrying aggregated signatures is submitted to the network.

* **Advantages**:
  - Lower total transaction fee on the ledger (one transaction vs. multiple proposal transactions).
  - Native integration with wallets that support off-chain signature collection.

### Conclusion & Design Choice
StreamPay supports **both models transparently**:
1. Users with native Stellar multisig accounts or external smart wallets can use them directly—the contract natively enforces `sender.require_auth()`.
2. For organizations requiring on-chain governance, asynchronous signing, and emergency risk controls without third-party relayer infrastructure, StreamPay provides the **reference `contracts/multisig` implementation**.
3. The frontend (`StreamForm.tsx`) automatically detects whether a provided address is a Stellar multisig account or a Soroban multisig contract and displays the appropriate threshold and signer requirements.

---

## 2. Reference Implementation Architecture (`contracts/multisig`)

The reference multisig contract (`streampay-multisig`) implements an on-chain K-of-N governance state machine with the following components:

### State Machine Lifecycle
```text
                  +---------------------------+
                  |  Proposal Created (s1)    |
                  |  (Auto-approved by s1)    |
                  +-------------+-------------+
                                |
                 [approve()]    |    [revoke_approval()]
                 +--------------+--------------+
                 |                             |
                 v                             v
     +-----------------------+     +-----------------------+
     |   Signer s2 Approves  |     |   Signer s2 Revokes   |
     +-----------+-----------+     +-----------------------+
                 |
                 | (Valid Active Approvals >= Threshold)
                 v
     +-----------------------+
     |  execute() Triggered  |
     |  Atomic Action Ran    |
     +-----------+-----------+
                 |
                 v
     +-----------------------+
     |   Proposal Executed   |
     +-----------------------+
```

### Supported Actions (`MultisigAction`)
- `CreateStream`: Pre-authorizes and sets SAC allowance (`approve`), then invokes `StreamingPayments::create_stream`.
- `TopUp`: Pre-authorizes and sets SAC allowance, then invokes `StreamingPayments::top_up`.
- `CancelStream`: Invokes `StreamingPayments::cancel_stream`.
- `Withdraw`: When multisig is recipient, claims accrued tokens from an active stream via `StreamingPayments::withdraw`.
- `TransferToken`: Transfers tokens owned by the multisig contract to an external address.
- `AddSigner` / `RemoveSigner`: Updates the active signer set.
- `SetThreshold`: Updates the execution threshold.
- `SetCancelThreshold`: Updates the emergency cancellation threshold.

### Emergency Cancellation Path
Streaming payments carry continuous financial risk if an unauthorized recipient, compromised rate, or faulty parameter is detected. Waiting for a multi-signature threshold can lead to severe capital leakage.

To address this, `contracts/multisig` implements `cancel_stream_immediate(env, signer, contract, stream_id)`:
- If `cancel_threshold <= 1`, **any single authorized signer** can immediately cancel an active stream without waiting for a proposal to gather approvals.
- Halts accrual immediately, refunds unstreamed balance to the multisig contract, and pays only what has accrued up to that ledger timestamp.

---

## 3. Threshold Edge Cases & Defensive Invariants

### 1. Mid-Proposal Member-Set Changes
* **Threat**: Proposal A is created and approved by Signer 1 and Signer 2. Before execution, Signer 2 is removed from the multisig (or turns rogue). If approvals are merely counted by historical array length, an unauthorized execution could occur.
* **Defense**: In `execute()`, the contract recalculates valid approvals by intersecting recorded approval addresses against the **currently active `signers` list**:
  ```rust
  let valid_count = approvals.iter().filter(|a| current_signers.contains(a)).count();
  if valid_count < threshold {
      return Err(MultisigError::ThresholdNotMet);
  }
  ```
  If a signer was removed, their approval ceases to count toward the threshold.

### 2. Duplicate Approvals & Replay Prevention
* Approving a proposal twice by the same signer is strictly rejected with `MultisigError::AlreadyApproved`.
* Executing an executed proposal is rejected with `MultisigError::ProposalAlreadyExecuted`.
* Revoking a revoked or executed proposal is rejected.

### 3. Signer Removal Floor
* Signer removal requires `signers.len() - 1 >= threshold`. A multisig can never accidentally or maliciously remove signers such that the active set size falls below the required threshold, preventing bricked contracts.

---

## 4. Fee Implications: On-Chain Multisig vs. Account-Level Signatures

| Dimension | On-Chain Reference Multisig (`contracts/multisig`) | Account-Level Multisig (Stellar native / CustomAccount) |
| :--- | :--- | :--- |
| **Transaction Count** | $1 \text{ (propose)} + (K - 1) \text{ (approvals)} + 1 \text{ (execute)}$ | $1 \text{ transaction}$ |
| **Base Ledger Fees** | $(K + 1) \times \text{base\_fee}$ (e.g. $3 \times 100 \text{ stroops} = 300 \text{ stroops}$) | $1 \times \text{base\_fee}$ |
| **Coordination Model** | **Asynchronous**: Signers submit transactions independently whenever online. | **Synchronous / Relayed**: Signatures must be collected off-chain before submission. |
| **CPU / Footprint** | Distributed across multiple small transactions. | Single transaction verifies all signatures (higher compute limit). |
| **Emergency Halting** | Single-signer emergency execution supported ($1 \text{ tx}$). | Requires $K$ signatures unless custom account policy permits. |

---

## 5. Security Notes & Cross-Chain / Cross-Network Replay Protection

1. **Network Passphrase Binding**:
   - All Soroban transactions and authorizations are cryptographically bound to the network passphrase (`Test SDF Network ; September 2015` vs `Public Global Stellar Network ; September 2015`).
   - A signature or authorization produced on Testnet can **never** be replayed on Mainnet or any private network.

2. **Contract ID Isolation**:
   - Contract addresses are derived from the deployer account and cryptographic salt. Even with identical WASM bytecode, contract IDs differ across networks.
   - Authorizations generated via `authorize_as_current_contract` explicitly bind the exact target contract ID and function symbol.

3. **Monotonic Proposal Nonces**:
   - Proposal IDs are monotonically incremented (`u64`) and stored under persistent instance keys. Replay of past proposals within the contract is impossible.

---

## 6. Frontend Detection & UX Workflow

`frontend/lib/multisig.ts` and `frontend/components/StreamForm.tsx` provide automatic detection:

1. **Contract Address (`C...`)**:
   - The frontend simulates `get_threshold()`, `get_signers()`, and `get_cancel_threshold()` on the recipient address.
   - If recognized as a multisig contract, an informative banner alerts the user:
     - Displays required threshold ($K$-of-$N$).
     - Outlines that withdrawals/cancellations require multi-signature proposal execution.
     - Displays the emergency cancel threshold if enabled.
2. **Stellar Account (`G...`)**:
   - Queries Horizon `/accounts/{address}` to detect multi-signers and medium threshold weight.
   - Alerts the creator of the multi-sign requirements.
