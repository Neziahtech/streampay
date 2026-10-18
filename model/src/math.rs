//! Pure checked accrual and fee arithmetic for StreamPay.
//!
//! All operations are checked and mirror the exact behavior of [`streampay_contract`].

use crate::errors::ModelError;
use crate::types::{ModelStream, ModelStreamStatus, BPS_DENOMINATOR};

/// Seconds elapsed within the half-open window `[start_time, end_time)`.
pub fn elapsed_seconds(now: u64, start_time: u64, end_time: u64) -> u64 {
    if now <= start_time {
        0
    } else if now >= end_time {
        end_time - start_time
    } else {
        now - start_time
    }
}

/// Validates that worst-case rate product `deposit * duration` fits in `u128`.
pub fn validate_capacity(deposit: i128, duration: u64) -> Result<(), ModelError> {
    let cap = u128::MAX / (duration.max(1) as u128);
    if (deposit as u128) > cap {
        return Err(ModelError::MathOverflow);
    }
    Ok(())
}

/// Pure linear accrual: `deposit * elapsed / duration`, floored, capped at `deposit`.
pub fn streamed_at(deposit: i128, duration: u64, elapsed: u64) -> Result<i128, ModelError> {
    if elapsed == 0 || deposit <= 0 || duration == 0 {
        return Ok(0);
    }
    let product = (deposit as u128)
        .checked_mul(elapsed as u128)
        .ok_or(ModelError::MathOverflow)?;
    let streamed = (product / (duration.max(1) as u128)).min(deposit as u128);
    Ok(streamed as i128)
}

/// Accrued-but-unwithdrawn amount at `now`. Zero for cancelled streams.
pub fn available_amount(now: u64, stream: &ModelStream) -> Result<i128, ModelError> {
    if stream.status == ModelStreamStatus::Cancelled {
        return Ok(0);
    }
    let elapsed = elapsed_seconds(now, stream.start_time, stream.end_time);
    let streamed = streamed_at(stream.deposit, stream.duration(), elapsed)?;
    streamed
        .checked_sub(stream.withdrawn)
        .ok_or(ModelError::MathOverflow)
}

/// Cancel split: `(recipient_amount, sender_refund)`.
pub fn cancel_amounts(now: u64, stream: &ModelStream) -> Result<(i128, i128), ModelError> {
    let elapsed = elapsed_seconds(now, stream.start_time, stream.end_time);
    let streamed = streamed_at(stream.deposit, stream.duration(), elapsed)?;
    let recipient_amount = streamed
        .checked_sub(stream.withdrawn)
        .ok_or(ModelError::MathOverflow)?;
    let sender_amount = stream
        .deposit
        .checked_sub(streamed)
        .ok_or(ModelError::MathOverflow)?;
    Ok((recipient_amount, sender_amount))
}

/// Protocol fee: `deposit * fee_bps / 10_000`, floored.
pub fn fee_amount(deposit: i128, fee_bps: u32) -> Result<i128, ModelError> {
    if fee_bps == 0 || deposit <= 0 {
        return Ok(0);
    }
    let product = (deposit as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(ModelError::MathOverflow)?;
    Ok((product / (BPS_DENOMINATOR as u128)) as i128)
}
