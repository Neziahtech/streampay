//! Events emitted by StreamPay.
//!
//! Every event is keyed by `stream_id` as a topic, so indexers can filter per
//! stream efficiently. Non-`#[topic]` fields are event data.

use soroban_sdk::{contractevent, Address};

/// Emitted when a new stream is created and its deposit pulled in.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamCreated {
    #[topic]
    pub stream_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    pub deposit: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub cancelable: bool,
}

/// Emitted when the recipient withdraws accrued funds.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    #[topic]
    pub stream_id: u64,
    pub recipient: Address,
    pub amount: i128,
    /// Total withdrawn from the stream after this withdrawal.
    pub withdrawn_total: i128,
}

/// Emitted when a stream is cancelled. The recipient's accrued balance and
/// the sender's refund are both paid atomically in the same transaction.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamCancelled {
    #[topic]
    pub stream_id: u64,
    pub cancelled_by: Address,
    /// Amount paid out to the recipient at cancellation.
    pub recipient_amount: i128,
    /// Amount refunded to the sender at cancellation.
    pub sender_amount: i128,
}

/// Emitted when the sender adds funds to an existing stream.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamToppedUp {
    #[topic]
    pub stream_id: u64,
    pub sender: Address,
    pub amount: i128,
    /// Stream deposit after the top-up.
    pub new_deposit: i128,
}

/// Emitted when the recipient raises a dispute, freezing the stream's
/// cancel/top-up mutations until resolution or expiry. The bond (stream
/// token, held by the contract) accompanies the flag.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeRaised {
    #[topic]
    pub stream_id: u64,
    pub recipient: Address,
    /// Bond pulled into the contract for the duration of the dispute.
    pub bond: i128,
    /// First ledger timestamp at which the dispute can be expired.
    pub expires_at: u64,
}

/// Emitted when the sender resolves an open dispute. `accept = true`
/// refunds the bond to the recipient and unwinds the stream pro-rata
/// (a `StreamCancelled` event accompanies it); `accept = false` treats the
/// dispute as bad-faith and slashes the bond to the sender, resuming the
/// stream normally.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeResolved {
    #[topic]
    pub stream_id: u64,
    pub sender: Address,
    /// Whether the sender accepted the dispute as legitimate.
    pub accept: bool,
    /// The bond at stake (paid to the recipient on accept, slashed to the
    /// sender otherwise).
    pub bond: i128,
}

/// Emitted when a dispute's timelock expires without a verdict: the stream
/// resumes and the bond is split, `sender_share` rounding up.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeExpired {
    #[topic]
    pub stream_id: u64,
    pub recipient: Address,
    pub bond: i128,
    /// Half of the bond (rounded up) paid to the sender as compensation for
    /// the frozen window.
    pub sender_share: i128,
    /// The remainder of the bond refunded to the recipient.
    pub recipient_share: i128,
}
