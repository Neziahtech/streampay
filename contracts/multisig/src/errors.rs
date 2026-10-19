use soroban_sdk::contracterror;

/// Stable numeric error codes for the K-of-N Multisig contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum MultisigError {
    /// The multisig contract has not been initialized.
    NotInitialized = 1,
    /// The multisig contract is already initialized.
    AlreadyInitialized = 2,
    /// Caller is not a registered signer in the current signer set.
    NotSigner = 3,
    /// Threshold must be greater than 0 and less than or equal to signer count.
    InvalidThreshold = 4,
    /// Proposal does not have enough valid approvals from current signers to execute.
    ThresholdNotMet = 5,
    /// The specified proposal ID was not found.
    ProposalNotFound = 6,
    /// Proposal has already been executed.
    ProposalAlreadyExecuted = 7,
    /// Proposal was cancelled or revoked.
    ProposalRevoked = 8,
    /// The signer has already approved this proposal.
    AlreadyApproved = 9,
    /// The signer has not approved this proposal.
    NotApproved = 10,
    /// The signer being added already exists in the signer set.
    SignerAlreadyExists = 11,
    /// The signer being removed was not found in the signer set.
    SignerNotFound = 12,
    /// Signer set cannot be empty.
    EmptySigners = 13,
    /// Signer set contains duplicate addresses.
    DuplicateSigner = 14,
    /// Cannot remove signer if it reduces signer count below the threshold.
    CannotRemoveBelowThreshold = 15,
    /// Caller is not authorized to perform this operation.
    Unauthorized = 16,
}
