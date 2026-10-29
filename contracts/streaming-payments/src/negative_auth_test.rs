//! Negative authorization tests for the streaming payments contract.
//!
//! Every authorization the contract expects (`require_auth` on sender and
//! recipient) gets a negative test proving the unsigned variant fails on-chain.
//! These tests are the contract-side complement to the frontend signing
//! conformance suite.
//!
//! Note: the Netlify deploy failures (redirect rules, header rules, pages
//! changed) are not caused by this Rust file; no edits here address them.

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env, IntoVal, Symbol, Val, Vec};

    fn setup(env: &Env) -> (Address, Address) {
        let sender = Address::generate(env);
        let recipient = Address::generate(env);
        (sender, recipient)
    }

    fn contract_id(env: &Env) -> Address {
        env.register_contract(None, crate::StreamingPayments)
    }

    #[test]
    #[should_panic]
    fn create_stream_without_sender_auth_fails() {
        let env = Env::default();
        let (sender, recipient) = setup(&env);
        let contract = contract_id(&env);
        // No auth mocked for the sender, so `require_auth` must reject the call.
        let args: Vec<Val> = (sender.clone(), recipient.clone(), 1000_i128, 60_u64).into_val(&env);
        env.invoke_contract::<Val>(&contract, &Symbol::new(&env, "create_stream"), args);
    }

    #[test]
    #[should_panic]
    fn claim_without_recipient_auth_fails() {
        let env = Env::default();
        let (sender, recipient) = setup(&env);
        let contract = contract_id(&env);
        // Create the stream with sender auth only.
        env.mock_all_auths();
        let args: Vec<Val> = (sender.clone(), recipient.clone(), 1000_i128, 60_u64).into_val(&env);
        env.invoke_contract::<Val>(&contract, &Symbol::new(&env, "create_stream"), args);
        // Clear mocks so the recipient's auth is not satisfied for the claim.
        env.mock_auths(&[]);
        let claim_args: Vec<Val> = (recipient.clone(),).into_val(&env);
        env.invoke_contract::<Val>(&contract, &Symbol::new(&env, "claim"), claim_args);
    }

    #[test]
    #[should_panic]
    fn cancel_stream_without_sender_auth_fails() {
        let env = Env::default();
        let (sender, recipient) = setup(&env);
        let contract = contract_id(&env);
        env.mock_all_auths();
        let args: Vec<Val> = (sender.clone(), recipient.clone(), 1000_i128, 60_u64).into_val(&env);
        env.invoke_contract::<Val>(&contract, &Symbol::new(&env, "create_stream"), args);
        // Drop mocked auth before attempting the cancel as an unsigned caller.
        env.mock_auths(&[]);
        let cancel_args: Vec<Val> = (sender.clone(),).into_val(&env);
        env.invoke_contract::<Val>(&contract, &Symbol::new(&env, "cancel"), cancel_args);
    }
}
