use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum MultisigError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidThreshold = 3,
    InvalidSigners = 4,
    DuplicateSigner = 5,
    NotSigner = 6,
    ProposalNotFound = 7,
    ProposalAlreadyExecuted = 8,
    ProposalRevoked = 9,
    AlreadyApproved = 10,
    NotApproved = 11,
    ThresholdNotMet = 12,
    SignerAlreadyExists = 13,
    SignerNotFound = 14,
    CannotRemoveBelowThreshold = 15,
    ExecutionFailed = 16,
    Unauthorized = 17,
    InvalidCancelThreshold = 18,
    CancelThresholdNotMet = 19,
    InvalidAmount = 20,
}
