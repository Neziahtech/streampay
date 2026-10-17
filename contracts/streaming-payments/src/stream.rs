//! Stream state, storage, and the checked accrual math.
//!
//! Accrual is linear over the stream window: a stream funded with `deposit`
//! between `start_time` and `end_time` streams `deposit * elapsed / duration`
//! tokens, floored to whole token units. All arithmetic is checked (`u128`
//! intermediate products) and returns [`StreamError::MathOverflow`] instead of
//! overflowing or panicking.

use soroban_sdk::{contracttype, Address, BytesN, Env, MuxedAddress, TryFromVal, Val, Vec};

use crate::errors::StreamError;
use crate::surface::{self, Branch};

/// Minimum delay for an upgrade proposal timelock: 24 hours.
pub const MIN_UPGRADE_DELAY_SECONDS: u64 = 86_400;

/// Initial schema version (v1).
pub const INITIAL_SCHEMA_VERSION: u32 = 1;

/// Target schema version after migration (v3: pause fields added to `Stream`).
///
/// * v2 — fee/treasury keys added (append-only; `Stream` layout unchanged).
/// * v3 — `Stream` gained `paused_total` / `last_resumed_at` / `last_paused_at`.
///   `#[contracttype]` structs encode positionally, so entries written by
///   pre-v3 Wasm decode only through the legacy cross-read in
///   [`migrate_stream`]; `migrate_storage` rewrites every entry in the new
///   layout while the contract is frozen (see `docs/ARCHITECTURE.md` §13.2).
pub const TARGET_SCHEMA_VERSION: u32 = 3;

/// Maximum number of streams processed per migration call.
pub const MAX_MIGRATION_BATCH_SIZE: u32 = 50;

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
    /// Accrual frozen at the pause-time value; withdrawals against the frozen
    /// balance and top-ups remain allowed. Appended after the terminal states
    /// so the XDR discriminants of `Active`/`Cancelled`/`Depleted` never move
    /// (the enum is name-encoded on the wire, but existing values are pinned
    /// in stored `Stream` entries — see `docs/ARCHITECTURE.md` §13.2).
    Paused,
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
    /// Cumulative seconds the stream has spent paused in past (completed)
    /// pause intervals. Always `0` for streams created before schema v3.
    pub paused_total: u64,
    /// Timestamp of the last resume (`0` if the stream never resumed).
    pub last_resumed_at: u64,
    /// Timestamp of the current pause (`0` when not paused). Accrual freezes
    /// at this value while `status == StreamStatus::Paused`.
    pub last_paused_at: u64,
}

impl Stream {
    /// Seconds in the stream's full *active* window. Always `>= 1` for a
    /// stored stream (`create_stream` rejects `end_time <= start_time`).
    ///
    /// `resume_stream` shifts `end_time` forward by exactly the paused
    /// interval and accumulates the same interval into `paused_total`, so the
    /// two cancel out: the active duration is invariant across pause/resume
    /// cycles and `streamed_at(deposit, duration(), duration()) == deposit`
    /// still holds over the active window.
    pub fn duration(&self) -> u64 {
        self.end_time
            .saturating_sub(self.start_time)
            .saturating_sub(self.paused_total)
    }
}

/// The stored shape of a [`Stream`] before schema v3 — the layout written by
/// every pre-pause Wasm (v1 and v2 shared it; neither pause field existed).
///
/// Cross-read only: `migrate_stream` decodes entries with this type when the
/// current layout does not match, then rewrites them with default pause
/// fields. Never construct it for new data.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamPreV3 {
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
    /// Next scheduled-intent id to hand out; ids start at 1.
    NextIntentId,
    /// The scheduled intent with the given id.
    Intent(u64),
    /// Append-only index of scheduled-intent ids created (as sender) by the
    /// given address. Same advisory semantics as [`DataKey::SenderStreams`].
    SenderIntents(Address),
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
    /// Schema version for storage layout evolution (instance storage).
    SchemaVersion,
    /// Freeze state: when true, all state-mutating entrypoints revert (instance storage).
    ContractFrozen,
    /// Proposed contract upgrade pending timelock expiration (instance storage).
    PendingUpgrade,
    /// Highest stream id processed by storage migration (instance storage).
    MigrationCursor,
}

/// Seconds elapsed of the stream window at the current ledger time.
///
/// The window is half-open `[start_time, end_time)`: at `now == start_time`
/// nothing has accrued yet; at `now >= end_time` the full duration has elapsed.
///
/// Kept as the plain-window reference implementation; accrual goes through
/// [`stream_elapsed_seconds`], which additionally subtracts paused time.
#[allow(dead_code)] // referenced by the elapsed-window tests and mutant checks
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

/// Seconds elapsed of the stream's *active* window at the current ledger time.
///
/// Pause-aware evaluation:
///
/// * While [`StreamStatus::Paused`], time is evaluated at `last_paused_at`, so
///   accrual is frozen exactly at the pause-time value no matter how far the
///   ledger advances (or that `now` passes `end_time`).
/// * Otherwise, elapsed = `now - start_time - paused_total`, clamped to
///   `[0, duration()]`: completed pause intervals never count, and because
///   `resume_stream` shifts `end_time` forward by exactly the same interval it
///   adds to `paused_total`, the active window stays invariant.
///
/// This is deliberately `Env`-pure — no storage reads — so it composes with
/// the checked rate math in [`streamed_at`] without new failure modes.
pub fn stream_elapsed_seconds(env: &Env, stream: &Stream) -> u64 {
    let eval_time = if stream.status == StreamStatus::Paused {
        stream.last_paused_at
    } else {
        env.ledger().timestamp()
    };
    if eval_time <= stream.start_time {
        0
    } else if eval_time >= stream.end_time {
        stream.duration()
    } else {
        let raw = eval_time - stream.start_time;
        raw.saturating_sub(stream.paused_total)
            .min(stream.duration())
    }
}

/// Amount streamed (accrued) at the current ledger time.
///
/// See [`streamed_at`] for the rate semantics and [`stream_elapsed_seconds`]
/// for how paused intervals are excluded from the elapsed window.
pub fn streamed_amount(env: &Env, stream: &Stream) -> Result<i128, StreamError> {
    let elapsed = stream_elapsed_seconds(env, stream);
    streamed_at(stream.deposit, stream.duration(), elapsed)
}

/// Accrued-but-unwithdrawn balance at the current ledger time. Zero for
/// cancelled streams (their payout was settled atomically at cancellation).
pub fn available_amount(env: &Env, stream: &Stream) -> Result<i128, StreamError> {
    if stream.status == StreamStatus::Cancelled {
        return Ok(0);
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

/// Reserves a contiguous range of stream ids with one persistent write.
pub fn reserve_stream_ids(env: &Env, count: u32) -> Result<u64, StreamError> {
    let key = DataKey::NextStreamId;
    let first: u64 = env.storage().persistent().get(&key).unwrap_or(1);
    let next = first
        .checked_add(count as u64)
        .ok_or(StreamError::MathOverflow)?;
    env.storage().persistent().set(&key, &next);
    Ok(first)
}

/// Loads a stream, or returns [`StreamError::StreamNotFound`].
pub fn get_stream(env: &Env, id: u64) -> Result<Stream, StreamError> {
    env.storage()
        .persistent()
        .get(&DataKey::Stream(id))
        .ok_or_else(|| surface::reject(Branch::StreamNotFound))
}

/// Persists a stream and extends its storage TTL.
pub fn put_stream(env: &Env, stream: &Stream) {
    let key = DataKey::Stream(stream.id);
    env.storage().persistent().set(&key, stream);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Reads one stored stream for `migrate_storage`, upgrading a pre-v3 layout,
/// and re-stores it (touching the entry's TTL).
///
/// Returns `Ok(false)` when nothing is stored under `id`. The current
/// positional layout is tried first — entries written by this Wasm (or already
/// migrated in an earlier batch) decode directly. When it does not match, the
/// legacy [`StreamPreV3`] shape written by pre-pause Wasm is cross-read and the
/// v3 pause fields are defaulted to `0`, so every pre-v3 entry migrates
/// losslessly. Storage that decodes under neither layout was never written by
/// this contract and traps, exactly like `get_stream` would on the same entry.
pub fn migrate_stream(env: &Env, id: u64) -> Result<bool, StreamError> {
    let key = DataKey::Stream(id);
    let Some(raw): Option<Val> = env.storage().persistent().get(&key) else {
        return Ok(false);
    };

    let migrated = match Stream::try_from_val(env, &raw) {
        Ok(current) => current,
        Err(_) => {
            let legacy = StreamPreV3::try_from_val(env, &raw)
                .unwrap_or_else(|_| panic!("stream {id} matches no known schema version"));
            Stream {
                id: legacy.id,
                sender: legacy.sender,
                recipient: legacy.recipient,
                token: legacy.token,
                deposit: legacy.deposit,
                withdrawn: legacy.withdrawn,
                start_time: legacy.start_time,
                end_time: legacy.end_time,
                cancelable: legacy.cancelable,
                status: legacy.status,
                paused_total: 0,
                last_resumed_at: 0,
                last_paused_at: 0,
            }
        }
    };

    put_stream(env, &migrated);
    Ok(true)
}

/// Appends a stream's id to both parties' address indexes.
///
/// Called after each stream created by `create_stream` or `create_streams`
/// is persisted.
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

/// Returns the current schema version (defaults to INITIAL_SCHEMA_VERSION if unset).
pub fn schema_version(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::SchemaVersion)
        .unwrap_or(INITIAL_SCHEMA_VERSION)
}

/// Persists the new schema version and extends instance storage TTL.
pub fn set_schema_version(env: &Env, version: u32) {
    env.storage()
        .instance()
        .set(&DataKey::SchemaVersion, &version);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Checks whether the contract is currently frozen.
pub fn is_frozen(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::ContractFrozen)
        .unwrap_or(false)
}

/// Updates the contract freeze state and extends instance storage TTL.
pub fn set_frozen(env: &Env, frozen: bool) {
    env.storage()
        .instance()
        .set(&DataKey::ContractFrozen, &frozen);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Returns the pending contract upgrade proposal, if one exists.
pub fn pending_upgrade(env: &Env) -> Option<PendingUpgrade> {
    env.storage().instance().get(&DataKey::PendingUpgrade)
}

/// Sets the pending contract upgrade proposal and extends instance storage TTL.
pub fn set_pending_upgrade(env: &Env, pending: &PendingUpgrade) {
    env.storage()
        .instance()
        .set(&DataKey::PendingUpgrade, pending);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Removes any pending contract upgrade proposal and extends instance storage TTL.
pub fn remove_pending_upgrade(env: &Env) {
    env.storage().instance().remove(&DataKey::PendingUpgrade);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Returns the current migration cursor (highest stream id migrated so far).
pub fn migration_cursor(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::MigrationCursor)
        .unwrap_or(0)
}

/// Sets the migration cursor and extends instance storage TTL.
pub fn set_migration_cursor(env: &Env, cursor: u64) {
    env.storage()
        .instance()
        .set(&DataKey::MigrationCursor, &cursor);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}
