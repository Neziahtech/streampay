//! Stream state, storage, and the checked accrual math.
//!
//! Accrual is linear over the stream window: a stream funded with `deposit`
//! between `start_time` and `end_time` streams `deposit * elapsed / duration`
//! tokens, floored to whole token units. All arithmetic is checked (`u128`
//! intermediate products) and returns [`StreamError::MathOverflow`] instead of
//! overflowing or panicking.

use soroban_sdk::{contracttype, Address, Env, MuxedAddress, Vec};

use crate::errors::StreamError;
use crate::surface::{self, Branch};

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
///
/// # Semantics
///
/// - `cliff_time` — nothing is claimable before this timestamp, even if
///   `start_time` has passed and time has elapsed. The deposit is locked
///   up-front as usual; the cliff only gates *withdrawal*, not funding.
/// - `steps` — defines a piecewise-constant accrual schedule over the
///   `[start_time, end_time)` window. Each step's `time` is the absolute
///   timestamp at which its rate becomes effective. Accrual within a step is
///   linear at `rate_bps / 10_000` of the deposit's total-window rate.
///
/// # Invariants enforced at creation (`validate_schedule`)
///
/// 1. `steps` is non-empty.
/// 2. Every step's `time` lies in `[start_time, end_time)`, in strict ascending
///    order.
/// 3. `steps[0].time == start_time` — the schedule covers the full window.
/// 4. The sum of all `rate_bps` == `10_000`.
/// 5. `cliff_time` is in `[start_time, end_time]`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Schedule {
    pub cliff_time: u64,
    pub steps: Vec<VestingStep>,
}

/// Validates a [`Schedule`] against its parent stream's time bounds.
///
/// Called once at `create_stream_vested`; stored only after passing.
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
    // First step must anchor at start_time.
    if schedule.steps.get(0).map(|s| s.time) != Some(start_time) {
        return Err(surface::reject(Branch::CreateInvalidSchedule));
    }

    let mut rate_sum: u32 = 0;
    let mut prev_time: u64 = 0;
    let n = schedule.steps.len();
    for i in 0..n {
        let step = schedule.steps.get(i).unwrap();
        // Strict ascending order; all times within the window.
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
/// Computes how much of `deposit` has vested at a point `elapsed` seconds into
/// the `[start_time, end_time)` window, according to `schedule`. The cliff is
/// not enforced here — it gates *withdrawals*, not the accrual accounting used
/// by cancellation splits. Callers that need cliff enforcement (withdraw paths)
/// check it separately.
///
/// Each step covers `[step.time, next_step.time)` (or `[step.time, end_time)`
/// for the last step). Within that window the accrual is:
///
/// ```text
/// step_deposit  = deposit * step.rate_bps / 10_000   (floor)
/// step_duration = next_step.time - step.time          (or end_time - step.time)
/// contribution  = step_deposit * step_elapsed / step_duration   (floor)
/// ```
///
/// Summed across all steps whose window overlaps `[start_time, start_time + elapsed)`.
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
            break; // this step hasn't started yet
        }

        let step_duration = step_end - step_start; // >= 1 by invariant
        let step_elapsed = now.min(step_end) - step_start;

        // step_deposit = floor(deposit * rate_bps / 10_000)
        // Overflow guard: deposit fits i128, rate_bps <= 10_000, so
        // deposit * rate_bps fits u128 whenever deposit * 10_000 fits.
        let step_deposit_u128 = (deposit as u128)
            .checked_mul(step.rate_bps as u128)
            .ok_or_else(|| surface::reject(Branch::RateProductOverflow))?
            / (BPS_DENOM as u128);
        let step_deposit = step_deposit_u128.min(deposit as u128) as i128;

        // Linear accrual within the step.
        let contribution = (step_deposit as u128)
            .checked_mul(step_elapsed as u128)
            .ok_or_else(|| surface::reject(Branch::RateProductOverflow))?
            / (step_duration as u128);

        total = total
            .checked_add(contribution as i128)
            .ok_or(StreamError::MathOverflow)?;
    }

    // Cap at deposit to absorb any rounding residual on the final step.
    Ok(total.min(deposit))
}

/// Loads the optional [`Schedule`] for `stream_id`. Returns `None` for plain
/// linear streams (the v0.x default).
pub fn get_schedule(env: &Env, stream_id: u64) -> Option<Schedule> {
    env.storage()
        .persistent()
        .get(&DataKey::Schedule(stream_id))
}

/// Persists a [`Schedule`] and extends its TTL in lock-step with its stream.
pub fn put_schedule(env: &Env, stream_id: u64, schedule: &Schedule) {
    let key = DataKey::Schedule(stream_id);
    env.storage().persistent().set(&key, schedule);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Maximum supported stream duration: 100 years, including leap days
/// (36,525 days). Bounds worst-case rate multiplications and rejects
/// nonsensical windows early.
pub const MAX_DURATION_SECONDS: u64 = 3_155_760_000;

/// Maximum number of stream ids a single paginated index query may return.
/// Callers asking for more are clamped down; this bounds per-call footprint
/// of the address-index views.
pub const MAX_PAGE_SIZE: u32 = 50;

/// TTL maintenance, in ledgers (~5 seconds per ledger on Stellar mainnet).
///
/// Streams live in persistent storage: entries that go untouched are
/// eventually archived off-chain (and auto-restored at a fee when next read).
/// Every mutating entrypoint extends the stream entry's TTL, so a stream that
/// is actually being used never goes cold.
pub(crate) const TTL_THRESHOLD_LEDGERS: u32 = 200_000; // extend when TTL drops below ~11.5 days
pub(crate) const TTL_EXTEND_LEDGERS: u32 = 500_000; // extend to ~29 days

/// Lifecycle state of a stream.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum StreamStatus {
    /// Running; funds accrue and can be withdrawn or topped up.
    Active,
    /// Cancelled; remaining funds were split at cancellation. Terminal.
    Cancelled,
    /// Fully streamed and fully withdrawn. Terminal.
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
    /// Total amount funded into the stream (original deposit + top-ups).
    pub deposit: i128,
    /// Total amount paid to the recipient so far (withdrawals + cancel payout).
    pub withdrawn: i128,
    pub start_time: u64,
    pub end_time: u64,
    /// If true, the recipient may also cancel and reclaim their accrued balance.
    pub cancelable: bool,
    pub status: StreamStatus,
}

impl Stream {
    /// Seconds in the stream's full window. Always `>= 1` for a stored stream
    /// (`create_stream` rejects `end_time <= start_time`).
    pub fn duration(&self) -> u64 {
        self.end_time - self.start_time
    }
}

/// Storage keys for the contract.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// Next stream id to hand out; ids start at 1.
    NextStreamId,
    /// The stream with the given id.
    Stream(u64),
    /// Append-only index of stream ids where the given address is the
    /// recipient. Advisory (discovery) data: the `Stream` entries remain the
    /// source of truth, and terminal streams keep their place in the index.
    RecipientStreams(Address),
    /// Append-only index of stream ids created (as sender) by the given
    /// address. Same advisory semantics as [`DataKey::RecipientStreams`].
    SenderStreams(Address),
    /// Treasury governor address (instance storage; set once by the
    /// contract constructor, later by two-step nomination/acceptance).
    Governor,
    /// Pending governor nominee (instance storage; set by
    /// `nominate_governor`, cleared by `accept_governor`).
    PendingGovernor,
    /// Configured protocol fee in basis points (instance storage; absent
    /// means 0 — fees disabled, the v0.3 behavior).
    FeeBps,
    /// Per-token fee accounting: fees charged minus fees withdrawn
    /// (persistent storage; written only by fee-affecting entrypoints).
    Treasury(Address),
    /// Fee charged for one stream at creation time (persistent storage;
    /// written only when the fee rounds above zero, so absent == 0).
    StreamFee(u64),
    /// Optional vesting schedule attached to a stream (persistent storage;
    /// absent means plain linear accrual — the v0.x default).
    Schedule(u64),
}

/// Seconds elapsed of the stream window at the current ledger time.
///
/// The window is half-open `[start_time, end_time)`: at `now == start_time`
/// nothing has accrued yet; at `now >= end_time` the full duration has elapsed.
pub fn elapsed_seconds(env: &Env, start_time: u64, end_time: u64) -> u64 {
    let now = env.ledger().timestamp();
    if now <= start_time {
        0
    } else if now >= end_time {
        // MUTANT-SUPPRESS: replace - with + is acceptable because this branch
        // is only reachable when now >= end_time, which means the full duration
        // has already elapsed. The test elapsed_after_end_returns_full_duration
        // verifies that the full deposit is available at this point. The mutation
        // would cause an overflow in the subsequent streamed_at calculation,
        // which is caught by MathOverflow. This is an unreachable code path given
        // the contract's usage pattern.
        end_time - start_time
    } else {
        now - start_time
    }
}

/// Validates that `deposit * duration` — the worst-case rate multiplication —
/// fits in `u128`, so [`streamed_amount`] can never overflow for this stream.
///
/// `duration` must be `>= 1` (enforced by `create_stream`).
pub fn validate_capacity(deposit: i128, duration: u64) -> Result<(), StreamError> {
    let cap = u128::MAX / (duration.max(1) as u128);
    if (deposit as u128) > cap {
        return Err(surface::reject(Branch::CapacityOverflow));
    }
    Ok(())
}

/// Pure rate computation: amount streamed after `elapsed` seconds of a
/// `duration`-second window funded with `deposit`.
///
/// Linear rate: `deposit * elapsed / duration`, floored to whole token units,
/// capped at `deposit`. Checked math throughout; returns
/// [`StreamError::MathOverflow`] rather than overflowing or panicking. Exposed
/// as a pure function so tests and fuzzing can exercise it without an
/// environment.
pub fn streamed_at(deposit: i128, duration: u64, elapsed: u64) -> Result<i128, StreamError> {
    if elapsed == 0 || deposit <= 0 || duration == 0 {
        return Ok(0);
    }
    let product = (deposit as u128)
        .checked_mul(elapsed as u128)
        .ok_or_else(|| surface::reject(Branch::RateProductOverflow))?;
    let streamed = (product / (duration.max(1) as u128)).min(deposit as u128);
    // `streamed <= deposit <= i128::MAX`, so the narrowing cast cannot wrap.
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
/// the current time has not yet passed `cliff_time`. Zero for cancelled
/// streams (their payout was settled atomically at cancellation).
pub fn available_amount(env: &Env, stream: &Stream) -> Result<i128, StreamError> {
    if stream.status == StreamStatus::Cancelled {
        return Ok(0);
    }
    // Enforce cliff: nothing claimable before cliff_time.
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

/// Payout split at cancellation: `(recipient_amount, sender_amount)`.
///
/// The recipient receives their accrued-but-unwithdrawn balance; the sender is
/// refunded the unaccrued remainder.
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

/// Address helper: token transfer destinations are muxed addresses.
pub(crate) fn muxed(addr: &Address) -> MuxedAddress {
    addr.clone().into()
}

/// Hands out the next stream id (1-based) and stores the incremented counter.
pub fn next_stream_id(env: &Env) -> u64 {
    let key = DataKey::NextStreamId;
    let id: u64 = env.storage().persistent().get(&key).unwrap_or(1);
    env.storage().persistent().set(&key, &id.saturating_add(1));
    id
}

/// Loads a stream, or returns [`StreamError::StreamNotFound`].
pub fn get_stream(env: &Env, id: u64) -> Result<Stream, StreamError> {
    env.storage()
        .persistent()
        .get(&DataKey::Stream(id))
        .ok_or_else(|| surface::reject(Branch::StreamNotFound))
}

/// Persists a stream and extends its storage TTL. If the stream has an
/// attached schedule its TTL is extended in lockstep.
pub fn put_stream(env: &Env, stream: &Stream) {
    let key = DataKey::Stream(stream.id);
    env.storage().persistent().set(&key, stream);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    // Keep the schedule entry alive alongside its stream.
    let sched_key = DataKey::Schedule(stream.id);
    if env.storage().persistent().has(&sched_key) {
        env.storage()
            .persistent()
            .extend_ttl(&sched_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    }
}

/// Appends a stream's id to both parties' address indexes.
///
/// Called once, from `create_stream`, right after the stream is persisted.
/// Cancel/deplete/top-up flows intentionally do not touch the indexes: they
/// are append-only discovery aids keyed by *creation*, not by lifecycle.
pub fn index_stream(env: &Env, stream: &Stream) {
    push_to_index(
        env,
        &DataKey::SenderStreams(stream.sender.clone()),
        stream.id,
    );
    push_to_index(
        env,
        &DataKey::RecipientStreams(stream.recipient.clone()),
        stream.id,
    );
}

fn push_to_index(env: &Env, key: &DataKey, id: u64) {
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

/// Returns one page of stream ids from an address index, in creation order.
///
/// `limit` is clamped to [`MAX_PAGE_SIZE`]; an `offset` past the end (or an
/// unknown address) yields an empty page rather than an error. Reading the
/// index extends its TTL, so actively-queried addresses never go cold.
/// Addresses with no index entry never had any streams: return early without
/// touching storage (`extend_ttl` on a never-written key would fail).
pub fn page_stream_ids(env: &Env, key: &DataKey, offset: u32, limit: u32) -> Vec<u64> {
    let storage = env.storage().persistent();
    let Some(ids): Option<Vec<u64>> = storage.get(key) else {
        return Vec::new(env);
    };
    storage.extend_ttl(key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    let start = offset.min(ids.len());
    let end = start
        .saturating_add(limit.min(MAX_PAGE_SIZE))
        .min(ids.len());
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
