//! Protocol errors for the StreamPay reference model.
//!
//! Numeric codes match [`streampay_contract::StreamError`]. Every expected failure
//! is mapped to a distinct numeric code for wire and spec compatibility.

#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord, Hash)]
#[repr(u32)]
pub enum ModelError {
    /// No stream exists with the provided id.
    StreamNotFound = 1,
    /// Retired reserved check.
    NotStreamSender = 2,
    /// Retired reserved check.
    NotStreamRecipient = 3,
    /// The stream is not cancelable, so the recipient cannot cancel it.
    StreamNotCancellable = 4,
    /// The stream is cancelled or depleted; operation not permitted.
    StreamNotActive = 5,
    /// start_time is before current ledger timestamp.
    StartTimeInPast = 6,
    /// end_time is not strictly after start_time.
    InvalidTimeRange = 7,
    /// Stream duration exceeds maximum supported duration.
    DurationTooLong = 8,
    /// Deposit, top-up, or withdrawal amount is zero or negative.
    ZeroAmount = 9,
    /// Withdrawal exceeds accrued, unwithdrawn balance.
    AmountExceedsAvailable = 10,
    /// Intermediate computation would overflow.
    MathOverflow = 11,
    /// Caller is not authorized for this action.
    NotAuthorized = 12,
    /// withdraw_max found nothing to withdraw.
    NothingToWithdraw = 13,
    /// Requested fee rate exceeds protocol cap.
    FeeRateTooHigh = 14,
    /// Caller is not the treasury governor.
    NotGovernor = 15,
    /// accept_governor called without a pending governor nomination.
    NoPendingGovernor = 16,
    /// Treasury withdrawal exceeds collectible balance.
    InsufficientTreasuryBalance = 17,
    /// Token pull in create_stream failed.
    DepositTransferFailed = 18,
    /// Token pull in top_up failed.
    TopUpTransferFailed = 19,
    /// Payout of accrued funds to recipient failed.
    RecipientPayoutFailed = 20,
    /// Refund of unaccrued funds to sender failed.
    SenderRefundFailed = 21,
    /// Payout of collected fees in withdraw_treasury failed.
    TreasuryPayoutFailed = 22,
}

impl ModelError {
    pub const fn code(self) -> u32 {
        self as u32
    }
}
