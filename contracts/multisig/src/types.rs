use soroban_sdk::{contracttype, Address, Symbol, Val, Vec};

/// Storage keys for the K-of-N Multisig contract.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// Active signers list (`Vec<Address>`).
    Signers,
    /// Approval threshold K (`u32`).
    Threshold,
    /// Next proposal counter (`u64`).
    NextProposalId,
    /// Stored proposal by ID (`u64`).
    Proposal(u64),
    /// Stored list of signer approvals by proposal ID (`u64` -> `Vec<Address>`).
    Approvals(u64),
}

/// Stored proposal record representing an intended cross-contract invocation.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub target: Address,
    pub function: Symbol,
    pub args: Vec<Val>,
    pub executed: bool,
    pub revoked: bool,
}

/// Client-friendly read-only view of a proposal and its execution eligibility.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalView {
    pub id: u64,
    pub proposer: Address,
    pub target: Address,
    pub function: Symbol,
    pub executed: bool,
    pub revoked: bool,
    pub approval_count: u32,
    pub threshold: u32,
    pub is_executable: bool,
}
