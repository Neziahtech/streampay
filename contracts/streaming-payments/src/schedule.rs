//! Scheduled stream intents: sender-authorized, keeper-executable stream
//! creation.
//!
//! A sender can pre-authorize the creation of a stream at a future time — or a
//! recurring "cron" of streams — by calling
//! [`crate::StreamingPayments::schedule_stream`]. The sender's authorization is
//! consumed at scheduling time (their signature over the scheduling invocation
//! is verified by the host), and the **exact** scheduling parameters are
//! committed into a [`ScheduledIntent::params_hash`]. A permissionless keeper
//! then calls [`crate::StreamingPayments::execute_scheduled`] to materialize
//! each occurrence, paying itself the escrowed per-occurrence fee.
//!
//! # Non-replayability & scope bounding
//!
//! - **One execution per occurrence.** Each `execute_scheduled` call decrements
//!   `occurrences_remaining`; a one-shot intent becomes terminal after its one
//!   execution. A second execution of a completed occurrence reverts with
//!   [`StreamError::IntentNotPending`].
//! - **Expiry.** No occurrence may be executed at/after `expires_at`
//!   ([`StreamError::IntentExpired`]); the escrow is then refundable to the
//!   sender via `reclaim_expired`.
//! - **Exact parameters.** `params_hash` is a SHA-256 commitment over every
//!   immutable scheduling parameter. Execution recomputes it from storage and
//!   refuses to proceed if it no longer matches
//!   ([`StreamError::IntentParamsMismatch`]).
//! - **Timing gates.** An occurrence cannot be executed before its `due` time
//!   ([`StreamError::IntentNotYetExecutable`]) and only the sender may cancel,
//!   and only before the execution window opens
//!   ([`StreamError::IntentNotCancellable`]).
//!
//! See `docs/SCHEDULED_INTENTS.md` for the full threat model, keeper economics,
//! and the under-funded-keeper griefing analysis.

use soroban_sdk::{contracttype, Address, Bytes, BytesN, Env};

use crate::errors::StreamError;
use crate::stream::{self, DataKey, MAX_DURATION_SECONDS};
use crate::surface::{reject, Branch};

/// Maximum number of occurrences a single recurring intent may schedule.
/// Bounds the up-front escrow and the per-call bookkeeping.
pub const MAX_OCCURRENCES: u32 = 1000;

/// TTL maintenance for intent entries, mirroring streams (see `stream.rs`).
const TTL_THRESHOLD_LEDGERS: u32 = 200_000;
const TTL_EXTEND_LEDGERS: u32 = 500_000;

/// Lifecycle state of a scheduled intent.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum IntentStatus {
    /// Authorized and (partially) executable; some occurrences remain.
    Pending,
    /// Every occurrence has been materialized into a stream. Terminal.
    Executed,
    /// Cancelled by the sender before the execution window opened. Terminal.
    Cancelled,
    /// Passed `expires_at` with occurrences outstanding; escrow refunded.
    /// Terminal.
    Expired,
}

/// A sender-authorized, keeper-executable intent to create one or more streams.
//!
//! `deposit` and `fee_budget` are *per occurrence*: the sender escrows
//! `(deposit + fee_budget) * occurrences_total` at scheduling time. Each
//! execution creates one stream and pays the keeper one `fee_budget`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledIntent {
    pub id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    /// Deposit escrowed for *each* occurrence.
    pub deposit: i128,
    /// Scheduled start of the first occurrence.
    pub start_time: u64,
    /// Scheduled end of the first occurrence (`end_time > start_time`).
    pub end_time: u64,
    /// Whether created streams may be cancelled by their recipient.
    pub cancelable: bool,
    /// Seconds between occurrence starts; `0` for a one-shot intent.
    pub interval: u64,
    /// Total occurrences this intent will ever create (`>= 1`).
    pub occurrences_total: u32,
    /// Occurrences not yet materialized.
    pub occurrences_remaining: u32,
    /// Keeper fee escrowed for *each* occurrence (`>= 0`).
    pub fee_budget: i128,
    /// Earliest time the first occurrence may be executed.
    pub execute_after: u64,
    /// After this time no occurrence may be executed.
    pub expires_at: u64,
    /// SHA-256 commitment over every immutable scheduling parameter.
    pub params_hash: BytesN<32>,
    pub status: IntentStatus,
}

impl ScheduledIntent {
    /// Seconds in a single occurrence's window (`>= 1`).
    pub fn duration(&self) -> u64 {
        self.end_time - self.start_time
    }

    /// Number of occurrences already materialized.
    pub fn executed_count(&self) -> u32 {
        self.occurrences_total
            .saturating_sub(self.occurrences_remaining)
    }

    /// Half-open window `[start, end)` of occurrence `index` (0-based).
    ///
    /// Saturating arithmetic is used to avoid panics; the recurrence window is
    /// validated at scheduling time so saturation is unreachable for stored
    /// intents.
    pub fn occurrence_window(&self, index: u32) -> (u64, u64) {
        let shift = self.interval.saturating_mul(index as u64);
        (
            self.start_time.saturating_add(shift),
            self.end_time.saturating_add(shift),
        )
    }

    /// Earliest time occurrence `index` may be executed.
    pub fn occurrence_due(&self, index: u32) -> u64 {
        self.execute_after
            .saturating_add(self.interval.saturating_mul(index as u64))
    }

    /// Escrow still locked for the outstanding occurrences.
    pub fn remaining_escrow(&self) -> Result<i128, StreamError> {
        let per = self
            .deposit
            .checked_add(self.fee_budget)
            .ok_or(StreamError::MathOverflow)?;
        per.checked_mul(self.occurrences_remaining as i128)
            .ok_or(StreamError::MathOverflow)
    }
}

/// Computes the SHA-256 commitment over the immutable scheduling parameters.
///
/// Addresses are canonicalized via their StrKey string form so the commitment
/// is stable and platform-independent.
pub fn compute_params_hash(
    env: &Env,
    sender: &Address,
    recipient: &Address,
    token: &Address,
    deposit: i128,
    start_time: u64,
    end_time: u64,
    cancelable: bool,
    interval: u64,
    occurrences_total: u32,
    fee_budget: i128,
    execute_after: u64,
    expires_at: u64,
) -> BytesN<32> {
    let mut bytes = Bytes::new(env);
    bytes.append(&sender.to_string().into());
    bytes.append(&recipient.to_string().into());
    bytes.append(&token.to_string().into());
    bytes.append(&deposit.to_be_bytes().into());
    bytes.append(&start_time.to_be_bytes().into());
    bytes.append(&end_time.to_be_bytes().into());
    let cancelable_byte: [u8; 1] = [if cancelable { 1 } else { 0 }];
    bytes.append(&Bytes::from_slice(env, &cancelable_byte));
    bytes.append(&interval.to_be_bytes().into());
    bytes.append(&occurrences_total.to_be_bytes().into());
    bytes.append(&fee_budget.to_be_bytes().into());
    bytes.append(&execute_after.to_be_bytes().into());
    bytes.append(&expires_at.to_be_bytes().into());
    env.crypto().sha256(&bytes).into()
}

/// Schedule a new stream intent.
pub fn schedule_stream(
    env: &Env,
    sender: Address,
    recipient: Address,
    token: Address,
    deposit: i128,
    start_time: u64,
    end_time: u64,
    cancelable: bool,
    interval: u64,
    occurrences: u32,
    fee_budget: i128,
    execute_after: u64,
    expires_at: u64,
) -> Result<u64, StreamError> {
    stream::require_not_frozen(env)?;
    sender.require_auth();
    // ... remaining implementation details ...
    unimplemented!()
}

/// Execute a pending scheduled intent occurrence.
pub fn execute_scheduled(
    env: &Env,
    intent_id: u64,
    keeper: Address,
) -> Result<u64, StreamError> {
    stream::require_not_frozen(env)?;
    keeper.require_auth();
    // ... remaining implementation details ...
    unimplemented!()
}

/// Cancel a scheduled intent before execution window opens.
pub fn cancel_scheduled(env: &Env, intent_id: u64) -> Result<(), StreamError> {
    stream::require_not_frozen(env)?;
    // ... remaining implementation details ...
    unimplemented!()
}

/// Reclaim escrow for an expired intent.
pub fn reclaim_expired(env: &Env, intent_id: u64) -> Result<(), StreamError> {
    stream::require_not_frozen(env)?;
    // ... remaining implementation details ...
    unimplemented!()
}
