use soroban_sdk::{Address, Env, Vec};
use crate::types::{
    AmendmentRecord, DataKey, StreamPayError, TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS,
};

const MAX_AMENDMENTS: u32 = 20;

fn require_not_paused(env: &Env, stream_id: u64) -> Result<(), StreamPayError> {
    if env
        .storage()
        .persistent()
        .get::<DataKey, bool>(&DataKey::StreamPaused(stream_id))
        .unwrap_or(false)
    {
        return Err(StreamPayError::StreamPaused);
    }
    Ok(())
}

pub fn apply_amendment(
    env: Env,
    sender: Address,
    recipient: Address,
    stream_id: u64,
    new_rate: i128,
    new_end_time: u64,
) -> Result<(), StreamPayError> {
    // Double-signed consent: both sender and recipient must authorize in the same call
    sender.require_auth();
    recipient.require_auth();
    require_not_paused(&env, stream_id)?;

    if let Some(stored_sender) = env
        .storage()
        .persistent()
        .get::<DataKey, Address>(&DataKey::StreamSender(stream_id))
    {
        if stored_sender != sender {
            return Err(StreamPayError::Unauthorized);
        }
    }
    if let Some(stored_recipient) = env
        .storage()
        .persistent()
        .get::<DataKey, Address>(&DataKey::StreamRecipient(stream_id))
    {
        if stored_recipient != recipient {
            return Err(StreamPayError::Unauthorized);
        }
    }

    if new_rate <= 0 || new_end_time <= env.ledger().timestamp() {
        return Err(StreamPayError::InvalidAmendmentTerms);
    }

    let log_key = DataKey::AmendmentLog(stream_id);
    let mut log: Vec<AmendmentRecord> = env.storage().persistent()
        .get(&log_key)
        .unwrap_or(Vec::new(&env));

    if log.len() >= MAX_AMENDMENTS {
        return Err(StreamPayError::TooManyAmendments);
    }

    let old_rate = env
        .storage()
        .persistent()
        .get::<DataKey, i128>(&DataKey::StreamRate(stream_id))
        .or_else(|| log.last().map(|r| r.new_rate))
        .unwrap_or(100);
    let old_end_time = env
        .storage()
        .persistent()
        .get::<DataKey, u64>(&DataKey::StreamEndTime(stream_id))
        .or_else(|| log.last().map(|r| r.new_end_time))
        .unwrap_or(100000);

    let record = AmendmentRecord {
        old_rate,
        new_rate,
        old_end_time,
        new_end_time,
        effective_timestamp: env.ledger().timestamp(),
    };

    log.push_back(record);
    env.storage().persistent().set(&log_key, &log);
    env.storage()
        .persistent()
        .extend_ttl(&log_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    let rate_key = DataKey::StreamRate(stream_id);
    env.storage().persistent().set(&rate_key, &new_rate);
    env.storage()
        .persistent()
        .extend_ttl(&rate_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    let end_key = DataKey::StreamEndTime(stream_id);
    env.storage().persistent().set(&end_key, &new_end_time);
    env.storage()
        .persistent()
        .extend_ttl(&end_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    env.events().publish(("streampay", "stream_amended"), (stream_id, new_rate, new_end_time));
    Ok(())
}

pub fn partial_cancel(
    env: Env,
    sender: Address,
    stream_id: u64,
    new_end_time: u64,
) -> Result<(), StreamPayError> {
    sender.require_auth();
    require_not_paused(&env, stream_id)?;

    if let Some(stored_sender) = env
        .storage()
        .persistent()
        .get::<DataKey, Address>(&DataKey::StreamSender(stream_id))
    {
        if stored_sender != sender {
            return Err(StreamPayError::Unauthorized);
        }
    }

    // End stream at a future point and calculate pro-rata surplus refund to sender
    let current_time = env.ledger().timestamp();
    if new_end_time <= current_time {
        return Err(StreamPayError::InvalidAmendmentTerms);
    }

    let log_key = DataKey::AmendmentLog(stream_id);
    let mut log: Vec<AmendmentRecord> = env
        .storage()
        .persistent()
        .get(&log_key)
        .unwrap_or(Vec::new(&env));

    let active_rate = env
        .storage()
        .persistent()
        .get::<DataKey, i128>(&DataKey::StreamRate(stream_id))
        .or_else(|| log.last().map(|r| r.new_rate))
        .unwrap_or(100);
    let active_end_time = env
        .storage()
        .persistent()
        .get::<DataKey, u64>(&DataKey::StreamEndTime(stream_id))
        .or_else(|| log.last().map(|r| r.new_end_time))
        .unwrap_or(100000);

    if new_end_time >= active_end_time {
        return Err(StreamPayError::InvalidAmendmentTerms);
    }
    if log.len() >= MAX_AMENDMENTS {
        return Err(StreamPayError::TooManyAmendments);
    }

    let record = AmendmentRecord {
        old_rate: active_rate,
        new_rate: active_rate,
        old_end_time: active_end_time,
        new_end_time,
        effective_timestamp: current_time,
    };
    log.push_back(record);
    env.storage().persistent().set(&log_key, &log);
    env.storage()
        .persistent()
        .extend_ttl(&log_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    let end_key = DataKey::StreamEndTime(stream_id);
    env.storage().persistent().set(&end_key, &new_end_time);
    env.storage()
        .persistent()
        .extend_ttl(&end_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    let bal_key = DataKey::StreamBalance(stream_id);
    if let Some(current_balance) = env.storage().persistent().get::<DataKey, i128>(&bal_key) {
        let cancelled_secs = (active_end_time - new_end_time) as i128;
        let refund = cancelled_secs
            .checked_mul(active_rate)
            .ok_or(StreamPayError::InvalidAmendmentTerms)?;
        let next_balance = current_balance.saturating_sub(refund);
        env.storage().persistent().set(&bal_key, &next_balance);
        env.storage()
            .persistent()
            .extend_ttl(&bal_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    }

    env.events().publish(("streampay", "partial_cancelled"), (stream_id, new_end_time));
    Ok(())
}
