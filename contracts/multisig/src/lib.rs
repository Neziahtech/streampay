#![no_std]

//! # StreamPay K-of-N Multisig Smart Contract
//!
//! A reference on-chain multi-signature wallet engine designed for Soroban smart contracts
//! and continuous payment stream management (e.g. `create_stream`, `top_up`, `cancel_stream`).
//!
//! ## Overview
//!
//! In Soroban, smart contracts have their own first-class cryptographic identities (`Address`).
//! This contract provides an asynchronous, on-chain **Propose / Approve / Execute** workflow:
//!
//! 1. Any registered signer can **propose** an arbitrary contract call (such as a token approval
//!    or stream creation).
//! 2. Other signers **approve** the proposal.
//! 3. Once the active approval count reaches the threshold $K$ ($K \le N$), any signer can
//!    **execute** the proposal.
//! 4. The multisig contract invokes the target contract via `env.invoke_contract(...)`.
//!    During this invocation, the multisig contract itself is the `caller` / `sender`, so
//!    standard `sender.require_auth()` checks in StreamPay pass naturally without requiring
//!    special-case logic inside StreamPay.
//!
//! ## Security & Edge Cases
//!
//! - **Checks-Effects-Interactions (CEI)**: Proposals are marked executed in persistent storage
//!   *before* the cross-contract invocation, eliminating reentrancy vulnerabilities.
//! - **Duplicate Approval Rejection**: Re-approving an already-approved proposal reverts with
//!   [`MultisigError::AlreadyApproved`].
//! - **Revocation**: Signers can revoke their individual approvals, and proposers/members can
//!   revoke an unexecuted proposal.
//! - **Mid-Proposal Member Set Changes**: When a proposal is executed, approvals are validated
//!   against the **current** signer set. If a member who previously approved is removed, their
//!   approval no longer counts toward the threshold.
//! - **Network / Replay Isolation**: All invocations are bound to the specific deployed contract
//!   ID and the active Stellar network passphrase.

pub mod errors;
pub mod events;
pub mod types;

#[cfg(test)]
mod test;

#[cfg(test)]
mod integration_test;

use errors::MultisigError;
use events::{
    ApprovalRevoked, MultisigInitialized, ProposalApproved, ProposalCreated, ProposalExecuted,
    ProposalRevoked, SignerAdded, SignerRemoved, ThresholdChanged,
};
use soroban_sdk::{contract, contractimpl, Address, Env, Symbol, Val, Vec};
use types::{DataKey, Proposal, ProposalView};

#[contract]
pub struct MultisigContract;

#[contractimpl]
impl MultisigContract {
    /// Initializes the multisig instance with an initial K-of-N signer set and threshold.
    /// Constructor runs at deployment time.
    pub fn __constructor(env: Env, signers: Vec<Address>, threshold: u32) {
        Self::internal_init(&env, signers, threshold).unwrap();
    }

    /// Initializes the multisig contract if not set via constructor.
    pub fn init(env: Env, signers: Vec<Address>, threshold: u32) -> Result<(), MultisigError> {
        if env.storage().instance().has(&DataKey::Signers) {
            return Err(MultisigError::AlreadyInitialized);
        }
        Self::internal_init(&env, signers, threshold)
    }

    /// Internal validation and initialization logic.
    fn internal_init(env: &Env, signers: Vec<Address>, threshold: u32) -> Result<(), MultisigError> {
        let count = signers.len();
        if count == 0 {
            return Err(MultisigError::EmptySigners);
        }
        if threshold == 0 || threshold > count {
            return Err(MultisigError::InvalidThreshold);
        }

        // Validate uniqueness: no duplicate signers allowed
        for i in 0..count {
            let s1 = signers.get(i).unwrap();
            for j in (i + 1)..count {
                let s2 = signers.get(j).unwrap();
                if s1 == s2 {
                    return Err(MultisigError::DuplicateSigner);
                }
            }
        }

        env.storage().instance().set(&DataKey::Signers, &signers);
        env.storage().instance().set(&DataKey::Threshold, &threshold);
        env.storage().instance().set(&DataKey::NextProposalId, &1u64);

        MultisigInitialized { signers, threshold }.publish(env);
        Ok(())
    }

    /// Creates a new proposal to invoke `target.function(args)`.
    ///
    /// Requires authentication from the proposer, who must be a current signer.
    /// The proposer automatically casts their approval for the newly created proposal.
    pub fn propose(
        env: Env,
        proposer: Address,
        target: Address,
        function: Symbol,
        args: Vec<Val>,
    ) -> Result<u64, MultisigError> {
        Self::require_initialized(&env)?;
        proposer.require_auth();

        if !Self::is_signer_internal(&env, &proposer) {
            return Err(MultisigError::NotSigner);
        }

        let next_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextProposalId)
            .unwrap_or(1);
        let proposal_id = next_id;
        env.storage()
            .instance()
            .set(&DataKey::NextProposalId, &(next_id + 1));

        let proposal = Proposal {
            id: proposal_id,
            proposer: proposer.clone(),
            target: target.clone(),
            function: function.clone(),
            args,
            executed: false,
            revoked: false,
        };

        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        // Proposer automatically approves their own proposal
        let mut approvals = Vec::new(&env);
        approvals.push_back(proposer.clone());
        env.storage()
            .instance()
            .set(&DataKey::Approvals(proposal_id), &approvals);

        ProposalCreated {
            proposal_id,
            proposer: proposer.clone(),
            target,
            function,
        }
        .publish(&env);

        ProposalApproved {
            proposal_id,
            signer: proposer,
        }
        .publish(&env);

        Ok(proposal_id)
    }

    /// Approves an existing, active proposal.
    ///
    /// Requires authentication from `signer`, who must be an active signer.
    /// Duplicate approvals revert with [`MultisigError::AlreadyApproved`].
    pub fn approve(env: Env, signer: Address, proposal_id: u64) -> Result<(), MultisigError> {
        Self::require_initialized(&env)?;
        signer.require_auth();

        if !Self::is_signer_internal(&env, &signer) {
            return Err(MultisigError::NotSigner);
        }

        let mut proposal = Self::get_proposal_internal(&env, proposal_id)?;
        if proposal.executed {
            return Err(MultisigError::ProposalAlreadyExecuted);
        }
        if proposal.revoked {
            return Err(MultisigError::ProposalRevoked);
        }

        let mut approvals: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Approvals(proposal_id))
            .unwrap_or_else(|| Vec::new(&env));

        for addr in approvals.iter() {
            if addr == signer {
                return Err(MultisigError::AlreadyApproved);
            }
        }

        approvals.push_back(signer.clone());
        env.storage()
            .instance()
            .set(&DataKey::Approvals(proposal_id), &approvals);

        // Touch proposal to refresh persistent footprint if needed
        proposal.id = proposal_id;
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        ProposalApproved { proposal_id, signer }.publish(&env);
        Ok(())
    }

    /// Revokes a previously granted approval from `signer`.
    pub fn revoke_approval(
        env: Env,
        signer: Address,
        proposal_id: u64,
    ) -> Result<(), MultisigError> {
        Self::require_initialized(&env)?;
        signer.require_auth();

        if !Self::is_signer_internal(&env, &signer) {
            return Err(MultisigError::NotSigner);
        }

        let proposal = Self::get_proposal_internal(&env, proposal_id)?;
        if proposal.executed {
            return Err(MultisigError::ProposalAlreadyExecuted);
        }
        if proposal.revoked {
            return Err(MultisigError::ProposalRevoked);
        }

        let approvals: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Approvals(proposal_id))
            .unwrap_or_else(|| Vec::new(&env));

        let mut new_approvals = Vec::new(&env);
        let mut found = false;

        for addr in approvals.iter() {
            if addr == signer {
                found = true;
            } else {
                new_approvals.push_back(addr);
            }
        }

        if !found {
            return Err(MultisigError::NotApproved);
        }

        env.storage()
            .instance()
            .set(&DataKey::Approvals(proposal_id), &new_approvals);

        ApprovalRevoked { proposal_id, signer }.publish(&env);
        Ok(())
    }

    /// Revokes/cancels an entire proposal.
    ///
    /// Can be called by the original proposer or any active multisig signer.
    pub fn revoke_proposal(
        env: Env,
        caller: Address,
        proposal_id: u64,
    ) -> Result<(), MultisigError> {
        Self::require_initialized(&env)?;
        caller.require_auth();

        let mut proposal = Self::get_proposal_internal(&env, proposal_id)?;
        if proposal.executed {
            return Err(MultisigError::ProposalAlreadyExecuted);
        }
        if proposal.revoked {
            return Err(MultisigError::ProposalRevoked);
        }

        if caller != proposal.proposer && !Self::is_signer_internal(&env, &caller) {
            return Err(MultisigError::Unauthorized);
        }

        proposal.revoked = true;
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        ProposalRevoked {
            proposal_id,
            caller,
        }
        .publish(&env);

        Ok(())
    }

    /// Executes an approved proposal once the threshold is satisfied.
    ///
    /// Follows Checks-Effects-Interactions: the proposal is marked executed
    /// prior to executing the external contract call.
    ///
    /// Edge case defense: Approvals are validated against the **currently active**
    /// signer set, preventing revoked or removed signers from counting toward the threshold.
    pub fn execute(env: Env, executor: Address, proposal_id: u64) -> Result<Val, MultisigError> {
        Self::require_initialized(&env)?;
        executor.require_auth();

        if !Self::is_signer_internal(&env, &executor) {
            return Err(MultisigError::NotSigner);
        }

        let mut proposal = Self::get_proposal_internal(&env, proposal_id)?;
        if proposal.executed {
            return Err(MultisigError::ProposalAlreadyExecuted);
        }
        if proposal.revoked {
            return Err(MultisigError::ProposalRevoked);
        }

        let current_signers: Vec<Address> = env.storage().instance().get(&DataKey::Signers).unwrap();
        let current_threshold: u32 = env.storage().instance().get(&DataKey::Threshold).unwrap();
        let approvals: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Approvals(proposal_id))
            .unwrap_or_else(|| Vec::new(&env));

        // Count only approvals from currently active signers
        let mut valid_approval_count: u32 = 0;
        for addr in approvals.iter() {
            for s in current_signers.iter() {
                if addr == s {
                    valid_approval_count += 1;
                    break;
                }
            }
        }

        if valid_approval_count < current_threshold {
            return Err(MultisigError::ThresholdNotMet);
        }

        // CEI: Mark executed before calling out to external contract
        proposal.executed = true;
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        ProposalExecuted {
            proposal_id,
            executor,
        }
        .publish(&env);

        // Perform cross-contract invocation as this contract
        let result = env.invoke_contract(&proposal.target, &proposal.function, proposal.args);
        Ok(result)
    }

    // -----------------------------------------------------------------------
    // Governance / Signer Management (Callable by the multisig contract itself)
    // -----------------------------------------------------------------------

    /// Adds a new signer to the multisig.
    /// Must be executed by the multisig contract itself through a proposal.
    pub fn add_signer(env: Env, new_signer: Address) -> Result<(), MultisigError> {
        Self::require_self_auth(&env)?;

        let mut signers: Vec<Address> = env.storage().instance().get(&DataKey::Signers).unwrap();
        for s in signers.iter() {
            if s == new_signer {
                return Err(MultisigError::SignerAlreadyExists);
            }
        }

        signers.push_back(new_signer.clone());
        env.storage().instance().set(&DataKey::Signers, &signers);

        SignerAdded { new_signer }.publish(&env);
        Ok(())
    }

    /// Removes a signer and optionally updates the threshold.
    /// Must be executed by the multisig contract itself through a proposal.
    pub fn remove_signer(
        env: Env,
        old_signer: Address,
        new_threshold: Option<u32>,
    ) -> Result<(), MultisigError> {
        Self::require_self_auth(&env)?;

        let signers: Vec<Address> = env.storage().instance().get(&DataKey::Signers).unwrap();
        let current_threshold: u32 = env.storage().instance().get(&DataKey::Threshold).unwrap();

        let mut new_signers = Vec::new(&env);
        let mut found = false;

        for s in signers.iter() {
            if s == old_signer {
                found = true;
            } else {
                new_signers.push_back(s);
            }
        }

        if !found {
            return Err(MultisigError::SignerNotFound);
        }
        if new_signers.len() == 0 {
            return Err(MultisigError::EmptySigners);
        }

        let target_threshold = new_threshold.unwrap_or(current_threshold);
        if target_threshold == 0 || target_threshold > new_signers.len() {
            return Err(MultisigError::CannotRemoveBelowThreshold);
        }

        env.storage().instance().set(&DataKey::Signers, &new_signers);
        env.storage()
            .instance()
            .set(&DataKey::Threshold, &target_threshold);

        SignerRemoved {
            removed_signer: old_signer,
            new_threshold: target_threshold,
        }
        .publish(&env);

        Ok(())
    }

    /// Modifies the signature threshold.
    /// Must be executed by the multisig contract itself through a proposal.
    pub fn set_threshold(env: Env, new_threshold: u32) -> Result<(), MultisigError> {
        Self::require_self_auth(&env)?;

        let signers: Vec<Address> = env.storage().instance().get(&DataKey::Signers).unwrap();
        if new_threshold == 0 || new_threshold > signers.len() {
            return Err(MultisigError::InvalidThreshold);
        }

        let old_threshold: u32 = env.storage().instance().get(&DataKey::Threshold).unwrap();
        env.storage()
            .instance()
            .set(&DataKey::Threshold, &new_threshold);

        ThresholdChanged {
            old_threshold,
            new_threshold,
        }
        .publish(&env);

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Inspection & Query Entrypoints
    // -----------------------------------------------------------------------

    /// Identifies this contract as a standard StreamPay-compatible multisig contract.
    pub fn is_multisig(_env: Env) -> bool {
        true
    }

    /// Returns the current active signer set.
    pub fn get_signers(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Returns the current signature threshold K.
    pub fn get_threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or(0)
    }

    /// Checks if a given address is an active signer.
    pub fn is_signer(env: Env, address: Address) -> bool {
        Self::is_signer_internal(&env, &address)
    }

    /// Reads raw proposal state by ID.
    pub fn get_proposal(env: Env, proposal_id: u64) -> Result<Proposal, MultisigError> {
        Self::get_proposal_internal(&env, proposal_id)
    }

    /// Returns a structured, client-friendly view of proposal status.
    pub fn get_proposal_view(env: Env, proposal_id: u64) -> Result<ProposalView, MultisigError> {
        let proposal = Self::get_proposal_internal(&env, proposal_id)?;
        let current_signers = Self::get_signers(env.clone());
        let threshold = Self::get_threshold(env.clone());
        let approvals = Self::get_approvals(env.clone(), proposal_id);

        let mut valid_count: u32 = 0;
        for a in approvals.iter() {
            for s in current_signers.iter() {
                if a == s {
                    valid_count += 1;
                    break;
                }
            }
        }

        let is_executable = !proposal.executed && !proposal.revoked && valid_count >= threshold;

        Ok(ProposalView {
            id: proposal.id,
            proposer: proposal.proposer,
            target: proposal.target,
            function: proposal.function,
            executed: proposal.executed,
            revoked: proposal.revoked,
            approval_count: valid_count,
            threshold,
            is_executable,
        })
    }

    /// Returns the list of addresses that approved this proposal.
    pub fn get_approvals(env: Env, proposal_id: u64) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Approvals(proposal_id))
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Returns the total count of proposals created to date.
    pub fn proposal_count(env: Env) -> u64 {
        let next_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextProposalId)
            .unwrap_or(1);
        next_id.saturating_sub(1)
    }

    // -----------------------------------------------------------------------
    // Internal Helper Functions
    // -----------------------------------------------------------------------

    fn require_initialized(env: &Env) -> Result<(), MultisigError> {
        if !env.storage().instance().has(&DataKey::Signers) {
            return Err(MultisigError::NotInitialized);
        }
        Ok(())
    }

    fn require_self_auth(env: &Env) -> Result<(), MultisigError> {
        env.current_contract_address().require_auth();
        Ok(())
    }

    fn is_signer_internal(env: &Env, address: &Address) -> bool {
        if let Some(signers) = env.storage().instance().get::<_, Vec<Address>>(&DataKey::Signers) {
            for s in signers.iter() {
                if &s == address {
                    return true;
                }
            }
        }
        false
    }

    fn get_proposal_internal(env: &Env, proposal_id: u64) -> Result<Proposal, MultisigError> {
        env.storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(MultisigError::ProposalNotFound)
    }
}
