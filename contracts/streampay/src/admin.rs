use soroban_sdk::{Env, Address};
use crate::types::{GovernanceCaps, DataKey, StreamPayError};

pub fn set_governance_caps(
    env: Env,
    admin: Address,
    max_per_stream: i128,
    max_global: i128,
) -> Result<(), StreamPayError> {
    admin.require_auth();

    let stored_admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(StreamPayError::Unauthorized)?;
    if stored_admin != admin {
        return Err(StreamPayError::Unauthorized);
    }

    if max_per_stream <= 0 || max_global < max_per_stream {
        return Err(StreamPayError::GovernanceCapExceeded);
    }

    let caps = GovernanceCaps {
        max_per_stream_cap: max_per_stream,
        max_global_account_cap: max_global,
    };
    env.storage().instance().set(&DataKey::GovernanceCaps, &caps);
    Ok(())
}

