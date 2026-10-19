use soroban_sdk::{token, Address, Env};
use crate::types::{
    DataKey, GovernanceCaps, RefillRule, StreamPayError, TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS,
};

fn require_active_and_unexpired(env: &Env, stream_id: u64) -> Result<(), StreamPayError> {
    if env
        .storage()
        .persistent()
        .get::<DataKey, bool>(&DataKey::StreamPaused(stream_id))
        .unwrap_or(false)
    {
        return Err(StreamPayError::StreamPaused);
    }
    if let Some(end_time) = env
        .storage()
        .persistent()
        .get::<DataKey, u64>(&DataKey::StreamEndTime(stream_id))
    {
        if env.ledger().timestamp() >= end_time {
            return Err(StreamPayError::StreamExpired);
        }
    }
    Ok(())
}

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
    require_active_and_unexpired(&env, stream_id)?;

    if let Some(stored_sender) = env
        .storage()
        .persistent()
        .get::<DataKey, Address>(&DataKey::StreamSender(stream_id))
    {
        if stored_sender != registrant {
            return Err(StreamPayError::Unauthorized);
        }
    }

    let existing_rule: Option<RefillRule> = env
        .storage()
        .persistent()
        .get(&DataKey::RefillRule(stream_id));
    if let Some(prev) = &existing_rule {
        if prev.registrant != registrant {
            return Err(StreamPayError::Unauthorized);
        }
    }

    let (topups_executed, total_refilled) = existing_rule
        .as_ref()
        .map(|r| (r.topups_executed, r.total_refilled))
        .unwrap_or((0, 0));

    if amount <= 0
        || total_budget < amount
        || total_budget < total_refilled
        || cadence_seconds == 0
        || max_topups == 0
    {
        return Err(StreamPayError::BudgetExceeded);
    }

    // Enforce governance budget caps; only release the unconsumed portion of an existing rule's budget
    let caps: GovernanceCaps = env
        .storage()
        .instance()
        .get(&DataKey::GovernanceCaps)
        .unwrap_or(GovernanceCaps {
            max_per_stream_cap: i128::MAX,
            max_global_account_cap: i128::MAX,
        });

    let current_account_budget: i128 = env
        .storage()
        .persistent()
        .get(&DataKey::AccountBudget(registrant.clone()))
        .unwrap_or(0);
    let unconsumed_existing = existing_rule
        .as_ref()
        .map(|prev| prev.total_budget.saturating_sub(prev.total_refilled).max(0))
        .unwrap_or(0);
    let base_account_budget = current_account_budget.saturating_sub(unconsumed_existing);
    let unconsumed_new = total_budget.saturating_sub(total_refilled).max(0);
    let next_account_budget = base_account_budget
        .checked_add(unconsumed_new)
        .ok_or(StreamPayError::GovernanceCapExceeded)?;

    if amount > caps.max_per_stream_cap || next_account_budget > caps.max_global_account_cap {
        return Err(StreamPayError::GovernanceCapExceeded);
    }

    let rule = RefillRule {
        registrant: registrant.clone(),
        amount,
        cadence_seconds,
        max_topups,
        topups_executed,
        total_budget,
        total_refilled,
        last_refill_timestamp: env.ledger().timestamp(),
    };

    let key = DataKey::RefillRule(stream_id);
    env.storage().persistent().set(&key, &rule);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    let acct_key = DataKey::AccountBudget(registrant);
    env.storage()
        .persistent()
        .set(&acct_key, &next_account_budget);
    env.storage()
        .persistent()
        .extend_ttl(&acct_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    // Emit event with rule hash for client verification
    let rule_hash = env.crypto().keccak256(&env.to_xdr(&rule));
    env.events().publish(("streampay", "refill_rule_set"), rule_hash);

    Ok(())
}

pub fn execute_refill(env: Env, stream_id: u64) -> Result<(), StreamPayError> {
    require_active_and_unexpired(&env, stream_id)?;

    let key = DataKey::RefillRule(stream_id);
    let mut rule: RefillRule = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(StreamPayError::RefillRuleNotFound)?;

    let now = env.ledger().timestamp();
    let next_allowed = rule
        .last_refill_timestamp
        .checked_add(rule.cadence_seconds)
        .ok_or(StreamPayError::CadenceNotElapsed)?;
    if now < next_allowed {
        return Err(StreamPayError::CadenceNotElapsed);
    }
    if rule.topups_executed >= rule.max_topups {
        return Err(StreamPayError::MaxTopupsExceeded);
    }
    let next_refilled = rule
        .total_refilled
        .checked_add(rule.amount)
        .ok_or(StreamPayError::BudgetExceeded)?;
    if next_refilled > rule.total_budget {
        return Err(StreamPayError::BudgetExceeded);
    }

    rule.topups_executed += 1;
    rule.total_refilled = next_refilled;
    rule.last_refill_timestamp = now;

    env.storage().persistent().set(&key, &rule);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    let bal_key = DataKey::StreamBalance(stream_id);
    let current_balance = env
        .storage()
        .persistent()
        .get::<DataKey, i128>(&bal_key)
        .unwrap_or(0);
    let next_balance = current_balance
        .checked_add(rule.amount)
        .ok_or(StreamPayError::BudgetExceeded)?;
    env.storage().persistent().set(&bal_key, &next_balance);
    env.storage()
        .persistent()
        .extend_ttl(&bal_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    // Extend StreamEndTime proportionally when StreamRate > 0 so refilled funds can accrue
    if let (Some(end_time), Some(rate)) = (
        env.storage()
            .persistent()
            .get::<DataKey, u64>(&DataKey::StreamEndTime(stream_id)),
        env.storage()
            .persistent()
            .get::<DataKey, i128>(&DataKey::StreamRate(stream_id)),
    ) {
        if rate > 0 {
            let extension = (rule.amount / rate).max(0) as u64;
            let new_end_time = end_time
                .checked_add(extension)
                .ok_or(StreamPayError::BudgetExceeded)?;
            let end_key = DataKey::StreamEndTime(stream_id);
            env.storage().persistent().set(&end_key, &new_end_time);
            env.storage()
                .persistent()
                .extend_ttl(&end_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
        }
    }

    if let Some(token_addr) = env
        .storage()
        .persistent()
        .get::<DataKey, Address>(&DataKey::StreamToken(stream_id))
    {
        token::Client::new(&env, &token_addr).transfer_from(
            &env.current_contract_address(),
            &rule.registrant,
            &env.current_contract_address(),
            &rule.amount,
        );
    }

    env.events().publish(
        ("streampay", "refill_executed"),
        (stream_id, rule.amount, rule.topups_executed),
    );

    Ok(())
}

pub fn cancel_refill_rule(
    env: Env,
    registrant: Address,
    stream_id: u64,
) -> Result<(), StreamPayError> {
    registrant.require_auth();

    let rule: RefillRule = env
        .storage()
        .persistent()
        .get(&DataKey::RefillRule(stream_id))
        .ok_or(StreamPayError::RefillRuleNotFound)?;

    if rule.registrant != registrant {
        return Err(StreamPayError::Unauthorized);
    }

    // Release only the unconsumed reservation from AccountBudget(registrant)
    let unconsumed = rule.total_budget.saturating_sub(rule.total_refilled).max(0);
    let acct_key = DataKey::AccountBudget(registrant);
    let current_account_budget: i128 = env.storage().persistent().get(&acct_key).unwrap_or(0);
    let updated_budget = current_account_budget.saturating_sub(unconsumed);
    env.storage().persistent().set(&acct_key, &updated_budget);
    env.storage()
        .persistent()
        .extend_ttl(&acct_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    env.storage().persistent().remove(&DataKey::RefillRule(stream_id));
    env.events().publish(("streampay", "refill_rule_cancelled"), stream_id);

    Ok(())
}
