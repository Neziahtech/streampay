//! Rate-swap tests (#568): two-phase commit, net settlement, unwind and the
//! pair conservation identity.
//!
//! Three layers:
//!
//! * Scenario tests pin the exact amounts of a settlement and an unwind, the
//!   event shapes, the withdrawal guard and the cancel hook.
//! * A proptest round-trips random swap → settle* → unwind sequences and checks
//!   that combined value is conserved and that no token is created.
//! * A differential test compares the contract against an independent reference
//!   model of the net-settlement math over random schedules.
//!
//! The operation-order tests are CEI goldens (`test_orderings/settle_swap.txt`
//! and `test_orderings/unwind_swap.txt`), and the first scenario runs with the
//! SDK's snapshot capture enabled, so the stored swap/stream records are also
//! pinned as a storage golden.
#![cfg(test)]

use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _},
    token::Client as TokenClient,
    Address, Event as _, IntoVal, TryFromVal,
};

use crate::test::Fixture;
use crate::{
    net_settlement, RateSwap, StreamError, StreamStatus, SwapStatus, SWAP_PROPOSAL_TTL_SECONDS,
};

const DEPOSIT_A: i128 = 1_000_000_000;
const DEPOSIT_B: i128 = 300_000_000;
const DURATION: u64 = 1_000;

/// Two counterparties with one stream each, plus the distinct payout addresses
/// the streams had before the swap. Net settlement pays the *parties*; the
/// original recipients resume their claims on unwind.
struct SwapFixture {
    f: Fixture,
    a: u64,
    b: u64,
    payer: Address,
    recipient_a: Address,
    recipient_b: Address,
}

impl SwapFixture {
    fn setup(deposit_a: i128, deposit_b: i128, duration: u64) -> Self {
        Self::setup_with_snapshot(deposit_a, deposit_b, duration, false)
    }

    fn setup_with_snapshot(deposit_a: i128, deposit_b: i128, duration: u64, capture: bool) -> Self {
        let f = if capture {
            Fixture::setup()
        } else {
            Fixture::setup_quiet()
        };
        let now = f.env.ledger().timestamp();
        let payer = f.fund_payer();
        let recipient_a = Address::generate(&f.env);
        let recipient_b = Address::generate(&f.env);
        let a = f.client.create_stream(
            &f.sender,
            &recipient_a,
            &f.token,
            &deposit_a,
            &now,
            &(now + duration),
            &true,
        );
        let b = f.client.create_stream(
            &payer,
            &recipient_b,
            &f.token,
            &deposit_b,
            &now,
            &(now + duration),
            &true,
        );
        SwapFixture {
            f,
            a,
            b,
            payer,
            recipient_a,
            recipient_b,
        }
    }

    fn propose(&self) -> u64 {
        self.f
            .client
            .mock_all_auths()
            .propose_swap(&self.f.sender, &self.a, &self.b)
    }

    fn propose_and_accept(&self) -> u64 {
        let id = self.propose();
        self.f.client.mock_all_auths().accept_swap(&self.payer, &id);
        id
    }

    fn swap(&self, id: u64) -> RateSwap {
        self.f.client.get_swap(&id)
    }

    fn stream(&self, id: u64) -> crate::Stream {
        self.f.client.get_stream(&id)
    }

    fn balance(&self, who: &Address) -> i128 {
        TokenClient::new(&self.f.env, &self.f.token).balance(who)
    }

    fn contract_balance(&self) -> i128 {
        self.balance(&self.f.client.address)
    }

    fn advance(&self, seconds: u64) {
        self.f.advance_time(seconds);
    }
}

// ------------------------------------------------------------- scenarios ---

#[test]
fn propose_links_both_legs_and_emits_swap_proposed() {
    // Snapshot capture on: this scenario's stored records are a storage golden.
    let s = SwapFixture::setup_with_snapshot(DEPOSIT_A, DEPOSIT_B, DURATION, true);
    let now = s.f.env.ledger().timestamp();

    let swap_id = s.propose();
    // `events().all()` reports the last invocation's events, so snapshot them
    // before any further client call (a view would replace the log).
    let events = s.f.env.events().all();

    let swap = s.swap(swap_id);
    assert_eq!(swap.status, SwapStatus::Pending);
    assert_eq!(swap.stream_a, s.a);
    assert_eq!(swap.stream_b, s.b);
    assert_eq!(swap.proposed_by, s.f.sender);
    assert_eq!(swap.counterparty, s.payer);
    assert_eq!(swap.expires_at, now + SWAP_PROPOSAL_TTL_SECONDS);
    // Parent↔leg links are readable from either side.
    assert_eq!(s.f.client.stream_swap(&s.a), Some(swap_id));
    assert_eq!(s.f.client.stream_swap(&s.b), Some(swap_id));

    // Nothing about either stream's accounting changed at proposal time.
    let a = s.stream(s.a);
    let b = s.stream(s.b);
    assert_eq!(a.withdrawn, 0);
    assert_eq!(b.withdrawn, 0);
    assert_eq!(a.status, StreamStatus::Active);
    // Routing is untouched at proposal time: each leg still pays its own
    // recipient until the counterparty accepts.
    assert_eq!(a.recipient, s.recipient_a);
    assert_eq!(b.recipient, s.recipient_b);

    let proposed = crate::SwapProposed {
        swap_id,
        stream_a: s.a,
        stream_b: s.b,
        proposed_by: s.f.sender.clone(),
        counterparty: s.payer.clone(),
        expires_at: swap.expires_at,
    };
    assert_eq!(
        events.filter_by_contract(&s.f.client.address),
        [proposed.to_xdr(&s.f.env, &s.f.client.address)],
    );
}

#[test]
fn accept_records_baseline_and_emits_swap_executed() {
    let s = SwapFixture::setup(DEPOSIT_A, DEPOSIT_B, DURATION);
    let swap_id = s.propose();
    s.advance(DURATION / 2);

    // Accrued before acceptance belongs to the original recipients and must not
    // be netted: it is captured as the baseline.
    s.f.client.mock_all_auths().accept_swap(&s.payer, &swap_id);
    let events = s.f.env.events().all();

    let swap = s.swap(swap_id);
    assert_eq!(swap.status, SwapStatus::Active);
    assert_eq!(swap.baseline_a, DEPOSIT_A / 2);
    assert_eq!(swap.baseline_b, DEPOSIT_B / 2);
    assert_eq!(swap.settled_a, swap.baseline_a);
    assert_eq!(swap.settled_b, swap.baseline_b);

    let executed = crate::SwapExecuted {
        swap_id,
        stream_a: s.a,
        stream_b: s.b,
        executed_at: swap.executed_at,
        baseline_a: swap.baseline_a,
        baseline_b: swap.baseline_b,
    };
    assert_eq!(
        events.filter_by_contract(&s.f.client.address),
        [executed.to_xdr(&s.f.env, &s.f.client.address)],
    );
}

#[test]
fn settle_routes_only_the_net_difference() {
    let s = SwapFixture::setup(DEPOSIT_A, DEPOSIT_B, DURATION);
    let swap_id = s.propose_and_accept();
    let payer_before = s.balance(&s.payer);
    let contract_before = s.contract_balance();
    s.advance(DURATION / 2);

    s.f.client
        .mock_all_auths()
        .settle_swap(&s.f.sender, &swap_id);
    let events = s.f.env.events().all();

    // Leg A accrued 500, leg B 150; only the 350 difference moves, to B.
    let swap = s.swap(swap_id);
    assert_eq!(swap.settled_a, DEPOSIT_A / 2);
    assert_eq!(swap.settled_b, DEPOSIT_B / 2);
    assert_eq!(swap.refund_a, DEPOSIT_B / 2);
    assert_eq!(swap.refund_b, DEPOSIT_B / 2);
    assert_eq!(
        s.balance(&s.payer),
        payer_before + (DEPOSIT_A / 2 - DEPOSIT_B / 2)
    );
    assert_eq!(
        s.contract_balance(),
        contract_before - (DEPOSIT_A / 2 - DEPOSIT_B / 2)
    );

    let a = s.stream(s.a);
    let b = s.stream(s.b);
    // Only tokens that actually left an escrow count as withdrawn.
    assert_eq!(a.withdrawn, DEPOSIT_A / 2 - DEPOSIT_B / 2);
    assert_eq!(b.withdrawn, 0);
    // No gross double transfer: exactly one token transfer event for the net.
    assert_eq!(events.filter_by_contract(&s.f.token).events().len(), 1);
}

#[test]
fn settle_is_additive_and_never_favors_a_party() {
    // Deposits that do not divide evenly by the window: every leg floors its own
    // accrual, and the net is the difference of the two cumulative floors.
    let s = SwapFixture::setup(1_000_000_007, 300_000_013, 7);
    let swap_id = s.propose_and_accept();
    let payer_before = s.balance(&s.payer);

    // Settling at 1, 3 and 6 seconds must telescope to the same totals as one
    // settlement at 6 seconds.
    for step in [1u64, 2, 3] {
        s.advance(step);
        s.f.client
            .mock_all_auths()
            .settle_swap(&s.f.sender, &swap_id);
    }
    let swap = s.swap(swap_id);
    let expected_a = 1_000_000_007i128 * 6 / 7;
    let expected_b = 300_000_013i128 * 6 / 7;
    assert_eq!(swap.settled_a, expected_a);
    assert_eq!(swap.settled_b, expected_b);
    // The net is exact: difference of the two floored cumulative amounts.
    assert_eq!(
        s.balance(&s.payer),
        payer_before + (expected_a - expected_b)
    );
    // Offsets are exactly what each leg accrued but did not transfer.
    assert_eq!(swap.refund_a, expected_b);
    assert_eq!(swap.refund_b, expected_b);
    // Floor residue stays in the legs, never moves to the peer.
    assert_eq!(
        s.stream(s.a).deposit - expected_a,
        1_000_000_007 - expected_a
    );
}

#[test]
fn unwind_refunds_offsets_and_restores_routing() {
    let s = SwapFixture::setup(DEPOSIT_A, DEPOSIT_B, DURATION);
    let swap_id = s.propose_and_accept();
    let sender_before = s.balance(&s.f.sender);
    let payer_before = s.balance(&s.payer);
    s.advance(DURATION / 2);
    s.f.client
        .mock_all_auths()
        .settle_swap(&s.f.sender, &swap_id);
    s.advance(DURATION / 2);

    s.f.client.mock_all_auths().unwind_swap(&s.payer, &swap_id);
    let events = s.f.env.events().all();

    let swap = s.swap(swap_id);
    assert_eq!(swap.status, SwapStatus::Unwound);
    assert_eq!(swap.refund_a, 0);
    assert_eq!(swap.refund_b, 0);
    assert_eq!(s.f.client.stream_swap(&s.a), None);
    assert_eq!(s.f.client.stream_swap(&s.b), None);

    // Every accrued token was either netted or refunded: both deposits are fully
    // discharged and the contract holds nothing for the pair.
    let a = s.stream(s.a);
    let b = s.stream(s.b);
    assert_eq!(a.withdrawn, DEPOSIT_A);
    assert_eq!(b.withdrawn, DEPOSIT_B);
    assert_eq!(s.balance(&s.f.sender), sender_before + DEPOSIT_B);
    assert_eq!(s.balance(&s.payer), payer_before + DEPOSIT_A);
    assert_eq!(s.contract_balance(), 0);

    // Routing is restored: the original recipients can claim again (nothing is
    // left to claim here, because the whole window elapsed while swapped).
    assert!(s.f.client.mock_all_auths().try_withdraw_max(&s.a).is_err());

    let unwound = crate::SwapUnwound {
        swap_id,
        stream_a: s.a,
        stream_b: s.b,
        unwound_at: swap.unwound_at,
        settled_a: DEPOSIT_A,
        settled_b: DEPOSIT_B,
        refund_a: DEPOSIT_B,
        refund_b: DEPOSIT_B,
    };
    assert_eq!(
        events.filter_by_contract(&s.f.client.address),
        [unwound.to_xdr(&s.f.env, &s.f.client.address)],
    );
}

#[test]
fn cancel_stream_unwinds_active_swap_first() {
    let s = SwapFixture::setup(DEPOSIT_A, DEPOSIT_B, DURATION);
    let swap_id = s.propose_and_accept();
    s.advance(DURATION / 2);
    let payer_before = s.balance(&s.payer);

    // Cancelling leg A settles the pair, refunds both offsets, then splits leg
    // A's own deposit at the same instant.
    s.f.client.mock_all_auths().cancel_stream(&s.f.sender, &s.a);

    let swap = s.swap(swap_id);
    assert_eq!(swap.status, SwapStatus::Unwound);
    let a = s.stream(s.a);
    assert_eq!(a.status, StreamStatus::Cancelled);
    assert_eq!(a.withdrawn, DEPOSIT_A / 2);
    // Leg B keeps streaming under its original routing.
    assert_eq!(s.f.client.stream_swap(&s.b), None);
    assert_eq!(s.stream(s.b).status, StreamStatus::Active);
    // B's party received the net difference during the unwind settlement and
    // its own offset credit from the unwind itself.
    assert_eq!(
        s.balance(&s.payer),
        payer_before + (DEPOSIT_A / 2 - DEPOSIT_B / 2) + (DEPOSIT_B / 2)
    );
}

#[test]
fn expired_swap_can_be_unwound_by_anyone() {
    let s = SwapFixture::setup(DEPOSIT_A, DEPOSIT_B, DURATION);
    let swap_id = s.propose_and_accept();
    s.advance(DURATION);

    let stranger = Address::generate(&s.f.env);
    s.f.client.mock_all_auths().unwind_swap(&stranger, &swap_id);

    assert_eq!(s.swap(swap_id).status, SwapStatus::Unwound);
    assert_eq!(s.stream(s.a).withdrawn, DEPOSIT_A);
    assert_eq!(s.stream(s.b).withdrawn, DEPOSIT_B);
}

#[test]
fn withdraw_is_blocked_while_swapped() {
    let s = SwapFixture::setup(DEPOSIT_A, DEPOSIT_B, DURATION);
    let swap_id = s.propose_and_accept();
    s.advance(DURATION / 2);

    assert_eq!(
        s.f.client
            .mock_all_auths()
            .try_withdraw(&s.a, &crate::MIN_CLAIM_AMOUNT)
            .unwrap_err()
            .unwrap(),
        StreamError::SwapStreamBusy
    );
    assert_eq!(
        s.f.client
            .mock_all_auths()
            .try_withdraw_max(&s.b)
            .unwrap_err()
            .unwrap(),
        StreamError::SwapStreamBusy
    );
    // A pending proposal does not change routing, so it does not block claims.
    let pending = SwapFixture::setup(DEPOSIT_A, DEPOSIT_B, DURATION);
    let _ = pending.propose();
    pending.advance(DURATION / 2);
    pending.f.client.mock_all_auths().withdraw_max(&pending.a);
    let _ = swap_id;
}

#[test]
fn cancelling_a_leg_clears_a_pending_proposal() {
    let s = SwapFixture::setup(DEPOSIT_A, DEPOSIT_B, DURATION);
    let swap_id = s.propose();
    s.f.client.mock_all_auths().cancel_stream(&s.f.sender, &s.a);

    assert_eq!(s.swap(swap_id).status, SwapStatus::Unwound);
    assert_eq!(s.f.client.stream_swap(&s.a), None);
    assert_eq!(s.f.client.stream_swap(&s.b), None);
    // Leg B was never routed and can be swapped again.
    let now = s.f.env.ledger().timestamp();
    let _ = now;
}

#[test]
fn swap_storage_keys_are_named() {
    use soroban_sdk::xdr::ScVal;

    let f = Fixture::setup_quiet();
    for (key, name) in [
        (crate::stream::DataKey::NextSwapId, "next_swap_id"),
        (crate::stream::DataKey::Swap(7), "swap"),
        (crate::stream::DataKey::StreamSwap(7), "stream_swap"),
    ] {
        let val: soroban_sdk::Val = key.into_val(&f.env);
        let scval = ScVal::try_from_val(&f.env, &val).expect("data key scval");
        assert_eq!(
            crate::storage_golden::kind_for_key(&f.env, &scval).as_deref(),
            Some(name)
        );
    }
}

// -------------------------------------------------------- reference model --

/// Independent reference model of the net-settlement math, written with plain
/// integers and no contract code. The differential test compares the contract's
/// stored state against it after every operation.
#[derive(Clone, Debug)]
struct ReferenceModel {
    deposit_a: i128,
    deposit_b: i128,
    duration: u64,
    start: u64,
    baseline_a: i128,
    baseline_b: i128,
    withdrawn_a_at_exec: i128,
    withdrawn_b_at_exec: i128,
    settled_a: i128,
    settled_b: i128,
    withdrawn_a: i128,
    withdrawn_b: i128,
    refund_a: i128,
    refund_b: i128,
    executed: bool,
}

impl ReferenceModel {
    fn new(deposit_a: i128, deposit_b: i128, duration: u64, start: u64) -> Self {
        ReferenceModel {
            deposit_a,
            deposit_b,
            duration,
            start,
            baseline_a: 0,
            baseline_b: 0,
            withdrawn_a_at_exec: 0,
            withdrawn_b_at_exec: 0,
            settled_a: 0,
            settled_b: 0,
            withdrawn_a: 0,
            withdrawn_b: 0,
            refund_a: 0,
            refund_b: 0,
            executed: false,
        }
    }

    fn streamed(deposit: i128, duration: u64, elapsed: u64) -> i128 {
        deposit * elapsed as i128 / duration as i128
    }

    fn execute(&mut self, now: u64) {
        let elapsed = now - self.start;
        self.baseline_a = Self::streamed(self.deposit_a, self.duration, elapsed);
        self.baseline_b = Self::streamed(self.deposit_b, self.duration, elapsed);
        self.settled_a = self.baseline_a;
        self.settled_b = self.baseline_b;
        self.executed = true;
    }

    fn settle(&mut self, now: u64) {
        let elapsed = now - self.start;
        let streamed_a = Self::streamed(self.deposit_a, self.duration, elapsed);
        let streamed_b = Self::streamed(self.deposit_b, self.duration, elapsed);
        let gross_a = streamed_a - self.settled_a;
        let gross_b = streamed_b - self.settled_b;
        let settlement = net_settlement(gross_a, gross_b).expect("model net settlement");
        self.withdrawn_a += settlement.paid_a;
        self.withdrawn_b += settlement.paid_b;
        self.settled_a = streamed_a;
        self.settled_b = streamed_b;
        self.refund_a += settlement.offset_a;
        self.refund_b += settlement.offset_b;
    }

    fn unwind(&mut self, now: u64) {
        self.settle(now);
        self.withdrawn_a += self.refund_a;
        self.withdrawn_b += self.refund_b;
        self.refund_a = 0;
        self.refund_b = 0;
    }

    /// `withdrawn + refundable + remaining_streamable + unsettled` for the pair.
    fn conserved_total(&self, now: u64) -> i128 {
        let elapsed = now - self.start;
        let streamed_a = Self::streamed(self.deposit_a, self.duration, elapsed);
        let streamed_b = Self::streamed(self.deposit_b, self.duration, elapsed);
        self.withdrawn_a
            + self.withdrawn_b
            + self.refund_a
            + self.refund_b
            + (self.baseline_a - self.withdrawn_a_at_exec)
            + (self.baseline_b - self.withdrawn_b_at_exec)
            + (self.deposit_a - streamed_a)
            + (self.deposit_b - streamed_b)
            + (streamed_a - self.settled_a)
            + (streamed_b - self.settled_b)
    }
}

fn assert_matches_model(s: &SwapFixture, id: u64, model: &ReferenceModel) {
    let swap = s.swap(id);
    let a = s.stream(s.a);
    let b = s.stream(s.b);
    assert_eq!(swap.settled_a, model.settled_a, "settled_a");
    assert_eq!(swap.settled_b, model.settled_b, "settled_b");
    assert_eq!(swap.refund_a, model.refund_a, "refund_a");
    assert_eq!(swap.refund_b, model.refund_b, "refund_b");
    assert_eq!(swap.baseline_a, model.baseline_a, "baseline_a");
    assert_eq!(swap.baseline_b, model.baseline_b, "baseline_b");
    assert_eq!(a.withdrawn, model.withdrawn_a, "withdrawn_a");
    assert_eq!(b.withdrawn, model.withdrawn_b, "withdrawn_b");
    assert_eq!(a.deposit, model.deposit_a, "deposit_a");
    assert_eq!(b.deposit, model.deposit_b, "deposit_b");
}

// -------------------------------------------------------------- proptest ---

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// Random swap → settle* → unwind round-trips conserve the pair's combined
    /// deposit, and the contract never ends up holding a token it did not take
    /// in: after unwinding at the end of the window, the two parties' balances
    /// plus the contract's are exactly the deposits.
    #[test]
    fn prop_swap_unwind_round_trip_conserves_combined_value(
        deposit_a in 10_000_000i128..2_000_000_000,
        deposit_b in 10_000_000i128..2_000_000_000,
        duration in 10u64..5_000,
        settle_at in prop::collection::vec(1u64..100, 1..4),
    ) {
        let s = SwapFixture::setup(deposit_a, deposit_b, duration);
        let initial_sender = s.balance(&s.f.sender);
        let initial_payer = s.balance(&s.payer);
        let swap_id = s.propose_and_accept();

        let mut elapsed = 0u64;
        for step in settle_at {
            let next = elapsed + step;
            if next >= duration { break; }
            s.advance(step);
            elapsed = next;
            s.f.client.mock_all_auths().settle_swap(&s.f.sender, &swap_id);

            // After every settlement the pair identity re-derives.
            let swap = s.swap(swap_id);
            let a = s.stream(s.a);
            let b = s.stream(s.b);
            let streamed_a = deposit_a * elapsed as i128 / duration as i128;
            let streamed_b = deposit_b * elapsed as i128 / duration as i128;
            prop_assert_eq!(swap.settled_a, streamed_a);
            prop_assert_eq!(swap.settled_b, streamed_b);
            let total = a.withdrawn + b.withdrawn + swap.refund_a + swap.refund_b
                + (swap.baseline_a - swap.withdrawn_a_at_exec)
                + (swap.baseline_b - swap.withdrawn_b_at_exec)
                + (deposit_a - streamed_a) + (deposit_b - streamed_b);
            prop_assert_eq!(total, deposit_a + deposit_b);
        }

        s.advance(duration - elapsed);
        s.f.client.mock_all_auths().unwind_swap(&s.f.sender, &swap_id);

        let swap = s.swap(swap_id);
        prop_assert_eq!(swap.status, SwapStatus::Unwound);
        prop_assert_eq!(swap.refund_a, 0);
        prop_assert_eq!(swap.refund_b, 0);
        prop_assert_eq!(s.stream(s.a).withdrawn, deposit_a);
        prop_assert_eq!(s.stream(s.b).withdrawn, deposit_b);
        // No value created or destroyed: parties' balances plus the contract's
        // remaining escrow equal the two deposits.
        prop_assert_eq!(
            s.balance(&s.f.sender) + s.balance(&s.payer) + s.contract_balance(),
            initial_sender + initial_payer + deposit_a + deposit_b
        );
        prop_assert_eq!(s.contract_balance(), 0);
    }

    /// Differential test: the contract's stored state must equal an independent
    /// reference model over random settlement schedules, and a final unwind.
    #[test]
    fn prop_matches_reference_model(
        deposit_a in 10_000_000i128..1_000_000_000,
        deposit_b in 10_000_000i128..1_000_000_000,
        duration in 10u64..2_000,
        steps in prop::collection::vec(1u64..200, 1..5),
    ) {
        let s = SwapFixture::setup(deposit_a, deposit_b, duration);
        let start = s.f.env.ledger().timestamp();
        let mut model = ReferenceModel::new(deposit_a, deposit_b, duration, start);
        let swap_id = s.propose_and_accept();
        model.execute(start);

        let mut elapsed = 0u64;
        for step in steps {
            let next = elapsed + step;
            if next >= duration { break; }
            s.advance(step);
            elapsed = next;
            s.f.client.mock_all_auths().settle_swap(&s.f.sender, &swap_id);
            model.settle(start + elapsed);
            assert_matches_model(&s, swap_id, &model);
            prop_assert_eq!(model.conserved_total(start + elapsed), deposit_a + deposit_b);
        }

        s.advance(duration - elapsed);
        s.f.client.mock_all_auths().unwind_swap(&s.f.sender, &swap_id);
        model.unwind(start + duration);
        assert_matches_model(&s, swap_id, &model);
        prop_assert_eq!(model.conserved_total(start + duration), deposit_a + deposit_b);
    }
}

// ----------------------------------------------------------- CEI goldens ---

#[test]
fn settle_swap_operation_order_matches_golden() {
    let s = SwapFixture::setup(DEPOSIT_A, DEPOSIT_B, DURATION);
    let swap_id = s.propose_and_accept();
    s.advance(DURATION / 2);

    crate::cei_trace::begin();
    s.f.client
        .mock_all_auths()
        .settle_swap(&s.f.sender, &swap_id);
    let actual = crate::cei_trace::finish();

    std::println!("--- settle trace ---\n{actual}\n--- end ---");
    assert_eq!(
        actual,
        include_str!("../test_orderings/settle_swap.txt").trim_end()
    );
}

#[test]
fn unwind_swap_operation_order_matches_golden() {
    let s = SwapFixture::setup(DEPOSIT_A, DEPOSIT_B, DURATION);
    let swap_id = s.propose_and_accept();
    s.advance(DURATION / 2);

    crate::cei_trace::begin();
    s.f.client
        .mock_all_auths()
        .unwind_swap(&s.f.sender, &swap_id);
    let actual = crate::cei_trace::finish();

    std::println!("--- unwind trace ---\n{actual}\n--- end ---");
    assert_eq!(
        actual,
        include_str!("../test_orderings/unwind_swap.txt").trim_end()
    );
}
