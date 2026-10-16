//! Error-surface matrix tests.
#![cfg(test)]

use std::vec::Vec;

use soroban_sdk::testutils::Address as _;

use crate::stream::streamed_at;
use crate::surface::{trace, Branch, Reachability, RETIRED_CODES};
use crate::test::{Fixture, RefusingFixture};
use crate::{StreamError, MAX_DURATION_SECONDS, MAX_FEE_BPS};

const DAY: u64 = 24 * 60 * 60;
const DEPOSIT: i128 = 10_000_000_000;

fn make_single_step_schedule(
    env: &soroban_sdk::Env,
    start: u64,
    end: u64,
    cliff: u64,
) -> crate::Schedule {
    let _ = end;
    let mut steps = soroban_sdk::Vec::new(env);
    steps.push_back(crate::VestingStep { time: start, rate_bps: 10_000 });
    crate::Schedule { cliff_time: cliff, steps }
}

macro_rules! rejected {
    ($call:expr) => {
        $call.expect_err("expected the contract to reject the call").unwrap()
    };
}

fn probe(branch: Branch) -> Option<StreamError> {
    match branch {
        Branch::CreateDepositNonPositive => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender, &f.recipient, &f.token, &0, &(now + DAY), &(now + 2 * DAY), &false,
            )))
        }
        Branch::CreateStartTimeInPast => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            f.advance_time(DAY);
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender, &f.recipient, &f.token, &DEPOSIT, &now, &(now + 2 * DAY), &false,
            )))
        }
        Branch::CreateInvalidTimeRange => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender, &f.recipient, &f.token, &DEPOSIT, &(now + DAY), &(now + DAY), &false,
            )))
        }
        Branch::CreateDurationTooLong => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender, &f.recipient, &f.token, &DEPOSIT,
                &now, &(now + MAX_DURATION_SECONDS + 1), &false,
            )))
        }
        Branch::CapacityOverflow => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender, &f.recipient, &f.token, &i128::MAX,
                &now, &(now + 2 * 365 * DAY), &false,
            )))
        }
        Branch::WithdrawAmountNonPositive => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            f.advance_time(2 * DAY);
            Some(rejected!(f.client.mock_all_auths().try_withdraw(&id, &0)))
        }
        Branch::WithdrawAmountExceedsAvailable => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            f.advance_time(2 * DAY);
            Some(rejected!(f.client.mock_all_auths().try_withdraw(&id, &(DEPOSIT / 10 + 1))))
        }
        Branch::WithdrawMaxNothingToWithdraw => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            Some(rejected!(f.client.mock_all_auths().try_withdraw_max(&id)))
        }
        Branch::CancelStreamNotCancellable => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            Some(rejected!(f.client.mock_all_auths().try_cancel_stream(&f.recipient, &id)))
        }
        Branch::CancelStreamNotAuthorized => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);
            let stranger = soroban_sdk::Address::generate(&f.env);
            Some(rejected!(f.client.mock_all_auths().try_cancel_stream(&stranger, &id)))
        }
        Branch::TopUpAmountNonPositive => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            Some(rejected!(f.client.mock_all_auths().try_top_up(&id, &0)))
        }
        Branch::TopUpDepositOverflow => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            Some(rejected!(f.client.mock_all_auths().try_top_up(&id, &i128::MAX)))
        }
        Branch::StreamNotFound => {
            let f = Fixture::setup_quiet();
            Some(rejected!(f.client.mock_all_auths().try_get_stream(&999)))
        }
        Branch::StreamNotActive => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            f.client.mock_all_auths().cancel_stream(&f.sender, &id);
            Some(rejected!(f.client.mock_all_auths().try_withdraw(&id, &1)))
        }
        Branch::RateProductOverflow => Some(streamed_at(i128::MAX, 3, 3).unwrap_err()),
        Branch::SetFeeRateTooHigh => {
            let f = Fixture::setup_quiet();
            Some(rejected!(f.client.mock_all_auths().try_set_fee_bps(&f.governor, &(MAX_FEE_BPS + 1))))
        }
        Branch::GovernorNotAllowed => {
            let f = Fixture::setup_quiet();
            let stranger = soroban_sdk::Address::generate(&f.env);
            Some(rejected!(f.client.mock_all_auths().try_set_fee_bps(&stranger, &0)))
        }
        Branch::AcceptGovernorNoPending => {
            let f = Fixture::setup_quiet();
            Some(rejected!(f.client.mock_all_auths().try_accept_governor(&f.sender)))
        }
        Branch::AcceptGovernorNotNominee => {
            let f = Fixture::setup_quiet();
            f.client.mock_all_auths().nominate_governor(&f.governor, &f.recipient);
            Some(rejected!(f.client.mock_all_auths().try_accept_governor(&f.sender)))
        }
        Branch::WithdrawTreasuryAmountNonPositive => {
            let f = Fixture::setup_quiet();
            Some(rejected!(f.client.mock_all_auths().try_withdraw_treasury(
                &f.governor, &f.token, &f.recipient, &0,
            )))
        }
        Branch::WithdrawTreasuryExceedsBalance => {
            let f = Fixture::setup_quiet();
            Some(rejected!(f.client.mock_all_auths().try_withdraw_treasury(
                &f.governor, &f.token, &f.recipient, &1,
            )))
        }
        Branch::CreateDepositTransferFailed => {
            let f = RefusingFixture::setup_quiet();
            f.refuse(false, true);
            let now = f.env.ledger().timestamp();
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender, &f.recipient, &f.token, &DEPOSIT,
                &now, &(now + 2 * DAY), &false,
            )))
        }
        Branch::TopUpTransferFailed => {
            let f = RefusingFixture::setup_quiet();
            let id = f.create(DEPOSIT, 0, 10 * DAY);
            f.refuse(false, true);
            Some(rejected!(f.client.mock_all_auths().try_top_up(&id, &DEPOSIT)))
        }
        Branch::RecipientPayoutFailed => {
            let f = RefusingFixture::setup_quiet();
            let id = f.create(DEPOSIT, 0, 10 * DAY);
            f.advance_time(DAY);
            f.refuse(true, false);
            Some(rejected!(f.client.mock_all_auths().try_withdraw(&id, &(DEPOSIT / 10))))
        }
        Branch::SenderRefundFailed => {
            let f = RefusingFixture::setup_quiet();
            let id = f.create(DEPOSIT, DAY, 10 * DAY);
            f.refuse(true, false);
            Some(rejected!(f.client.mock_all_auths().try_cancel_stream(&f.sender, &id)))
        }
        Branch::TreasuryPayoutFailed => {
            let f = RefusingFixture::setup_quiet();
            f.client.mock_all_auths().set_fee_bps(&f.governor, &100);
            let _id = f.create(DEPOSIT, 0, 10 * DAY);
            f.refuse(true, false);
            Some(rejected!(f.client.mock_all_auths().try_withdraw_treasury(
                &f.governor, &f.token, &f.recipient, &1,
            )))
        }
        Branch::WithdrawBeforeCliff => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            let start = now;
            let end = now + 10 * DAY;
            let cliff = now + 5 * DAY;
            let schedule = make_single_step_schedule(&f.env, start, end, cliff);
            let id = f.client.mock_all_auths()
                .create_stream_vested(&f.sender, &f.recipient, &f.token, &DEPOSIT,
                    &start, &end, &false, &schedule)
                .unwrap();
            f.advance_time(DAY);
            Some(rejected!(f.client.mock_all_auths().try_available(&id)))
        }
        Branch::CreateInvalidSchedule => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            let mut steps = soroban_sdk::Vec::new(&f.env);
            steps.push_back(crate::VestingStep { time: now + DAY, rate_bps: 5_000 });
            let schedule = crate::Schedule { cliff_time: now + DAY, steps };
            Some(rejected!(f.client.mock_all_auths().try_create_stream_vested(
                &f.sender, &f.recipient, &f.token, &DEPOSIT,
                &(now + DAY), &(now + 10 * DAY), &false, &schedule,
            )))
        }
        Branch::AvailableBalanceOverflow | Branch::CancelSplitOverflow | Branch::PayoutOverflow => None,
    }
}

#[test]
fn error_surface_matrix_proves_every_branch_is_reachable() {
    for &branch in Branch::ALL.iter() {
        trace::clear();
        let got = probe(branch);
        let hits = trace::drain();
        match branch.reachability() {
            Reachability::Reachable => {
                let error = got.unwrap_or_else(|| {
                    panic!("branch {branch:?} produced no rejection but is marked Reachable")
                });
                assert_eq!(error, branch.error(), "branch {branch:?} returned the wrong code");
                assert!(hits.contains(&branch),
                    "branch {branch:?} was classified reachable but never fired (trace: {hits:?})");
            }
            Reachability::Defensive => {
                assert!(got.is_none() && hits.is_empty(),
                    "defensive branch {branch:?} unexpectedly fired");
            }
        }
    }
}

#[test]
fn every_error_code_is_produced_or_retired() {
    for &code in StreamError::ALL.iter() {
        let produced = Branch::ALL.iter().any(|b| b.error() == code && b.reachability() == Reachability::Reachable);
        let retired = RETIRED_CODES.contains(&code);
        assert!(produced || retired,
            "dead error code {code:?} (#{}): no reachable branch produces it and it is not retired",
            code.code());
        assert!(!(produced && retired),
            "code {code:?} is both reachable and retired — remove it from RETIRED_CODES");
    }
}

#[test]
fn retired_codes_are_not_produced() {
    for &code in RETIRED_CODES.iter() {
        assert!(!Branch::ALL.iter().any(|b| b.error() == code),
            "retired code {code:?} is still produced by a branch");
    }
}

#[test]
fn branch_registry_has_no_duplicates() {
    for (i, &a) in Branch::ALL.iter().enumerate() {
        for &b in &Branch::ALL[i + 1..] {
            assert_ne!(a, b, "branch {a:?} appears more than once in Branch::ALL");
        }
    }
}

#[test]
fn defensive_branches_are_exactly_documented() {
    let defensive: Vec<Branch> = Branch::ALL.iter().copied()
        .filter(|b| b.reachability() == Reachability::Defensive)
        .collect();
    assert_eq!(
        defensive,
        std::vec![Branch::AvailableBalanceOverflow, Branch::CancelSplitOverflow, Branch::PayoutOverflow],
        "the defensive set changed; update the matrix test and docs/ERRORS.md"
    );
}

#[test]
fn stream_error_variant_list_is_exhaustive() {
    fn listed(e: StreamError) -> bool {
        match e {
            StreamError::StreamNotFound
            | StreamError::NotStreamSender
            | StreamError::NotStreamRecipient
            | StreamError::StreamNotCancellable
            | StreamError::StreamNotActive
            | StreamError::StartTimeInPast
            | StreamError::InvalidTimeRange
            | StreamError::DurationTooLong
            | StreamError::ZeroAmount
            | StreamError::AmountExceedsAvailable
            | StreamError::MathOverflow
            | StreamError::NotAuthorized
            | StreamError::NothingToWithdraw
            | StreamError::FeeRateTooHigh
            | StreamError::NotGovernor
            | StreamError::NoPendingGovernor
            | StreamError::InsufficientTreasuryBalance
            | StreamError::DepositTransferFailed
            | StreamError::TopUpTransferFailed
            | StreamError::RecipientPayoutFailed
            | StreamError::SenderRefundFailed
            | StreamError::TreasuryPayoutFailed
            | StreamError::CliffNotReached
            | StreamError::InvalidSchedule => StreamError::ALL.contains(&e),
        }
    }
    for &e in StreamError::ALL.iter() {
        assert!(listed(e), "variant {e:?} missing from StreamError::ALL");
    }
}
