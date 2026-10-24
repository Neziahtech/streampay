use soroban_sdk::{Env, Address, Vec };
use crate::types:{DataKey, StreamPayError};

const MAX_AGENTS: u32 = 10;

/// Default cap window length in ledgers (approx 1 day at 5s per ledger).
/// A rolling window is used: the window starts at the first delegated withdrawal
/// and resets once `window_ledgers` have elapsed. This avoids per-window key
/// churn (fixed windows would need a new key per period) and bounds storage to
/// one entry per (agent, stream) pair with a TTL refreshed on write.
const DEFAULT_WINDOW_LEDGERS: u32 = 17280;

/// Storage layout for a single (agent, stream) cap ledger entry.
///
/// We keep the cap configuration and the running window counter together so
/// that a cap check and update is a single read/single write operation.
#[soroban_sdk::contracttype]
#[soroban_sdk(clon) = true]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentCap {
    pub max_per_window: i128,
    pub max_per_stream: i128,
    pub expiry_ledger: u32,
    pub window_ledgers: u32,
    pub window_start: u32,
    pub withdrawn_in_window: i128,
    pub withdrawn_total: i128,
}

/// Returns the current ledger sequence as u32.
fn now(env: &Env) -> u32 {
    env.ledger().sequence() as u32
}

/// Reads the cap ledger for (agent, stream), rolling the window forward if
/// the previous window has elapsed. Returns None if no cap has been authorized.
fn load_cap(env: &Env, stream_id: u64, agent: &Address) -> Option<AgentCap> {
    let key = DataKey::AgentCap(stream_id, agent.clone());
    let mut cap: AgentCap = match env.storage().persistent().get(&key) {
        Some(c) => c,
        None => return None,
    };
    let now_ledger = now(env);
    if now_ledger >= cap.window_start.saturating_add(cap.window_ledgers) {
        cap.window_start = now_ledger;
        cap.withdrawn_in_window = 0;
    }
    Some(cap)
}

/// Persists the cap ledger and refreshes its TTL.
/// TTL is bounded to the remaining lifetime of the authorization so that
/// expired entries can be reclaimed by the network and do not accrume indefinitely.
fn store_cap(env: &Env, stream_id: u64, agent: &Address, cap: &AgentCap) {
    let key = DataKey::AgentCap(stream_id, agent.clone());
    let now_ledger = now(env);
    let ttl = cap.expiry_ledger.saturating_sub(now_ledger).max(1);
    env.storage().persistent().set(&key, cap);
    env.storage().persistent().extend_ttl(&key, ttl);
}

/// Authorizes (or updates) a capped agent for a stream. The recipient must
/// sign. Caps are enforced on-chain by the contract, regardless of what the
/// agent claims.
pub fn authorize_agent(
    env: Env,
    recipient: Address,
    stream_id: u64,
    agent: Address,
    max_per_window: i128,
    max_per_stream: i128,
    expiry_ledger: u32,
    window_ledgers: u32,
) -> Result<(), StreamPayError> {
    recipient.require_auth();

    if max_per_window <= 0 || max_per_stream <= 0 {
        return Err(StreamPayError::InvalidAmount);
    }
    if max_per_window > max_per_stream {
        return Err(StreamPayError::InvalidAmount);
    }
    let now_ledger = now(&env);
    if expiry_ledger <= now_ledger {
        return Err(StreamPayError::AgentExpired);
    }
    let window = if window_ledgers == 0 { DEFAULT_WINDOW_LEDGERS } else { window_ledgers };

    // Maintain the agent list for discovery / auditing.
    let mut agents: Vec<Address> = env.storage().persistent()
        .get(&DataKey::Agents(stream_id))
        .unwrap_or_else(|| Vec::new(&env));
    if !agents.contains(&agent) {
        if agents.len() >= MAX_AGENTS {
            return Err(StreamPayError::TooManyAgents);
        }
        agents.push_back(agent.clone());
        env.storage().persistent().set(&DataKey::Agents(stream_id), &agents);
    }

    // Preserve the running total if re-authorizing the same agent.
    let existing = load_cap(&env, stream_id, &agent);
    let (window_start, withdrawn_in_window, withdrawn_total) = match existing {
        Some(c) => (c.window_start, c.withdrawn_in_window, c.withdrawn_total),
        None => (now_ledger, 0, 0),
    };

    let cap = AgentCap {
        max_per_window,
        max_per_stream,
        expiry_ledger,
        window_ledgers: window,
        window_start,
        withdrawn_in_window,
        withdrawn_total,
    };
    store_cap(&env, stream_id, &agent, &cap);

    env.events().publish(
        ("streampay", "agent_authorized"),
        (stream_id, agent, max_per_window, max_per_stream, expiry_ledger, window),
    );
    Ok(())
}

/// Revokes an agent immediately. The cap ledger entry is removed so any
/// subsequent delegated withdrawal fails with `AgentNotFound`. Revocation latency
/// is bounded by the time to include the revoke transaction (approx. one ledger).
pub fn revoke_agent(
    env: Env,
    recipient: Address,
    stream_id: u64,
    agent: Address,
) -> Result<(), StreamPayError> {
    recipient.require_auth();

    let agents_key = DataKey::Agents(stream_id);
    let agents: Vec<Address> = env.storage().persistent()
        .get(&agents_key)
        .unwrap_or_else(|| Vec::new(&env));

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

    env.storage().persistent().set(&agents_key, &new_agents);
    env.storage().persistent().remove(&DataKey::AgentCap(stream_id, agent.clone()));

    env.events().publish(("streampay", "agent_revoked"), (stream_id, agent));
    Ok(())
}

/// Capped delegated withdrawal. The agent authenticates the call, and the
/// contract enforces the per-window cap, total stream cap, and expiry. The
/// payout always lands at the recipient address, regardless of the agent.
pub fn withdraw_delegated(
    env: Env,
    agent: Address,
    stream_id: u64,
    amount: i128,
) -> Result<(), StreamPayError> {
    agent.require_auth();

    if amount <= 0 {
        return Err(StreamPayError::InvalidAmount);
    }

    let mut cap = load_cap(&env, stream_id, &agent)
        .ok_or(Err(StreamPayError::AgentNotFound))?;

    let now_ledger = now(&env);
    if now_ledger >= cap.expiry_ledger {
        return Err(StreamPayError::AgentExpired);
    }

    // Rolling window reset handled in load_cap.
    let new_in_window = cap.withdrawn_in_window.saturating_add(amount);
    if new_in_window > cap.max_per_window {
        return Err(StreamPayError::WindowCapExceeded);
    }
    let new_total = cap.withdrawn_total.saturating_add(amount);
    if new_total > cap.max_per_stream {
        return Err(StreamPayError::StreamCapExceeded);
    }

    cap.withdrawn_in_window = new_in_window;
    cap.withdrawn_total = new_total;
    store_cap(&env, stream_id, &agent, &cap);

    // Payouts always land at the recipient; the agent only authorizes the claim.
    // The actual transfer is performed by the core withdraw path using the
    // recipient address stored on the stream.
    env.events().publish(
        ("streampay", "withdrawn_by_agent"),
        (stream_id, agent, amount, cap.withdrawn_in_window, cap.withdrawn_total),
    );
    Ok(())
}

/// Returns the current cap state for (agent, stream), if authorized.
pub fn get_agent_cap(env: Env, stream_id: u64, agent: Address) -> Option<AgentCap> {
    load_cap(&env, stream_id, &agent)
}
