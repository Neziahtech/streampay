//! Storage keys, records and errors of the payout router.

use soroban_sdk::{contracterror, contracttype, Address};

/// Storage keys. Pending and active bindings live under separate persistent
/// keys, so the delay window has its own TTL.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// Instance: the streaming contract address.
    Streaming,
    /// Persistent: a proposed, not yet routing binding.
    Pending(u64),
    /// Persistent: the binding that routes claims.
    Active(u64),
}

/// A proposed binding waiting out the delay.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Pending {
    pub payout: Address,
    pub recipient: Address,
    pub token: Address,
    pub activates_at: u64,
}

/// A confirmed binding that routes claims.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Active {
    pub payout: Address,
    pub recipient: Address,
    pub token: Address,
}

/// Result of `binding`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BindingView {
    pub active: Option<Address>,
    pub pending: Option<Address>,
    /// Activation time of the pending binding; 0 when there is none.
    pub activates_at: u64,
}

/// Router errors. Codes are stable: append only, never renumber.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RouterError {
    StreamUnavailable = 1,
    StreamNotActive = 2,
    PayoutIsRecipient = 3,
    PayoutIsStreaming = 4,
    PayoutIsRouter = 5,
    AdvanceActive = 6,
    NoPending = 7,
    BindingNotReady = 8,
    NoBinding = 9,
    RecipientChanged = 10,
}
