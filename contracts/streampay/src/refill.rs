use soroban_sdk::{Env, Address, symbol_short};
use crate::types::{RefillRule, GovernanceCaps, DataKey, StreamPayError};

pub fn set_refill_rule(
    env: Env,
    registrant: Address,
    stream_id: u64,
    amount: i128,
    cadence_seconds: u64,
    max_topups: u32,
    total_budget: i128,
) -> Result<(), StreamPayError> {
    registrant.require_auth();

    // Enforce governance budget caps
    let caps: GovernanceCaps = env.storage().instance()
        .get(&DataKey::GovernanceCaps)
        .unwrap_or(GovernanceCaps { max_per_stream_cap: i128::MAX, max_global_account_cap: i128::MAX });

    if amount <= 0 || total_budget < amount || amount > caps.max_per_stream_cap || total_budget > caps.max_global_account_cap {
        return Err(StreamPayError::GovernanceCapExceeded);
    }

    let (topups_executed, total_refilled, last_refill_timestamp) =
        if let Some(existing) = env.storage().persistent().get::<DataKey, RefillRule>(&DataKey::RefillRule(stream_id)) {
            if existing.registrant != registrant {
                return Err(StreamPayError::Unauthorized);
            }
            if total_budget < existing.total_refilled {
                return Err(StreamPayError::BudgetExceeded);
            }
            if max_topups > 0 && max_topups < existing.topups_executed {
                return Err(StreamPayError::MaxTopupsExceeded);
            }
            (existing.topups_executed, existing.total_refilled, existing.last_refill_timestamp)
        } else {
            (0, 0, env.ledger().timestamp())
        };

    let rule = RefillRule {
        registrant,
        amount,
        cadence_seconds,
        max_topups,
        topups_executed,
        total_budget,
        total_refilled,
        last_refill_timestamp,
    };

    env.storage().persistent().set(&DataKey::RefillRule(stream_id), &rule);

    // Emit event with rule hash for client verification
    let rule_hash = env.crypto().keccak256(&env.to_xdr(&rule));
    env.events().publish(("streampay", "refill_rule_set"), rule_hash);

    Ok(())
}

pub fn cancel_refill_rule(env: Env, registrant: Address, stream_id: u64) -> Result<(), StreamPayError> {
    registrant.require_auth();

    let rule: RefillRule = env.storage().persistent()
        .get(&DataKey::RefillRule(stream_id))
        .ok_or(StreamPayError::RefillRuleNotFound)?;

    if rule.registrant != registrant {
        return Err(StreamPayError::Unauthorized);
    }

    env.storage().persistent().remove(&DataKey::RefillRule(stream_id));
    env.events().publish(("streampay", "refill_rule_cancelled"), stream_id);

    Ok(())
}
