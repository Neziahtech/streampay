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

    let existing_rule: Option<RefillRule> = env.storage().persistent().get(&DataKey::RefillRule(stream_id));
    if let Some(prev) = &existing_rule {
        if prev.registrant != registrant {
            return Err(StreamPayError::Unauthorized);
        }
    }

    let current_account_budget: i128 = env.storage().persistent()
        .get(&DataKey::AccountBudget(registrant.clone()))
        .unwrap_or(0);
    let base_account_budget = match &existing_rule {
        Some(prev) => current_account_budget.saturating_sub(prev.total_budget),
        None => current_account_budget,
    };
    let next_account_budget = base_account_budget
        .checked_add(total_budget)
        .ok_or(StreamPayError::GovernanceCapExceeded)?;

    if amount > caps.max_per_stream_cap || next_account_budget > caps.max_global_account_cap {
        return Err(StreamPayError::GovernanceCapExceeded);
    }

    let rule = RefillRule {
        registrant: registrant.clone(),
        amount,
        cadence_seconds,
        max_topups,
        topups_executed: 0,
        total_budget,
        total_refilled: 0,
        last_refill_timestamp: env.ledger().timestamp(),
    };

    env.storage().persistent().set(&DataKey::RefillRule(stream_id), &rule);
    env.storage().persistent().set(&DataKey::AccountBudget(registrant), &next_account_budget);

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

    let current_account_budget: i128 = env.storage().persistent()
        .get(&DataKey::AccountBudget(registrant.clone()))
        .unwrap_or(0);
    let updated_budget = current_account_budget.saturating_sub(rule.total_budget);
    env.storage().persistent().set(&DataKey::AccountBudget(registrant), &updated_budget);

    env.storage().persistent().remove(&DataKey::RefillRule(stream_id));
    env.events().publish(("streampay", "refill_rule_cancelled"), stream_id);

    Ok(())
}

