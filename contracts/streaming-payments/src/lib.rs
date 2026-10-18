#![no_std]
//! StreamPay: continuous, linear streaming payments for Stellar (Soroban).

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod cei_trace;
mod client_parity_test;
#[cfg(test)]
mod differential_harness;
#[cfg(test)]
mod differential_test;
#[cfg(test)]
mod error_surface_test;
mod errors;
mod events;
mod policy;
mod schedule;
#[cfg(test)]
mod schedule_test;
mod stream;
pub mod surface;
#[cfg(test)]
mod test;
#[cfg(any(test, feature = "testutils"))]
pub mod test_client;
mod treasury;
pub mod verification;

use soroban_sdk::{
    contract, contractimpl, contracttype, token::TokenClient, Address, BytesN, ConversionError,
    Env, Error as SorobanError, InvokeError, MuxedAddress, Vec,
};

use surface::Branch;

pub use errors::StreamError;
pub use events::{
    ContractFrozenStateChanged, ContractUpgraded, FeeCharged, FeeWithdrawn, PolicyAssetExecuted,
    PolicyAssetQueued, PolicyHandoffAccepted, PolicyHandoffCancelled, PolicyHandoffProposed,
    PolicyInitialized, ScheduledIntentCancelled, ScheduledIntentExpired, ScheduledStreamExecuted,
    StorageMigrated, StreamCancelled, StreamCreated, StreamCreatedVested, StreamPolicySet,
    StreamScheduled, StreamToppedUp, StreamsCreated, UpgradeCancelled, UpgradeProposed, Withdrawn,
};
pub use policy::{validate_stream_args, validate_top_up_args, QueuedAssetChange, StreamPolicy};
pub use schedule::{IntentStatus, ScheduledIntent, MAX_OCCURRENCES};
// `streamed_at` and `scheduled_vested_at` are re-exported for the fuzz target
// and downstream rate calculators: both are pure functions requiring no `Env`.
pub use stream::{
    scheduled_vested_at, streamed_at, MigrationStatus, PendingUpgrade, Schedule, Stream,
    StreamStatus, VestingStep, INITIAL_SCHEMA_VERSION, MAX_DURATION_SECONDS,
    MAX_MIGRATION_BATCH_SIZE, MAX_PAGE_SIZE, MIN_UPGRADE_DELAY_SECONDS, TARGET_SCHEMA_VERSION,
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
    #[cfg(test)]
    cei_trace::record("transfer_from token");
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
    #[cfg(test)]
    cei_trace::record(match on_failure {
        Branch::RecipientPayoutFailed => "transfer recipient payout",
        Branch::SenderRefundFailed => "transfer sender refund",
        Branch::TreasuryPayoutFailed => "transfer treasury payout",
        _ => "transfer token",
    });
    let res = TokenClient::new(env, token).try_transfer(
        &env.current_contract_address(),
        recipient,
        &amount,
    );
    token_result(res, on_failure)
}

#[contractimpl]
impl StreamingPayments {
    /// Internal helper: verifies that mutating entrypoints are not called
    /// while the contract is frozen for maintenance or upgrade.
    fn require_not_frozen(env: &Env) -> Result<(), StreamError> {
        if stream::is_frozen(env) {
            return Err(surface::reject(Branch::ContractFrozen));
        }
        Ok(())
    }

    pub fn __constructor(env: Env, governor: Address) {
        env.storage().instance().set(&stream::DataKey::Governor, &governor);
        env.storage().instance().extend_ttl(stream::TTL_THRESHOLD_LEDGERS, stream::TTL_EXTEND_LEDGERS);
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
        Self::require_not_frozen(&env)?;
        sender.require_auth();
        let now = env.ledger().timestamp();
        Self::validate_stream_creation(now, deposit_amount, start_time, end_time)?;
        // Policy check: if the policy module is active, the asset must be on
        // the allowlist. Uninitialized policy permits all assets (opt-in).
        policy::check_asset_allowed(&env, &token)?;
        let stream_policy = policy::get_stream_policy(&env, Some(token.clone()));
        let duration = end_time - start_time;
        policy::validate_stream_args(stream_policy.as_ref(), deposit_amount, duration)?;
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

    /// Allocates the next stream id, persists the stream, indexes it under both
    /// parties, and emits [`StreamCreated`]. No authorization and no token
    /// movement: callers are responsible for the checks and for having the
    /// deposit escrowed in the contract (scheduled execution uses an intent's
    /// already-escrowed deposit).
    #[allow(clippy::too_many_arguments)]
    fn create_stream_internal(
        env: &Env,
        sender: Address,
        recipient: Address,
        token: Address,
        deposit: i128,
        start_time: u64,
        end_time: u64,
        cancelable: bool,
    ) -> u64 {
        let id = stream::next_stream_id(env);
        let stream = Stream {
            id,
            sender: sender.clone(),
            recipient: recipient.clone(),
            token: token.clone(),
            deposit,
            withdrawn: 0,
            start_time,
            end_time,
            cancelable,
            status: StreamStatus::Active,
        };
        stream::put_stream(env, &stream);
        stream::index_stream(env, &stream);
        #[cfg(test)]
        cei_trace::record("event StreamCreated");
        StreamCreated {
            stream_id: id,
            sender,
            recipient,
            token,
            deposit,
            start_time,
            end_time,
            cancelable,
        }
        .publish(env);
        id
    }

    /// Creates multiple streams atomically, authorizing the sender once and
    /// grouping deposits into one token pull per token.
    pub fn create_streams(
        env: Env,
        sender: Address,
        inputs: Vec<StreamInput>,
    ) -> Result<Vec<u64>, StreamError> {
        Self::require_not_frozen(&env)?;
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
            Self::validate_stream_creation(
                now,
                input.deposit_amount,
                input.start_time,
                input.end_time,
            )?;
            policy::check_asset_allowed(&env, &input.token)?;
            let stream_policy = policy::get_stream_policy(&env, Some(input.token.clone()));
            let duration = input.end_time - input.start_time;
            policy::validate_stream_args(stream_policy.as_ref(), input.deposit_amount, duration)?;
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
        Self::require_not_frozen(&env)?;
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

    pub fn withdraw(env: Env, stream_id: u64, amount: i128) -> Result<(), StreamError> {
        Self::require_not_frozen(&env)?;
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
        Self::require_not_frozen(&env)?;
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
        #[cfg(test)]
        cei_trace::record("event Withdrawn");
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
        Self::require_not_frozen(&env)?;
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
        #[cfg(test)]
        cei_trace::record("event StreamCancelled");
        StreamCancelled {
            stream_id,
            cancelled_by: caller,
            recipient_amount,
            sender_amount,
        }
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
        Self::require_not_frozen(&env)?;
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
        let stream_policy = policy::get_stream_policy(&env, Some(s.token.clone()));
        policy::validate_top_up_args(stream_policy.as_ref(), new_deposit, s.duration())?;
        pull(&env, &s.token, &s.sender, amount, Branch::TopUpTransferFailed)?;
        s.deposit = new_deposit;
        stream::put_stream(&env, &s);
        #[cfg(test)]
        cei_trace::record("event StreamToppedUp");
        StreamToppedUp {
            stream_id,
            sender: s.sender.clone(),
            amount,
            new_deposit,
        }
        .publish(&env);
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

    // ------------------------------------------------- scheduled intents ----

    #[allow(clippy::too_many_arguments)]
    pub fn schedule_stream(
        env: Env,
        sender: Address,
        recipient: Address,
        token: Address,
        deposit_amount: i128,
        start_time: u64,
        end_time: u64,
        cancelable: bool,
        interval: u64,
        occurrences: u32,
        fee_budget: i128,
        execute_after: u64,
        expires_at: u64,
    ) -> Result<u64, StreamError> {
        sender.require_auth();
        let total_escrow = schedule::validate_schedule(
            &env,
            deposit_amount,
            start_time,
            end_time,
            interval,
            occurrences,
            fee_budget,
            execute_after,
            expires_at,
        )?;
        let id = schedule::next_intent_id(&env);
        let params_hash = schedule::params_hash(
            &env,
            &sender,
            &recipient,
            &token,
            deposit_amount,
            start_time,
            end_time,
            cancelable,
            interval,
            occurrences,
            fee_budget,
            execute_after,
            expires_at,
        );
        let intent = ScheduledIntent {
            id,
            sender: sender.clone(),
            recipient: recipient.clone(),
            token: token.clone(),
            deposit: deposit_amount,
            start_time,
            end_time,
            cancelable,
            interval,
            occurrences_total: occurrences,
            occurrences_remaining: occurrences,
            fee_budget,
            execute_after,
            expires_at,
            params_hash,
            status: IntentStatus::Pending,
        };
        schedule::put_intent(&env, &intent);
        schedule::index_intent(&env, &intent);
        StreamScheduled {
            intent_id: id,
            sender: sender.clone(),
            recipient,
            token: token.clone(),
            deposit: deposit_amount,
            start_time,
            end_time,
            cancelable,
            interval,
            occurrences,
            fee_budget,
            execute_after,
            expires_at,
        }
        .publish(&env);
        TokenClient::new(&env, &token).transfer_from(
            &env.current_contract_address(),
            &sender,
            &env.current_contract_address(),
            &total_escrow,
        );
        Ok(id)
    }

    pub fn execute_scheduled(
        env: Env,
        intent_id: u64,
        keeper: Address,
    ) -> Result<u64, StreamError> {
        keeper.require_auth();
        let mut intent = schedule::get_intent(&env, intent_id)?;
        if intent.status != IntentStatus::Pending {
            return Err(surface::reject(Branch::IntentNotPending));
        }
        if schedule::intent_params_hash(&env, &intent) != intent.params_hash {
            return Err(surface::reject(Branch::IntentParamsMismatch));
        }
        let now = env.ledger().timestamp();
        if now >= intent.expires_at {
            return Err(surface::reject(Branch::IntentExpired));
        }
        let index = intent.executed_count();
        if now < intent.occurrence_due(index) {
            return Err(surface::reject(Branch::IntentNotYetExecutable));
        }
        let (start_time, end_time) = intent.occurrence_window(index);
        intent.occurrences_remaining = intent
            .occurrences_remaining
            .checked_sub(1)
            .ok_or(StreamError::MathOverflow)?;
        if intent.occurrences_remaining == 0 {
            intent.status = IntentStatus::Executed;
        }
        schedule::put_intent(&env, &intent);
        let stream_id = Self::create_stream_internal(
            &env,
            intent.sender.clone(),
            intent.recipient.clone(),
            intent.token.clone(),
            intent.deposit,
            start_time,
            end_time,
            intent.cancelable,
        );
        let fee_paid = intent.fee_budget;
        if fee_paid > 0 {
            #[cfg(test)]
            cei_trace::record("transfer keeper fee");
            TokenClient::new(&env, &intent.token).transfer(
                &env.current_contract_address(),
                stream::muxed(&keeper),
                &fee_paid,
            );
        }
        #[cfg(test)]
        cei_trace::record("event ScheduledStreamExecuted");
        ScheduledStreamExecuted {
            intent_id,
            keeper,
            stream_id,
            occurrence_index: index,
            occurrences_remaining: intent.occurrences_remaining,
            fee_paid,
        }
        .publish(&env);
        Ok(stream_id)
    }

    pub fn cancel_scheduled(
        env: Env,
        sender: Address,
        intent_id: u64,
    ) -> Result<(), StreamError> {
        sender.require_auth();
        let mut intent = schedule::get_intent(&env, intent_id)?;
        if intent.status != IntentStatus::Pending {
            return Err(surface::reject(Branch::IntentNotPending));
        }
        if sender != intent.sender {
            return Err(StreamError::NotAuthorized);
        }
        let now = env.ledger().timestamp();
        if now >= intent.expires_at {
            return Err(surface::reject(Branch::IntentExpired));
        }
        if now >= intent.execute_after {
            return Err(surface::reject(Branch::IntentNotCancellable));
        }
        let refund = intent.remaining_escrow()?;
        intent.status = IntentStatus::Cancelled;
        schedule::put_intent(&env, &intent);
        if refund > 0 {
            #[cfg(test)]
            cei_trace::record("transfer scheduled refund");
            TokenClient::new(&env, &intent.token).transfer(
                &env.current_contract_address(),
                stream::muxed(&intent.sender),
                &refund,
            );
        }
        #[cfg(test)]
        cei_trace::record("event ScheduledIntentCancelled");
        ScheduledIntentCancelled {
            intent_id,
            sender: intent.sender.clone(),
            refund,
        }
        .publish(&env);
        Ok(())
    }

    pub fn reclaim_expired(env: Env, intent_id: u64) -> Result<(), StreamError> {
        let mut intent = schedule::get_intent(&env, intent_id)?;
        if intent.status != IntentStatus::Pending {
            return Err(surface::reject(Branch::IntentNotPending));
        }
        let now = env.ledger().timestamp();
        if now < intent.expires_at {
            return Err(surface::reject(Branch::IntentNotExpired));
        }
        let refund = intent.remaining_escrow()?;
        intent.status = IntentStatus::Expired;
        schedule::put_intent(&env, &intent);
        if refund > 0 {
            #[cfg(test)]
            cei_trace::record("transfer scheduled refund");
            TokenClient::new(&env, &intent.token).transfer(
                &env.current_contract_address(),
                stream::muxed(&intent.sender),
                &refund,
            );
        }
        #[cfg(test)]
        cei_trace::record("event ScheduledIntentExpired");
        ScheduledIntentExpired {
            intent_id,
            sender: intent.sender.clone(),
            refund,
        }
        .publish(&env);
        Ok(())
    }

    pub fn get_intent(env: Env, intent_id: u64) -> Result<ScheduledIntent, StreamError> {
        schedule::get_intent(&env, intent_id)
    }

    pub fn sender_intents(env: Env, sender: Address, offset: u32, limit: u32) -> Vec<u64> {
        stream::page_stream_ids(&env, &stream::DataKey::SenderIntents(sender), offset, limit)
    }

    // ------------------------------------------------------------ treasury --

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
        #[cfg(test)]
        cei_trace::record("event FeeWithdrawn");
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
        let next: u64 = env
            .storage()
            .persistent()
            .get(&stream::DataKey::NextStreamId)
            .unwrap_or(1);
        next.saturating_sub(1)
    }

    // ------------------------------------------------------------- policy --

    pub fn policy_init(env: Env, admin: Address) {
        policy::init(&env, &admin);
    }

    pub fn policy_propose_asset(env: Env, asset: Address, allowed: bool) -> Result<(), StreamError> {
        policy::propose_asset(&env, asset, allowed)
    }

    pub fn policy_execute_asset(env: Env, asset: Address) -> Result<(), StreamError> {
        policy::execute_asset(&env, asset)
    }

    pub fn policy_propose_handoff(env: Env, new_admin: Address) -> Result<(), StreamError> {
        policy::propose_handoff(&env, new_admin)
    }

    pub fn policy_accept_handoff(env: Env) -> Result<(), StreamError> {
        policy::accept_handoff(&env)
    }

    pub fn policy_cancel_handoff(env: Env) -> Result<(), StreamError> {
        policy::cancel_handoff(&env)
    }

    pub fn policy_admin(env: Env) -> Option<Address> {
        policy::admin(&env)
    }

    pub fn policy_pending_admin(env: Env) -> Option<Address> {
        policy::pending_admin(&env)
    }

    pub fn policy_timelock_delay(env: Env) -> u64 {
        policy::timelock_delay(&env)
    }

    pub fn policy_set_timelock_delay(env: Env, delay: u64) -> Result<(), StreamError> {
        policy::set_timelock_delay(&env, delay)
    }

    pub fn policy_is_asset_allowed(env: Env, asset: Address) -> bool {
        policy::is_asset_allowed(&env, &asset)
    }

    pub fn policy_get_queued_asset(env: Env, asset: Address) -> Option<QueuedAssetChange> {
        policy::get_queued_asset(&env, &asset)
    }

    pub fn set_stream_policy(
        env: Env,
        caller: Address,
        token: Option<Address>,
        policy: StreamPolicy,
    ) -> Result<(), StreamError> {
        Self::require_not_frozen(&env)?;
        treasury::require_governor(&env, &caller)?;
        policy::set_stream_policy(&env, token, policy)
    }

    pub fn get_stream_policy(env: Env, token: Option<Address>) -> Option<StreamPolicy> {
        policy::get_stream_policy(&env, token)
    }

    // --------------------------------------------- upgrade & migration --

    pub fn schema_version(env: Env) -> u32 {
        stream::schema_version(&env)
    }

    pub fn is_frozen(env: Env) -> bool {
        stream::is_frozen(&env)
    }

    pub fn set_frozen(env: Env, caller: Address, frozen: bool) -> Result<(), StreamError> {
        treasury::require_governor(&env, &caller)?;
        stream::set_frozen(&env, frozen);
        ContractFrozenStateChanged { frozen, changed_by: caller }.publish(&env);
        Ok(())
    }

    pub fn propose_upgrade(
        env: Env,
        caller: Address,
        new_wasm_hash: BytesN<32>,
        delay_seconds: u64,
    ) -> Result<(), StreamError> {
        treasury::require_governor(&env, &caller)?;
        if delay_seconds < stream::MIN_UPGRADE_DELAY_SECONDS {
            return Err(surface::reject(Branch::UpgradeDelayTooShort));
        }
        let now = env.ledger().timestamp();
        let unlock_time = now.checked_add(delay_seconds).ok_or(StreamError::MathOverflow)?;
        let pending = PendingUpgrade { new_wasm_hash: new_wasm_hash.clone(), unlock_time };
        stream::set_pending_upgrade(&env, &pending);
        UpgradeProposed { new_wasm_hash, unlock_time, proposer: caller }.publish(&env);
        Ok(())
    }

    pub fn cancel_upgrade(env: Env, caller: Address) -> Result<(), StreamError> {
        treasury::require_governor(&env, &caller)?;
        let pending = stream::pending_upgrade(&env)
            .ok_or_else(|| surface::reject(Branch::CancelUpgradeNoPending))?;
        stream::remove_pending_upgrade(&env);
        UpgradeCancelled { new_wasm_hash: pending.new_wasm_hash, cancelled_by: caller }.publish(&env);
        Ok(())
    }

    pub fn execute_upgrade(env: Env, caller: Address) -> Result<(), StreamError> {
        treasury::require_governor(&env, &caller)?;
        let pending = stream::pending_upgrade(&env)
            .ok_or_else(|| surface::reject(Branch::ExecuteUpgradeNoPending))?;
        let now = env.ledger().timestamp();
        if now < pending.unlock_time {
            return Err(surface::reject(Branch::TimelockNotExpired));
        }
        env.deployer().update_current_contract(soroban_sdk::ContractExecutable::Wasm(
            pending.new_wasm_hash.clone(),
        ));
        stream::remove_pending_upgrade(&env);
        ContractUpgraded { new_wasm_hash: pending.new_wasm_hash, executed_by: caller }.publish(&env);
        Ok(())
    }

    pub fn pending_upgrade(env: Env) -> Option<PendingUpgrade> {
        stream::pending_upgrade(&env)
    }

    pub fn migrate_storage(
        env: Env,
        caller: Address,
        start_id: u64,
        count: u32,
    ) -> Result<MigrationStatus, StreamError> {
        treasury::require_governor(&env, &caller)?;
        if !stream::is_frozen(&env) {
            return Err(surface::reject(Branch::MigrationNotFrozen));
        }
        let current_version = stream::schema_version(&env);
        if current_version >= stream::TARGET_SCHEMA_VERSION {
            return Err(surface::reject(Branch::AlreadyMigrated));
        }
        let total = Self::total_streams(env.clone());
        let batch_size = count.clamp(1, stream::MAX_MIGRATION_BATCH_SIZE) as u64;
        if total == 0 {
            stream::set_schema_version(&env, stream::TARGET_SCHEMA_VERSION);
            stream::set_migration_cursor(&env, 0);
            StorageMigrated {
                from_version: current_version,
                to_version: stream::TARGET_SCHEMA_VERSION,
                start_id: 0,
                end_id: 0,
                is_complete: true,
            }
            .publish(&env);
            return Ok(MigrationStatus {
                current_version: stream::TARGET_SCHEMA_VERSION,
                target_version: stream::TARGET_SCHEMA_VERSION,
                cursor: 0,
                total_streams: 0,
                is_complete: true,
            });
        }
        let cursor = stream::migration_cursor(&env);
        let effective_start = if start_id == 0 { cursor.saturating_add(1) } else { start_id };
        let effective_start = effective_start.clamp(1, total);
        let end_id = (effective_start.saturating_add(batch_size).saturating_sub(1)).min(total);
        for id in effective_start..=end_id {
            if let Ok(s) = stream::get_stream(&env, id) {
                stream::put_stream(&env, &s);
            }
        }
        let new_cursor = cursor.max(end_id);
        stream::set_migration_cursor(&env, new_cursor);
        let is_complete = new_cursor >= total;
        let new_version = if is_complete {
            stream::set_schema_version(&env, stream::TARGET_SCHEMA_VERSION);
            stream::TARGET_SCHEMA_VERSION
        } else {
            current_version
        };
        StorageMigrated {
            from_version: current_version,
            to_version: new_version,
            start_id: effective_start,
            end_id,
            is_complete,
        }
        .publish(&env);
        Ok(MigrationStatus {
            current_version: new_version,
            target_version: stream::TARGET_SCHEMA_VERSION,
            cursor: new_cursor,
            total_streams: total,
            is_complete,
        })
    }

    pub fn migration_progress(env: Env) -> MigrationStatus {
        let current_version = stream::schema_version(&env);
        let cursor = stream::migration_cursor(&env);
        let total = Self::total_streams(env);
        let is_complete = current_version >= stream::TARGET_SCHEMA_VERSION;
        MigrationStatus {
            current_version,
            target_version: stream::TARGET_SCHEMA_VERSION,
            cursor,
            total_streams: total,
            is_complete,
        }
    }
}
