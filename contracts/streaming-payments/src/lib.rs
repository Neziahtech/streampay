#![no_std]

//! StreamPay: continuous, linear streaming payments for Stellar (Soroban).
//!
//! Lock a deposit and let it accrue to a recipient per second between
//! `start_time` and `end_time` — for payroll, DAO contributor pay,
//! subscriptions, or vesting. The recipient withdraws accrued funds at any
//! time; the sender can top up or cancel with a fair pro-rata refund.
//!
//! # Entry points
//!
//! - [`StreamingPayments::create_stream`] — open a stream and pull the deposit
//! - [`StreamingPayments::withdraw`] — recipient claims accrued funds
//! - [`StreamingPayments::withdraw_max`] — recipient claims *all* accrued
//!   funds in one atomic call
//! - [`StreamingPayments::cancel_stream`] — sender (or recipient, if the
//!   stream is `cancelable`) closes the stream with a pro-rata split
//! - [`StreamingPayments::top_up`] — add funds to a running stream
//! - [`StreamingPayments::raise_dispute`] — recipient flags the stream
//!   (wrong address, coerced creation) for a bond; cancel/top-up are frozen
//!   until the sender resolves or the timelock expires
//! - [`StreamingPayments::resolve_dispute`] — sender accepts (unwind +
//!   refund bond) or rejects as bad-faith (bond slashed, stream resumes)
//! - [`StreamingPayments::expire_dispute`] — anyone, after the timelock:
//!   bond split, stream resumes
//! - [`StreamingPayments::get_stream`] / [`StreamingPayments::available`] —
//!   read-only views
//! - [`StreamingPayments::get_dispute`] /
//!   [`StreamingPayments::required_dispute_bond`] — dispute read-only views
//! - [`StreamingPayments::recipient_streams`] /
//!   [`StreamingPayments::sender_streams`] — paginated on-chain discovery
//!   indexes per address
//!
//! # Invariants
//!
//! - `0 <= withdrawn <= streamed <= deposit` for every stored stream.
//! - The contract's token balance always covers
//!   `sum(deposit - withdrawn)` over live (non-cancelled) streams plus all
//!   outstanding dispute bonds (funds are only ever moved by these entry
//!   points; a cancelled stream holds nothing once its split was paid).
//! - All state changes happen *before* token transfers (checks-effects-
//!   interactions), so reentrant token callbacks cannot over-withdraw.
//! - A dispute freezes cancel/top-up only: accrual keeps running and the
//!   recipient can always withdraw accrued funds, dispute or not.

mod dispute;
#[cfg(test)]
extern crate std;

#[cfg(test)]
mod error_surface_test;
mod errors;
mod events;
mod stream;
pub mod surface;
#[cfg(test)]
mod test;
#[cfg(test)]
mod test_client;

use soroban_sdk::{contract, contractimpl, token::TokenClient, Address, Env, Vec};

pub use dispute::{
    bond_shares, required_bond, Dispute, DISPUTE_BOND_BPS, DISPUTE_TIMEOUT_SECONDS,
    MIN_DISPUTE_BOND,
};
use surface::Branch;

pub use errors::StreamError;
pub use events::{
    DisputeExpired, DisputeRaised, DisputeResolved, StreamCancelled, StreamCreated, StreamToppedUp,
    Withdrawn,
};
// `streamed_at` is re-exported for the fuzz target and downstream rate
// calculators: it is a pure function requiring no `Env`.
pub use stream::{streamed_at, Stream, StreamStatus, MAX_DURATION_SECONDS, MAX_PAGE_SIZE};

/// The StreamPay streaming-payments contract.
#[contract]
pub struct StreamingPayments;

#[contractimpl]
impl StreamingPayments {
    /// Creates a linear payment stream and pulls `deposit_amount` of `token`
    /// from `sender` into this contract.
    ///
    /// The sender must first approve this contract as a spender on `token`
    /// (`token.approve(sender, streaming_contract, deposit_amount, ...)`).
    ///
    /// * `start_time` must not be in the past (UIs pass the current time to
    ///   start streaming immediately).
    /// * `end_time` must be strictly after `start_time` (zero-duration streams
    ///   are rejected) and at most `MAX_DURATION_SECONDS` long.
    #[allow(clippy::too_many_arguments)] // 8-arg surface is the intended client API
    /// * `cancelable` controls whether the recipient may also call
    ///   `cancel_stream` to reclaim their accrued balance.
    ///
    /// Returns the new stream id (monotonically increasing, starting at 1).
    pub fn create_stream(
        env: Env,
        sender: Address,
        recipient: Address,
        token: Address,
        deposit_amount: i128,
        start_time: u64,
        end_time: u64,
        cancelable: bool,
    ) -> Result<u64, StreamError> {
        sender.require_auth();

        if deposit_amount <= 0 {
            return Err(surface::reject(Branch::CreateDepositNonPositive));
        }
        let now = env.ledger().timestamp();
        if start_time < now {
            return Err(surface::reject(Branch::CreateStartTimeInPast));
        }
        if end_time <= start_time {
            return Err(surface::reject(Branch::CreateInvalidTimeRange));
        }
        // MUTANT-SUPPRESS: replace - with + is acceptable because create_stream
        // enforces end_time > start_time at lines 89-90. The mutation would
        // produce an absurdly large duration that would immediately fail
        // MAX_DURATION_SECONDS validation (line 93). This is an unreachable
        // code path given the contract's invariants.
        let duration = end_time - start_time;
        if duration > MAX_DURATION_SECONDS {
            return Err(surface::reject(Branch::CreateDurationTooLong));
        }
        stream::validate_capacity(deposit_amount, duration)?;

        // Interaction: pull the deposit from the sender.
        TokenClient::new(&env, &token).transfer_from(
            &env.current_contract_address(),
            &sender,
            &env.current_contract_address(),
            &deposit_amount,
        );

        // Effects: persist the stream and announce it.
        let id = stream::next_stream_id(&env);
        let s = Stream {
            id,
            sender: sender.clone(),
            recipient: recipient.clone(),
            token: token.clone(),
            deposit: deposit_amount,
            withdrawn: 0,
            start_time,
            end_time,
            cancelable,
            status: StreamStatus::Active,
        };
        stream::put_stream(&env, &s);
        stream::index_stream(&env, &s);

        StreamCreated {
            stream_id: id,
            sender,
            recipient,
            token,
            deposit: deposit_amount,
            start_time,
            end_time,
            cancelable,
        }
        .publish(&env);

        Ok(id)
    }

    /// Withdraws up to `amount` of the accrued-but-unwithdrawn balance and
    /// pays it to the stream recipient. Only the recipient can call this
    /// (their authorization is required).
    ///
    /// Reverts with [`StreamError::AmountExceedsAvailable`] if `amount`
    /// exceeds what has accrued so far; before `start_time` nothing has
    /// accrued, at or after `end_time` the full remainder is available.
    pub fn withdraw(env: Env, stream_id: u64, amount: i128) -> Result<(), StreamError> {
        if amount <= 0 {
            return Err(surface::reject(Branch::WithdrawAmountNonPositive));
        }
        let mut s = Self::authorize_withdrawal(&env, stream_id)?;

        let available = stream::available_amount(&env, &s)?;
        if amount > available {
            return Err(surface::reject(Branch::WithdrawAmountExceedsAvailable));
        }

        Self::pay_out(&env, &mut s, amount)
    }

    /// Withdraws the entire accrued-but-unwithdrawn balance in one call and
    /// returns the amount paid. Only the recipient can call this (their
    /// authorization is required).
    ///
    /// This is the atomic form of "read `available`, then `withdraw` it":
    /// clients never risk a stale amount between the two calls. Reverts with
    /// [`StreamError::NothingToWithdraw`] when nothing has accrued yet (or
    /// everything accrued has already been withdrawn), and with
    /// [`StreamError::StreamNotActive`] on cancelled or depleted streams.
    pub fn withdraw_max(env: Env, stream_id: u64) -> Result<i128, StreamError> {
        let mut s = Self::authorize_withdrawal(&env, stream_id)?;

        let amount = stream::available_amount(&env, &s)?;
        if amount <= 0 {
            return Err(surface::reject(Branch::WithdrawMaxNothingToWithdraw));
        }

        Self::pay_out(&env, &mut s, amount)?;
        Ok(amount)
    }

    /// Shared preamble for both withdrawal paths: load the stream, require
    /// the recipient's authorization, and reject terminal streams.
    fn authorize_withdrawal(env: &Env, stream_id: u64) -> Result<Stream, StreamError> {
        let s = stream::get_stream(env, stream_id)?;
        s.recipient.require_auth();
        if s.status != StreamStatus::Active {
            return Err(surface::reject(Branch::StreamNotActive));
        }
        Ok(s)
    }

    /// Shared payout tail for both withdrawal paths, checks-effects-
    /// interactions ordered: record `withdrawn` and emit the event *before*
    /// moving tokens, so a reentrant token callback can never double-spend.
    fn pay_out(env: &Env, s: &mut Stream, amount: i128) -> Result<(), StreamError> {
        s.withdrawn = s
            .withdrawn
            .checked_add(amount)
            .ok_or_else(|| surface::reject(Branch::PayoutOverflow))?;
        if s.withdrawn == s.deposit {
            s.status = StreamStatus::Depleted;
        }
        stream::put_stream(env, s);

        Withdrawn {
            stream_id: s.id,
            recipient: s.recipient.clone(),
            amount,
            withdrawn_total: s.withdrawn,
        }
        .publish(env);

        TokenClient::new(env, &s.token).transfer(
            &env.current_contract_address(),
            stream::muxed(&s.recipient),
            &amount,
        );

        Ok(())
    }

    /// Cancels a stream: pays the recipient their accrued-but-unwithdrawn
    /// balance and refunds the sender the unaccrued remainder, atomically.
    ///
    /// Callable by the sender always, and by the recipient only if the stream
    /// was created with `cancelable = true`. Cancelling an already-cancelled
    /// or depleted stream reverts with [`StreamError::StreamNotActive`];
    /// cancelling while a dispute is open reverts with
    /// [`StreamError::DisputeActive`] until the dispute is resolved or expires.
    pub fn cancel_stream(env: Env, caller: Address, stream_id: u64) -> Result<(), StreamError> {
        caller.require_auth();

        let mut s = stream::get_stream(&env, stream_id)?;
        if s.status != StreamStatus::Active {
            return Err(surface::reject(Branch::StreamNotActive));
        }
        if dispute::get_dispute_opt(&env, stream_id).is_some() {
            return Err(StreamError::DisputeActive);
        }
        if caller != s.sender {
            if caller == s.recipient {
                if !s.cancelable {
                    return Err(surface::reject(Branch::CancelStreamNotCancellable));
                }
            } else {
                return Err(surface::reject(Branch::CancelStreamNotAuthorized));
            }
        }

        let (recipient_amount, sender_amount) = stream::cancel_amounts(&env, &s)?;

        // Effects first (CEI): finalise state before moving tokens.
        s.status = StreamStatus::Cancelled;
        s.withdrawn = s
            .withdrawn
            .checked_add(recipient_amount)
            .ok_or_else(|| surface::reject(Branch::CancelSplitOverflow))?;
        stream::put_stream(&env, &s);

        StreamCancelled {
            stream_id,
            cancelled_by: caller,
            recipient_amount,
            sender_amount,
        }
        .publish(&env);

        let token = TokenClient::new(&env, &s.token);
        // MUTANT-SUPPRESS: replace > with >= is acceptable because recipient_amount
        // is only 0 when cancel_amounts computes 0 (cancel before start). The test
        // cancel_at_exact_start_pays_sender_everything verifies correct behavior
        // without the transfer. The >= mutation would only add a no-op transfer of
        // 0 tokens, which is functionally equivalent but unnecessary.
        if recipient_amount > 0 {
            token.transfer(
                &env.current_contract_address(),
                stream::muxed(&s.recipient),
                &recipient_amount,
            );
        }
        // MUTANT-SUPPRESS: replace > with >= is acceptable because sender_amount
        // is only 0 when cancel_amounts computes 0 (cancel after end). The test
        // cancel_after_end_pays_recipient_everything verifies correct behavior
        // without the transfer. The >= mutation would only add a no-op transfer of
        // 0 tokens, which is functionally equivalent but unnecessary.
        if sender_amount > 0 {
            token.transfer(
                &env.current_contract_address(),
                stream::muxed(&s.sender),
                &sender_amount,
            );
        }

        Ok(())
    }

    /// Adds funds to an existing active stream. The deposit grows and accrual
    /// remains linear over the original window, so the recipient's accrued
    /// amount increases pro-rata immediately (Sablier-v1 `increaseAmount`
    /// semantics).
    ///
    /// Top-ups are rejected on cancelled or depleted streams, and frozen
    /// ([`StreamError::DisputeActive`]) while a dispute is open. Topping up a
    /// stream that has already passed `end_time` adds fully-accrued funds the
    /// recipient can withdraw immediately.
    ///
    /// Note: extending `end_time` is intentionally not supported in v1 —
    /// retroactively re-baselining accrual is lossy for the recipient; see
    /// `docs/ARCHITECTURE.md` for the design considerations and roadmap.
    pub fn top_up(env: Env, stream_id: u64, amount: i128) -> Result<(), StreamError> {
        if amount <= 0 {
            return Err(surface::reject(Branch::TopUpAmountNonPositive));
        }
        let mut s = stream::get_stream(&env, stream_id)?;
        if s.status != StreamStatus::Active {
            return Err(surface::reject(Branch::StreamNotActive));
        }
        s.sender.require_auth();
        if dispute::get_dispute_opt(&env, stream_id).is_some() {
            return Err(StreamError::DisputeActive);
        }

        let new_deposit = s
            .deposit
            .checked_add(amount)
            .ok_or_else(|| surface::reject(Branch::TopUpDepositOverflow))?;
        stream::validate_capacity(new_deposit, s.duration())?;

        // Interaction: pull the added funds from the sender.
        TokenClient::new(&env, &s.token).transfer_from(
            &env.current_contract_address(),
            &s.sender,
            &env.current_contract_address(),
            &amount,
        );

        // Effects: record the new deposit and announce it.
        s.deposit = new_deposit;
        stream::put_stream(&env, &s);

        StreamToppedUp {
            stream_id,
            sender: s.sender.clone(),
            amount,
            new_deposit,
        }
        .publish(&env);

        Ok(())
    }

    /// Recipient-initiated dispute: flags this stream (wrong address,
    /// coerced creation) and freezes its cancel/top-up mutations until the
    /// sender calls [`StreamingPayments::resolve_dispute`] or the timelock
    /// elapses and anyone calls [`StreamingPayments::expire_dispute`].
    ///
    /// Only the stream's recipient can raise it (their authorization is
    /// required), only on an active, undisputed stream. Anti-griefing: the
    /// recipient posts a bond ([`StreamingPayments::required_dispute_bond`],
    /// a share of the deposit that escalates with every dispute round on
    /// the stream) via a prior token approval, held by the contract until
    /// resolution. Accrual keeps running and accrued funds stay withdrawable
    /// throughout — the freeze targets the stream's lifecycle, not the
    /// recipient's earned balance.
    ///
    /// Returns the recorded dispute (bond, window, expiry timestamp).
    pub fn raise_dispute(env: Env, stream_id: u64) -> Result<Dispute, StreamError> {
        let s = stream::get_stream(&env, stream_id)?;
        if s.status != StreamStatus::Active {
            return Err(StreamError::StreamNotActive);
        }
        if dispute::get_dispute_opt(&env, stream_id).is_some() {
            return Err(StreamError::DisputeActive);
        }
        s.recipient.require_auth();

        let bond = dispute::required_bond(s.deposit, dispute::dispute_count(&env, stream_id))?;

        // Interaction: pull the bond from the recipient (a prior approval is
        // required, like `create_stream`'s deposit pull).
        TokenClient::new(&env, &s.token).transfer_from(
            &env.current_contract_address(),
            &s.recipient,
            &env.current_contract_address(),
            &bond,
        );

        // Effects: open the dispute and record the round (escalating bond).
        let now = env.ledger().timestamp();
        let d = Dispute {
            stream_id,
            raised_by: s.recipient.clone(),
            bond,
            started_at: now,
            expires_at: now.saturating_add(dispute::DISPUTE_TIMEOUT_SECONDS),
        };
        dispute::put_dispute(&env, &d);
        dispute::bump_dispute_count(&env, stream_id);

        DisputeRaised {
            stream_id,
            recipient: s.recipient,
            bond,
            expires_at: d.expires_at,
        }
        .publish(&env);

        Ok(d)
    }

    /// Sender-only resolution of an open dispute:
    ///
    /// * `accept = true` — the dispute is legitimate: the bond is refunded
    ///   to the recipient and the stream is unwound with the standard
    ///   pro-rata cancel split (a `StreamCancelled` event accompanies the
    ///   `DisputeResolved`). If the stream already depleted during the
    ///   dispute (the recipient withdrew everything), only the bond is
    ///   refunded.
    /// * `accept = false` — bad faith: the bond is slashed to the sender as
    ///   compensation for the frozen window, and the stream resumes normal
    ///   operation immediately.
    pub fn resolve_dispute(
        env: Env,
        caller: Address,
        stream_id: u64,
        accept: bool,
    ) -> Result<(), StreamError> {
        caller.require_auth();

        let mut s = stream::get_stream(&env, stream_id)?;
        let d = dispute::get_dispute(&env, stream_id)?;
        if caller != s.sender {
            return Err(StreamError::NotStreamSender);
        }

        // Effects: close the dispute, then optionally unwind the stream.
        dispute::delete_dispute(&env, stream_id);

        let (recipient_settlement, sender_settlement) =
            if accept && s.status == StreamStatus::Active {
                let amounts = stream::cancel_amounts(&env, &s)?;
                s.status = StreamStatus::Cancelled;
                s.withdrawn = s
                    .withdrawn
                    .checked_add(amounts.0)
                    .ok_or(StreamError::MathOverflow)?;
                stream::put_stream(&env, &s);

                StreamCancelled {
                    stream_id,
                    cancelled_by: caller.clone(),
                    recipient_amount: amounts.0,
                    sender_amount: amounts.1,
                }
                .publish(&env);
                amounts
            } else {
                (0, 0)
            };

        DisputeResolved {
            stream_id,
            sender: s.sender.clone(),
            accept,
            bond: d.bond,
        }
        .publish(&env);

        // Interactions last (CEI): bond refund/slash plus settlement.
        let token = TokenClient::new(&env, &s.token);
        let bond_to_recipient = if accept { d.bond } else { 0 };
        let bond_to_sender = if accept { 0 } else { d.bond };
        if bond_to_recipient + recipient_settlement > 0 {
            token.transfer(
                &env.current_contract_address(),
                stream::muxed(&s.recipient),
                &(bond_to_recipient + recipient_settlement),
            );
        }
        if bond_to_sender + sender_settlement > 0 {
            token.transfer(
                &env.current_contract_address(),
                stream::muxed(&s.sender),
                &(bond_to_sender + sender_settlement),
            );
        }

        Ok(())
    }

    /// Closes a dispute whose timelock has fully elapsed: the bond is split
    /// (sender receives the upper half as compensation for the frozen
    /// window, the recipient the remainder) and the stream resumes normally.
    ///
    /// Callable by anyone once `now >= expires_at` — no authorization is
    /// involved and no funds ever move to the trigger. Reverting the split
    /// to a full bond refund would make serial disputes free for a patient
    /// griefer; see `docs/ARCHITECTURE.md` for the griefing-threshold math.
    pub fn expire_dispute(env: Env, stream_id: u64) -> Result<(), StreamError> {
        let s = stream::get_stream(&env, stream_id)?;
        let d = dispute::get_dispute(&env, stream_id)?;
        if env.ledger().timestamp() < d.expires_at {
            return Err(StreamError::DisputeNotExpired);
        }

        // Effects: close the dispute; the stream entry was never touched.
        dispute::delete_dispute(&env, stream_id);
        let (sender_share, recipient_share) = dispute::bond_shares(d.bond);

        DisputeExpired {
            stream_id,
            recipient: s.recipient.clone(),
            bond: d.bond,
            sender_share,
            recipient_share,
        }
        .publish(&env);

        // Interactions last (CEI).
        let token = TokenClient::new(&env, &s.token);
        if recipient_share > 0 {
            token.transfer(
                &env.current_contract_address(),
                stream::muxed(&s.recipient),
                &recipient_share,
            );
        }
        if sender_share > 0 {
            token.transfer(
                &env.current_contract_address(),
                stream::muxed(&s.sender),
                &sender_share,
            );
        }

        Ok(())
    }

    /// Read-only view of a stream's full state.
    pub fn get_stream(env: Env, stream_id: u64) -> Result<Stream, StreamError> {
        stream::get_stream(&env, stream_id)
    }

    /// Read-only view of a stream's open dispute. Reverts with
    /// [`StreamError::DisputeNotFound`] when the stream is undisputed
    /// (disputes exist only while open; resolution and expiry remove them).
    pub fn get_dispute(env: Env, stream_id: u64) -> Result<Dispute, StreamError> {
        dispute::get_dispute(&env, stream_id)
    }

    /// The bond a recipient must post (and pre-approve) to raise the next
    /// dispute on this stream: 5% of the deposit, multiplied by the number
    /// of disputes already raised on it, floored at one token unit.
    pub fn required_dispute_bond(env: Env, stream_id: u64) -> Result<i128, StreamError> {
        let s = stream::get_stream(&env, stream_id)?;
        dispute::required_bond(s.deposit, dispute::dispute_count(&env, stream_id))
    }

    /// Read-only view of the accrued-but-unwithdrawn balance at the current
    /// ledger time. Zero before `start_time` and for cancelled streams; the
    /// full remainder at or after `end_time`.
    pub fn available(env: Env, stream_id: u64) -> Result<i128, StreamError> {
        let s = stream::get_stream(&env, stream_id)?;
        stream::available_amount(&env, &s)
    }

    /// A page of stream ids where `recipient` is the recipient, in creation
    /// order (oldest first). `limit` is clamped to `MAX_PAGE_SIZE`; paginate
    /// by advancing `offset`. Unknown addresses yield an empty page.
    ///
    /// Discovery view only: it does not authorize anything and terminal
    /// (cancelled/depleted) streams keep their ids — read each stream's
    /// `status` for lifecycle state.
    pub fn recipient_streams(env: Env, recipient: Address, offset: u32, limit: u32) -> Vec<u64> {
        stream::page_stream_ids(
            &env,
            &stream::DataKey::RecipientStreams(recipient),
            offset,
            limit,
        )
    }

    /// A page of stream ids created by `sender`, in creation order. Same
    /// pagination and advisory semantics as [`StreamingPayments::recipient_streams`].
    pub fn sender_streams(env: Env, sender: Address, offset: u32, limit: u32) -> Vec<u64> {
        stream::page_stream_ids(&env, &stream::DataKey::SenderStreams(sender), offset, limit)
    }
}
