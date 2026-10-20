use soroban_sdk::{contracttype, Address};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreateStreamArgs {
    pub contract: Address,
    pub recipient: Address,
    pub token: Address,
    pub deposit: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub cancellable: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TopUpArgs {
    pub contract: Address,
    pub token: Address,
    pub stream_id: u64,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CancelStreamArgs {
    pub contract: Address,
    pub stream_id: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawArgs {
    pub contract: Address,
    pub stream_id: u64,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransferTokenArgs {
    pub token: Address,
    pub to: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerArgs {
    pub signer: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThresholdArgs {
    pub new_threshold: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MultisigAction {
    CreateStream(CreateStreamArgs),
    TopUp(TopUpArgs),
    CancelStream(CancelStreamArgs),
    Withdraw(WithdrawArgs),
    TransferToken(TransferTokenArgs),
    AddSigner(SignerArgs),
    RemoveSigner(SignerArgs),
    SetThreshold(ThresholdArgs),
    SetCancelThreshold(ThresholdArgs),
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Pending = 0,
    Executed = 1,
    Revoked = 2,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub action: MultisigAction,
    pub status: ProposalStatus,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Initialized,
    Signers,
    Threshold,
    CancelThreshold,
    ProposalCount,
    Proposal(u64),
    ProposalApprovals(u64),
}
