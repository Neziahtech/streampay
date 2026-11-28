//! Non-transferable stream credit reputation (issue #574).
//!
//! Every address accumulates a reputation record from its stream settlement
//! history. Integrators read the score through
//! [`crate::StreamingPayments::reputation_score`] /
//! [`crate::StreamingPayments::get_reputation`] to gate access. The score
//! moves no token value, has no transfer/approval surface, and is bound to
//! the address it was earned by: it is computed from contract storage keyed
//! by that address and can only change through the contract's own
//! settlement paths.
//!
//! # What earns (and loses) score
//!
//! The score derives **only** from settled outcomes and resolved disputes:
//!
//! * **Completion** — a stream that runs to depletion (`withdrawn ==
//!   deposit` through the payout path) credits both sender and recipient.
//!   Cancellations never credit anyone, however much had accrued: a cancel
//!   is churn, not settlement.
//! * **Refill reliability** — a completion credits the *sender* a refill
//!   bonus when the stream had been topped up at least once. A top-up alone
//!   earns nothing: it is a pending deposit until the stream settles, so
//!   topping up and cancelling cannot farm the bonus.
//! * **Resolved disputes** — the party the outcome favours gains, the other
//!   loses: `resolve_dispute(accept = true)` upholds the recipient's
//!   dispute (recipient wins, sender loses); `accept = false` rejects it as
//!   bad-faith (sender wins, recipient loses). Dispute *expiry* is neutral
//!   and moves no counters.
//!
//! # Anti-wash rules
//!
//! * Create + cancel churn yields exactly zero score, at any volume: no
//!   counter moves on create or on cancel (proved by a proptest over the
//!   scoring model and by entrypoint tests).
//! * Self-streams (`sender == recipient`) earn nothing, so two pockets of
//!   the same actor cannot credit each other.
//! * Zero-value settlements earn nothing.
//! * Per-source caps bound any single behaviour's contribution, and the
//!   total is clamped to [`MAX_SCORE`], so even genuine completion farming
//!   saturates quickly — and every completion still costs the farmer a
//!   full stream duration of locked capital.
//!
//! # Formula (deterministic, bounded)
//!
//! ```text
//! raw = min(40 * completed_streams, 700)
//!     + min(10 * refilled_completions, 100)
//!     + min(20 * disputes_won, 200)
//!     - 30 * disputes_lost
//! score_raw = clamp(raw, 0, 1000)
//! ```
//!
//! # Decay
//!
//! The score integrators read decays linearly with inactivity, reaching
//! zero [`DECAY_WINDOW_SECONDS`] (180 days) after `last_activity` — the
//! same linear recency shape as `voting_power`. Decay is computed at read
//! time from the ledger timestamp, so a read never writes and the same
//! state always yields the same score at the same ledger time
//! (determinism). For completions, `last_activity` anchors to the stream's
//! `end_time` — the moment its outcome was fully determined (a stream can
//! only deplete once fully accrued); for disputes, to the resolution time.
//!
//! # Cost (why completions are derived, not written)
//!
//! The performance budget is a hard gate in this repo: every extra
//! persistent-storage access on a hot path costs ~26k CPU instructions in
//! host metering, and `withdraw` / `withdraw_max` / `top_up` carry a 5%
//! regression band against baselines measured without this feature.
//! Writing per-party records at settlement time (two reads + two writes on
//! every depleting payout) measured +212k instructions on `withdraw_max`
//! (+39.5%) — no stored-counter design can fit the band. So the hot paths
//! write **no** reputation state at all:
//!
//! * **Completions are derived at read time** from data the settlement
//!   paths already write: the stream records themselves (`Depleted`
//!   status, `deposit`, parties, `end_time`) reached through the sender /
//!   recipient discovery indexes. A read scans at most
//!   [`MAX_DERIVATION_SCAN`] most-recent index entries per role.
//! * **Sweep-time archival** keeps derivation sound: `sweep_stream`
//!   deletes a finished stream's record and prunes its index entries, so
//!   before that happens it folds the stream's completion contribution
//!   into the parties' stored records (see [`archive_completion`]).
//!   Reputation therefore survives storage reclamation, and nobody can
//!   erase it by sweeping. Between completion and sweep the contribution
//!   comes from the live tier; afterwards from the archive — never both,
//!   because the sweep prunes the index entry in the same invocation.
//! * **Dispute counters are stored**, updated only by
//!   [`record_dispute_resolution`]: a resolved dispute's outcome exists
//!   nowhere else once the dispute entry is cleared, and the dispute path
//!   is not a benchmarked hot path.
//! * **The refill marker** is a single instance-storage flag per stream
//!   (see [`note_top_up`]): `top_up` already loads and rewrites the stream,
//!   and one instance write (+21k) fits its budget band where a persistent
//!   entry (+55k) did not. Markers are consulted only for `Depleted`
//!   streams, are removed when the stream is swept, and so are bounded by
//!   the number of topped-up streams whose records still exist.
//!
//! # Storage / errors
//!
//! Stored records sit under [`ReputationDataKey`], in keys separate from
//! the stream keys (the `dispute.rs` pattern), so the stream record wire
//! format never changes. No new [`crate::errors::StreamError`] codes are
//! added: recording is internal and infallible, and the reads return a
//! default (zero) record for unknown addresses instead of reverting.

use soroban_sdk::{contracttype, Address, Env};

use crate::events::ReputationUpdated;
use crate::stream::{
    self, DataKey, Stream, StreamStatus, TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS,
};

/// Maximum reputation score. Scores are clamped to `0..=MAX_SCORE`.
pub const MAX_SCORE: u32 = 1_000;
/// Points per completed (fully settled) stream, before the source cap.
pub const POINTS_PER_COMPLETION: u32 = 40;
/// Cap on points earned from completions alone.
pub const COMPLETION_POINTS_CAP: u32 = 700;
/// Points per refilled completion (sender only), before the source cap.
pub const POINTS_PER_REFILLED_COMPLETION: u32 = 10;
/// Cap on points earned from refilled completions alone.
pub const REFILL_POINTS_CAP: u32 = 100;
/// Points per dispute resolved in the subject's favour, before the cap.
pub const POINTS_PER_DISPUTE_WON: u32 = 20;
/// Cap on points earned from disputes won alone.
pub const DISPUTE_WON_POINTS_CAP: u32 = 200;
/// Points lost per dispute resolved against the subject.
pub const POINTS_PER_DISPUTE_LOST: u32 = 30;
/// Inactivity window over which the score decays linearly to zero:
/// 180 days in seconds, matching the voting-power decay window.
pub const DECAY_WINDOW_SECONDS: u64 = 180 * 24 * 60 * 60;
/// Most-recent index entries per role that a reputation read derives
/// completion counters from. Bounds the read's cost for addresses with
/// very long stream histories; contributions beyond the window are the
/// oldest ones, and the score's per-source caps saturate long before 256
/// qualifying completions in the overwhelming majority of histories.
pub const MAX_DERIVATION_SCAN: u32 = 256;

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Accumulated reputation counters for one address."
)]
#[cfg_attr(not(target_family = "wasm"), doc = "")]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Field order and names are the storage wire format for the *stored*"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " record; only append fields. What [`get_record`] returns is a merge: the"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " stored record carries the dispute counters plus the completion"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " contributions archived by `sweep_stream`, and the completion counters"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " of streams that still exist are derived live and added in (see the"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " module's Cost section). Counters are aggregates, never a history list."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReputationRecord {
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Streams that ran to full settlement with this address as a party."
    )]
    pub completed_streams: u32,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Completed streams this address funded that had been topped up at"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " least once before settling (sender-side refill reliability)."
    )]
    pub refilled_completions: u32,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Disputes resolved in this address's favour."
    )]
    pub disputes_won: u32,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Disputes resolved against this address."
    )]
    pub disputes_lost: u32,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Total value settled across this address's completed streams."
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Informational (auditing/integrator display); never scored directly,"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " so inflating stream sizes cannot inflate the score."
    )]
    pub settled_total: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Ledger timestamp of the last scored outcome. Drives decay."
    )]
    pub last_activity: u64,
}

impl ReputationRecord {
    pub fn zero() -> Self {
        ReputationRecord {
            completed_streams: 0,
            refilled_completions: 0,
            disputes_won: 0,
            disputes_lost: 0,
            settled_total: 0,
            last_activity: 0,
        }
    }
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " What the integrator-facing read returns: the merged counters plus the"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " score as of the current ledger time (raw and decayed)."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReputationView {
    pub record: ReputationRecord,
    #[cfg_attr(not(target_family = "wasm"), doc = " Score before inactivity decay.")]
    pub raw_score: u32,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Score after inactivity decay at the current ledger timestamp. This"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " is the value access gates should use."
    )]
    pub score: u32,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Storage keys for reputation state, kept separate from the stream keys"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " so existing stream serialization never changes."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReputationDataKey {
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The stored reputation record of the given address (persistent):"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " dispute counters plus sweep-archived completion contributions."
    )]
    Record(Address),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Marker that a stream has been topped up at least once (instance"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " storage). Unscored on its own; consulted by completion derivation"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " and archival, and removed when the stream is swept."
    )]
    StreamRefills(u64),
}

/// The uncapped-then-clamped score a record's counters produce, before
/// inactivity decay. Pure: same counters, same score, always.
pub fn raw_score(record: &ReputationRecord) -> u32 {
    let completion = record
        .completed_streams
        .saturating_mul(POINTS_PER_COMPLETION)
        .min(COMPLETION_POINTS_CAP);
    let refill = record
        .refilled_completions
        .saturating_mul(POINTS_PER_REFILLED_COMPLETION)
        .min(REFILL_POINTS_CAP);
    let won = record
        .disputes_won
        .saturating_mul(POINTS_PER_DISPUTE_WON)
        .min(DISPUTE_WON_POINTS_CAP);
    let lost = record.disputes_lost.saturating_mul(POINTS_PER_DISPUTE_LOST);

    let positive = completion.saturating_add(refill).saturating_add(won);
    positive.saturating_sub(lost).min(MAX_SCORE)
}

/// Apply inactivity decay to a raw score: full score at `last_activity`,
/// linearly down to zero once `now - last_activity >= DECAY_WINDOW_SECONDS`.
/// Pure and boundary-exact (age 0 → raw; age == window → 0).
pub fn decayed_score(record: &ReputationRecord, now: u64) -> u32 {
    let raw = raw_score(record);
    if raw == 0 || record.last_activity == 0 {
        return raw;
    }
    let age = now.saturating_sub(record.last_activity);
    if age >= DECAY_WINDOW_SECONDS {
        return 0;
    }
    let remaining = (DECAY_WINDOW_SECONDS - age) as u128;
    ((raw as u128 * remaining) / DECAY_WINDOW_SECONDS as u128) as u32
}

/// Load an address's *stored* record (dispute counters + archived
/// completions), or the zero record if it has none.
fn get_stored_record(env: &Env, subject: &Address) -> ReputationRecord {
    env.storage()
        .persistent()
        .get(&ReputationDataKey::Record(subject.clone()))
        .unwrap_or_else(ReputationRecord::zero)
}

fn put_record(env: &Env, subject: &Address, record: &ReputationRecord) {
    let key = ReputationDataKey::Record(subject.clone());
    env.storage().persistent().set(&key, record);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Whether a stream's settled outcome earns completion credit at all:
/// it ran to depletion with real value at stake between two distinct
/// parties. Cancellations, self-streams and zero-value streams earn
/// nothing — this predicate is the single anti-wash gate shared by live
/// derivation and sweep-time archival.
fn completion_counts(stream: &Stream) -> bool {
    stream.status == StreamStatus::Depleted
        && stream.deposit > 0
        && stream.sender != stream.recipient
}

/// Completion contributions of the streams that still exist, derived from
/// one discovery index (`sender_role` selects the refill credit, which is
/// sender-only). Scans at most [`MAX_DERIVATION_SCAN`] most-recent ids.
fn derive_from_index(
    env: &Env,
    key: &DataKey,
    subject: &Address,
    sender_role: bool,
    tally: &mut ReputationRecord,
) {
    let ids: soroban_sdk::Vec<u64> = match env.storage().persistent().get(key) {
        Some(ids) => ids,
        None => return,
    };
    let len = ids.len();
    let start = len.saturating_sub(MAX_DERIVATION_SCAN);
    for index in start..len {
        let Some(id) = ids.get(index) else { continue };
        let Ok(stream) = stream::get_stream(env, id) else {
            continue;
        };
        let party = if sender_role {
            &stream.sender
        } else {
            &stream.recipient
        };
        if party != subject || !completion_counts(&stream) {
            continue;
        }
        tally.completed_streams = tally.completed_streams.saturating_add(1);
        tally.settled_total = tally.settled_total.saturating_add(stream.deposit);
        if sender_role && stream_topped_up(env, stream.id) {
            tally.refilled_completions = tally.refilled_completions.saturating_add(1);
        }
        tally.last_activity = tally.last_activity.max(stream.end_time);
    }
}

/// Load an address's full reputation record: the stored record (dispute
/// counters + sweep-archived completions) merged with the completion
/// contributions derived live from the streams that still exist.
pub fn get_record(env: &Env, subject: &Address) -> ReputationRecord {
    let mut record = get_stored_record(env, subject);
    let mut live = ReputationRecord::zero();
    derive_from_index(
        env,
        &DataKey::SenderStreams(subject.clone()),
        subject,
        true,
        &mut live,
    );
    derive_from_index(
        env,
        &DataKey::RecipientStreams(subject.clone()),
        subject,
        false,
        &mut live,
    );
    record.completed_streams = record
        .completed_streams
        .saturating_add(live.completed_streams);
    record.refilled_completions = record
        .refilled_completions
        .saturating_add(live.refilled_completions);
    record.settled_total = record.settled_total.saturating_add(live.settled_total);
    record.last_activity = record.last_activity.max(live.last_activity);
    record
}

/// Whether the stream has been topped up at least once (unscored side
/// data, kept as an instance-storage marker — see the module Cost notes).
pub fn stream_topped_up(env: &Env, stream_id: u64) -> bool {
    env.storage()
        .instance()
        .get(&ReputationDataKey::StreamRefills(stream_id))
        .unwrap_or(false)
}

/// Note a successful top-up. Moves no score by itself: the refill only
/// counts if and when the stream later completes (see the module docs).
pub fn note_top_up(env: &Env, stream_id: u64) {
    env.storage()
        .instance()
        .set(&ReputationDataKey::StreamRefills(stream_id), &true);
}

fn clear_top_up_marker(env: &Env, stream_id: u64) {
    env.storage()
        .instance()
        .remove(&ReputationDataKey::StreamRefills(stream_id));
}

fn publish_update(env: &Env, subject: &Address, stream_id: u64, record: &ReputationRecord) {
    ReputationUpdated {
        subject: subject.clone(),
        stream_id,
        score: raw_score(record),
        completed_streams: record.completed_streams,
    }
    .publish(env);
}

/// Fold a finished stream's completion contribution into the stored
/// records, ahead of `sweep_stream` deleting its record and index
/// entries. Returns true when the stream qualified as a completion (and
/// the parties' stored records changed). No [`ReputationUpdated`] event
/// is emitted: the parties' scores do not change — the contribution was
/// already counted by live derivation and merely changes tier. The
/// refill marker is cleared for every swept stream, qualifying or not.
pub fn archive_completion(env: &Env, stream: &Stream) -> bool {
    let topped_up = stream_topped_up(env, stream.id);
    clear_top_up_marker(env, stream.id);
    if !completion_counts(stream) {
        return false;
    }
    for subject in [&stream.sender, &stream.recipient] {
        let mut record = get_stored_record(env, subject);
        record.completed_streams = record.completed_streams.saturating_add(1);
        record.settled_total = record.settled_total.saturating_add(stream.deposit);
        if topped_up && *subject == stream.sender {
            record.refilled_completions = record.refilled_completions.saturating_add(1);
        }
        record.last_activity = record.last_activity.max(stream.end_time);
        put_record(env, subject, &record);
    }
    true
}

/// Credit a resolved dispute: `accepted = true` upholds the recipient's
/// dispute (recipient wins, sender loses); `accepted = false` rejects it
/// as bad-faith (sender wins, recipient loses). Expiry never calls this —
/// an expired dispute is neutral and moves no counters.
pub fn record_dispute_resolution(env: &Env, stream: &Stream, accepted: bool, now: u64) {
    if stream.sender == stream.recipient {
        return;
    }
    let (winner, loser) = if accepted {
        (&stream.recipient, &stream.sender)
    } else {
        (&stream.sender, &stream.recipient)
    };

    let mut win_record = get_stored_record(env, winner);
    win_record.disputes_won = win_record.disputes_won.saturating_add(1);
    win_record.last_activity = win_record.last_activity.max(now);
    put_record(env, winner, &win_record);
    publish_update(env, winner, stream.id, &get_record(env, winner));

    let mut lose_record = get_stored_record(env, loser);
    lose_record.disputes_lost = lose_record.disputes_lost.saturating_add(1);
    lose_record.last_activity = lose_record.last_activity.max(now);
    put_record(env, loser, &lose_record);
    publish_update(env, loser, stream.id, &get_record(env, loser));
}

/// The integrator read: merged counters plus raw and decayed scores at
/// `now`. See the module Cost notes for why the completion half is
/// derived rather than stored.
pub fn view(env: &Env, subject: &Address, now: u64) -> ReputationView {
    let record = get_record(env, subject);
    ReputationView {
        raw_score: raw_score(&record),
        score: decayed_score(&record, now),
        record,
    }
}
