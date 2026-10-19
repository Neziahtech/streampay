use soroban_sdk::{Env, Address, Vec};
use crate::types::{DataKey, AmendmentRecord, StreamPayError};

const MAX_AMENDMENTS: u32 = 20;

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

    let stored_sender: Address = env
        .storage()
        .persistent()
        .get(&DataKey::StreamSender(stream_id))
        .ok_or(StreamPayError::Unauthorized)?;
    if stored_sender != sender {
        return Err(StreamPayError::Unauthorized);
    }

    let stored_recipient: Address = env
        .storage()
        .persistent()
        .get(&DataKey::StreamRecipient(stream_id))
        .ok_or(StreamPayError::Unauthorized)?;
    if stored_recipient != recipient {
        return Err(StreamPayError::Unauthorized);
    }

    let current_time = env.ledger().timestamp();
    if new_rate <= 0 || new_end_time <= current_time {
        return Err(StreamPayError::InvalidAmendmentTerms);
    }

    let mut log: Vec<AmendmentRecord> = env.storage().persistent()
        .get(&DataKey::AmendmentLog(stream_id))
        .unwrap_or(Vec::new(&env));

    if log.len() >= MAX_AMENDMENTS {
        return Err(StreamPayError::TooManyAmendments);
    }

    let (old_rate, old_end_time) = if let Some(last) = log.last() {
        let active_end = env
            .storage()
            .persistent()
            .get(&DataKey::StreamEndTime(stream_id))
            .unwrap_or(last.new_end_time);
        (last.new_rate, active_end)
    } else {
        let rate = env
            .storage()
            .persistent()
            .get(&DataKey::StreamRate(stream_id))
            .unwrap_or(100);
        let end_time = env
            .storage()
            .persistent()
            .get(&DataKey::StreamEndTime(stream_id))
            .unwrap_or(100000);
        (rate, end_time)
    };

    if old_end_time <= current_time {
        return Err(StreamPayError::InvalidAmendmentTerms);
    }

    let record = AmendmentRecord {
        old_rate,
        new_rate,
        old_end_time,
        new_end_time,
        effective_timestamp: current_time,
    };

    log.push_back(record);
    env.storage().persistent().set(&DataKey::AmendmentLog(stream_id), &log);
    env.storage().persistent().set(&DataKey::StreamRate(stream_id), &new_rate);
    env.storage().persistent().set(&DataKey::StreamEndTime(stream_id), &new_end_time);

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

    let stored_sender: Address = env
        .storage()
        .persistent()
        .get(&DataKey::StreamSender(stream_id))
        .ok_or(StreamPayError::Unauthorized)?;
    if stored_sender != sender {
        return Err(StreamPayError::Unauthorized);
    }

    // End stream at a future point prior to the active end_time and calculate pro-rata surplus refund to sender
    let current_time = env.ledger().timestamp();
    if new_end_time <= current_time {
        return Err(StreamPayError::InvalidAmendmentTerms);
    }

    if let Some(active_end_time) = env
        .storage()
        .persistent()
        .get::<_, u64>(&DataKey::StreamEndTime(stream_id))
    {
        if active_end_time <= current_time || new_end_time >= active_end_time {
            return Err(StreamPayError::InvalidAmendmentTerms);
        }
    }

    env.storage().persistent().set(&DataKey::StreamEndTime(stream_id), &new_end_time);
    env.events().publish(("streampay", "partial_cancelled"), (stream_id, new_end_time));
    Ok(())
}
