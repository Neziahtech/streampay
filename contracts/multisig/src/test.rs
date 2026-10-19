#![cfg(test)]

use crate::errors::MultisigError;
use crate::MultisigContract;
use crate::MultisigContractClient;
use soroban_sdk::{
    testutils::Address as _, vec, Address, Env, IntoVal, Symbol, Val, Vec,
};

fn create_signers(env: &Env) -> (Address, Address, Address) {
    (
        Address::generate(env),
        Address::generate(env),
        Address::generate(env),
    )
}

fn setup_multisig(env: &Env, threshold: u32) -> (MultisigContractClient, Address, Address, Address) {
    env.mock_all_auths();
    let (s1, s2, s3) = create_signers(env);
    let contract_id = env.register(MultisigContract, (vec![env, s1.clone(), s2.clone(), s3.clone()], threshold));
    let client = MultisigContractClient::new(env, &contract_id);
    (client, s1, s2, s3)
}

#[test]
fn test_initialization_success() {
    let env = Env::default();
    let (client, s1, s2, s3) = setup_multisig(&env, 2);

    assert_eq!(client.is_multisig(), true);
    assert_eq!(client.get_threshold(), 2);
    let signers = client.get_signers();
    assert_eq!(signers.len(), 3);
    assert!(client.is_signer(&s1));
    assert!(client.is_signer(&s2));
    assert!(client.is_signer(&s3));
    assert_eq!(client.proposal_count(), 0);
}

#[test]
fn test_initialization_validations() {
    let env = Env::default();
    env.mock_all_auths();
    let (s1, s2, _) = create_signers(&env);

    // Empty signers
    let contract_id_empty = env.register(MultisigContract, ());
    let client_empty = MultisigContractClient::new(&env, &contract_id_empty);
    let res = client_empty.try_init(&Vec::new(&env), &1);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::EmptySigners);

    // Invalid threshold: 0
    let res0 = client_empty.try_init(&vec![&env, s1.clone(), s2.clone()], &0);
    assert_eq!(res0.unwrap_err().unwrap(), MultisigError::InvalidThreshold);

    // Invalid threshold: > N
    let res3 = client_empty.try_init(&vec![&env, s1.clone(), s2.clone()], &3);
    assert_eq!(res3.unwrap_err().unwrap(), MultisigError::InvalidThreshold);

    // Duplicate signers
    let res_dup = client_empty.try_init(&vec![&env, s1.clone(), s1.clone()], &1);
    assert_eq!(res_dup.unwrap_err().unwrap(), MultisigError::DuplicateSigner);
}

#[test]
fn test_propose_and_auto_approval() {
    let env = Env::default();
    let (client, s1, _s2, _s3) = setup_multisig(&env, 2);

    let dummy_target = Address::generate(&env);
    let dummy_func = Symbol::new(&env, "dummy");
    let dummy_args: Vec<Val> = Vec::new(&env);

    let pid = client.propose(&s1, &dummy_target, &dummy_func, &dummy_args);
    assert_eq!(pid, 1);
    assert_eq!(client.proposal_count(), 1);

    let proposal = client.get_proposal(&pid);
    assert_eq!(proposal.proposer, s1);
    assert_eq!(proposal.executed, false);
    assert_eq!(proposal.revoked, false);

    // Proposer auto-approved
    let approvals = client.get_approvals(&pid);
    assert_eq!(approvals.len(), 1);
    assert_eq!(approvals.get(0).unwrap(), s1);

    let view = client.get_proposal_view(&pid);
    assert_eq!(view.approval_count, 1);
    assert_eq!(view.threshold, 2);
    assert_eq!(view.is_executable, false);
}

#[test]
fn test_non_signer_cannot_propose() {
    let env = Env::default();
    let (client, _, _, _) = setup_multisig(&env, 2);
    let stranger = Address::generate(&env);

    let dummy_target = Address::generate(&env);
    let dummy_func = Symbol::new(&env, "dummy");
    let dummy_args: Vec<Val> = Vec::new(&env);

    let res = client.try_propose(&stranger, &dummy_target, &dummy_func, &dummy_args);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::NotSigner);
}

#[test]
fn test_duplicate_approval_rejected() {
    let env = Env::default();
    let (client, s1, _s2, _s3) = setup_multisig(&env, 2);

    let dummy_target = Address::generate(&env);
    let dummy_func = Symbol::new(&env, "dummy");
    let dummy_args: Vec<Val> = Vec::new(&env);

    let pid = client.propose(&s1, &dummy_target, &dummy_func, &dummy_args);

    // s1 already approved at propose time, attempting to approve again fails
    let res = client.try_approve(&s1, &pid);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::AlreadyApproved);
}

#[test]
fn test_approval_and_execution_threshold() {
    let env = Env::default();
    let (client, s1, s2, _s3) = setup_multisig(&env, 2);

    let dummy_target = Address::generate(&env);
    let dummy_func = Symbol::new(&env, "dummy");
    let dummy_args: Vec<Val> = Vec::new(&env);

    let pid = client.propose(&s1, &dummy_target, &dummy_func, &dummy_args);

    // At 1 approval, execute must fail
    let res = client.try_execute(&s1, &pid);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::ThresholdNotMet);

    // s2 approves
    client.approve(&s2, &pid);

    let view = client.get_proposal_view(&pid);
    assert_eq!(view.approval_count, 2);
    assert_eq!(view.is_executable, true);
}

#[test]
fn test_revoking_approval() {
    let env = Env::default();
    let (client, s1, s2, _s3) = setup_multisig(&env, 2);

    let dummy_target = Address::generate(&env);
    let dummy_func = Symbol::new(&env, "dummy");
    let dummy_args: Vec<Val> = Vec::new(&env);

    let pid = client.propose(&s1, &dummy_target, &dummy_func, &dummy_args);
    client.approve(&s2, &pid);
    assert_eq!(client.get_proposal_view(&pid).is_executable, true);

    // s2 revokes approval
    client.revoke_approval(&s2, &pid);
    let view = client.get_proposal_view(&pid);
    assert_eq!(view.approval_count, 1);
    assert_eq!(view.is_executable, false);

    // s2 revoking again returns NotApproved
    let res = client.try_revoke_approval(&s2, &pid);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::NotApproved);
}

#[test]
fn test_revoking_proposal() {
    let env = Env::default();
    let (client, s1, s2, _s3) = setup_multisig(&env, 2);

    let dummy_target = Address::generate(&env);
    let dummy_func = Symbol::new(&env, "dummy");
    let dummy_args: Vec<Val> = Vec::new(&env);

    let pid = client.propose(&s1, &dummy_target, &dummy_func, &dummy_args);
    client.approve(&s2, &pid);

    // Revoke the proposal
    client.revoke_proposal(&s1, &pid);

    let proposal = client.get_proposal(&pid);
    assert_eq!(proposal.revoked, true);

    // Cannot approve revoked proposal
    let res_app = client.try_approve(&s2, &pid);
    assert_eq!(res_app.unwrap_err().unwrap(), MultisigError::ProposalRevoked);

    // Cannot execute revoked proposal
    let res_exec = client.try_execute(&s1, &pid);
    assert_eq!(res_exec.unwrap_err().unwrap(), MultisigError::ProposalRevoked);
}

#[test]
fn test_member_set_change_mid_proposal() {
    let env = Env::default();
    let (client, s1, s2, s3) = setup_multisig(&env, 2);

    let dummy_target = Address::generate(&env);
    let dummy_func = Symbol::new(&env, "dummy");
    let dummy_args: Vec<Val> = Vec::new(&env);

    // s1 proposes, s2 approves => 2 approvals: s1 and s2
    let pid = client.propose(&s1, &dummy_target, &dummy_func, &dummy_args);
    client.approve(&s2, &pid);
    assert_eq!(client.get_proposal_view(&pid).is_executable, true);

    // Now s2 is removed from the signer set (via multisig call)
    // Directly invoking governance method requires contract's own auth, which mock_all_auths satisfies
    client.remove_signer(&s2, &Some(2));

    let current_signers = client.get_signers();
    assert_eq!(current_signers.len(), 2);
    assert!(!client.is_signer(&s2));

    // Proposal view reflects that s2's approval is no longer valid!
    let view = client.get_proposal_view(&pid);
    assert_eq!(view.approval_count, 1); // only s1 is a valid active signer
    assert_eq!(view.is_executable, false);

    // Execute must fail with ThresholdNotMet because s2 was removed
    let res = client.try_execute(&s1, &pid);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::ThresholdNotMet);

    // When s3 approves, threshold is satisfied again
    client.approve(&s3, &pid);
    let view2 = client.get_proposal_view(&pid);
    assert_eq!(view2.approval_count, 2); // s1 and s3
    assert_eq!(view2.is_executable, true);
}
