//! Negative authorization tests for the streaming payments contract.
//!
/// Every authorization the contract expects (`require_auth` on sender and
/// recipient) gets a negative test proving the unsigned variant fails on-chain.
/// These tests are the contract-side complement to the frontend signing
/// conformance suite.

#[!cfg(test)]
mod tests {
    use soroban_sdk::{Address, Env, InvokeError, Symbol, Val};
    use super::*;

    fn address(env: &Env, byte: u8) -> Address {
        Address::from_contract(env.register(Symbol::new(env, "address"), &byte))
    }

    fn setup(env: &Env) -> (Address, Address) {
        let sender = address(env, 1);
        let recipient = address(env, 2);
        (sender, recipient)
    }

    fn contract_id(env: &Env) -> Address {
        // The contract is registered under the crate name in the test environment.
        env.register(Symbol::new(env, "contract"), &0)
    }

    #[test]
    fn create_stream_without_sender_auth_fails() {
        let env = Env::default();
        let (sender, recipient) = setup(&env);
        // No auth entry for the sender is provided, so the contract must reject
        // the call at the `require_auth` boundary.
        let result = env.try_invoke_contract(
            &contract_id(&env),
            &Symbol::new(&env, "create_stream"),
            &soroban_sdk:vec![&env, [
                Val::from(sender.clone()),
                Val::from(recipient.clone()),
                Val::from(1000_i64),
                Val::from(60_u64),
            ]],
        );
        assert!(result.is_error(), "create_stream without sender auth must fail");
        matches!(result.unwrap_err(), InvokeError::Auth(error) => error.is_auth_failure());
    }

    #t[test]
    fn claim_without_recipient_auth_fails() {
        let env = Env::default();
        let (sender, recipient) = setup(&env);
        // Sender auth is provided for stream creation, but no recipient auth
        // is provided for the claim. The contract must reject the claim.
        env.mock_all_auths();
        let contract = contract_id(&env);
        env.invoke_contract(
            &contract,
            &Symbol::new(&env, "create_stream"),
            &soroban_sdk:vec![&env, [
                Val::from(sender.clone()),
                Val::from(recipient.clone()),
                Val::from(1000_i64),
                Val::from(60_u64),
            ]],
        );
        // Now attempt the claim without recipient auth.
        let result = env.try_invoke_contract(
            &contract,
            &Symbol::new(&env, "claim"),
            &soroban_sdk:vec![&env, [Val::from(recipient.clone())]],
        );
        assert!(result.is_error(), "claim without recipient auth must fail");
        matches!(result.unwrap_err(), InvokeError::Auth(error) => error.is_auth_failure());
    }

    #[test]
    fn cancel_stream_without_sender_auth_fails() {
        let env = Env::default();
        let (sender, recipient) = setup(&env);
        env.mock_all_auths();
        let contract = contract_id(&env);
        env.invoke_contract(
            &contract,
            &Symbol::new(&env, "create_stream"),
            &soroban_sdk::vec![&env, [
                Val::from(sender.clone()),
                Val::from(recipient.clone()),
                Val::from(1000_i64),
                Val::from(60_u64),
            ]],
        );
        // Cancel without sender auth.
        let result = env.try_invoke_contract(
            &contract,
            &Symbol::new(&env, "cancel"),
            &soroban_sdk:vec![&env, [Val::from(sender.clone())]],
        );
        assert!(result.is_error(), "cancel without sender auth must fail");
        matches!(result.unwrap_err(), InvokeError::Auth(error) => error.is_auth_failure());
    }
}
