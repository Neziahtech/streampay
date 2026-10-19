use soroban_sdk::{contracttype, Address, Env, Symbol, Vec};

/// Emitted when the multisig contract is deployed and initialized.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MultisigInitialized {
    pub signers: Vec<Address>,
    pub threshold: u32,
}

impl MultisigInitialized {
    pub fn publish(self, env: &Env) {
        env.events().publish((Symbol::new(env, "initialized"),), self);
    }
}

/// Emitted when a new proposal is created.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalCreated {
    pub proposal_id: u64,
    pub proposer: Address,
    pub target: Address,
    pub function: Symbol,
}

impl ProposalCreated {
    pub fn publish(self, env: &Env) {
        env.events().publish((Symbol::new(env, "proposal_created"), self.proposal_id), self);
    }
}

/// Emitted when a signer approves a proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalApproved {
    pub proposal_id: u64,
    pub signer: Address,
}

impl ProposalApproved {
    pub fn publish(self, env: &Env) {
        env.events().publish((Symbol::new(env, "proposal_approved"), self.proposal_id), self);
    }
}

/// Emitted when a signer revokes an existing approval.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApprovalRevoked {
    pub proposal_id: u64,
    pub signer: Address,
}

impl ApprovalRevoked {
    pub fn publish(self, env: &Env) {
        env.events().publish((Symbol::new(env, "approval_revoked"), self.proposal_id), self);
    }
}

/// Emitted when a proposal is explicitly cancelled/revoked.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalRevoked {
    pub proposal_id: u64,
    pub caller: Address,
}

impl ProposalRevoked {
    pub fn publish(self, env: &Env) {
        env.events().publish((Symbol::new(env, "proposal_revoked"), self.proposal_id), self);
    }
}

/// Emitted when an approved proposal is executed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalExecuted {
    pub proposal_id: u64,
    pub executor: Address,
}

impl ProposalExecuted {
    pub fn publish(self, env: &Env) {
        env.events().publish((Symbol::new(env, "proposal_executed"), self.proposal_id), self);
    }
}

/// Emitted when a new signer is added to the multisig.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerAdded {
    pub new_signer: Address,
}

impl SignerAdded {
    pub fn publish(self, env: &Env) {
        env.events().publish((Symbol::new(env, "signer_added"),), self);
    }
}

/// Emitted when a signer is removed from the multisig.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerRemoved {
    pub removed_signer: Address,
    pub new_threshold: u32,
}

impl SignerRemoved {
    pub fn publish(self, env: &Env) {
        env.events().publish((Symbol::new(env, "signer_removed"),), self);
    }
}

/// Emitted when the signature threshold K is changed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThresholdChanged {
    pub old_threshold: u32,
    pub new_threshold: u32,
}

impl ThresholdChanged {
    pub fn publish(self, env: &Env) {
        env.events().publish((Symbol::new(env, "threshold_changed"),), self);
    }
}
