#![no_std]

//! StreamPay: continuous, linear streaming payments for Stellar (Soroban).

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
mod treasury;

use soroban_sdk::{
    contract, contractimpl, contracttype, token::TokenClient, Address, ConversionError, Env,
    Error as SorobanError, InvokeError, MuxedAddress, Vec,
};

use surface::Branch;

pub use errors::StreamError;
pub use events::{
    FeeCharged, FeeWithdrawn, StreamCancelled, StreamCreated, StreamCreatedVested, StreamToppedUp,
    StreamsCreated, Withdrawn,
};
pub use stream::{
    scheduled_vested_at, streamed_at, Schedule, Stream, StreamStatus, VestingStep,
    MAX_DURATION_SECONDS, MAX_PAGE_SIZE,
};
pub use treasury::{fee_amount, FeeScan, Treasury, TreasuryStatus, BPS_DENOMINATOR, MAX_FEE_BPS};

/// Parameters for one stream in a [`StreamingPayments::create_streams`] call.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamInput {
    pub recipient: Address,
    pub token: Address,
    pub deposit_amount: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub cancelable: bool,
}

/// The StreamPay streaming-payments contract.
#[contract]
pub struct StreamingPayments;

type TokenCall<T> = Result<Result<T, ConversionError>, Result<SorobanError, InvokeError>>;

fn token_result<T>(res: TokenCall<T>, on_failure: Branch) -> Result<T, StreamError> {
    match res {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) | Err(_) => Err(surface::reject(on_failure)),
    }
}

fn pull(
    env: &Env,
    token: &Address,
    payer: &Address,
    amount: i128,
    on_failure: Branch,
) -> Result<(), StreamError> {
    let res = TokenClient::new(env, token).try_transfer_from(
        &env.current_contract_address(),
        payer,
        &env.current_contract_address(),
        &amount,
    );
    token_result(res, on_failure)
}

fn push(
    env: &Env,
    token: &Address,
    recipient: &MuxedAddress,
    amount: i128,
    on_failure: Branch,
) -> Result<(), StreamError> {
    let res = TokenClient::new(env, token).try_transfer(
        &env.current_contract_address(),
        recipient,
        &amount,
    );
    token_result(res, on_failure)
}

#[contractimpl]
impl StreamingPayments {
    pub fn __constructor(env: Env, governor: Address) {
        env.storage()
            .instance()
            .set(&stream::DataKey::Governor, &governor);
        env.storage()
            .instance()
            .extend_ttl(stream::TTL_THRESHOLD_LEDGERS, stream::TTL_EXTEND_LEDGERS);
    }

    /// Creates a linear payment stream and pulls `deposit_amount` of `token`
    /// from `sender` into this contract.
    #[allow(clippy::too_many_arguments)]
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
        let now = env.ledger().timestamp();
        Self::validate_stream_creation(now, deposit_amount, start_time, end_time)?;

        let fee_bps = treasury::current_fee_bps(&env);
        let fee = treasury::fee_amount(deposit_amount, fee_bps)?;
        let pull_amount = deposit_amount
            .checked_add(fee)
            .ok_or(StreamError::MathOverflow)?;

        pull(&env, &token, &sender, pull_amount, Branch::CreateDepositTransferFailed)?;

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
        if fee > 0 {
            treasury::apply_fee(&env, &token, id, fee)?;
        }

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

        if fee > 0 {
            FeeCharged {
                stream_id: id,
                token: s.token.clone(),
                payer: s.sender.clone(),
                amount: fee,
                fee_bps,
            }
            .publish(&env);
        }

        Ok(id)
    }

    /// Creates multiple streams atomically, authorizing the sender once and
    /// grouping deposits into one token pull per token.
    pub fn create_streams(
        env: Env,
        sender: Address,
        inputs: Vec<StreamInput>,
    ) -> Result<Vec<u64>, StreamError> {
        let mut ids = Vec::new(&env);
        let count = inputs.len();
        if count == 0 {
            return Ok(ids);
        }
        sender.require_auth();

        let now = env.ledger().timestamp();
        let fee_bps = treasury::current_fee_bps(&env);
        let mut pull_totals: Vec<(Address, i128)> = Vec::new(&env);
        let mut fees = Vec::new(&env);
        let mut index = 0;
        while index < count {
            let input = inputs.get(index).ok_or(StreamError::MathOverflow)?;
            Self::validate_stream_creation(now, input.deposit_amount, input.start_time, input.end_time)?;
            let fee = treasury::fee_amount(input.deposit_amount, fee_bps)?;
            let pull_amount = input.deposit_amount.checked_add(fee).ok_or(StreamError::MathOverflow)?;
            let mut token_index = 0;
            let mut found = false;
            while token_index < pull_totals.len() {
                let (token, total) = pull_totals.get(token_index).ok_or(StreamError::MathOverflow)?;
                if token == input.token {
                    pull_totals.set(token_index, (token, total.checked_add(pull_amount).ok_or(StreamError::MathOverflow)?));
                    found = true;
                    break;
                }
                token_index += 1;
            }
            if !found {
                pull_totals.push_back((input.token, pull_amount));
            }
            fees.push_back(fee);
            index += 1;
        }

        let first_id = stream::reserve_stream_ids(&env, count)?;
        index = 0;
        while index < count {
            let id = first_id.checked_add(index as u64).ok_or(StreamError::MathOverflow)?;
            ids.push_back(id);
            index += 1;
        }

        let mut token_index = 0;
        while token_index < pull_totals.len() {
            let (token, amount) = pull_totals.get(token_index).ok_or(StreamError::MathOverflow)?;
            pull(&env, &token, &sender, amount, Branch::CreateDepositTransferFailed)?;
            token_index += 1;
        }

        let mut index = 0;
        while index < count {
            let input = inputs.get(index).ok_or(StreamError::MathOverflow)?;
            let id = ids.get(index).ok_or(StreamError::MathOverflow)?;
            let fee = fees.get(index).ok_or(StreamError::MathOverflow)?;
            let created = Stream {
                id,
                sender: sender.clone(),
                recipient: input.recipient,
                token: input.token,
                deposit: input.deposit_amount,
                withdrawn: 0,
                start_time: input.start_time,
                end_time: input.end_time,
                cancelable: input.cancelable,
                status: StreamStatus::Active,
            };
            stream::put_stream(&env, &created);
            stream::index_stream(&env, &created);
            if fee > 0 {
                treasury::apply_fee(&env, &created.token, id, fee)?;
                FeeCharged {
                    stream_id: id,
                    token: created.token.clone(),
                    payer: sender.clone(),
                    amount: fee,
                    fee_bps,
                }
                .publish(&env);
            }
            index += 1;
        }

        StreamsCreated { sender, stream_ids: ids.clone() }.publish(&env);
        Ok(ids)
    }

    /// Creates a stream with a cliff and piecewise vesting schedule.
    #[allow(clippy::too_many_arguments)]
    pub fn create_stream_vested(
        env: Env,
        sender: Address,
        recipient: Address,
        token: Address,
        deposit_amount: i128,
        start_time: u64,
        end_time: u64,
        cancelable: bool,
        schedule: Schedule,
    ) -> Result<u64, StreamError> {
        sender.require_auth();
        let now = env.ledger().timestamp();
        Self::validate_stream_creation(now, deposit_amount, start_time, end_time)?;
        stream::validate_schedule(&schedule, start_time, end_time)?;

        let fee_bps = treasury::current_fee_bps(&env);
        let fee = treasury::fee_amount(deposit_amount, fee_bps)?;
        let pull_amount = deposit_amount.checked_add(fee).ok_or(StreamError::MathOverflow)?;

        pull(&env, &token, &sender, pull_amount, Branch::CreateDepositTransferFailed)?;

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
        stream::put_schedule(&env, id, &schedule);
        stream::index_stream(&env, &s);
        if fee > 0 {
            treasury::apply_fee(&env, &token, id, fee)?;
        }

        StreamCreatedVested {
            stream_id: id,
            sender,
            recipient,
            token,
            deposit: deposit_amount,
            start_time,
            end_time,
            cancelable,
            cliff_time: schedule.cliff_time,
        }
        .publish(&env);

        if fee > 0 {
            FeeCharged {
                stream_id: id,
                token: s.token.clone(),
                payer: s.sender.clone(),
                amount: fee,
                fee_bps,
            }
            .publish(&env);
        }

        Ok(id)
    }

    /// Read-only view of the vesting schedule attached to a stream.
    pub fn get_schedule(env: Env, stream_id: u64) -> Result<Option<Schedule>, StreamError> {
        stream::get_stream(&env, stream_id)?;
        Ok(stream::get_schedule(&env, stream_id))
    }

    fn validate_stream_creation(
        now: u64,
        deposit_amount: i128,
        start_time: u64,
        end_time: u64,
    ) -> Result<(), StreamError> {
        if deposit_amount <= 0 {
            return Err(surface::reject(Branch::CreateDepositNonPositive));
        }
        if start_time < now {
            return Err(surface::reject(Branch::CreateStartTimeInPast));
        }
        if end_time <= start_time {
            return Err(surface::reject(Branch::CreateInvalidTimeRange));
        }
        let duration = end_time - start_time;
        if duration > MAX_DURATION_SECONDS {
            return Err(surface::reject(Branch::CreateDurationTooLong));
        }
        stream::validate_capacity(deposit_amount, duration)
    }

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

    pub fn withdraw_max(env: Env, stream_id: u64) -> Result<i128, StreamError> {
        let mut s = Self::authorize_withdrawal(&env, stream_id)?;
        let amount = stream::available_amount(&env, &s)?;
        if amount <= 0 {
            return Err(surface::reject(Branch::WithdrawMaxNothingToWithdraw));
        }
        Self::pay_out(&env, &mut s, amount)?;
        Ok(amount)
    }

    fn authorize_withdrawal(env: &Env, stream_id: u64) -> Result<Stream, StreamError> {
        let s = stream::get_stream(env, stream_id)?;
        s.recipient.require_auth();
        if s.status != StreamStatus::Active {
            return Err(surface::reject(Branch::StreamNotActive));
        }
        Ok(s)
    }

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
        push(env, &s.token, &stream::muxed(&s.recipient), amount, Branch::RecipientPayoutFailed)
    }

    pub fn cancel_stream(env: Env, caller: Address, stream_id: u64) -> Result<(), StreamError> {
        caller.require_auth();
        let mut s = stream::get_stream(&env, stream_id)?;
        if s.status != StreamStatus::Active {
            return Err(surface::reject(Branch::StreamNotActive));
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
        s.status = StreamStatus::Cancelled;
        s.withdrawn = s
            .withdrawn
            .checked_add(recipient_amount)
            .ok_or_else(|| surface::reject(Branch::CancelSplitOverflow))?;
        stream::put_stream(&env, &s);
        StreamCancelled { stream_id, cancelled_by: caller, recipient_amount, sender_amount }
            .publish(&env);
        if recipient_amount > 0 {
            push(&env, &s.token, &stream::muxed(&s.recipient), recipient_amount, Branch::RecipientPayoutFailed)?;
        }
        if sender_amount > 0 {
            push(&env, &s.token, &stream::muxed(&s.sender), sender_amount, Branch::SenderRefundFailed)?;
        }
        Ok(())
    }

    pub fn top_up(env: Env, stream_id: u64, amount: i128) -> Result<(), StreamError> {
        if amount <= 0 {
            return Err(surface::reject(Branch::TopUpAmountNonPositive));
        }
        let mut s = stream::get_stream(&env, stream_id)?;
        if s.status != StreamStatus::Active {
            return Err(surface::reject(Branch::StreamNotActive));
        }
        s.sender.require_auth();
        let new_deposit = s
            .deposit
            .checked_add(amount)
            .ok_or_else(|| surface::reject(Branch::TopUpDepositOverflow))?;
        stream::validate_capacity(new_deposit, s.duration())?;
        pull(&env, &s.token, &s.sender, amount, Branch::TopUpTransferFailed)?;
        s.deposit = new_deposit;
        stream::put_stream(&env, &s);
        StreamToppedUp { stream_id, sender: s.sender.clone(), amount, new_deposit }.publish(&env);
        Ok(())
    }

    pub fn get_stream(env: Env, stream_id: u64) -> Result<Stream, StreamError> {
        stream::get_stream(&env, stream_id)
    }

    pub fn available(env: Env, stream_id: u64) -> Result<i128, StreamError> {
        let s = stream::get_stream(&env, stream_id)?;
        stream::available_amount(&env, &s)
    }

    pub fn recipient_streams(env: Env, recipient: Address, offset: u32, limit: u32) -> Vec<u64> {
        stream::page_stream_ids(&env, &stream::DataKey::RecipientStreams(recipient), offset, limit)
    }

    pub fn sender_streams(env: Env, sender: Address, offset: u32, limit: u32) -> Vec<u64> {
        stream::page_stream_ids(&env, &stream::DataKey::SenderStreams(sender), offset, limit)
    }

    pub fn set_fee_bps(env: Env, caller: Address, new_fee_bps: u32) -> Result<(), StreamError> {
        treasury::require_governor(&env, &caller)?;
        if new_fee_bps > MAX_FEE_BPS {
            return Err(surface::reject(Branch::SetFeeRateTooHigh));
        }
        treasury::set_fee_bps(&env, new_fee_bps);
        env.storage().instance().extend_ttl(stream::TTL_THRESHOLD_LEDGERS, stream::TTL_EXTEND_LEDGERS);
        Ok(())
    }

    pub fn nominate_governor(env: Env, caller: Address, new_governor: Address) -> Result<(), StreamError> {
        treasury::require_governor(&env, &caller)?;
        env.storage().instance().set(&stream::DataKey::PendingGovernor, &new_governor);
        env.storage().instance().extend_ttl(stream::TTL_THRESHOLD_LEDGERS, stream::TTL_EXTEND_LEDGERS);
        Ok(())
    }

    pub fn accept_governor(env: Env, caller: Address) -> Result<(), StreamError> {
        let pending: Address = env
            .storage()
            .instance()
            .get(&stream::DataKey::PendingGovernor)
            .ok_or_else(|| surface::reject(Branch::AcceptGovernorNoPending))?;
        if pending != caller {
            return Err(surface::reject(Branch::AcceptGovernorNotNominee));
        }
        caller.require_auth();
        env.storage().instance().set(&stream::DataKey::Governor, &caller);
        env.storage().instance().remove(&stream::DataKey::PendingGovernor);
        env.storage().instance().extend_ttl(stream::TTL_THRESHOLD_LEDGERS, stream::TTL_EXTEND_LEDGERS);
        Ok(())
    }

    pub fn withdraw_treasury(
        env: Env,
        caller: Address,
        token: Address,
        recipient: Address,
        amount: i128,
    ) -> Result<(), StreamError> {
        treasury::require_governor(&env, &caller)?;
        if amount <= 0 {
            return Err(surface::reject(Branch::WithdrawTreasuryAmountNonPositive));
        }
        let mut t = treasury::get_treasury(&env, &token);
        if amount > t.collectible()? {
            return Err(surface::reject(Branch::WithdrawTreasuryExceedsBalance));
        }
        t.withdrawn_total = t.withdrawn_total.checked_add(amount).ok_or(StreamError::MathOverflow)?;
        treasury::put_treasury(&env, &token, &t);
        FeeWithdrawn {
            token: token.clone(),
            governor: caller,
            recipient: recipient.clone(),
            amount,
            withdrawn_total: t.withdrawn_total,
        }
        .publish(&env);
        push(&env, &token, &stream::muxed(&recipient), amount, Branch::TreasuryPayoutFailed)?;
        Ok(())
    }

    pub fn treasury_status(env: Env, token: Address) -> TreasuryStatus {
        let t = treasury::get_treasury(&env, &token);
        let collectible = t.collectible().unwrap_or(0);
        TreasuryStatus {
            token,
            governor: treasury::governor(&env),
            pending_governor: treasury::pending_governor(&env),
            fee_bps: treasury::current_fee_bps(&env),
            max_fee_bps: MAX_FEE_BPS,
            charged_total: t.charged_total,
            withdrawn_total: t.withdrawn_total,
            collectible,
        }
    }

    pub fn stream_fee(env: Env, stream_id: u64) -> Result<i128, StreamError> {
        stream::get_stream(&env, stream_id)?;
        Ok(treasury::stream_fee(&env, stream_id))
    }

    pub fn verify_treasury(env: Env, token: Address, start_id: u64, count: u32) -> FeeScan {
        treasury::scan_fees(&env, &token, start_id, count)
    }

    pub fn total_streams(env: Env) -> u64 {
        let next: u64 = env.storage().persistent().get(&stream::DataKey::NextStreamId).unwrap_or(1);
        next.saturating_sub(1)
    }
}
