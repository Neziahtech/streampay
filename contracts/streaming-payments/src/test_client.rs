//! Test-only client for the streaming payments contract.
//!
//! `#[contractimpl]` generates an exported client only when the impl lives
//! outside the defining crate, so for in-crate unit tests we declare the
//! contract's interface as a trait and generate a client from it with
//! `#[contractclient]`. The client still targets the real contract address
//! (`Client::new(&env, &streaming_contract_address)`), so it drives the actual
//! implementation without building Wasm.
#![cfg(any(test, feature = "testutils"))]

use soroban_sdk::{contractclient, Address, BytesN, Env, Vec};

use crate::{
    FeeScan, MigrationStatus, PendingUpgrade, Schedule, ScheduledIntent, Stream, StreamError,
    StreamInput, StreamPolicy, TreasuryStatus,
};

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

    // --- scheduled intents ---
    #[allow(clippy::too_many_arguments)]
    fn schedule_stream(
        env: Env,
        sender: Address,
        recipient: Address,
        token: Address,
        deposit_amount: i128,
        start_time: u64,
        end_time: u64,
        cancelable: bool,
        interval: u64,
        occurrences: u32,
        fee_budget: i128,
        execute_after: u64,
        expires_at: u64,
    ) -> Result<u64, StreamError>;
    fn execute_scheduled(env: Env, intent_id: u64, keeper: Address) -> Result<u64, StreamError>;
    fn cancel_scheduled(env: Env, sender: Address, intent_id: u64) -> Result<(), StreamError>;
    fn reclaim_expired(env: Env, intent_id: u64) -> Result<(), StreamError>;
    fn get_intent(env: Env, intent_id: u64) -> Result<ScheduledIntent, StreamError>;
    fn sender_intents(env: Env, sender: Address, offset: u32, limit: u32) -> Vec<u64>;

    // --- treasury ---
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
    fn policy_init(env: Env, admin: Address);
    fn policy_propose_asset(env: Env, asset: Address, allowed: bool) -> Result<(), StreamError>;
    fn policy_execute_asset(env: Env, asset: Address) -> Result<(), StreamError>;
    fn policy_propose_handoff(env: Env, new_admin: Address) -> Result<(), StreamError>;
    fn policy_accept_handoff(env: Env) -> Result<(), StreamError>;
    fn policy_cancel_handoff(env: Env) -> Result<(), StreamError>;
    fn policy_admin(env: Env) -> Option<Address>;
    fn policy_pending_admin(env: Env) -> Option<Address>;
    fn policy_timelock_delay(env: Env) -> u64;
    fn policy_set_timelock_delay(env: Env, delay: u64) -> Result<(), StreamError>;
    fn policy_is_asset_allowed(env: Env, asset: Address) -> bool;
    fn policy_get_queued_asset(env: Env, asset: Address) -> Option<crate::QueuedAssetChange>;
    fn set_stream_policy(
        env: Env,
        caller: Address,
        token: Option<Address>,
        policy: StreamPolicy,
    ) -> Result<(), StreamError>;
    fn get_stream_policy(env: Env, token: Option<Address>) -> Option<StreamPolicy>;
    fn schema_version(env: Env) -> u32;
    fn is_frozen(env: Env) -> bool;
    fn set_frozen(env: Env, caller: Address, frozen: bool) -> Result<(), StreamError>;
    fn propose_upgrade(
        env: Env,
        caller: Address,
        new_wasm_hash: BytesN<32>,
        delay_seconds: u64,
    ) -> Result<(), StreamError>;
    fn cancel_upgrade(env: Env, caller: Address) -> Result<(), StreamError>;
    fn execute_upgrade(env: Env, caller: Address) -> Result<(), StreamError>;
    fn pending_upgrade(env: Env) -> Option<PendingUpgrade>;
    fn migrate_storage(
        env: Env,
        caller: Address,
        start_id: u64,
        count: u32,
    ) -> Result<MigrationStatus, StreamError>;
    fn migration_progress(env: Env) -> MigrationStatus;
}
