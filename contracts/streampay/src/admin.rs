use soroban_sdk::{Address, Env};
use crate::types::{
    DataKey, GovernanceCaps, StreamPayError, TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS,
};

pub fn init_admin(env: Env, admin: Address) -> Result<(), StreamPayError> {
    admin.require_auth();
    if env.storage().instance().has(&DataKey::Admin) {
        return Err(StreamPayError::Unauthorized);
    }
    env.storage().instance().set(&DataKey::Admin, &admin);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    Ok(())
}

pub fn set_governance_caps(
    env: Env,
    admin: Address,
    max_per_stream: i128,
    max_global: i128,
) -> Result<(), StreamPayError> {
    admin.require_auth();

    if let Some(stored_admin) = env.storage().instance().get::<DataKey, Address>(&DataKey::Admin) {
        if stored_admin != admin {
            return Err(StreamPayError::Unauthorized);
        }
    }

    if max_per_stream <= 0 || max_global < max_per_stream {
        return Err(StreamPayError::GovernanceCapExceeded);
    }

    let caps = GovernanceCaps {
        max_per_stream_cap: max_per_stream,
        max_global_account_cap: max_global,
    };
    env.storage().instance().set(&DataKey::GovernanceCaps, &caps);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    Ok(())
}

pub fn set_stream_paused(
    env: Env,
    caller: Address,
    stream_id: u64,
    paused: bool,
) -> Result<(), StreamPayError> {
    caller.require_auth();

    let is_admin = env
        .storage()
        .instance()
        .get::<DataKey, Address>(&DataKey::Admin)
        .map(|a| a == caller)
        .unwrap_or(false);
    let is_sender = env
        .storage()
        .persistent()
        .get::<DataKey, Address>(&DataKey::StreamSender(stream_id))
        .map(|s| s == caller)
        .unwrap_or(false);

    if !is_admin && !is_sender {
        return Err(StreamPayError::Unauthorized);
    }

    let key = DataKey::StreamPaused(stream_id);
    env.storage().persistent().set(&key, &paused);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    Ok(())
}
