#![no_std]

//! # StreamPay payout router
//!
//! Lets a stream recipient bind an alternate payout address (an exchange
//! deposit account, an anchor-connected account) so claims land there while
//! every authorization stays with the recipient's original key.
//!
//! The router is a second contract that plugs into the streaming contract's
//! existing per-stream `Withdraw` callback hook. The streaming contract is not
//! changed (its Wasm is at the size wall; see `docs/PAYOUT_ROUTING.md`).
//!
//! ```text
//! none --propose--> pending --confirm (>= 24 h later)--> active
//!   ^                  |  ^---- propose (replaces, restarts delay) ----'
//!   '------ cancel ----'-------------- cancel ---------------'
//! ```
//!
//! Only `Active` bindings route. A pending binding never moves funds.

mod events;
mod types;

#[cfg(test)]
mod test;

use soroban_sdk::{
    contract, contractimpl, token, Address, Env, InvokeError, Map, Symbol, TryFromVal, Val, Vec,
};

pub use events::{PayoutActive, PayoutBound, PayoutCleared};
pub use types::{Active, BindingView, DataKey, Pending, RouterError};

/// Delay between `propose` and the earliest `confirm`: 24 hours.
pub const BIND_DELAY_SECS: u64 = 86_400;

/// Persistent-entry TTL policy (ledgers, ~5 s each): extend to ~30 days when
/// fewer than ~15 days remain.
pub const TTL_THRESHOLD_LEDGERS: u32 = 259_200;
pub const TTL_EXTEND_LEDGERS: u32 = 518_400;

/// Facts read from the streaming contract's `get_stream` result.
struct StreamFacts {
    recipient: Address,
    token: Address,
}

#[contract]
pub struct PayoutRouter;

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Extends a persistent entry only if it exists. `extend_ttl` on a missing key
/// traps, so every read path goes through this helper (existence-check-before-
/// extend). Returns whether the key exists.
fn touch(env: &Env, key: &DataKey) -> bool {
    let store = env.storage().persistent();
    if store.has(key) {
        store.extend_ttl(key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
        true
    } else {
        false
    }
}

fn put<T: soroban_sdk::IntoVal<Env, Val>>(env: &Env, key: &DataKey, value: &T) {
    let store = env.storage().persistent();
    store.set(key, value);
    store.extend_ttl(key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

fn streaming(env: &Env) -> Address {
    extend_instance(env);
    env.storage()
        .instance()
        .get(&DataKey::Streaming)
        .expect("constructor sets the streaming contract")
}

fn get_pending(env: &Env, id: u64) -> Option<Pending> {
    let key = DataKey::Pending(id);
    if touch(env, &key) {
        env.storage().persistent().get(&key)
    } else {
        None
    }
}

fn get_active(env: &Env, id: u64) -> Option<Active> {
    let key = DataKey::Active(id);
    if touch(env, &key) {
        env.storage().persistent().get(&key)
    } else {
        None
    }
}

/// Reads `recipient`, `token` and `status` from the streaming contract's
/// `get_stream` by decoding the result as a symbol-keyed map. This needs no
/// copy of the `Stream` type, so fields added to it later never break the
/// router. Returns `(facts, is_active)`.
fn read_stream(env: &Env, id: u64) -> Result<(StreamFacts, bool), RouterError> {
    let streaming = streaming(env);
    let mut args: Vec<Val> = Vec::new(env);
    args.push_back(soroban_sdk::IntoVal::into_val(&id, env));
    let fields = match env.try_invoke_contract::<Map<Symbol, Val>, InvokeError>(
        &streaming,
        &Symbol::new(env, "get_stream"),
        args,
    ) {
        Ok(Ok(m)) => m,
        _ => return Err(RouterError::StreamUnavailable),
    };
    let field = |name: &str| -> Result<Val, RouterError> {
        fields
            .get(Symbol::new(env, name))
            .ok_or(RouterError::StreamUnavailable)
    };
    let recipient = Address::try_from_val(env, &field("recipient")?)
        .map_err(|_| RouterError::StreamUnavailable)?;
    let token =
        Address::try_from_val(env, &field("token")?).map_err(|_| RouterError::StreamUnavailable)?;
    // A unit enum variant is encoded as a one-element vec holding its name.
    let status = Vec::<Symbol>::try_from_val(env, &field("status")?)
        .map_err(|_| RouterError::StreamUnavailable)?;
    let active = status.get(0) == Some(Symbol::new(env, "Active"));
    Ok((StreamFacts { recipient, token }, active))
}

/// True when the stream has an open receivables advance. A lender intercept
/// pays part of each claim to the lender, so forwarding the gross amount would
/// not match what the recipient received.
fn has_advance(env: &Env, id: u64) -> Result<bool, RouterError> {
    let streaming = streaming(env);
    let mut args: Vec<Val> = Vec::new(env);
    args.push_back(soroban_sdk::IntoVal::into_val(&id, env));
    match env.try_invoke_contract::<Option<Val>, InvokeError>(
        &streaming,
        &Symbol::new(env, "get_advance"),
        args,
    ) {
        Ok(Ok(v)) => Ok(v.is_some()),
        _ => Err(RouterError::StreamUnavailable),
    }
}

#[contractimpl]
impl PayoutRouter {
    /// Stores the streaming contract this router serves.
    pub fn __constructor(env: Env, streaming: Address) {
        env.storage()
            .instance()
            .set(&DataKey::Streaming, &streaming);
        extend_instance(&env);
    }

    /// Proposes `payout` as the alternate claim address of stream `stream_id`.
    /// Recipient-authenticated. Starts (or restarts) the 24 h delay. Does not
    /// route anything until `confirm`. Returns the activation timestamp.
    pub fn propose(env: Env, stream_id: u64, payout: Address) -> Result<u64, RouterError> {
        let (facts, active) = read_stream(&env, stream_id)?;
        facts.recipient.require_auth();
        if !active {
            return Err(RouterError::StreamNotActive);
        }
        if payout == facts.recipient {
            return Err(RouterError::PayoutIsRecipient);
        }
        if payout == streaming(&env) {
            return Err(RouterError::PayoutIsStreaming);
        }
        if payout == env.current_contract_address() {
            return Err(RouterError::PayoutIsRouter);
        }
        if has_advance(&env, stream_id)? {
            return Err(RouterError::AdvanceActive);
        }

        let activates_at = env.ledger().timestamp().saturating_add(BIND_DELAY_SECS);
        put(
            &env,
            &DataKey::Pending(stream_id),
            &Pending {
                payout: payout.clone(),
                recipient: facts.recipient.clone(),
                token: facts.token,
                activates_at,
            },
        );
        PayoutBound {
            stream_id,
            recipient: facts.recipient,
            payout,
            activates_at,
        }
        .publish(&env);
        Ok(activates_at)
    }

    /// Turns a pending binding into the active one once the delay has passed.
    /// Recipient-authenticated.
    pub fn confirm(env: Env, stream_id: u64) -> Result<(), RouterError> {
        let pending = get_pending(&env, stream_id).ok_or(RouterError::NoPending)?;
        pending.recipient.require_auth();
        if env.ledger().timestamp() < pending.activates_at {
            return Err(RouterError::BindingNotReady);
        }
        let (facts, active) = read_stream(&env, stream_id)?;
        if !active {
            return Err(RouterError::StreamNotActive);
        }
        if facts.recipient != pending.recipient {
            return Err(RouterError::RecipientChanged);
        }
        if has_advance(&env, stream_id)? {
            return Err(RouterError::AdvanceActive);
        }

        put(
            &env,
            &DataKey::Active(stream_id),
            &Active {
                payout: pending.payout.clone(),
                recipient: pending.recipient.clone(),
                token: pending.token,
            },
        );
        env.storage()
            .persistent()
            .remove(&DataKey::Pending(stream_id));
        PayoutActive {
            stream_id,
            recipient: pending.recipient,
            payout: pending.payout,
        }
        .publish(&env);
        Ok(())
    }

    /// Removes the pending and active binding; claims land at the recipient
    /// again. Authorized by the recipient who made the binding, or, if the
    /// stream's recipient has since changed, by the CURRENT recipient.
    pub fn cancel(env: Env, stream_id: u64) -> Result<(), RouterError> {
        let pending = get_pending(&env, stream_id);
        let active = get_active(&env, stream_id);
        let stored = match (&active, &pending) {
            (Some(a), _) => a.recipient.clone(),
            (None, Some(p)) => p.recipient.clone(),
            (None, None) => return Err(RouterError::NoBinding),
        };
        let who = match read_stream(&env, stream_id) {
            Ok((facts, _)) => facts.recipient,
            Err(_) => stored,
        };
        who.require_auth();

        env.storage()
            .persistent()
            .remove(&DataKey::Pending(stream_id));
        env.storage()
            .persistent()
            .remove(&DataKey::Active(stream_id));
        PayoutCleared {
            stream_id,
            recipient: who,
        }
        .publish(&env);
        Ok(())
    }

    /// Read-only view of the binding state of a stream.
    pub fn binding(env: Env, stream_id: u64) -> BindingView {
        let pending = get_pending(&env, stream_id);
        let active = get_active(&env, stream_id);
        BindingView {
            active: active.map(|a| a.payout),
            activates_at: pending.as_ref().map(|p| p.activates_at).unwrap_or(0),
            pending: pending.map(|p| p.payout),
        }
    }

    /// Withdraw-hook entry point: `selector(stream_id, amount)` as called by the
    /// streaming contract from inside its payout. Consults ONLY the active
    /// binding. With none, it does nothing and the claim stays at the recipient.
    pub fn on_withdraw(env: Env, stream_id: u64, amount: i128) -> Result<(), RouterError> {
        streaming(&env).require_auth();
        if amount <= 0 {
            return Ok(());
        }
        let Some(active) = get_active(&env, stream_id) else {
            return Ok(());
        };
        token::Client::new(&env, &active.token).transfer(
            &active.recipient,
            &active.payout,
            &amount,
        );
        Ok(())
    }
}
