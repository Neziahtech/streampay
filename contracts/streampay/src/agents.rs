use soroban_sdk::{token, Address, Env, Vec};
use crate::types::{DataKey, StreamPayError, TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS};

const MAX_AGENTS: u32 = 10;

pub fn add_agent(env: Env, recipient: Address, stream_id: u64, agent: Address) -> Result<(), StreamPayError> {
    recipient.require_auth();

    if agent == recipient {
        return Err(StreamPayError::Unauthorized);
    }

    if let Some(stored_recipient) = env.storage().persistent().get::<DataKey, Address>(&DataKey::StreamRecipient(stream_id)) {
        if stored_recipient != recipient {
            return Err(StreamPayError::Unauthorized);
        }
        env.storage().persistent().extend_ttl(
            &DataKey::StreamRecipient(stream_id),
            TTL_THRESHOLD_LEDGERS,
            TTL_EXTEND_LEDGERS,
        );
    }

    if env.storage().persistent().get(&DataKey::StreamPaused(stream_id)).unwrap_or(false) {
        return Err(StreamPayError::StreamPaused);
    }

    let mut agents: Vec<Address> = env.storage().persistent()
        .get(&DataKey::Agents(stream_id))
        .unwrap_or(Vec::new(&env));

    if agents.contains(&agent) {
        return Ok(());
    }

    if agents.len() >= MAX_AGENTS {
        return Err(StreamPayError::TooManyAgents);
    }

    agents.push_back(agent.clone());
    env.storage().persistent().set(&DataKey::Agents(stream_id), &agents);
    env.storage().persistent().extend_ttl(
        &DataKey::Agents(stream_id),
        TTL_THRESHOLD_LEDGERS,
        TTL_EXTEND_LEDGERS,
    );

    env.events().publish(("streampay", "agent_added"), (stream_id, agent));
    Ok(())
}

pub fn remove_agent(env: Env, recipient: Address, stream_id: u64, agent: Address) -> Result<(), StreamPayError> {
    recipient.require_auth();

    if let Some(stored_recipient) = env.storage().persistent().get::<DataKey, Address>(&DataKey::StreamRecipient(stream_id)) {
        if stored_recipient != recipient {
            return Err(StreamPayError::Unauthorized);
        }
    }

    let agents: Vec<Address> = env.storage().persistent()
        .get(&DataKey::Agents(stream_id))
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

    if new_agents.is_empty() {
        env.storage().persistent().remove(&DataKey::Agents(stream_id));
    } else {
        env.storage().persistent().set(&DataKey::Agents(stream_id), &new_agents);
        env.storage().persistent().extend_ttl(
            &DataKey::Agents(stream_id),
            TTL_THRESHOLD_LEDGERS,
            TTL_EXTEND_LEDGERS,
        );
    }
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

    if amount <= 0 {
        return Err(StreamPayError::BudgetExceeded);
    }

    if env.storage().persistent().get(&DataKey::StreamPaused(stream_id)).unwrap_or(false) {
        return Err(StreamPayError::StreamPaused);
    }

    let agents: Vec<Address> = env.storage().persistent()
        .get(&DataKey::Agents(stream_id))
        .ok_or(StreamPayError::AgentNotFound)?;

    if !agents.contains(&agent) {
        return Err(StreamPayError::Unauthorized);
    }

    env.storage().persistent().extend_ttl(
        &DataKey::Agents(stream_id),
        TTL_THRESHOLD_LEDGERS,
        TTL_EXTEND_LEDGERS,
    );

    if let Some(remaining) = env.storage().persistent().get::<DataKey, i128>(&DataKey::StreamBalance(stream_id)) {
        let withdrawn: i128 = env.storage().persistent().get(&DataKey::StreamWithdrawn(stream_id)).unwrap_or(0);
        let withdrawable = if let (Some(start), Some(end), Some(rate)) = (
            env.storage().persistent().get::<DataKey, u64>(&DataKey::StreamStartTime(stream_id)),
            env.storage().persistent().get::<DataKey, u64>(&DataKey::StreamEndTime(stream_id)),
            env.storage().persistent().get::<DataKey, i128>(&DataKey::StreamRate(stream_id)),
        ) {
            let now = env.ledger().timestamp();
            let elapsed = if now <= start {
                0u64
            } else if now >= end {
                end.saturating_sub(start)
            } else {
                now.saturating_sub(start)
            };
            let total_accrued = (elapsed as i128).saturating_mul(rate);
            total_accrued.saturating_sub(withdrawn).min(remaining)
        } else {
            remaining
        };

        if amount > withdrawable {
            return Err(StreamPayError::BudgetExceeded);
        }

        let new_remaining = remaining.checked_sub(amount).ok_or(StreamPayError::BudgetExceeded)?;
        let new_withdrawn = withdrawn.checked_add(amount).ok_or(StreamPayError::BudgetExceeded)?;
        env.storage().persistent().set(&DataKey::StreamBalance(stream_id), &new_remaining);
        env.storage().persistent().extend_ttl(
            &DataKey::StreamBalance(stream_id),
            TTL_THRESHOLD_LEDGERS,
            TTL_EXTEND_LEDGERS,
        );
        env.storage().persistent().set(&DataKey::StreamWithdrawn(stream_id), &new_withdrawn);
        env.storage().persistent().extend_ttl(
            &DataKey::StreamWithdrawn(stream_id),
            TTL_THRESHOLD_LEDGERS,
            TTL_EXTEND_LEDGERS,
        );

        if let (Some(token_addr), Some(recipient)) = (
            env.storage().persistent().get::<DataKey, Address>(&DataKey::StreamToken(stream_id)),
            env.storage().persistent().get::<DataKey, Address>(&DataKey::StreamRecipient(stream_id)),
        ) {
            token::Client::new(&env, &token_addr).transfer(
                &env.current_contract_address(),
                &recipient,
                &amount,
            );
        }
    }

    // Execute transfer to recipient's address (payouts always land at recipient)
    // emit event with withdrawn_by field for auditability
    env.events().publish(("streampay", "withdrawn_by_agent"), (stream_id, agent, amount));

    Ok(())
}
