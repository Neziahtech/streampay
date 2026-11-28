//! Events emitted by the payout router.

use soroban_sdk::{contractevent, Address};

/// Emitted when a recipient proposes a payout address. The binding is NOT yet
/// in force; it activates no earlier than `activates_at` and only after the
/// recipient confirms. Watchers use this event to spot a hostile rebind.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutBound {
    #[topic]
    pub stream_id: u64,
    pub recipient: Address,
    pub payout: Address,
    pub activates_at: u64,
}

/// Emitted when a pending binding is confirmed and starts routing claims.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutActive {
    #[topic]
    pub stream_id: u64,
    pub recipient: Address,
    pub payout: Address,
}

/// Emitted when a pending and/or active binding is removed.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutCleared {
    #[topic]
    pub stream_id: u64,
    pub recipient: Address,
}
