//! Test-only client for the streaming payments contract.
#![cfg(test)]

use soroban_sdk::{contractclient, Address, Env, Vec};

use crate::{FeeScan, Schedule, Stream, StreamError, StreamInput, TreasuryStatus};

/// Interface of the StreamPay streaming-payments contract.
#[contractclient(name = "StreamingPaymentsClient")]
#[allow(dead_code)]
pub trait StreamingPaymentsApi {
    #[allow(clippy::too_many_arguments)]
    fn create_stream(
        env: Env,
        sender: Address,
        recipient: Address,
        token: Address,
        deposit_amount: i128,
        start_time: u64,
        end_time: u64,
        cancelable: bool,
    ) -> Result<u64, StreamError>;
    fn create_streams(
        env: Env,
        sender: Address,
        inputs: Vec<StreamInput>,
    ) -> Result<Vec<u64>, StreamError>;
    #[allow(clippy::too_many_arguments)]
    fn create_stream_vested(
        env: Env,
        sender: Address,
        recipient: Address,
        token: Address,
        deposit_amount: i128,
        start_time: u64,
        end_time: u64,
        cancelable: bool,
        schedule: Schedule,
    ) -> Result<u64, StreamError>;
    fn get_schedule(env: Env, stream_id: u64) -> Result<Option<Schedule>, StreamError>;
    fn withdraw(env: Env, stream_id: u64, amount: i128) -> Result<(), StreamError>;
    fn withdraw_max(env: Env, stream_id: u64) -> Result<i128, StreamError>;
    fn cancel_stream(env: Env, caller: Address, stream_id: u64) -> Result<(), StreamError>;
    fn top_up(env: Env, stream_id: u64, amount: i128) -> Result<(), StreamError>;
    fn get_stream(env: Env, stream_id: u64) -> Result<Stream, StreamError>;
    fn available(env: Env, stream_id: u64) -> Result<i128, StreamError>;
    fn recipient_streams(env: Env, recipient: Address, offset: u32, limit: u32) -> Vec<u64>;
    fn sender_streams(env: Env, sender: Address, offset: u32, limit: u32) -> Vec<u64>;
    fn set_fee_bps(env: Env, caller: Address, new_fee_bps: u32) -> Result<(), StreamError>;
    fn nominate_governor(
        env: Env,
        caller: Address,
        new_governor: Address,
    ) -> Result<(), StreamError>;
    fn accept_governor(env: Env, caller: Address) -> Result<(), StreamError>;
    fn withdraw_treasury(
        env: Env,
        caller: Address,
        token: Address,
        recipient: Address,
        amount: i128,
    ) -> Result<(), StreamError>;
    fn treasury_status(env: Env, token: Address) -> TreasuryStatus;
    fn stream_fee(env: Env, stream_id: u64) -> Result<i128, StreamError>;
    fn verify_treasury(env: Env, token: Address, start_id: u64, count: u32) -> FeeScan;
    fn total_streams(env: Env) -> u64;
}
