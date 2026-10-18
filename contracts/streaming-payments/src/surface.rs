//! Error-surface instrumentation.
//!
//! Every expected failure in the contract funnels through [`reject`]: a
//! rejection site names a [`Branch`] — one `(entrypoint, condition)` validation
//! decision — instead of returning a bare [`StreamError`]. The branch registry
//! is the single source of truth for the mapping
//! `(entrypoint, condition) -> error code`, so that:
//!
//! * the generated test matrix (`error_surface_test.rs`) can prove that every
//!   *reachable* branch fires its declared code, and
//! * `docs/ERRORS.md` is generated from the same table (see
//!   `examples/error_surface_doc.rs`) and diffed in CI.
//!
//! Because the table is data, a hand-maintained list of "which test covers
//! which code" never exists: the mapping is emitted from here.
//!
//! Instrumentation is test-only. In non-test builds [`reject`] compiles down to
//! the error it returns (the `#[cfg(test)]` trace is the only overhead, and it
//! disappears entirely in the Wasm build).

use crate::errors::StreamError;

/// Whether a rejection branch is expected to be reachable at runtime.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Reachability {
    Reachable,
    Defensive,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Branch {
    // --------------------------------------------------------- create_stream
    CreateDepositNonPositive,
    CreateStartTimeInPast,
    CreateInvalidTimeRange,
    CreateDurationTooLong,
    // -------------------------------------------------------------- withdraw
    WithdrawAmountNonPositive,
    WithdrawAmountExceedsAvailable,
    // ---------------------------------------------------------- withdraw_max
    WithdrawMaxNothingToWithdraw,
    // --------------------------------------------------------- cancel_stream
    CancelStreamNotCancellable,
    CancelStreamNotAuthorized,
    // --------------------------------------------------------------- top_up
    TopUpAmountNonPositive,
    TopUpDepositOverflow,
    // ------------------------------------------------- shared storage/math
    StreamNotFound,
    StreamNotActive,
    CapacityOverflow,
    RateProductOverflow,
    AvailableBalanceOverflow,
    CancelSplitOverflow,
    PayoutOverflow,
    // ----------------------------------------------------------- treasury
    SetFeeRateTooHigh,
    GovernorNotAllowed,
    AcceptGovernorNoPending,
    AcceptGovernorNotNominee,
    WithdrawTreasuryAmountNonPositive,
    WithdrawTreasuryExceedsBalance,
    // --------------------------------------------------- scheduled intents
    IntentNotFound,
    IntentNotPending,
    IntentNotYetExecutable,
    IntentExpired,
    IntentNotCancellable,
    ScheduleInvalidParameters,
    IntentParamsMismatch,
    IntentNotExpired,
    // --------------------------------------------------- token interactions
    CreateDepositTransferFailed,
    TopUpTransferFailed,
    RecipientPayoutFailed,
    SenderRefundFailed,
    TreasuryPayoutFailed,
    // ------------------------------------------------------------ policy
    PolicyAssetNotAllowed,
    PolicyTimelockNotElapsed,
    PolicyNoQueuedChange,
    PolicyNotInitialized,
    PolicyNoPendingHandoff,
    // ------------------------------------------------ upgrade & freeze
    ContractFrozen,
    MigrationNotFrozen,
    ExecuteUpgradeNoPending,
    CancelUpgradeNoPending,
    TimelockNotExpired,
    UpgradeDelayTooShort,
    AlreadyMigrated,
    // ------------------------------------------------ stream policy floors
    PolicyRateBelowFloor,
    PolicyRateAboveCeiling,
    PolicyDurationBelowFloor,
    PolicyDurationAboveCeiling,
    PolicyDepositBelowFloor,
    // ----------------------------------------------------------- schedule
    /// `withdraw` / `withdraw_max` / `available`: called before `cliff_time`.
    WithdrawBeforeCliff,
    /// `create_stream_vested`: the schedule is structurally invalid.
    CreateInvalidSchedule,
}

impl Branch {
    pub const ALL: [Branch; 56] = [
        Branch::CreateDepositNonPositive,
        Branch::CreateStartTimeInPast,
        Branch::CreateInvalidTimeRange,
        Branch::CreateDurationTooLong,
        Branch::WithdrawAmountNonPositive,
        Branch::WithdrawAmountExceedsAvailable,
        Branch::WithdrawMaxNothingToWithdraw,
        Branch::CancelStreamNotCancellable,
        Branch::CancelStreamNotAuthorized,
        Branch::TopUpAmountNonPositive,
        Branch::TopUpDepositOverflow,
        Branch::StreamNotFound,
        Branch::StreamNotActive,
        Branch::CapacityOverflow,
        Branch::RateProductOverflow,
        Branch::AvailableBalanceOverflow,
        Branch::CancelSplitOverflow,
        Branch::PayoutOverflow,
        Branch::SetFeeRateTooHigh,
        Branch::GovernorNotAllowed,
        Branch::AcceptGovernorNoPending,
        Branch::AcceptGovernorNotNominee,
        Branch::WithdrawTreasuryAmountNonPositive,
        Branch::WithdrawTreasuryExceedsBalance,
        Branch::IntentNotFound,
        Branch::IntentNotPending,
        Branch::IntentNotYetExecutable,
        Branch::IntentExpired,
        Branch::IntentNotCancellable,
        Branch::ScheduleInvalidParameters,
        Branch::IntentParamsMismatch,
        Branch::IntentNotExpired,
        Branch::CreateDepositTransferFailed,
        Branch::TopUpTransferFailed,
        Branch::RecipientPayoutFailed,
        Branch::SenderRefundFailed,
        Branch::TreasuryPayoutFailed,
        Branch::PolicyAssetNotAllowed,
        Branch::PolicyTimelockNotElapsed,
        Branch::PolicyNoQueuedChange,
        Branch::PolicyNotInitialized,
        Branch::PolicyNoPendingHandoff,
        Branch::ContractFrozen,
        Branch::MigrationNotFrozen,
        Branch::ExecuteUpgradeNoPending,
        Branch::CancelUpgradeNoPending,
        Branch::TimelockNotExpired,
        Branch::UpgradeDelayTooShort,
        Branch::AlreadyMigrated,
        Branch::PolicyRateBelowFloor,
        Branch::PolicyRateAboveCeiling,
        Branch::PolicyDurationBelowFloor,
        Branch::PolicyDurationAboveCeiling,
        Branch::PolicyDepositBelowFloor,
        Branch::WithdrawBeforeCliff,
        Branch::CreateInvalidSchedule,
    ];

    pub const fn entrypoints(self) -> &'static [&'static str] {
        match self {
            Branch::CreateDepositNonPositive
            | Branch::CreateStartTimeInPast
            | Branch::CreateInvalidTimeRange
            | Branch::CreateDurationTooLong => {
                &["create_stream", "create_stream_vested", "create_streams"]
            }
            Branch::WithdrawAmountNonPositive | Branch::WithdrawAmountExceedsAvailable => {
                &["withdraw"]
            }
            Branch::WithdrawMaxNothingToWithdraw => &["withdraw_max"],
            Branch::CancelStreamNotCancellable | Branch::CancelStreamNotAuthorized => {
                &["cancel_stream"]
            }
            Branch::TopUpAmountNonPositive | Branch::TopUpDepositOverflow => &["top_up"],
            Branch::StreamNotFound => &[
                "get_stream",
                "get_schedule",
                "available",
                "withdraw",
                "withdraw_max",
                "cancel_stream",
                "top_up",
            ],
            Branch::StreamNotActive => &["withdraw", "withdraw_max", "cancel_stream", "top_up"],
            Branch::CapacityOverflow => {
                &["create_stream", "create_stream_vested", "create_streams", "top_up"]
            }
            Branch::RateProductOverflow => &[
                "streamed_at",
                "available",
                "withdraw",
                "withdraw_max",
                "cancel_stream",
            ],
            Branch::AvailableBalanceOverflow => &["available", "withdraw", "withdraw_max"],
            Branch::CancelSplitOverflow => &["cancel_stream"],
            Branch::PayoutOverflow => &["withdraw", "withdraw_max"],
            Branch::SetFeeRateTooHigh => &["set_fee_bps"],
            Branch::GovernorNotAllowed => &[
                "set_fee_bps",
                "nominate_governor",
                "withdraw_treasury",
                "set_frozen",
                "propose_upgrade",
                "cancel_upgrade",
                "execute_upgrade",
                "migrate_storage",
                "set_stream_policy",
            ],
            Branch::AcceptGovernorNoPending | Branch::AcceptGovernorNotNominee => {
                &["accept_governor"]
            }
            Branch::WithdrawTreasuryAmountNonPositive | Branch::WithdrawTreasuryExceedsBalance => {
                &["withdraw_treasury"]
            }
            Branch::IntentNotFound => &[
                "get_intent",
                "execute_scheduled",
                "cancel_scheduled",
                "reclaim_expired",
            ],
            Branch::IntentNotPending => {
                &["execute_scheduled", "cancel_scheduled", "reclaim_expired"]
            }
            Branch::IntentNotYetExecutable
            | Branch::IntentExpired
            | Branch::IntentParamsMismatch => &["execute_scheduled"],
            Branch::IntentNotCancellable => &["cancel_scheduled"],
            Branch::ScheduleInvalidParameters => &["schedule_stream"],
            Branch::IntentNotExpired => &["reclaim_expired"],
            Branch::CreateDepositTransferFailed => {
                &["create_stream", "create_stream_vested", "create_streams"]
            }
            Branch::TopUpTransferFailed => &["top_up"],
            Branch::RecipientPayoutFailed => &["withdraw", "withdraw_max", "cancel_stream"],
            Branch::SenderRefundFailed => &["cancel_stream"],
            Branch::TreasuryPayoutFailed => &["withdraw_treasury"],
            Branch::PolicyAssetNotAllowed => &["create_stream", "create_streams"],
            Branch::PolicyTimelockNotElapsed | Branch::PolicyNoQueuedChange => {
                &["policy_execute_asset"]
            }
            Branch::PolicyNotInitialized => &[
                "policy_execute_asset",
                "policy_propose_asset",
                "policy_propose_handoff",
                "policy_accept_handoff",
                "policy_cancel_handoff",
                "policy_set_timelock_delay",
            ],
            Branch::PolicyNoPendingHandoff => &["policy_accept_handoff", "policy_cancel_handoff"],
            Branch::ContractFrozen => &[
                "create_stream",
                "create_streams",
                "withdraw",
                "withdraw_max",
                "cancel_stream",
                "top_up",
            ],
            Branch::MigrationNotFrozen | Branch::AlreadyMigrated => &["migrate_storage"],
            Branch::ExecuteUpgradeNoPending | Branch::TimelockNotExpired => &["execute_upgrade"],
            Branch::CancelUpgradeNoPending => &["cancel_upgrade"],
            Branch::UpgradeDelayTooShort => &["propose_upgrade"],
            Branch::PolicyDepositBelowFloor
            | Branch::PolicyRateBelowFloor
            | Branch::PolicyRateAboveCeiling => &["create_stream", "create_streams", "top_up"],
            Branch::PolicyDurationBelowFloor | Branch::PolicyDurationAboveCeiling => {
                &["create_stream", "create_streams"]
            }
            Branch::WithdrawBeforeCliff => &["available", "withdraw", "withdraw_max"],
            Branch::CreateInvalidSchedule => &["create_stream_vested"],
        }
    }

    pub const fn error(self) -> StreamError {
        match self {
            Branch::CreateDepositNonPositive => StreamError::ZeroAmount,
            Branch::CreateStartTimeInPast => StreamError::StartTimeInPast,
            Branch::CreateInvalidTimeRange => StreamError::InvalidTimeRange,
            Branch::CreateDurationTooLong => StreamError::DurationTooLong,
            Branch::WithdrawAmountNonPositive => StreamError::ZeroAmount,
            Branch::WithdrawAmountExceedsAvailable => StreamError::AmountExceedsAvailable,
            Branch::WithdrawMaxNothingToWithdraw => StreamError::NothingToWithdraw,
            Branch::CancelStreamNotCancellable => StreamError::StreamNotCancellable,
            Branch::CancelStreamNotAuthorized => StreamError::NotAuthorized,
            Branch::TopUpAmountNonPositive => StreamError::ZeroAmount,
            Branch::TopUpDepositOverflow => StreamError::MathOverflow,
            Branch::StreamNotFound => StreamError::StreamNotFound,
            Branch::StreamNotActive => StreamError::StreamNotActive,
            Branch::CapacityOverflow => StreamError::MathOverflow,
            Branch::RateProductOverflow => StreamError::MathOverflow,
            Branch::AvailableBalanceOverflow => StreamError::MathOverflow,
            Branch::CancelSplitOverflow => StreamError::MathOverflow,
            Branch::PayoutOverflow => StreamError::MathOverflow,
            Branch::SetFeeRateTooHigh => StreamError::FeeRateTooHigh,
            Branch::GovernorNotAllowed | Branch::AcceptGovernorNotNominee => {
                StreamError::NotGovernor
            }
            Branch::AcceptGovernorNoPending => StreamError::NoPendingGovernor,
            Branch::WithdrawTreasuryAmountNonPositive => StreamError::ZeroAmount,
            Branch::WithdrawTreasuryExceedsBalance => StreamError::InsufficientTreasuryBalance,
            Branch::IntentNotFound => StreamError::IntentNotFound,
            Branch::IntentNotPending => StreamError::IntentNotPending,
            Branch::IntentNotYetExecutable => StreamError::IntentNotYetExecutable,
            Branch::IntentExpired => StreamError::IntentExpired,
            Branch::IntentNotCancellable => StreamError::IntentNotCancellable,
            Branch::ScheduleInvalidParameters => StreamError::InvalidScheduleParameters,
            Branch::IntentParamsMismatch => StreamError::IntentParamsMismatch,
            Branch::IntentNotExpired => StreamError::IntentNotExpired,
            Branch::CreateDepositTransferFailed => StreamError::DepositTransferFailed,
            Branch::TopUpTransferFailed => StreamError::TopUpTransferFailed,
            Branch::RecipientPayoutFailed => StreamError::RecipientPayoutFailed,
            Branch::SenderRefundFailed => StreamError::SenderRefundFailed,
            Branch::TreasuryPayoutFailed => StreamError::TreasuryPayoutFailed,
            Branch::PolicyAssetNotAllowed => StreamError::PolicyAssetNotAllowed,
            Branch::PolicyTimelockNotElapsed => StreamError::PolicyTimelockNotElapsed,
            Branch::PolicyNoQueuedChange => StreamError::PolicyNoQueuedChange,
            Branch::PolicyNotInitialized => StreamError::PolicyNotInitialized,
            Branch::PolicyNoPendingHandoff => StreamError::PolicyNoPendingHandoff,
            Branch::ContractFrozen => StreamError::ContractFrozen,
            Branch::MigrationNotFrozen => StreamError::ContractNotFrozen,
            Branch::ExecuteUpgradeNoPending | Branch::CancelUpgradeNoPending => {
                StreamError::NoPendingUpgrade
            }
            Branch::TimelockNotExpired => StreamError::TimelockNotExpired,
            Branch::UpgradeDelayTooShort => StreamError::UpgradeDelayTooShort,
            Branch::AlreadyMigrated => StreamError::AlreadyMigrated,
            Branch::PolicyRateBelowFloor => StreamError::PolicyRateBelowFloor,
            Branch::PolicyRateAboveCeiling => StreamError::PolicyRateAboveCeiling,
            Branch::PolicyDurationBelowFloor => StreamError::PolicyDurationBelowFloor,
            Branch::PolicyDurationAboveCeiling => StreamError::PolicyDurationAboveCeiling,
            Branch::PolicyDepositBelowFloor => StreamError::PolicyDepositBelowFloor,
            Branch::WithdrawBeforeCliff => StreamError::CliffNotReached,
            Branch::CreateInvalidSchedule => StreamError::InvalidSchedule,
        }
    }

    pub const fn condition(self) -> &'static str {
        match self {
            Branch::CreateDepositNonPositive => "deposit_amount is zero or negative",
            Branch::CreateStartTimeInPast => "start_time is before the current ledger timestamp",
            Branch::CreateInvalidTimeRange => {
                "end_time is not strictly after start_time (zero or negative duration)"
            }
            Branch::CreateDurationTooLong => "duration exceeds MAX_DURATION_SECONDS (100 years)",
            Branch::WithdrawAmountNonPositive => "withdraw amount is zero or negative",
            Branch::WithdrawAmountExceedsAvailable => {
                "amount exceeds the accrued-but-unwithdrawn balance"
            }
            Branch::WithdrawMaxNothingToWithdraw => {
                "nothing has accrued yet, or everything accrued was already withdrawn"
            }
            Branch::CancelStreamNotCancellable => {
                "the recipient calls cancel_stream on a stream created non-cancelable"
            }
            Branch::CancelStreamNotAuthorized => {
                "the caller is neither the sender nor the recipient"
            }
            Branch::TopUpAmountNonPositive => "top-up amount is zero or negative",
            Branch::TopUpDepositOverflow => "deposit + amount would overflow i128",
            Branch::StreamNotFound => "no stream is stored under the id",
            Branch::StreamNotActive => "the stream status is Cancelled or Depleted",
            Branch::CapacityOverflow => "deposit * duration would overflow u128",
            Branch::RateProductOverflow => "deposit * elapsed would overflow u128",
            Branch::AvailableBalanceOverflow => {
                "withdrawn exceeds streamed (an invariant-violating stored stream)"
            }
            Branch::CancelSplitOverflow => "the cancel pro-rata split would underflow",
            Branch::PayoutOverflow => "withdrawn + amount would overflow i128",
            Branch::SetFeeRateTooHigh => "new_fee_bps exceeds MAX_FEE_BPS (the protocol cap)",
            Branch::GovernorNotAllowed => "the caller is not the treasury governor",
            Branch::AcceptGovernorNoPending => "accept_governor with no nomination pending",
            Branch::AcceptGovernorNotNominee => "the caller is not the nominated governor",
            Branch::WithdrawTreasuryAmountNonPositive => {
                "treasury withdrawal amount is zero or negative"
            }
            Branch::WithdrawTreasuryExceedsBalance => {
                "amount exceeds fees collected minus fees already withdrawn"
            }
            Branch::IntentNotFound => "no scheduled intent is stored under the id",
            Branch::IntentNotPending => "the intent is already executed, cancelled, or expired",
            Branch::IntentNotYetExecutable => "the next occurrence has not reached execute_after",
            Branch::IntentExpired => "the intent has reached expires_at",
            Branch::IntentNotCancellable => "the execution window opened before cancellation",
            Branch::ScheduleInvalidParameters => {
                "schedule parameters are inconsistent or out of bounds"
            }
            Branch::IntentParamsMismatch => {
                "stored parameters do not match the authorization commitment"
            }
            Branch::IntentNotExpired => "the intent has not reached expires_at",
            Branch::CreateDepositTransferFailed => {
                "the token refuses the deposit (+fee) pull (allowance, balance, or a non-compliant token)"
            }
            Branch::TopUpTransferFailed => "the token refuses the pull of the added funds",
            Branch::RecipientPayoutFailed => "the token refuses a payout to the recipient",
            Branch::SenderRefundFailed => "the token refuses the refund to the sender",
            Branch::TreasuryPayoutFailed => {
                "the token refuses the payout of collected protocol fees"
            }
            Branch::PolicyAssetNotAllowed => {
                "the asset is not permitted by the policy module allowlist"
            }
            Branch::PolicyTimelockNotElapsed => {
                "the timelock delay has not elapsed for this queued policy change"
            }
            Branch::PolicyNoQueuedChange => "no policy change is queued for the specified asset",
            Branch::PolicyNotInitialized => "the policy module has not been initialized",
            Branch::PolicyNoPendingHandoff => "no admin handoff proposal is pending",
            Branch::ContractFrozen => "the contract is frozen for maintenance or upgrade",
            Branch::MigrationNotFrozen => "storage migration requires the contract to be frozen",
            Branch::ExecuteUpgradeNoPending => "execute_upgrade called with no upgrade pending",
            Branch::CancelUpgradeNoPending => "cancel_upgrade called with no upgrade pending",
            Branch::TimelockNotExpired => "upgrade timelock delay has not yet expired",
            Branch::UpgradeDelayTooShort => {
                "proposed upgrade delay is shorter than MIN_UPGRADE_DELAY_SECONDS"
            }
            Branch::AlreadyMigrated => {
                "storage has already been migrated to the target schema version"
            }
            Branch::PolicyRateBelowFloor => "stream rate is below the governance policy floor",
            Branch::PolicyRateAboveCeiling => "stream rate exceeds the governance policy ceiling",
            Branch::PolicyDurationBelowFloor => {
                "stream duration is below the governance policy floor"
            }
            Branch::PolicyDurationAboveCeiling => {
                "stream duration exceeds the governance policy ceiling"
            }
            Branch::PolicyDepositBelowFloor => {
                "stream deposit is below the governance policy floor"
            }
            Branch::WithdrawBeforeCliff => {
                "current time is before the stream's cliff_time; nothing is claimable yet"
            }
            Branch::CreateInvalidSchedule => {
                "schedule steps are empty, unsorted, out of bounds, or rates do not sum to 10_000 bps"
            }
        }
    }

    pub const fn reachability(self) -> Reachability {
        match self {
            Branch::PayoutOverflow
            | Branch::AvailableBalanceOverflow
            | Branch::CancelSplitOverflow => Reachability::Defensive,
            Branch::CreateDepositNonPositive
            | Branch::CreateStartTimeInPast
            | Branch::CreateInvalidTimeRange
            | Branch::CreateDurationTooLong
            | Branch::WithdrawAmountNonPositive
            | Branch::WithdrawAmountExceedsAvailable
            | Branch::WithdrawMaxNothingToWithdraw
            | Branch::CancelStreamNotCancellable
            | Branch::CancelStreamNotAuthorized
            | Branch::TopUpAmountNonPositive
            | Branch::TopUpDepositOverflow
            | Branch::StreamNotFound
            | Branch::StreamNotActive
            | Branch::CapacityOverflow
            | Branch::RateProductOverflow
            | Branch::SetFeeRateTooHigh
            | Branch::GovernorNotAllowed
            | Branch::AcceptGovernorNoPending
            | Branch::AcceptGovernorNotNominee
            | Branch::WithdrawTreasuryAmountNonPositive
            | Branch::WithdrawTreasuryExceedsBalance
            | Branch::IntentNotFound
            | Branch::IntentNotPending
            | Branch::IntentNotYetExecutable
            | Branch::IntentExpired
            | Branch::IntentNotCancellable
            | Branch::ScheduleInvalidParameters
            | Branch::IntentParamsMismatch
            | Branch::IntentNotExpired
            | Branch::CreateDepositTransferFailed
            | Branch::TopUpTransferFailed
            | Branch::RecipientPayoutFailed
            | Branch::SenderRefundFailed
            | Branch::TreasuryPayoutFailed
            | Branch::PolicyAssetNotAllowed
            | Branch::PolicyTimelockNotElapsed
            | Branch::PolicyNoQueuedChange
            | Branch::PolicyNotInitialized
            | Branch::PolicyNoPendingHandoff
            | Branch::ContractFrozen
            | Branch::MigrationNotFrozen
            | Branch::ExecuteUpgradeNoPending
            | Branch::CancelUpgradeNoPending
            | Branch::TimelockNotExpired
            | Branch::UpgradeDelayTooShort
            | Branch::AlreadyMigrated
            | Branch::PolicyRateBelowFloor
            | Branch::PolicyRateAboveCeiling
            | Branch::PolicyDurationBelowFloor
            | Branch::PolicyDurationAboveCeiling
            | Branch::PolicyDepositBelowFloor
            | Branch::WithdrawBeforeCliff
            | Branch::CreateInvalidSchedule => Reachability::Reachable,
        }
    }
}

pub const RETIRED_CODES: &[StreamError] = &[
    StreamError::NotStreamSender,
    StreamError::NotStreamRecipient,
];

#[inline]
pub fn reject(branch: Branch) -> StreamError {
    #[cfg(test)]
    trace::record(branch);
    branch.error()
}

#[cfg(test)]
pub mod trace {
    use super::Branch;
    use std::cell::RefCell;
    use std::thread_local;
    use std::vec::Vec;

    thread_local! {
        static HITS: RefCell<Vec<Branch>> = const { RefCell::new(Vec::new()) };
    }

    pub fn record(branch: Branch) {
        HITS.with(|hits| hits.borrow_mut().push(branch));
    }

    pub fn drain() -> Vec<Branch> {
        HITS.with(|hits| core::mem::take(&mut *hits.borrow_mut()))
    }

    pub fn clear() {
        HITS.with(|hits| hits.borrow_mut().clear());
    }
}
