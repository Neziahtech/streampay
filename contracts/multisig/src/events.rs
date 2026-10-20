use soroban_sdk::{contractevent, Address, Vec};

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MultisigInitialized {
    pub signers: Vec<Address>,
    pub threshold: u32,
    pub cancel_threshold: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalCreated {
    #[topic]
    pub proposal_id: u64,
    pub proposer: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalApproved {
    #[topic]
    pub proposal_id: u64,
    pub signer: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApprovalRevoked {
    #[topic]
    pub proposal_id: u64,
    pub signer: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalRevoked {
    #[topic]
    pub proposal_id: u64,
    pub caller: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalExecuted {
    #[topic]
    pub proposal_id: u64,
    pub executor: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerAdded {
    #[topic]
    pub signer: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerRemoved {
    #[topic]
    pub signer: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThresholdChanged {
    pub old_threshold: u32,
    pub new_threshold: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CancelThresholdChanged {
    pub old_threshold: u32,
    pub new_threshold: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamCancelledImmediate {
    #[topic]
    pub signer: Address,
    pub contract: Address,
    pub stream_id: u64,
}
