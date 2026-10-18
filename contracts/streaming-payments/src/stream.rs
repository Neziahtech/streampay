//! Stream state, storage, and the checked accrual math.
//!
//! Accrual is linear over the stream window: a stream funded with `deposit`
//! between `start_time` and `end_time` streams `deposit * elapsed / duration`
//! tokens, floored to whole token units. All arithmetic is checked (`u128`
//! intermediate products) and returns [`StreamError::MathOverflow`] instead of
//! overflowing or panicking.

use soroban_sdk::{contracttype, Address, BytesN, Env, MuxedAddress, Vec};

use crate::errors::StreamError;
use crate::surface::{self, Branch};

// -------------------------------------------------------- cliff / vesting --

/// Basis-point denominator shared with treasury math. One full schedule sums
/// to exactly this many bps.
const BPS_DENOM: u32 = 10_000;

/// One step in a vesting schedule: the stream accrues at `rate_bps / 10_000`
/// of its deposit-per-second rate from this `time` until the next step's time
/// (or `end_time` for the final step).
///
/// Steps must be stored in strict ascending `time` order, and the sum of all
/// `rate_bps` values must equal `10_000` (100 % of the deposit).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingStep {
    /// Absolute Unix timestamp (seconds) at which this rate takes effect.
    pub time: u64,
    /// Rate in basis points (1 bp = 0.01 %). `rate_bps / 10_000` of the
    /// deposit accrues linearly per second within this step's window.
    pub rate_bps: u32,
}

/// Optional vesting schedule that augments a stream with a cliff and
/// piecewise-constant accrual rates.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Schedule {
    pub cliff_time: u64,
    pub steps: Vec<VestingStep>,
}

/// Validates a [`Schedule`] against its parent stream's time bounds.
pub fn validate_schedule(
    schedule: &Schedule,
    start_time: u64,
    end_time: u64,
) -> Result<(), StreamError> {
    if schedule.steps.is_empty() {
        return Err(surface::reject(Branch::CreateInvalidSchedule));
    }
    if schedule.cliff_time < start_time || schedule.cliff_time > end_time {
        return Err(surface::reject(Branch::CreateInvalidSchedule));
    }
    if schedule.steps.get(0).map(|s| s.time) != Some(start_time) {
        return Err(surface::reject(Branch::CreateInvalidSchedule));
    }
    let mut rate_sum: u32 = 0;
    let mut prev_time: u64 = 0;
    let n = schedule.steps.len();
    for i in 0..n {
        let step = schedule.steps.get(i).unwrap();
        if i > 0 && step.time <= prev_time {
            return Err(surface::reject(Branch::CreateInvalidSchedule));
        }
        if step.time >= end_time {
            return Err(surface::reject(Branch::CreateInvalidSchedule));
        }
        rate_sum = rate_sum
            .checked_add(step.rate_bps)
            .ok_or_else(|| surface::reject(Branch::CreateInvalidSchedule))?;
        prev_time = step.time;
    }
    if rate_sum != BPS_DENOM {
        return Err(surface::reject(Branch::CreateInvalidSchedule));
    }
    Ok(())
}

/// Pure vested-amount function for a scheduled stream.
///
/// This is a pure function (no `Env`): the fuzz harness can call it directly.
pub fn scheduled_vested_at(
    deposit: i128,
    start_time: u64,
    end_time: u64,
    schedule: &Schedule,
    elapsed: u64,
) -> Result<i128, StreamError> {
    if elapsed == 0 || deposit <= 0 {
        return Ok(0);
    }
    let now = start_time.saturating_add(elapsed).min(end_time);
    let mut total: i128 = 0;
    let n = schedule.steps.len();
    for i in 0..n {
        let step = schedule.steps.get(i).unwrap();
        let step_start = step.time;
        let step_end = if i + 1 < n {
            schedule.steps.get(i + 1).unwrap().time
        } else {
            end_time
        };
        if now <= step_start {
            break;
        }
        let step_duration = step_end - step_start;
        let step_elapsed = now.min(step_end) - step_start;
        let step_deposit_u128 = (deposit as u128)
            .checked_mul(step.rate_bps as u128)
            .ok_or_else(|| surface::reject(Branch::RateProductOverflow))?
            / (BPS_DENOM as u128);
        let step_deposit = step_deposit_u128.min(deposit as u128) as i128;
        let contribution = (step_deposit as u128)
            .checked_mul(step_elapsed as u128)
            .ok_or_else(|| surface::reject(Branch::RateProductOverflow))?
            / (step_duration as u128);
        total = total
            .checked_add(contribution as i128)
            .ok_or(StreamError::MathOverflow)?;
    }
    Ok(total.min(deposit))
}

/// Loads the optional [`Schedule`] for `stream_id`.
pub fn get_schedule(env: &Env, stream_id: u64) -> Option<Schedule> {
    env.storage().persistent().get(&DataKey::Schedule(stream_id))
}

/// Persists a [`Schedule`] and extends its TTL in lock-step with its stream.
pub fn put_schedule(env: &Env, stream_id: u64, schedule: &Schedule) {
    let key = DataKey::Schedule(stream_id);
    env.storage().persistent().set(&key, schedule);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

// ------------------------------------------------- upgrade / migration --

/// Minimum delay for an upgrade proposal timelock: 24 hours.
pub const MIN_UPGRADE_DELAY_SECONDS: u64 = 86_400;

/// Initial schema version (v1).
pub const INITIAL_SCHEMA_VERSION: u32 = 1;

/// Target schema version after migration (v2).
pub const TARGET_SCHEMA_VERSION: u32 = 2;

/// Maximum number of streams processed per migration call.
pub const MAX_MIGRATION_BATCH_SIZE: u32 = 50;

// ---------------------------------------------------------------- shared --

/// Maximum supported stream duration: 100 years, including leap days
/// (36,525 days). Bounds worst-case rate multiplications and rejects
/// nonsensical windows early.
pub const MAX_DURATION_SECONDS: u64 = 3_155_760_000;

/// Maximum number of stream ids a single paginated index query may return.
/// Callers asking for more are clamped down; this bounds per-call footprint
/// of the address-index views.
pub const MAX_PAGE_SIZE: u32 = 50;

/// TTL maintenance, in ledgers (~5 seconds per ledger on Stellar mainnet).
pub(crate) const TTL_THRESHOLD_LEDGERS: u32 = 200_000;
pub(crate) const TTL_EXTEND_LEDGERS: u32 = 500_000;

/// Lifecycle state of a stream.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum StreamStatus {
    Active,
    Cancelled,
    Depleted,
}

/// Full state of a payment stream.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Stream {
    pub id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    pub deposit: i128,
    pub withdrawn: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub cancelable: bool,
    pub status: StreamStatus,
}

impl Stream {
    pub fn duration(&self) -> u64 {
        self.end_time - self.start_time
    }
}

/// Proposed contract upgrade pending timelock expiration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingUpgrade {
    pub new_wasm_hash: BytesN<32>,
    pub unlock_time: u64,
}

/// Progress report for on-chain storage migration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationStatus {
    pub current_version: u32,
    pub target_version: u32,
    pub cursor: u64,
    pub total_streams: u64,
    pub is_complete: bool,
}

/// Storage keys for the contract.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    NextStreamId,
    Stream(u64),
    RecipientStreams(Address),
    SenderStreams(Address),
    NextIntentId,
    Intent(u64),
    SenderIntents(Address),
    Governor,
    PendingGovernor,
    FeeBps,
    Treasury(Address),
    StreamFee(u64),
    /// Optional vesting schedule attached to a stream (persistent storage;
    /// absent means plain linear accrual — the v0.x default).
    Schedule(u64),
    /// Schema version for storage layout evolution (instance storage).
    SchemaVersion,
    /// Freeze state: when true, all state-mutating entrypoints revert (instance storage).
    ContractFrozen,
    /// Proposed contract upgrade pending timelock expiration (instance storage).
    PendingUpgrade,
    /// Highest stream id processed by storage migration (instance storage).
    MigrationCursor,
}

pub fn elapsed_seconds(env: &Env, start_time: u64, end_time: u64) -> u64 {
    let now = env.ledger().timestamp();
    if now <= start_time {
        0
    } else if now >= end_time {
        end_time - start_time
    } else {
        now - start_time
    }
}

pub fn validate_capacity(deposit: i128, duration: u64) -> Result<(), StreamError> {
    let cap = u128::MAX / (duration.max(1) as u128);
    if (deposit as u128) > cap {
        return Err(surface::reject(Branch::CapacityOverflow));
    }
    Ok(())
}

pub fn streamed_at(deposit: i128, duration: u64, elapsed: u64) -> Result<i128, StreamError> {
    if elapsed == 0 || deposit <= 0 || duration == 0 {
        return Ok(0);
    }
    let product = (deposit as u128)
        .checked_mul(elapsed as u128)
        .ok_or_else(|| surface::reject(Branch::RateProductOverflow))?;
    let streamed = (product / (duration.max(1) as u128)).min(deposit as u128);
    Ok(streamed as i128)
}

/// Amount streamed (accrued) at the current ledger time.
///
/// For streams with an attached [`Schedule`] this delegates to
/// [`scheduled_vested_at`]; for plain streams it uses [`streamed_at`].
pub fn streamed_amount(env: &Env, stream: &Stream) -> Result<i128, StreamError> {
    let elapsed = elapsed_seconds(env, stream.start_time, stream.end_time);
    if let Some(schedule) = get_schedule(env, stream.id) {
        scheduled_vested_at(
            stream.deposit,
            stream.start_time,
            stream.end_time,
            &schedule,
            elapsed,
        )
    } else {
        streamed_at(stream.deposit, stream.duration(), elapsed)
    }
}

/// Accrued-but-unwithdrawn balance at the current ledger time.
///
/// Returns `StreamError::CliffNotReached` when the stream has a schedule and
/// the current time has not yet passed `cliff_time`.
pub fn available_amount(env: &Env, stream: &Stream) -> Result<i128, StreamError> {
    if stream.status == StreamStatus::Cancelled {
        return Ok(0);
    }
    if let Some(ref schedule) = get_schedule(env, stream.id) {
        let now = env.ledger().timestamp();
        if now < schedule.cliff_time {
            return Err(surface::reject(Branch::WithdrawBeforeCliff));
        }
    }
    let streamed = streamed_amount(env, stream)?;
    streamed
        .checked_sub(stream.withdrawn)
        .ok_or_else(|| surface::reject(Branch::AvailableBalanceOverflow))
}

pub fn cancel_amounts(env: &Env, stream: &Stream) -> Result<(i128, i128), StreamError> {
    let streamed = streamed_amount(env, stream)?;
    let recipient_amount = streamed
        .checked_sub(stream.withdrawn)
        .ok_or_else(|| surface::reject(Branch::CancelSplitOverflow))?;
    let sender_amount = stream
        .deposit
        .checked_sub(streamed)
        .ok_or_else(|| surface::reject(Branch::CancelSplitOverflow))?;
    Ok((recipient_amount, sender_amount))
}

pub(crate) fn muxed(addr: &Address) -> MuxedAddress {
    addr.clone().into()
}

pub fn next_stream_id(env: &Env) -> u64 {
    let key = DataKey::NextStreamId;
    let id: u64 = env.storage().persistent().get(&key).unwrap_or(1);
    env.storage().persistent().set(&key, &id.saturating_add(1));
    id
}

pub fn reserve_stream_ids(env: &Env, count: u32) -> Result<u64, StreamError> {
    let key = DataKey::NextStreamId;
    let first: u64 = env.storage().persistent().get(&key).unwrap_or(1);
    let next = first.checked_add(count as u64).ok_or(StreamError::MathOverflow)?;
    env.storage().persistent().set(&key, &next);
    Ok(first)
}

pub fn get_stream(env: &Env, id: u64) -> Result<Stream, StreamError> {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!("read persistent Stream({id})"));
    env.storage()
        .persistent()
        .get(&DataKey::Stream(id))
        .ok_or_else(|| surface::reject(Branch::StreamNotFound))
}

/// Persists a stream and extends its storage TTL. If the stream has an
/// attached schedule its TTL is extended in lockstep.
pub fn put_stream(env: &Env, stream: &Stream) {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!("write persistent Stream({})", stream.id));
    let key = DataKey::Stream(stream.id);
    env.storage().persistent().set(&key, stream);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    let sched_key = DataKey::Schedule(stream.id);
    if env.storage().persistent().has(&sched_key) {
        env.storage()
            .persistent()
            .extend_ttl(&sched_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    }
}

pub fn index_stream(env: &Env, stream: &Stream) {
    push_to_index(env, &DataKey::SenderStreams(stream.sender.clone()), stream.id);
    push_to_index(env, &DataKey::RecipientStreams(stream.recipient.clone()), stream.id);
}

pub(crate) fn push_to_index(env: &Env, key: &DataKey, id: u64) {
    let mut ids: Vec<u64> = env
        .storage()
        .persistent()
        .get(key)
        .unwrap_or_else(|| Vec::new(env));
    ids.push_back(id);
    env.storage().persistent().set(key, &ids);
    env.storage()
        .persistent()
        .extend_ttl(key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

pub fn page_stream_ids(env: &Env, key: &DataKey, offset: u32, limit: u32) -> Vec<u64> {
    let storage = env.storage().persistent();
    let Some(ids): Option<Vec<u64>> = storage.get(key) else {
        return Vec::new(env);
    };
    storage.extend_ttl(key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    let start = offset.min(ids.len());
    let end = start.saturating_add(limit.min(MAX_PAGE_SIZE)).min(ids.len());
    let mut page = Vec::new(env);
    let mut i = start;
    while i < end {
        if let Some(id) = ids.get(i) {
            page.push_back(id);
        }
        i += 1;
    }
    page
}

pub fn schema_version(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::SchemaVersion)
        .unwrap_or(INITIAL_SCHEMA_VERSION)
}

pub fn set_schema_version(env: &Env, version: u32) {
    env.storage().instance().set(&DataKey::SchemaVersion, &version);
    env.storage().instance().extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

pub fn is_frozen(env: &Env) -> bool {
    #[cfg(test)]
    crate::cei_trace::record("read instance ContractFrozen");
    env.storage()
        .instance()
        .get(&DataKey::ContractFrozen)
        .unwrap_or(false)
}

pub fn set_frozen(env: &Env, frozen: bool) {
    #[cfg(test)]
    crate::cei_trace::record("write instance ContractFrozen");
    env.storage().instance().set(&DataKey::ContractFrozen, &frozen);
    env.storage().instance().extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

pub fn pending_upgrade(env: &Env) -> Option<PendingUpgrade> {
    env.storage().instance().get(&DataKey::PendingUpgrade)
}

pub fn set_pending_upgrade(env: &Env, pending: &PendingUpgrade) {
    env.storage().instance().set(&DataKey::PendingUpgrade, pending);
    env.storage().instance().extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

pub fn remove_pending_upgrade(env: &Env) {
    env.storage().instance().remove(&DataKey::PendingUpgrade);
    env.storage().instance().extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

pub fn migration_cursor(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::MigrationCursor)
        .unwrap_or(0)
}

pub fn set_migration_cursor(env: &Env, cursor: u64) {
    env.storage().instance().set(&DataKey::MigrationCursor, &cursor);
    env.storage().instance().extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}
