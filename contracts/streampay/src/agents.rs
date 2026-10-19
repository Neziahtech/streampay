use soroban_sdk::{token, Address, Env, Vec};
use crate::types::{DataKey, StreamPayError, TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS};

const MAX_AGENTS: u32 = 10;

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

fn require_recipient_owner(
    env: &Env,
    stream_id: u64,
    recipient: &Address,
) -> Result<(), StreamPayError> {
    if let Some(stored_recipient) = env
        .storage()
        .persistent()
        .get::<DataKey, Address>(&DataKey::StreamRecipient(stream_id))
    {
        if &stored_recipient != recipient {
            return Err(StreamPayError::Unauthorized);
        }
    }
    Ok(())
}

pub fn add_agent(env: Env, recipient: Address, stream_id: u64, agent: Address) -> Result<(), StreamPayError> {
    recipient.require_auth();
    require_not_paused(&env, stream_id)?;
    require_recipient_owner(&env, stream_id, &recipient)?;

    let key = DataKey::Agents(stream_id);
    let mut agents: Vec<Address> = env.storage().persistent()
        .get(&key)
        .unwrap_or(Vec::new(&env));

    if agents.contains(&agent) {
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
        return Ok(());
    }

    if agents.len() >= MAX_AGENTS {
        return Err(StreamPayError::TooManyAgents);
    }

    agents.push_back(agent.clone());
    env.storage().persistent().set(&key, &agents);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    env.events().publish(("streampay", "agent_added"), (stream_id, agent));
    Ok(())
}

pub fn remove_agent(env: Env, recipient: Address, stream_id: u64, agent: Address) -> Result<(), StreamPayError> {
    recipient.require_auth();
    require_not_paused(&env, stream_id)?;
    require_recipient_owner(&env, stream_id, &recipient)?;

    let key = DataKey::Agents(stream_id);
    let agents: Vec<Address> = env.storage().persistent()
        .get(&key)
        .ok_or(StreamPayError::AgentNotFound)?;

    let mut new_agents = Vec::new(&env);
    let mut found = false;

    for a in agents.iter() {
        if a == agent {
            found = true;
        } else {
            new_agents.push_back(a);
        }
    }

    if !found {
        return Err(StreamPayError::AgentNotFound);
    }

    env.storage().persistent().set(&key, &new_agents);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    env.events().publish(("streampay", "agent_removed"), (stream_id, agent));
    Ok(())
}

pub fn withdraw_on_behalf_of(
    env: Env,
    agent: Address,
    stream_id: u64,
    amount: i128,
) -> Result<(), StreamPayError> {
    agent.require_auth();
    require_not_paused(&env, stream_id)?;

    if amount <= 0 {
        return Err(StreamPayError::BudgetExceeded);
    }

    let key = DataKey::Agents(stream_id);
    let agents: Vec<Address> = env.storage().persistent()
        .get(&key)
        .ok_or(StreamPayError::AgentNotFound)?;

    if !agents.contains(&agent) {
        return Err(StreamPayError::Unauthorized);
    }
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    let bal_key = DataKey::StreamBalance(stream_id);
    if let Some(current_balance) = env.storage().persistent().get::<DataKey, i128>(&bal_key) {
        if amount > current_balance {
            return Err(StreamPayError::BudgetExceeded);
        }
        let next_balance = current_balance
            .checked_sub(amount)
            .ok_or(StreamPayError::BudgetExceeded)?;
        env.storage().persistent().set(&bal_key, &next_balance);
        env.storage()
            .persistent()
            .extend_ttl(&bal_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    }

    let w_key = DataKey::StreamWithdrawn(stream_id);
    let withdrawn = env
        .storage()
        .persistent()
        .get::<DataKey, i128>(&w_key)
        .unwrap_or(0);
    let next_withdrawn = withdrawn
        .checked_add(amount)
        .ok_or(StreamPayError::BudgetExceeded)?;
    env.storage().persistent().set(&w_key, &next_withdrawn);
    env.storage()
        .persistent()
        .extend_ttl(&w_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    if let (Some(token_addr), Some(recipient_addr)) = (
        env.storage()
            .persistent()
            .get::<DataKey, Address>(&DataKey::StreamToken(stream_id)),
        env.storage()
            .persistent()
            .get::<DataKey, Address>(&DataKey::StreamRecipient(stream_id)),
    ) {
        token::Client::new(&env, &token_addr).transfer(
            &env.current_contract_address(),
            &recipient_addr,
            &amount,
        );
    }

    // Execute transfer to recipient's address (payouts always land at recipient)
    // emit event with withdrawn_by field for auditability
    env.events().publish(("streampay", "withdrawn_by_agent"), (stream_id, agent, amount));

    Ok(())
}
