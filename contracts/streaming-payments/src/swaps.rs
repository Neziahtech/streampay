//! Two-party rate swaps: exchanging the rate legs of two sibling streams.
//!
//! A swap links two streams that share one token. While the swap is active the
//! *routing* of each leg is exchanged: leg A's accrual is owed to the party
//! that owns leg B (its sender), and leg B's accrual to leg A's sender. Instead
//! of paying both legs gross every interval, [`settle`] nets the two accruals
//! and moves only the difference, so a payroll hedge or a rate rebalance costs
//! one transfer per settlement rather than two. The two parties are exactly the
//! addresses that consented to the swap, so the net can always be paid to the
//! party that is owed it without touching either stream's original recipient —
//! those recipients resume their normal claims on [`unwind`].
//!
//! # Two-phase commit
//!
//! [`propose`] records an offer under [`DataKey::Swap`] and links both legs
//! through [`DataKey::StreamSwap`]. The proposer must be the sender of one of
//! the two streams, and their authorization is required. Nothing about either
//! stream's accounting changes yet: the offer carries a seven-day acceptance
//! window ([`SWAP_PROPOSAL_TTL_SECONDS`]) and can be cleared by cancelling
//! either leg. [`accept`] is the second phase: only the named counterparty may
//! call it, both streams must still be `Active`, and the recorded pair must
//! still be the two streams' senders (a role transfer invalidates the offer
//! rather than binding a successor's funds). Acceptance fixes the *baseline*:
//! everything accrued up to that boundary stays with each stream's own
//! recipient, and only accrual after it is netted.
//!
//! # Net settlement math
//!
//! For a settlement at each leg's own clock `t`:
//!
//! ```text
//! gross_a = streamed_a(t) - settled_a      // accrual since the last settlement
//! gross_b = streamed_b(t) - settled_b
//! net     = gross_a - gross_b
//! ```
//!
//! If `net > 0`, leg A's escrow pays `net` to leg B's sender (the counterparty)
//! and leg B pays nothing; if `net < 0`, leg B pays `-net` to leg A's sender. The
//! offset — `min(gross_a, gross_b)` — is not transferred. It is booked as a
//! refund credit to the sender of each leg (`refund_a` / `refund_b`), because
//! the obligation that credit backed has been discharged by the netting and
//! the tokens still sit in that leg's escrow. [`unwind`] pays those credits back
//! to each leg's refund target and books them as withdrawn from that leg (they
//! are accrued value that left the escrow), so the stream's
//! `withdrawn <= streamed <= deposit` invariant and the contract's token
//! coverage both keep holding.
//!
//! ## Rounding policy
//!
//! Each leg's accrual is the existing floored pro-rata term
//! ([`stream::streamed_amount_at_segments`]), evaluated at the *cumulative*
//! settlement boundary rather than per interval. Settlement therefore subtracts
//! two already-floored cumulative amounts: the netting step itself is exact
//! integer subtraction and introduces no rounding at all. Whatever a leg's
//! floor leaves behind stays inside that leg as unaccrued escrow
//! (`deposit - streamed`), which is refundable to its own sender and is never
//! shifted to the peer. Neither party can gain a token by settling more or less
//! often: the sequence of settlements telescopes to the same cumulative
//! amounts.
//!
//! # Unwind semantics
//!
//! [`unwind`] settles up to now, pays the accumulated refund credits, clears
//! both [`DataKey::StreamSwap`] links and marks the swap `Unwound`, restoring
//! each stream's original routing — its own recipient claims normally again.
//! Either sender may unwind at any time; once either leg's window has elapsed
//! anyone may, so an expired swap can never strand a leg. [`unwind_for_cancel`]
//! runs the same path from `cancel_stream`, so cancelling a swapped leg first
//! unwinds the pair and then splits the stream's own (post-refund) deposit.
//! While a swap is active, direct withdrawals on either leg are refused with
//! [`StreamError::SwapStreamBusy`]: the leg's claim is settled through
//! [`settle`], not by the stream's own recipient.
//!
//! # Conservation
//!
//! [`check_pair_conservation`] re-derives the pair identity from the stored
//! records after every state change:
//!
//! ```text
//! deposit_a + deposit_b
//!   == withdrawn_a + withdrawn_b
//!    + refund_a + refund_b
//!    + pre_swap_claim_a + pre_swap_claim_b
//!    + (deposit_a - streamed_a) + (deposit_b - streamed_b)
//!    + (streamed_a - settled_a) + (streamed_b - settled_b)
//! ```
//!
//! where `pre_swap_claim = baseline - withdrawn_at_exec` is the pre-swap
//! accrual that still belongs to the leg's own recipient and `settled` is the
//! cumulative accrual the swap has discharged. At a settlement boundary the
//! last two terms are zero, which is exactly the issue's invariant: combined
//! deposit equals withdrawn + refundable + remaining streamable. A violation is
//! reported as [`StreamError::SwapConservationViolated`] (defensive: the
//! construction cannot produce one).

use soroban_sdk::{contracttype, Address, Env};

use crate::errors::StreamError;
use crate::events::{SwapExecuted, SwapProposed, SwapUnwound};
use crate::stream::{
    self, DataKey, Stream, StreamStatus, TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS,
};
use crate::surface::{self, Branch};
use crate::{oracle, push};

/// Lifetime of a pending swap proposal, in seconds (7 days).
///
/// Same window and same semantics as the rate-change proposal: an offer that is
/// not accepted in time is stale, and a fresh offer must be proposed.
pub const SWAP_PROPOSAL_TTL_SECONDS: u64 = 7 * 24 * 60 * 60;

#[cfg_attr(not(target_family = "wasm"), doc = " Lifecycle of a rate swap.")]
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SwapStatus {
    /// Proposed by one party, awaiting the counterparty's acceptance.
    Pending,
    /// Accepted: both legs' accrual is netted and routed to the peer recipient.
    Active,
    /// Settled up and closed; both streams are back on their own routing.
    Unwound,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " A two-party rate swap linking two sibling streams."
)]
#[cfg_attr(not(target_family = "wasm"), doc = "")]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Stored under [`DataKey::Swap`]; each leg points back through"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " [`DataKey::StreamSwap`], so the parent↔leg link is readable from either"
)]
#[cfg_attr(not(target_family = "wasm"), doc = " side.")]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RateSwap {
    pub id: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Leg A: its accrual is routed to leg B's recipient while swapped."
    )]
    pub stream_a: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Leg B: its accrual is routed to leg A's recipient while swapped."
    )]
    pub stream_b: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The party that proposed the swap (sender of one leg)."
    )]
    pub proposed_by: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The other party (sender of the other leg), whose acceptance executes."
    )]
    pub counterparty: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Ledger timestamp at or after which the offer is stale."
    )]
    pub expires_at: u64,
    pub status: SwapStatus,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Ledger timestamp at which the swap became active (0 while pending)."
    )]
    pub executed_at: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Ledger timestamp at which the swap was unwound (0 before that)."
    )]
    pub unwound_at: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Leg A's cumulative accrual at execution; pre-swap accrual is never netted."
    )]
    pub baseline_a: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Leg B's cumulative accrual at execution."
    )]
    pub baseline_b: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Leg A's `withdrawn` at execution, so the pre-swap claim stays derivable."
    )]
    pub withdrawn_a_at_exec: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Leg B's `withdrawn` at execution."
    )]
    pub withdrawn_b_at_exec: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Leg A's cumulative accrual already discharged by the swap."
    )]
    pub settled_a: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Leg B's cumulative accrual already discharged by the swap."
    )]
    pub settled_b: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Netted offset still owed back to leg A's sender."
    )]
    pub refund_a: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Netted offset still owed back to leg B's sender."
    )]
    pub refund_b: i128,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " One interval's net settlement of a swap pair."
)]
#[cfg_attr(not(target_family = "wasm"), doc = "")]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " `paid_a` / `paid_b` are the tokens each leg's escrow actually moves;"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " `offset_a` / `offset_b` are the discharged-but-unmoved parts booked as"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " refund credits. `paid_a + offset_a == gross_a` and"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " `paid_b + offset_b == gross_b` hold by construction, and at most one of"
)]
#[cfg_attr(not(target_family = "wasm"), doc = " `paid_a` / `paid_b` is non-zero.")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NetSettlement {
    pub gross_a: i128,
    pub gross_b: i128,
    pub net: i128,
    pub paid_a: i128,
    pub paid_b: i128,
    pub offset_a: i128,
    pub offset_b: i128,
}

/// Pure netting math: turns the two legs' gross accruals into the one net
/// transfer and the two offset credits.
///
/// This is exact integer arithmetic — no division, no rounding. `gross_a` and
/// `gross_b` are already-floored cumulative deltas, so the rounding policy is
/// decided upstream by [`stream::streamed_at`] and nothing here can favor one
/// side.
pub fn net_settlement(gross_a: i128, gross_b: i128) -> Result<NetSettlement, StreamError> {
    if gross_a < 0 || gross_b < 0 {
        return Err(surface::reject(Branch::SwapMathOverflow));
    }
    let net = gross_a
        .checked_sub(gross_b)
        .ok_or_else(|| surface::reject(Branch::SwapMathOverflow))?;
    let (paid_a, paid_b) = if net > 0 { (net, 0) } else { (0, -net) };
    let offset_a = gross_a
        .checked_sub(paid_a)
        .ok_or_else(|| surface::reject(Branch::SwapMathOverflow))?;
    let offset_b = gross_b
        .checked_sub(paid_b)
        .ok_or_else(|| surface::reject(Branch::SwapMathOverflow))?;
    Ok(NetSettlement {
        gross_a,
        gross_b,
        net,
        paid_a,
        paid_b,
        offset_a,
        offset_b,
    })
}

// --------------------------------------------------------------- storage --

fn extend_swap_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

fn put_swap(env: &Env, swap: &RateSwap) {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!("write persistent Swap({})", swap.id));
    let key = DataKey::Swap(swap.id);
    env.storage().persistent().set(&key, swap);
    extend_swap_ttl(env, &key);
}

/// Loads a swap record, extending its storage TTL on the read.
pub fn get_swap(env: &Env, swap_id: u64) -> Result<RateSwap, StreamError> {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!("read persistent Swap({swap_id})"));
    let key = DataKey::Swap(swap_id);
    let swap: RateSwap = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or_else(|| surface::reject(Branch::SwapNotFound))?;
    extend_swap_ttl(env, &key);
    Ok(swap)
}

/// The swap id linked to `stream_id`, if any (pending or active).
///
/// Deliberately outside the CEI trace: the claim guard reads this link before
/// any effect on every withdrawal, and tracing it would rewrite the golden
/// operation order of the pre-existing claim paths for a lookup that changes
/// nothing. The swap entrypoints' own effects (writes, link removals, events,
/// transfers) are traced as usual.
pub fn stream_swap(env: &Env, stream_id: u64) -> Option<u64> {
    env.storage()
        .persistent()
        .get(&DataKey::StreamSwap(stream_id))
}

/// Whether `stream_id` is currently on an *active* swap (a pending proposal
/// does not change routing and therefore does not block direct claims).
pub fn active_swap_for(env: &Env, stream_id: u64) -> bool {
    match stream_swap(env, stream_id) {
        Some(swap_id) => match env.storage().persistent().get(&DataKey::Swap(swap_id)) {
            Some(swap) => {
                let swap: RateSwap = swap;
                swap.status == SwapStatus::Active
            }
            None => false,
        },
        None => false,
    }
}

fn link_stream(env: &Env, stream_id: u64, swap_id: u64) {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!("write persistent StreamSwap({stream_id})"));
    let key = DataKey::StreamSwap(stream_id);
    env.storage().persistent().set(&key, &swap_id);
    extend_swap_ttl(env, &key);
}

fn unlink_stream(env: &Env, stream_id: u64) {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!("remove persistent StreamSwap({stream_id})"));
    env.storage()
        .persistent()
        .remove(&DataKey::StreamSwap(stream_id));
}

fn next_swap_id(env: &Env) -> u64 {
    let key = DataKey::NextSwapId;
    let id: u64 = env.storage().instance().get(&key).unwrap_or(1);
    env.storage().instance().set(&key, &(id + 1));
    id
}

// ------------------------------------------------------------------ clock --

/// A leg's accrual timestamp: its own oracle-resolved clock, frozen at a pause
/// boundary exactly like every other accrual read.
fn leg_now(env: &Env, stream: &Stream) -> u64 {
    let resolved = oracle::resolve_stream_time(env, stream.id, stream.uses_oracle());
    stream::accrual_now(env, stream.id, resolved.timestamp)
}

fn leg_streamed(env: &Env, stream: &Stream) -> Result<i128, StreamError> {
    let segments = stream::get_rate_segments(env, stream.id);
    stream::streamed_amount_at_segments(stream, leg_now(env, stream), &segments)
}

// -------------------------------------------------------------- two-phase --

/// Phase one: proposes a swap between two sibling streams.
///
/// `caller` must be the sender of one of the two streams and their
/// authorization is required. The streams must both be `Active`, share one
/// token, have distinct ids and distinct senders, be unlinked from any other
/// swap, and still have some window left. Nothing moves and no accounting
/// field changes; the offer is stored for [`SWAP_PROPOSAL_TTL_SECONDS`].
pub fn propose(
    env: &Env,
    caller: Address,
    stream_a: u64,
    stream_b: u64,
) -> Result<u64, StreamError> {
    if stream_a == stream_b {
        return Err(surface::reject(Branch::SwapSameStream));
    }
    let a = stream::get_stream(env, stream_a)?;
    let b = stream::get_stream(env, stream_b)?;
    if a.status != StreamStatus::Active || b.status != StreamStatus::Active {
        return Err(surface::reject(Branch::StreamNotActive));
    }
    if a.token != b.token {
        return Err(surface::reject(Branch::SwapIncompatibleStreams));
    }
    // The two parties are the two senders, and they must be distinct: a swap
    // between one address and itself has nothing to net.
    let counterparty = if caller == a.sender && caller != b.sender {
        b.sender.clone()
    } else if caller == b.sender && caller != a.sender {
        a.sender.clone()
    } else {
        return Err(surface::reject(Branch::SwapNotParty));
    };
    if stream_swap(env, stream_a).is_some() || stream_swap(env, stream_b).is_some() {
        return Err(surface::reject(Branch::SwapAlreadyLinked));
    }
    let now = env.ledger().timestamp();
    if now >= a.end_time || now >= b.end_time {
        return Err(surface::reject(Branch::SwapWindowElapsed));
    }

    let swap_id = next_swap_id(env);
    let swap = RateSwap {
        id: swap_id,
        stream_a,
        stream_b,
        proposed_by: caller.clone(),
        counterparty: counterparty.clone(),
        expires_at: now.saturating_add(SWAP_PROPOSAL_TTL_SECONDS),
        status: SwapStatus::Pending,
        executed_at: 0,
        unwound_at: 0,
        baseline_a: 0,
        baseline_b: 0,
        withdrawn_a_at_exec: 0,
        withdrawn_b_at_exec: 0,
        settled_a: 0,
        settled_b: 0,
        refund_a: 0,
        refund_b: 0,
    };
    put_swap(env, &swap);
    link_stream(env, stream_a, swap_id);
    link_stream(env, stream_b, swap_id);

    #[cfg(test)]
    crate::cei_trace::record("event SwapProposed");
    SwapProposed {
        swap_id,
        stream_a,
        stream_b,
        proposed_by: caller,
        counterparty,
        expires_at: swap.expires_at,
    }
    .publish(env);

    Ok(swap_id)
}

/// Phase two: the counterparty accepts a pending swap, making it active.
///
/// The acceptance boundary is fixed here: each leg's cumulative accrual and
/// `withdrawn` are recorded as the baseline, so nothing accrued before this
/// moment is ever netted.
pub fn accept(env: &Env, caller: Address, swap_id: u64) -> Result<(), StreamError> {
    let mut swap = get_swap(env, swap_id)?;
    if swap.status != SwapStatus::Pending {
        return Err(surface::reject(Branch::SwapNotPending));
    }
    if caller != swap.counterparty {
        return Err(surface::reject(Branch::SwapNotParty));
    }
    if env.ledger().timestamp() >= swap.expires_at {
        return Err(surface::reject(Branch::SwapProposalExpired));
    }
    let a = stream::get_stream(env, swap.stream_a)?;
    let b = stream::get_stream(env, swap.stream_b)?;
    if a.status != StreamStatus::Active || b.status != StreamStatus::Active {
        return Err(surface::reject(Branch::StreamNotActive));
    }
    // A role transfer after the offer was made invalidates it, exactly like a
    // rate-change proposal: the new holder never consented to this swap.
    let same_pair = (a.sender == swap.proposed_by && b.sender == swap.counterparty)
        || (a.sender == swap.counterparty && b.sender == swap.proposed_by);
    if !same_pair {
        return Err(surface::reject(Branch::SwapNotParty));
    }

    let baseline_a = leg_streamed(env, &a)?;
    let baseline_b = leg_streamed(env, &b)?;
    swap.baseline_a = baseline_a;
    swap.baseline_b = baseline_b;
    swap.withdrawn_a_at_exec = a.withdrawn;
    swap.withdrawn_b_at_exec = b.withdrawn;
    swap.settled_a = baseline_a;
    swap.settled_b = baseline_b;
    swap.status = SwapStatus::Active;
    swap.executed_at = env.ledger().timestamp();
    put_swap(env, &swap);
    check_pair_conservation(env, &swap)?;

    #[cfg(test)]
    crate::cei_trace::record("event SwapExecuted");
    SwapExecuted {
        swap_id,
        stream_a: swap.stream_a,
        stream_b: swap.stream_b,
        executed_at: swap.executed_at,
        baseline_a,
        baseline_b,
    }
    .publish(env);

    Ok(())
}

// -------------------------------------------------------------- settlement --

/// Settles the net difference accrued since the last settlement.
///
/// Either sender may call it. Only the net amount moves (at most one transfer);
/// the offset is booked as refund credits for both senders. Effects are written
/// before the transfer, so a token that refuses the payout rolls the whole
/// settlement back and the swap stays exactly where it was.
pub fn settle(env: &Env, caller: Address, swap_id: u64) -> Result<(), StreamError> {
    let mut swap = get_swap(env, swap_id)?;
    if swap.status != SwapStatus::Active {
        return Err(surface::reject(Branch::SwapNotActive));
    }
    let a = stream::get_stream(env, swap.stream_a)?;
    let b = stream::get_stream(env, swap.stream_b)?;
    if caller != a.sender && caller != b.sender {
        return Err(surface::reject(Branch::SwapNotParty));
    }
    settle_active(env, &mut swap)
}

/// Shared settlement body, used by [`settle`], [`unwind`] and the cancel hook.
fn settle_active(env: &Env, swap: &mut RateSwap) -> Result<(), StreamError> {
    let mut a = stream::get_stream(env, swap.stream_a)?;
    let mut b = stream::get_stream(env, swap.stream_b)?;
    if a.status != StreamStatus::Active || b.status != StreamStatus::Active {
        return Err(surface::reject(Branch::SwapNotActive));
    }

    let streamed_a = leg_streamed(env, &a)?;
    let streamed_b = leg_streamed(env, &b)?;
    let gross_a = streamed_a
        .checked_sub(swap.settled_a)
        .ok_or_else(|| surface::reject(Branch::SwapMathOverflow))?;
    let gross_b = streamed_b
        .checked_sub(swap.settled_b)
        .ok_or_else(|| surface::reject(Branch::SwapMathOverflow))?;
    let settlement = net_settlement(gross_a, gross_b)?;

    // Effects (CEI): book what each escrow paid and what it offset, then move
    // tokens. `withdrawn` only counts tokens that actually left the escrow, so
    // `deposit - withdrawn` stays exactly the value the contract still holds
    // for that stream plus its own pre-swap claim.
    a.withdrawn = a
        .withdrawn
        .checked_add(settlement.paid_a)
        .ok_or_else(|| surface::reject(Branch::SwapMathOverflow))?;
    b.withdrawn = b
        .withdrawn
        .checked_add(settlement.paid_b)
        .ok_or_else(|| surface::reject(Branch::SwapMathOverflow))?;
    swap.settled_a = streamed_a;
    swap.settled_b = streamed_b;
    swap.refund_a = swap
        .refund_a
        .checked_add(settlement.offset_a)
        .ok_or_else(|| surface::reject(Branch::SwapMathOverflow))?;
    swap.refund_b = swap
        .refund_b
        .checked_add(settlement.offset_b)
        .ok_or_else(|| surface::reject(Branch::SwapMathOverflow))?;
    stream::put_stream(env, &a);
    stream::put_stream(env, &b);
    put_swap(env, swap);

    // At most one transfer: the net, paid to the party whose leg accrued less
    // (the peer party, which is the address that consented to the swap).
    if settlement.net > 0 {
        push(
            env,
            &a.token,
            &stream::muxed(&b.sender),
            settlement.net,
            Branch::RecipientPayoutFailed,
        )?;
    } else if settlement.net < 0 {
        let amount = 0i128
            .checked_sub(settlement.net)
            .ok_or_else(|| surface::reject(Branch::SwapMathOverflow))?;
        push(
            env,
            &a.token,
            &stream::muxed(&a.sender),
            amount,
            Branch::RecipientPayoutFailed,
        )?;
    }

    check_pair_conservation(env, swap)
}

// ------------------------------------------------------------------ unwind --

/// Unwinds an active swap: settles to now, refunds both offset credits and
/// restores each stream's original routing.
///
/// Either sender may unwind at any time. After either leg's window has elapsed
/// anyone may, so an expired swap can never leave a leg stranded. A pending
/// proposal is not unwound here — it never changed routing; cancelling a leg
/// clears it.
pub fn unwind(env: &Env, caller: Address, swap_id: u64) -> Result<(), StreamError> {
    let mut swap = get_swap(env, swap_id)?;
    if swap.status != SwapStatus::Active {
        return Err(surface::reject(Branch::SwapNotActive));
    }
    let a = stream::get_stream(env, swap.stream_a)?;
    let b = stream::get_stream(env, swap.stream_b)?;
    let party = caller == a.sender || caller == b.sender;
    let now = env.ledger().timestamp();
    if !party && now < a.end_time && now < b.end_time {
        return Err(surface::reject(Branch::SwapNotParty));
    }
    settle_active(env, &mut swap)?;
    finish_unwind(env, &mut swap)
}

/// Pays both refund credits, books them as withdrawn from their legs and marks
/// the swap `Unwound`.
fn finish_unwind(env: &Env, swap: &mut RateSwap) -> Result<(), StreamError> {
    let mut a = stream::get_stream(env, swap.stream_a)?;
    let mut b = stream::get_stream(env, swap.stream_b)?;
    let refund_a = swap.refund_a;
    let refund_b = swap.refund_b;
    let token = a.token.clone();
    let refund_to_a = stream::refund_target(env, &a);
    let refund_to_b = stream::refund_target(env, &b);

    // Effects (CEI): the credits are accrued value that leaves each escrow, so
    // they are booked as withdrawn from the leg that funded them; both links are
    // cleared and the swap is closed before any token moves. `withdrawn` stays
    // `<= streamed` because every credit was discharged accrual.
    a.withdrawn = a
        .withdrawn
        .checked_add(refund_a)
        .ok_or_else(|| surface::reject(Branch::SwapMathOverflow))?;
    b.withdrawn = b
        .withdrawn
        .checked_add(refund_b)
        .ok_or_else(|| surface::reject(Branch::SwapMathOverflow))?;
    // A leg whose whole deposit is now discharged is depleted, exactly as the
    // normal payout path would leave it; the swap link is gone either way.
    if a.withdrawn == a.deposit {
        a.status = StreamStatus::Depleted;
    }
    if b.withdrawn == b.deposit {
        b.status = StreamStatus::Depleted;
    }
    stream::put_stream(env, &a);
    stream::put_stream(env, &b);
    swap.refund_a = 0;
    swap.refund_b = 0;
    swap.status = SwapStatus::Unwound;
    swap.unwound_at = env.ledger().timestamp();
    put_swap(env, swap);
    unlink_stream(env, swap.stream_a);
    unlink_stream(env, swap.stream_b);

    #[cfg(test)]
    crate::cei_trace::record("event SwapUnwound");
    SwapUnwound {
        swap_id: swap.id,
        stream_a: swap.stream_a,
        stream_b: swap.stream_b,
        unwound_at: swap.unwound_at,
        settled_a: swap.settled_a,
        settled_b: swap.settled_b,
        refund_a,
        refund_b,
    }
    .publish(env);

    if refund_a > 0 {
        push(
            env,
            &token,
            &stream::muxed(&refund_to_a),
            refund_a,
            Branch::SenderRefundFailed,
        )?;
    }
    if refund_b > 0 {
        push(
            env,
            &token,
            &stream::muxed(&refund_to_b),
            refund_b,
            Branch::SenderRefundFailed,
        )?;
    }

    check_pair_conservation(env, swap)
}

/// Unwinds whatever swap `stream_id` is part of, called from `cancel_stream`.
///
/// A pending proposal is simply cleared (it never changed routing, so there is
/// nothing to settle and no `SwapUnwound` event to emit); an active swap is
/// settled and unwound exactly like [`unwind`].
///
/// Returns whether the stream's record was rewritten, so `cancel_stream` only
/// reloads it (and only pays for that read) when a swap actually touched it.
pub fn unwind_for_cancel(env: &Env, stream_id: u64) -> Result<bool, StreamError> {
    let Some(swap_id) = stream_swap(env, stream_id) else {
        return Ok(false);
    };
    let mut swap = get_swap(env, swap_id)?;
    match swap.status {
        SwapStatus::Pending => {
            swap.status = SwapStatus::Unwound;
            swap.unwound_at = env.ledger().timestamp();
            put_swap(env, &swap);
            unlink_stream(env, swap.stream_a);
            unlink_stream(env, swap.stream_b);
            Ok(false)
        }
        SwapStatus::Active => {
            settle_active(env, &mut swap)?;
            finish_unwind(env, &mut swap)?;
            Ok(true)
        }
        SwapStatus::Unwound => {
            unlink_stream(env, stream_id);
            Ok(false)
        }
    }
}

// ----------------------------------------------------------- conservation --

/// Re-derives the swap pair's conservation identity from stored records.
///
/// See the module docs for the identity. Called after acceptance, every
/// settlement and every unwind; a mismatch is a defensive error, since the
/// construction cannot produce one.
pub fn check_pair_conservation(env: &Env, swap: &RateSwap) -> Result<(), StreamError> {
    if swap.status != SwapStatus::Active && swap.status != SwapStatus::Unwound {
        return Ok(());
    }
    let a = stream::get_stream(env, swap.stream_a)?;
    let b = stream::get_stream(env, swap.stream_b)?;
    let streamed_a = leg_streamed(env, &a)?;
    let streamed_b = leg_streamed(env, &b)?;

    let combined_deposit = a
        .deposit
        .checked_add(b.deposit)
        .ok_or_else(|| surface::reject(Branch::SwapConservationViolated))?;
    let withdrawn = a
        .withdrawn
        .checked_add(b.withdrawn)
        .ok_or_else(|| surface::reject(Branch::SwapConservationViolated))?;
    let pre_swap_a = swap
        .baseline_a
        .checked_sub(swap.withdrawn_a_at_exec)
        .ok_or_else(|| surface::reject(Branch::SwapConservationViolated))?;
    let pre_swap_b = swap
        .baseline_b
        .checked_sub(swap.withdrawn_b_at_exec)
        .ok_or_else(|| surface::reject(Branch::SwapConservationViolated))?;
    let refundable = swap
        .refund_a
        .checked_add(swap.refund_b)
        .and_then(|v| v.checked_add(pre_swap_a))
        .and_then(|v| v.checked_add(pre_swap_b))
        .ok_or_else(|| surface::reject(Branch::SwapConservationViolated))?;
    let remaining = a
        .deposit
        .checked_sub(streamed_a)
        .and_then(|v| v.checked_add(b.deposit.checked_sub(streamed_b)?))
        .ok_or_else(|| surface::reject(Branch::SwapConservationViolated))?;
    let unsettled = streamed_a
        .checked_sub(swap.settled_a)
        .and_then(|v| v.checked_add(streamed_b.checked_sub(swap.settled_b)?))
        .ok_or_else(|| surface::reject(Branch::SwapConservationViolated))?;
    let total = withdrawn
        .checked_add(refundable)
        .and_then(|v| v.checked_add(remaining))
        .and_then(|v| v.checked_add(unsettled))
        .ok_or_else(|| surface::reject(Branch::SwapConservationViolated))?;
    if total != combined_deposit {
        return Err(surface::reject(Branch::SwapConservationViolated));
    }
    Ok(())
}
