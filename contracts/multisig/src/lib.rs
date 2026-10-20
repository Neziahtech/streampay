#![no_std]
#![allow(clippy::too_many_arguments)]

pub mod errors;
pub mod events;
pub mod types;

#[cfg(test)]
mod test;

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contractimpl, symbol_short,
    token::Client as TokenClient,
    Address, Env, IntoVal, Vec,
};

pub use errors::MultisigError;
pub use events::*;
pub use types::*;

const TTL_THRESHOLD_LEDGERS: u32 = 100_000;
const TTL_EXTEND_LEDGERS: u32 = 200_000;

#[contractclient(name = "StreamingClient")]
pub trait StreamingContract {
    fn create_stream(
        env: Env,
        sender: Address,
        recipient: Address,
        token: Address,
        deposit: i128,
        start_time: u64,
        end_time: u64,
        cancellable: bool,
    ) -> u64;

    fn top_up(env: Env, stream_id: u64, amount: i128);

    fn cancel_stream(env: Env, caller: Address, stream_id: u64);

    fn withdraw(env: Env, stream_id: u64, amount: i128);
}

#[contract]
pub struct MultisigContract;

#[contractimpl]
impl MultisigContract {
    /// Initializes the multisig contract with a signer set and execution thresholds.
    pub fn initialize(
        env: Env,
        signers: Vec<Address>,
        threshold: u32,
        cancel_threshold: u32,
    ) -> Result<(), MultisigError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(MultisigError::AlreadyInitialized);
        }

        let n = signers.len();
        if n == 0 {
            return Err(MultisigError::InvalidSigners);
        }
        if threshold == 0 || threshold > n {
            return Err(MultisigError::InvalidThreshold);
        }
        if cancel_threshold == 0 || cancel_threshold > n {
            return Err(MultisigError::InvalidCancelThreshold);
        }

        // Verify uniqueness of signers
        for i in 0..n {
            let s1 = signers.get(i).unwrap();
            for j in (i + 1)..n {
                let s2 = signers.get(j).unwrap();
                if s1 == s2 {
                    return Err(MultisigError::DuplicateSigner);
                }
            }
        }

        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().set(&DataKey::Signers, &signers);
        env.storage()
            .instance()
            .set(&DataKey::Threshold, &threshold);
        env.storage()
            .instance()
            .set(&DataKey::CancelThreshold, &cancel_threshold);
        env.storage().instance().set(&DataKey::ProposalCount, &0u64);

        MultisigInitialized {
            signers,
            threshold,
            cancel_threshold,
        }
        .publish(&env);

        Ok(())
    }

    /// Proposes a new action. Automatically approves the proposal on behalf of the proposer.
    pub fn propose(
        env: Env,
        proposer: Address,
        action: MultisigAction,
    ) -> Result<u64, MultisigError> {
        Self::require_initialized(&env)?;
        proposer.require_auth();
        if !Self::is_signer(env.clone(), proposer.clone()) {
            return Err(MultisigError::NotSigner);
        }

        Self::validate_action(&action)?;

        let mut count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0);
        count = count.checked_add(1).ok_or(MultisigError::ExecutionFailed)?;
        env.storage()
            .instance()
            .set(&DataKey::ProposalCount, &count);

        let proposal = Proposal {
            id: count,
            proposer: proposer.clone(),
            action,
            status: ProposalStatus::Pending,
            created_at: env.ledger().timestamp(),
        };

        let prop_key = DataKey::Proposal(count);
        env.storage().persistent().set(&prop_key, &proposal);
        env.storage()
            .persistent()
            .extend_ttl(&prop_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

        // Proposer automatically approves the proposal
        let mut approvals = Vec::new(&env);
        approvals.push_back(proposer.clone());
        let app_key = DataKey::ProposalApprovals(count);
        env.storage().persistent().set(&app_key, &approvals);
        env.storage()
            .persistent()
            .extend_ttl(&app_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

        ProposalCreated {
            proposal_id: count,
            proposer: proposer.clone(),
        }
        .publish(&env);

        ProposalApproved {
            proposal_id: count,
            signer: proposer,
        }
        .publish(&env);

        Ok(count)
    }

    /// Casts an approval for a pending proposal.
    pub fn approve(env: Env, signer: Address, proposal_id: u64) -> Result<(), MultisigError> {
        Self::require_initialized(&env)?;
        signer.require_auth();
        if !Self::is_signer(env.clone(), signer.clone()) {
            return Err(MultisigError::NotSigner);
        }

        let prop_key = DataKey::Proposal(proposal_id);
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&prop_key)
            .ok_or(MultisigError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Pending {
            return Err(MultisigError::ProposalAlreadyExecuted);
        }

        let app_key = DataKey::ProposalApprovals(proposal_id);
        let mut approvals: Vec<Address> = env
            .storage()
            .persistent()
            .get(&app_key)
            .unwrap_or_else(|| Vec::new(&env));

        for i in 0..approvals.len() {
            if approvals.get(i).unwrap() == signer {
                return Err(MultisigError::AlreadyApproved);
            }
        }

        approvals.push_back(signer.clone());
        env.storage().persistent().set(&app_key, &approvals);
        env.storage()
            .persistent()
            .extend_ttl(&app_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

        ProposalApproved {
            proposal_id,
            signer,
        }
        .publish(&env);

        Ok(())
    }

    /// Revokes a previous approval for a pending proposal.
    pub fn revoke_approval(
        env: Env,
        signer: Address,
        proposal_id: u64,
    ) -> Result<(), MultisigError> {
        Self::require_initialized(&env)?;
        signer.require_auth();

        let prop_key = DataKey::Proposal(proposal_id);
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&prop_key)
            .ok_or(MultisigError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Pending {
            return Err(MultisigError::ProposalAlreadyExecuted);
        }

        let app_key = DataKey::ProposalApprovals(proposal_id);
        let approvals: Vec<Address> = env
            .storage()
            .persistent()
            .get(&app_key)
            .ok_or(MultisigError::NotApproved)?;

        let mut found = false;
        let mut new_approvals = Vec::new(&env);
        for i in 0..approvals.len() {
            let a = approvals.get(i).unwrap();
            if a == signer {
                found = true;
            } else {
                new_approvals.push_back(a);
            }
        }

        if !found {
            return Err(MultisigError::NotApproved);
        }

        env.storage().persistent().set(&app_key, &new_approvals);
        env.storage()
            .persistent()
            .extend_ttl(&app_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

        ApprovalRevoked {
            proposal_id,
            signer,
        }
        .publish(&env);

        Ok(())
    }

    /// Revokes a proposal. Can be called by the proposer.
    pub fn revoke_proposal(
        env: Env,
        caller: Address,
        proposal_id: u64,
    ) -> Result<(), MultisigError> {
        Self::require_initialized(&env)?;
        caller.require_auth();
        if !Self::is_signer(env.clone(), caller.clone()) {
            return Err(MultisigError::NotSigner);
        }

        let prop_key = DataKey::Proposal(proposal_id);
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&prop_key)
            .ok_or(MultisigError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Pending {
            return Err(MultisigError::ProposalAlreadyExecuted);
        }

        if proposal.proposer != caller {
            return Err(MultisigError::Unauthorized);
        }

        proposal.status = ProposalStatus::Revoked;
        env.storage().persistent().set(&prop_key, &proposal);
        env.storage()
            .persistent()
            .extend_ttl(&prop_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

        ProposalRevoked {
            proposal_id,
            caller,
        }
        .publish(&env);

        Ok(())
    }

    /// Executes a pending proposal if valid threshold of active signers is met.
    pub fn execute(env: Env, executor: Address, proposal_id: u64) -> Result<(), MultisigError> {
        Self::require_initialized(&env)?;
        executor.require_auth();
        if !Self::is_signer(env.clone(), executor.clone()) {
            return Err(MultisigError::NotSigner);
        }

        let prop_key = DataKey::Proposal(proposal_id);
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&prop_key)
            .ok_or(MultisigError::ProposalNotFound)?;

        if proposal.status == ProposalStatus::Executed {
            return Err(MultisigError::ProposalAlreadyExecuted);
        }
        if proposal.status == ProposalStatus::Revoked {
            return Err(MultisigError::ProposalRevoked);
        }

        let current_signers: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap_or_else(|| Vec::new(&env));
        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or(1);

        let app_key = DataKey::ProposalApprovals(proposal_id);
        let approvals: Vec<Address> = env
            .storage()
            .persistent()
            .get(&app_key)
            .unwrap_or_else(|| Vec::new(&env));

        // Member-set change protection: count only approvals from CURRENT active signers
        let mut valid_count: u32 = 0;
        for i in 0..approvals.len() {
            let app = approvals.get(i).unwrap();
            let mut is_active = false;
            for j in 0..current_signers.len() {
                if current_signers.get(j).unwrap() == app {
                    is_active = true;
                    break;
                }
            }
            if is_active {
                valid_count += 1;
            }
        }

        if valid_count < threshold {
            return Err(MultisigError::ThresholdNotMet);
        }

        proposal.status = ProposalStatus::Executed;
        env.storage().persistent().set(&prop_key, &proposal);
        env.storage()
            .persistent()
            .extend_ttl(&prop_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

        Self::dispatch_action(&env, &proposal.action)?;

        ProposalExecuted {
            proposal_id,
            executor,
        }
        .publish(&env);

        Ok(())
    }

    /// Immediate emergency cancel: any authorized signer can cancel an active stream if cancel_threshold <= 1.
    pub fn cancel_stream_immediate(
        env: Env,
        signer: Address,
        contract: Address,
        stream_id: u64,
    ) -> Result<(), MultisigError> {
        Self::require_initialized(&env)?;
        signer.require_auth();
        if !Self::is_signer(env.clone(), signer.clone()) {
            return Err(MultisigError::NotSigner);
        }

        let cancel_threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::CancelThreshold)
            .unwrap_or(1);
        if cancel_threshold > 1 {
            return Err(MultisigError::CancelThresholdNotMet);
        }

        let client = StreamingClient::new(&env, &contract);
        let current_addr = env.current_contract_address();
        client.cancel_stream(&current_addr, &stream_id);

        StreamCancelledImmediate {
            signer,
            contract,
            stream_id,
        }
        .publish(&env);

        Ok(())
    }

    // ---------------------------------------------------------------- views --

    pub fn get_signers(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn is_signer(env: Env, address: Address) -> bool {
        let signers: Vec<Address> = Self::get_signers(env);
        for i in 0..signers.len() {
            if signers.get(i).unwrap() == address {
                return true;
            }
        }
        false
    }

    pub fn get_threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or(0)
    }

    pub fn get_cancel_threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::CancelThreshold)
            .unwrap_or(0)
    }

    pub fn get_proposal(env: Env, proposal_id: u64) -> Option<Proposal> {
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
    }

    pub fn get_approvals(env: Env, proposal_id: u64) -> Vec<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::ProposalApprovals(proposal_id))
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn get_proposal_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0)
    }

    // -------------------------------------------------------------- helpers --

    fn require_initialized(env: &Env) -> Result<(), MultisigError> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(MultisigError::NotInitialized);
        }
        Ok(())
    }

    fn validate_action(action: &MultisigAction) -> Result<(), MultisigError> {
        match action {
            MultisigAction::CreateStream(args)
                if args.deposit <= 0 || args.end_time <= args.start_time =>
            {
                Err(MultisigError::InvalidAmount)
            }
            MultisigAction::TopUp(args) if args.amount <= 0 => Err(MultisigError::InvalidAmount),
            MultisigAction::Withdraw(args) if args.amount <= 0 => Err(MultisigError::InvalidAmount),
            MultisigAction::TransferToken(args) if args.amount <= 0 => {
                Err(MultisigError::InvalidAmount)
            }
            MultisigAction::SetThreshold(args) if args.new_threshold == 0 => {
                Err(MultisigError::InvalidThreshold)
            }
            MultisigAction::SetCancelThreshold(args) if args.new_threshold == 0 => {
                Err(MultisigError::InvalidCancelThreshold)
            }
            _ => Ok(()),
        }
    }

    fn dispatch_action(env: &Env, action: &MultisigAction) -> Result<(), MultisigError> {
        let current_addr = env.current_contract_address();
        match action {
            MultisigAction::CreateStream(args) => {
                // Authorize and set allowance for stream contract to pull deposit via transfer_from
                let current_ledger = env.ledger().sequence();
                let live_until_ledger = current_ledger + 100_000;
                let auth_entry = InvokerContractAuthEntry::Contract(SubContractInvocation {
                    context: ContractContext {
                        contract: args.token.clone(),
                        fn_name: symbol_short!("approve"),
                        args: (
                            current_addr.clone(),
                            args.contract.clone(),
                            args.deposit,
                            live_until_ledger,
                        )
                            .into_val(env),
                    },
                    sub_invocations: Vec::new(env),
                });
                env.authorize_as_current_contract(soroban_sdk::vec![env, auth_entry]);

                let token_client = TokenClient::new(env, &args.token);
                token_client.approve(
                    &current_addr,
                    &args.contract,
                    &args.deposit,
                    &live_until_ledger,
                );

                let client = StreamingClient::new(env, &args.contract);
                client.create_stream(
                    &current_addr,
                    &args.recipient,
                    &args.token,
                    &args.deposit,
                    &args.start_time,
                    &args.end_time,
                    &args.cancellable,
                );
            }
            MultisigAction::TopUp(args) => {
                // Authorize and set allowance for top_up
                let current_ledger = env.ledger().sequence();
                let live_until_ledger = current_ledger + 100_000;
                let auth_entry = InvokerContractAuthEntry::Contract(SubContractInvocation {
                    context: ContractContext {
                        contract: args.token.clone(),
                        fn_name: symbol_short!("approve"),
                        args: (
                            current_addr.clone(),
                            args.contract.clone(),
                            args.amount,
                            live_until_ledger,
                        )
                            .into_val(env),
                    },
                    sub_invocations: Vec::new(env),
                });
                env.authorize_as_current_contract(soroban_sdk::vec![env, auth_entry]);

                let token_client = TokenClient::new(env, &args.token);
                token_client.approve(
                    &current_addr,
                    &args.contract,
                    &args.amount,
                    &live_until_ledger,
                );

                let client = StreamingClient::new(env, &args.contract);
                client.top_up(&args.stream_id, &args.amount);
            }
            MultisigAction::CancelStream(args) => {
                let client = StreamingClient::new(env, &args.contract);
                client.cancel_stream(&current_addr, &args.stream_id);
            }
            MultisigAction::Withdraw(args) => {
                let client = StreamingClient::new(env, &args.contract);
                client.withdraw(&args.stream_id, &args.amount);
            }
            MultisigAction::TransferToken(args) => {
                let token_client = TokenClient::new(env, &args.token);
                token_client.transfer(&current_addr, &args.to, &args.amount);
            }
            MultisigAction::AddSigner(args) => {
                let mut signers: Vec<Address> = env
                    .storage()
                    .instance()
                    .get(&DataKey::Signers)
                    .unwrap_or_else(|| Vec::new(env));
                for i in 0..signers.len() {
                    if signers.get(i).unwrap() == args.signer {
                        return Err(MultisigError::SignerAlreadyExists);
                    }
                }
                signers.push_back(args.signer.clone());
                env.storage().instance().set(&DataKey::Signers, &signers);
                SignerAdded {
                    signer: args.signer.clone(),
                }
                .publish(env);
            }
            MultisigAction::RemoveSigner(args) => {
                let signers: Vec<Address> = env
                    .storage()
                    .instance()
                    .get(&DataKey::Signers)
                    .unwrap_or_else(|| Vec::new(env));
                let threshold: u32 = env
                    .storage()
                    .instance()
                    .get(&DataKey::Threshold)
                    .unwrap_or(1);

                if signers.len() <= 1 || (signers.len() - 1) < threshold {
                    return Err(MultisigError::CannotRemoveBelowThreshold);
                }

                let mut found = false;
                let mut new_signers = Vec::new(env);
                for i in 0..signers.len() {
                    let s = signers.get(i).unwrap();
                    if s == args.signer {
                        found = true;
                    } else {
                        new_signers.push_back(s);
                    }
                }
                if !found {
                    return Err(MultisigError::SignerNotFound);
                }
                env.storage()
                    .instance()
                    .set(&DataKey::Signers, &new_signers);
                SignerRemoved {
                    signer: args.signer.clone(),
                }
                .publish(env);
            }
            MultisigAction::SetThreshold(args) => {
                let signers: Vec<Address> = env
                    .storage()
                    .instance()
                    .get(&DataKey::Signers)
                    .unwrap_or_else(|| Vec::new(env));
                if args.new_threshold == 0 || args.new_threshold > signers.len() {
                    return Err(MultisigError::InvalidThreshold);
                }
                let old_threshold: u32 = env
                    .storage()
                    .instance()
                    .get(&DataKey::Threshold)
                    .unwrap_or(1);
                env.storage()
                    .instance()
                    .set(&DataKey::Threshold, &args.new_threshold);
                ThresholdChanged {
                    old_threshold,
                    new_threshold: args.new_threshold,
                }
                .publish(env);
            }
            MultisigAction::SetCancelThreshold(args) => {
                let signers: Vec<Address> = env
                    .storage()
                    .instance()
                    .get(&DataKey::Signers)
                    .unwrap_or_else(|| Vec::new(env));
                if args.new_threshold == 0 || args.new_threshold > signers.len() {
                    return Err(MultisigError::InvalidCancelThreshold);
                }
                let old_threshold: u32 = env
                    .storage()
                    .instance()
                    .get(&DataKey::CancelThreshold)
                    .unwrap_or(1);
                env.storage()
                    .instance()
                    .set(&DataKey::CancelThreshold, &args.new_threshold);
                CancelThresholdChanged {
                    old_threshold,
                    new_threshold: args.new_threshold,
                }
                .publish(env);
            }
        }
        Ok(())
    }
}
