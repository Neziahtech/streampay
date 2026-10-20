#![cfg(test)]

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, Env, Vec as SdkVec,
};

use streampay_contract::{test_client::StreamingPaymentsClient, StreamingPayments};

use crate::{
    types::{
        CancelStreamArgs, CreateStreamArgs, MultisigAction, ProposalStatus, SignerArgs,
        ThresholdArgs, TopUpArgs, TransferTokenArgs, WithdrawArgs,
    },
    MultisigContract, MultisigContractClient, MultisigError,
};

const DAY: u64 = 24 * 60 * 60;
const DEPOSIT: i128 = 10_000_000_000;

struct MultisigFixture {
    env: Env,
    s1: Address,
    s2: Address,
    s3: Address,
    client: MultisigContractClient<'static>,
    contract_id: Address,
}

impl MultisigFixture {
    fn setup_2_of_3() -> Self {
        let mut env = Env::default();
        env.set_config(soroban_sdk::testutils::EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000_000);

        let s1 = Address::generate(&env);
        let s2 = Address::generate(&env);
        let s3 = Address::generate(&env);

        let contract_id = env.register(MultisigContract, ());
        let client = MultisigContractClient::new(&env, &contract_id);

        let signers = vec![&env, s1.clone(), s2.clone(), s3.clone()];
        client.initialize(&signers, &2, &1);

        MultisigFixture {
            env,
            s1,
            s2,
            s3,
            client,
            contract_id,
        }
    }

    fn setup_uninitialized() -> (Env, MultisigContractClient<'static>, Address) {
        let mut env = Env::default();
        env.set_config(soroban_sdk::testutils::EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.mock_all_auths();
        let contract_id = env.register(MultisigContract, ());
        let client = MultisigContractClient::new(&env, &contract_id);
        (env, client, contract_id)
    }

    fn create_token(
        &self,
        admin: &Address,
    ) -> (Address, StellarAssetClient<'static>, TokenClient<'static>) {
        let token_addr = self
            .env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let admin_client = StellarAssetClient::new(&self.env, &token_addr);
        let token_client = TokenClient::new(&self.env, &token_addr);
        (token_addr, admin_client, token_client)
    }
}

// =============================================================================
// Unit Tests: Initialization & Parameters
// =============================================================================

#[test]
fn test_initialize_success() {
    let f = MultisigFixture::setup_2_of_3();
    assert_eq!(f.client.get_threshold(), 2);
    assert_eq!(f.client.get_cancel_threshold(), 1);
    assert_eq!(f.client.get_signers().len(), 3);
    assert!(f.client.is_signer(&f.s1));
    assert!(f.client.is_signer(&f.s2));
    assert!(f.client.is_signer(&f.s3));

    let stranger = Address::generate(&f.env);
    assert!(!f.client.is_signer(&stranger));
}

#[test]
fn test_initialize_already_initialized() {
    let f = MultisigFixture::setup_2_of_3();
    let signers = vec![&f.env, f.s1.clone()];
    let res = f.client.try_initialize(&signers, &1, &1);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::AlreadyInitialized);
}

#[test]
fn test_initialize_invalid_signers_empty() {
    let (env, client, _) = MultisigFixture::setup_uninitialized();
    let signers: SdkVec<Address> = SdkVec::new(&env);
    let res = client.try_initialize(&signers, &1, &1);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::InvalidSigners);
}

#[test]
fn test_initialize_invalid_threshold() {
    let (env, client, _) = MultisigFixture::setup_uninitialized();
    let s1 = Address::generate(&env);
    let signers = vec![&env, s1.clone()];

    // Threshold = 0
    let res = client.try_initialize(&signers, &0, &1);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::InvalidThreshold);

    // Threshold > signers count
    let res = client.try_initialize(&signers, &2, &1);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::InvalidThreshold);
}

#[test]
fn test_initialize_invalid_cancel_threshold() {
    let (env, client, _) = MultisigFixture::setup_uninitialized();
    let s1 = Address::generate(&env);
    let signers = vec![&env, s1.clone()];

    let res = client.try_initialize(&signers, &1, &0);
    assert_eq!(
        res.unwrap_err().unwrap(),
        MultisigError::InvalidCancelThreshold
    );

    let res = client.try_initialize(&signers, &1, &2);
    assert_eq!(
        res.unwrap_err().unwrap(),
        MultisigError::InvalidCancelThreshold
    );
}

#[test]
fn test_initialize_duplicate_signers() {
    let (env, client, _) = MultisigFixture::setup_uninitialized();
    let s1 = Address::generate(&env);
    let signers = vec![&env, s1.clone(), s1.clone()];

    let res = client.try_initialize(&signers, &1, &1);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::DuplicateSigner);
}

// =============================================================================
// Unit Tests: Propose, Approve, Revoke
// =============================================================================

#[test]
fn test_propose_by_signer_auto_approves() {
    let f = MultisigFixture::setup_2_of_3();

    let target = Address::generate(&f.env);
    let action = MultisigAction::CancelStream(CancelStreamArgs {
        contract: target,
        stream_id: 42,
    });

    let prop_id = f.client.mock_all_auths().propose(&f.s1, &action);
    assert_eq!(prop_id, 1);
    assert_eq!(f.client.get_proposal_count(), 1);

    let proposal = f.client.get_proposal(&prop_id).unwrap();
    assert_eq!(proposal.id, 1);
    assert_eq!(proposal.proposer, f.s1);
    assert_eq!(proposal.status, ProposalStatus::Pending);

    let approvals = f.client.get_approvals(&prop_id);
    assert_eq!(approvals.len(), 1);
    assert_eq!(approvals.get(0).unwrap(), f.s1);
}

#[test]
fn test_propose_by_non_signer_fails() {
    let f = MultisigFixture::setup_2_of_3();
    let stranger = Address::generate(&f.env);

    let action = MultisigAction::CancelStream(CancelStreamArgs {
        contract: Address::generate(&f.env),
        stream_id: 1,
    });

    let res = f.client.mock_all_auths().try_propose(&stranger, &action);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::NotSigner);
}

#[test]
fn test_approve_proposal() {
    let f = MultisigFixture::setup_2_of_3();
    let action = MultisigAction::CancelStream(CancelStreamArgs {
        contract: Address::generate(&f.env),
        stream_id: 1,
    });

    let prop_id = f.client.mock_all_auths().propose(&f.s1, &action);
    f.client.mock_all_auths().approve(&f.s2, &prop_id);

    let approvals = f.client.get_approvals(&prop_id);
    assert_eq!(approvals.len(), 2);
    assert_eq!(approvals.get(0).unwrap(), f.s1);
    assert_eq!(approvals.get(1).unwrap(), f.s2);
}

#[test]
fn test_duplicate_approval_rejected() {
    let f = MultisigFixture::setup_2_of_3();
    let action = MultisigAction::CancelStream(CancelStreamArgs {
        contract: Address::generate(&f.env),
        stream_id: 1,
    });

    let prop_id = f.client.mock_all_auths().propose(&f.s1, &action);
    // s1 was already auto-approved on proposal creation
    let res = f.client.mock_all_auths().try_approve(&f.s1, &prop_id);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::AlreadyApproved);

    // s2 approves once
    f.client.mock_all_auths().approve(&f.s2, &prop_id);
    // s2 approves again
    let res = f.client.mock_all_auths().try_approve(&f.s2, &prop_id);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::AlreadyApproved);
}

#[test]
fn test_approve_non_signer_rejected() {
    let f = MultisigFixture::setup_2_of_3();
    let action = MultisigAction::CancelStream(CancelStreamArgs {
        contract: Address::generate(&f.env),
        stream_id: 1,
    });

    let prop_id = f.client.mock_all_auths().propose(&f.s1, &action);
    let stranger = Address::generate(&f.env);

    let res = f.client.mock_all_auths().try_approve(&stranger, &prop_id);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::NotSigner);
}

#[test]
fn test_revoke_approval() {
    let f = MultisigFixture::setup_2_of_3();
    let action = MultisigAction::CancelStream(CancelStreamArgs {
        contract: Address::generate(&f.env),
        stream_id: 1,
    });

    let prop_id = f.client.mock_all_auths().propose(&f.s1, &action);
    f.client.mock_all_auths().approve(&f.s2, &prop_id);

    // Revoke s2's approval
    f.client.mock_all_auths().revoke_approval(&f.s2, &prop_id);
    let approvals = f.client.get_approvals(&prop_id);
    assert_eq!(approvals.len(), 1);
    assert_eq!(approvals.get(0).unwrap(), f.s1);

    // Revoking again fails
    let res = f
        .client
        .mock_all_auths()
        .try_revoke_approval(&f.s2, &prop_id);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::NotApproved);
}

#[test]
fn test_revoke_proposal_by_proposer() {
    let f = MultisigFixture::setup_2_of_3();
    let action = MultisigAction::CancelStream(CancelStreamArgs {
        contract: Address::generate(&f.env),
        stream_id: 1,
    });

    let prop_id = f.client.mock_all_auths().propose(&f.s1, &action);

    // Stranger or other signer cannot revoke proposer's proposal
    let res = f
        .client
        .mock_all_auths()
        .try_revoke_proposal(&f.s2, &prop_id);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::Unauthorized);

    // Proposer revokes successfully
    f.client.mock_all_auths().revoke_proposal(&f.s1, &prop_id);
    let proposal = f.client.get_proposal(&prop_id).unwrap();
    assert_eq!(proposal.status, ProposalStatus::Revoked);

    // Cannot approve or execute a revoked proposal
    let res = f.client.mock_all_auths().try_approve(&f.s2, &prop_id);
    assert_eq!(
        res.unwrap_err().unwrap(),
        MultisigError::ProposalAlreadyExecuted
    );

    let res = f.client.mock_all_auths().try_execute(&f.s1, &prop_id);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::ProposalRevoked);
}

// =============================================================================
// Edge Cases: Threshold, Member Set Changes Mid-Proposal
// =============================================================================

#[test]
fn test_execute_below_threshold_reverts() {
    let f = MultisigFixture::setup_2_of_3();
    let action = MultisigAction::CancelStream(CancelStreamArgs {
        contract: Address::generate(&f.env),
        stream_id: 1,
    });

    // Only 1 approval (s1) but threshold is 2
    let prop_id = f.client.mock_all_auths().propose(&f.s1, &action);
    let res = f.client.mock_all_auths().try_execute(&f.s1, &prop_id);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::ThresholdNotMet);
}

#[test]
fn test_member_set_change_mid_proposal_invalidates_removed_signer_approval() {
    let f = MultisigFixture::setup_2_of_3();

    // Proposal 1: An action to remove signer s2
    let remove_s2 = MultisigAction::RemoveSigner(SignerArgs {
        signer: f.s2.clone(),
    });
    let p_remove = f.client.mock_all_auths().propose(&f.s1, &remove_s2);
    f.client.mock_all_auths().approve(&f.s3, &p_remove);
    // (threshold is 2: s1 + s3 >= 2) -> execute remove_s2!
    f.client.mock_all_auths().execute(&f.s1, &p_remove);
    assert_eq!(f.client.get_signers().len(), 2);
    assert!(!f.client.is_signer(&f.s2));

    // Now consider Proposal 2 created while s2 was being removed, or imagine:
    // Let's create Proposal 3 and have s1 and a new signer approve
    let new_signer = Address::generate(&f.env);
    let add_new = MultisigAction::AddSigner(SignerArgs {
        signer: new_signer.clone(),
    });
    let p_add = f.client.mock_all_auths().propose(&f.s1, &add_new);
    f.client.mock_all_auths().approve(&f.s3, &p_add);
    f.client.mock_all_auths().execute(&f.s1, &p_add);
    assert_eq!(f.client.get_signers().len(), 3);
    assert!(f.client.is_signer(&new_signer));

    // Now test mid-proposal removal:
    // Proposal 4: action X proposed by s1, approved by new_signer
    let action_x = MultisigAction::SetCancelThreshold(ThresholdArgs { new_threshold: 2 });
    let p_x = f.client.mock_all_auths().propose(&f.s1, &action_x);
    f.client.mock_all_auths().approve(&new_signer, &p_x);
    // At this point p_x has approvals [s1, new_signer] (2 approvals).
    // Now remove new_signer via another proposal!
    let remove_new = MultisigAction::RemoveSigner(SignerArgs {
        signer: new_signer.clone(),
    });
    let p_rem_new = f.client.mock_all_auths().propose(&f.s1, &remove_new);
    f.client.mock_all_auths().approve(&f.s3, &p_rem_new);
    f.client.mock_all_auths().execute(&f.s1, &p_rem_new);

    // new_signer is now removed!
    assert!(!f.client.is_signer(&new_signer));

    // Now try to execute p_x!
    // Although p_x has 2 approvals recorded ([s1, new_signer]), new_signer is NO LONGER active!
    // Therefore, only 1 valid approval remains (s1 < threshold 2).
    let res = f.client.mock_all_auths().try_execute(&f.s1, &p_x);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::ThresholdNotMet);

    // Once the active signer s3 approves p_x, it can execute!
    f.client.mock_all_auths().approve(&f.s3, &p_x);
    f.client.mock_all_auths().execute(&f.s1, &p_x);
    assert_eq!(f.client.get_cancel_threshold(), 2);
}

#[test]
fn test_signer_management_guards() {
    let f = MultisigFixture::setup_2_of_3();

    // Adding an existing signer fails
    let add_dup = MultisigAction::AddSigner(SignerArgs {
        signer: f.s1.clone(),
    });
    let p1 = f.client.mock_all_auths().propose(&f.s1, &add_dup);
    f.client.mock_all_auths().approve(&f.s2, &p1);
    let res = f.client.mock_all_auths().try_execute(&f.s1, &p1);
    assert_eq!(
        res.unwrap_err().unwrap(),
        MultisigError::SignerAlreadyExists
    );

    // Removing a non-existent signer fails
    let rem_fake = MultisigAction::RemoveSigner(SignerArgs {
        signer: Address::generate(&f.env),
    });
    let p2 = f.client.mock_all_auths().propose(&f.s1, &rem_fake);
    f.client.mock_all_auths().approve(&f.s2, &p2);
    let res = f.client.mock_all_auths().try_execute(&f.s1, &p2);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::SignerNotFound);

    // Removing signer when remaining count < threshold fails
    // Current: 3 signers, threshold: 2.
    // If threshold is 3:
    let set_th = MultisigAction::SetThreshold(ThresholdArgs { new_threshold: 3 });
    let p3 = f.client.mock_all_auths().propose(&f.s1, &set_th);
    f.client.mock_all_auths().approve(&f.s2, &p3);
    f.client.mock_all_auths().execute(&f.s1, &p3);
    assert_eq!(f.client.get_threshold(), 3);

    // Now trying to remove s3 (3 signers - 1 = 2 < threshold 3) must fail
    let rem_s3 = MultisigAction::RemoveSigner(SignerArgs {
        signer: f.s3.clone(),
    });
    let p4 = f.client.mock_all_auths().propose(&f.s1, &rem_s3);
    f.client.mock_all_auths().approve(&f.s2, &p4);
    f.client.mock_all_auths().approve(&f.s3, &p4);
    let res = f.client.mock_all_auths().try_execute(&f.s1, &p4);
    assert_eq!(
        res.unwrap_err().unwrap(),
        MultisigError::CannotRemoveBelowThreshold
    );
}

// =============================================================================
// Token Transfer Proposal Execution
// =============================================================================

#[test]
fn test_token_transfer_proposal() {
    let f = MultisigFixture::setup_2_of_3();
    let token_admin = Address::generate(&f.env);
    let (token_addr, admin_client, token_client) = f.create_token(&token_admin);

    // Mint funds to multisig contract
    admin_client.mint(&f.contract_id, &50_000);
    assert_eq!(token_client.balance(&f.contract_id), 50_000);

    let destination = Address::generate(&f.env);
    let transfer_action = MultisigAction::TransferToken(TransferTokenArgs {
        token: token_addr,
        to: destination.clone(),
        amount: 20_000,
    });

    let p = f.client.mock_all_auths().propose(&f.s1, &transfer_action);
    f.client.mock_all_auths().approve(&f.s2, &p);
    f.client.mock_all_auths().execute(&f.s1, &p);

    assert_eq!(token_client.balance(&destination), 20_000);
    assert_eq!(token_client.balance(&f.contract_id), 30_000);
}

// =============================================================================
// Integration Tests: Multisig Stream Lifecycle (Create, Top-Up, Cancel, Withdraw)
// =============================================================================

struct IntegrationHarness {
    f: MultisigFixture,
    stream_contract: Address,
    stream_client: StreamingPaymentsClient<'static>,
    token_addr: Address,
    token_client: TokenClient<'static>,
    admin_client: StellarAssetClient<'static>,
}

impl IntegrationHarness {
    fn setup() -> Self {
        let f = MultisigFixture::setup_2_of_3();

        let governor = Address::generate(&f.env);
        let stream_contract = f.env.register(StreamingPayments, (governor.clone(),));
        let stream_client = StreamingPaymentsClient::new(&f.env, &stream_contract);

        let token_admin = Address::generate(&f.env);
        let (token_addr, admin_client, token_client) = f.create_token(&token_admin);

        // Fund multisig contract with tokens
        admin_client.mint(&f.contract_id, &100_000_000_000);

        IntegrationHarness {
            f,
            stream_contract,
            stream_client,
            token_addr,
            token_client,
            admin_client,
        }
    }
}

#[test]
fn test_integration_multisig_creates_stream_and_single_signer_emergency_cancels() {
    let h = IntegrationHarness::setup();
    let recipient = Address::generate(&h.f.env);
    let now = h.f.env.ledger().timestamp();

    // 1. 2-of-3 multisig proposes and executes stream creation
    let create_action = MultisigAction::CreateStream(CreateStreamArgs {
        contract: h.stream_contract.clone(),
        recipient: recipient.clone(),
        token: h.token_addr.clone(),
        deposit: DEPOSIT,
        start_time: now,
        end_time: now + 10 * DAY,
        cancellable: true,
    });

    let p_create = h.f.client.mock_all_auths().propose(&h.f.s1, &create_action);
    h.f.client.mock_all_auths().approve(&h.f.s2, &p_create);
    h.f.client.mock_all_auths().execute(&h.f.s1, &p_create);

    let stream_id = 1u64;
    let stream = h.stream_client.get_stream(&stream_id);
    assert_eq!(stream.sender, h.f.contract_id);
    assert_eq!(stream.recipient, recipient);
    assert_eq!(stream.deposit, DEPOSIT);

    // 2. Advance time mid-stream (3 days)
    h.f.env.ledger().set_timestamp(now + 3 * DAY);

    // 3. Single signer emergency cancels stream (cancel_threshold is 1)
    let multisig_bal_before = h.token_client.balance(&h.f.contract_id);
    let recipient_bal_before = h.token_client.balance(&recipient);

    h.f.client
        .mock_all_auths()
        .cancel_stream_immediate(&h.f.s3, &h.stream_contract, &stream_id);

    let stream = h.stream_client.get_stream(&stream_id);
    assert_eq!(stream.status, streampay_contract::StreamStatus::Cancelled);

    // Recipient received 3 days of accrued funds
    let recipient_bal_after = h.token_client.balance(&recipient);
    assert!(recipient_bal_after > recipient_bal_before);

    // Multisig received unaccrued refund (7 days)
    let multisig_bal_after = h.token_client.balance(&h.f.contract_id);
    assert!(multisig_bal_after > multisig_bal_before);
}

#[test]
fn test_integration_multisig_top_up() {
    let h = IntegrationHarness::setup();
    let recipient = Address::generate(&h.f.env);
    let now = h.f.env.ledger().timestamp();

    let create_action = MultisigAction::CreateStream(CreateStreamArgs {
        contract: h.stream_contract.clone(),
        recipient: recipient.clone(),
        token: h.token_addr.clone(),
        deposit: DEPOSIT,
        start_time: now,
        end_time: now + 10 * DAY,
        cancellable: true,
    });

    let p_create = h.f.client.mock_all_auths().propose(&h.f.s1, &create_action);
    h.f.client.mock_all_auths().approve(&h.f.s2, &p_create);
    h.f.client.mock_all_auths().execute(&h.f.s1, &p_create);

    let stream_id = 1u64;

    // Top up stream by 5_000_000_000
    let top_up_amount = 5_000_000_000i128;
    let top_up_action = MultisigAction::TopUp(TopUpArgs {
        contract: h.stream_contract.clone(),
        token: h.token_addr.clone(),
        stream_id,
        amount: top_up_amount,
    });

    let p_top_up = h.f.client.mock_all_auths().propose(&h.f.s1, &top_up_action);
    h.f.client.mock_all_auths().approve(&h.f.s3, &p_top_up);
    h.f.client.mock_all_auths().execute(&h.f.s1, &p_top_up);

    let stream = h.stream_client.get_stream(&stream_id);
    assert_eq!(stream.deposit, DEPOSIT + top_up_amount);
}

#[test]
fn test_integration_multisig_as_recipient_withdraws() {
    let h = IntegrationHarness::setup();
    let individual_sender = Address::generate(&h.f.env);
    let now = h.f.env.ledger().timestamp();

    // Mint funds to individual sender and approve streaming contract
    h.admin_client.mint(&individual_sender, &DEPOSIT);
    h.admin_client.approve(
        &individual_sender,
        &h.stream_contract,
        &DEPOSIT,
        &1_000_000u32,
    );

    // Individual creates a stream paying the multisig contract!
    let stream_id = h.stream_client.mock_all_auths().create_stream(
        &individual_sender,
        &h.f.contract_id,
        &h.token_addr,
        &DEPOSIT,
        &now,
        &(now + 10 * DAY),
        &true,
    );

    // Advance 5 days: half of deposit accrued
    h.f.env.ledger().set_timestamp(now + 5 * DAY);

    let multisig_bal_before = h.token_client.balance(&h.f.contract_id);

    // Multisig proposes and executes withdraw
    let withdraw_amount = 4_000_000_000i128;
    let withdraw_action = MultisigAction::Withdraw(WithdrawArgs {
        contract: h.stream_contract.clone(),
        stream_id,
        amount: withdraw_amount,
    });

    let p_with =
        h.f.client
            .mock_all_auths()
            .propose(&h.f.s1, &withdraw_action);
    h.f.client.mock_all_auths().approve(&h.f.s2, &p_with);
    h.f.client.mock_all_auths().execute(&h.f.s1, &p_with);

    let multisig_bal_after = h.token_client.balance(&h.f.contract_id);
    assert_eq!(multisig_bal_after - multisig_bal_before, withdraw_amount);
}

#[test]
fn test_uninitialized_calls_fail() {
    let (_, client, _) = MultisigFixture::setup_uninitialized();
    let action = MultisigAction::CancelStream(CancelStreamArgs {
        contract: Address::generate(&client.env),
        stream_id: 1,
    });
    let caller = Address::generate(&client.env);

    let res = client.mock_all_auths().try_propose(&caller, &action);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::NotInitialized);

    let res = client.mock_all_auths().try_approve(&caller, &1);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::NotInitialized);

    let res = client.mock_all_auths().try_execute(&caller, &1);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::NotInitialized);

    let res = client.mock_all_auths().try_revoke_approval(&caller, &1);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::NotInitialized);

    let res = client.mock_all_auths().try_revoke_proposal(&caller, &1);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::NotInitialized);

    let res = client
        .mock_all_auths()
        .try_cancel_stream_immediate(&caller, &caller, &1);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::NotInitialized);
}

#[test]
fn test_proposal_validation_errors() {
    let f = MultisigFixture::setup_2_of_3();

    // Invalid create stream deposit <= 0
    let res = f.client.mock_all_auths().try_propose(
        &f.s1,
        &MultisigAction::CreateStream(CreateStreamArgs {
            contract: Address::generate(&f.env),
            recipient: Address::generate(&f.env),
            token: Address::generate(&f.env),
            deposit: 0,
            start_time: 100,
            end_time: 200,
            cancellable: true,
        }),
    );
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::InvalidAmount);

    // Invalid create stream end_time <= start_time
    let res = f.client.mock_all_auths().try_propose(
        &f.s1,
        &MultisigAction::CreateStream(CreateStreamArgs {
            contract: Address::generate(&f.env),
            recipient: Address::generate(&f.env),
            token: Address::generate(&f.env),
            deposit: 1000,
            start_time: 200,
            end_time: 100,
            cancellable: true,
        }),
    );
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::InvalidAmount);

    // Invalid top up amount
    let res = f.client.mock_all_auths().try_propose(
        &f.s1,
        &MultisigAction::TopUp(TopUpArgs {
            contract: Address::generate(&f.env),
            token: Address::generate(&f.env),
            stream_id: 1,
            amount: 0,
        }),
    );
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::InvalidAmount);

    // Invalid withdraw amount
    let res = f.client.mock_all_auths().try_propose(
        &f.s1,
        &MultisigAction::Withdraw(WithdrawArgs {
            contract: Address::generate(&f.env),
            stream_id: 1,
            amount: 0,
        }),
    );
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::InvalidAmount);

    // Invalid transfer token amount
    let res = f.client.mock_all_auths().try_propose(
        &f.s1,
        &MultisigAction::TransferToken(TransferTokenArgs {
            token: Address::generate(&f.env),
            to: Address::generate(&f.env),
            amount: 0,
        }),
    );
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::InvalidAmount);

    // Invalid threshold 0
    let res = f.client.mock_all_auths().try_propose(
        &f.s1,
        &MultisigAction::SetThreshold(ThresholdArgs { new_threshold: 0 }),
    );
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::InvalidThreshold);

    // Invalid cancel threshold 0
    let res = f.client.mock_all_auths().try_propose(
        &f.s1,
        &MultisigAction::SetCancelThreshold(ThresholdArgs { new_threshold: 0 }),
    );
    assert_eq!(
        res.unwrap_err().unwrap(),
        MultisigError::InvalidCancelThreshold
    );
}

#[test]
fn test_proposal_not_found_errors() {
    let f = MultisigFixture::setup_2_of_3();

    let res = f.client.mock_all_auths().try_approve(&f.s1, &999);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::ProposalNotFound);

    let res = f.client.mock_all_auths().try_revoke_approval(&f.s1, &999);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::ProposalNotFound);

    let res = f.client.mock_all_auths().try_revoke_proposal(&f.s1, &999);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::ProposalNotFound);

    let res = f.client.mock_all_auths().try_execute(&f.s1, &999);
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::ProposalNotFound);
}

#[test]
fn test_cannot_execute_already_executed_proposal() {
    let f = MultisigFixture::setup_2_of_3();
    let action = MultisigAction::CancelStream(CancelStreamArgs {
        contract: Address::generate(&f.env),
        stream_id: 1,
    });
    let p = f.client.mock_all_auths().propose(&f.s1, &action);
    f.client.mock_all_auths().approve(&f.s2, &p);

    // CancelStream to a fake contract will fail during dispatch_action or succeed?
    // Let's use SetThreshold or SetCancelThreshold which execute cleanly internal state!
    let action_th = MultisigAction::SetCancelThreshold(ThresholdArgs { new_threshold: 2 });
    let p_th = f.client.mock_all_auths().propose(&f.s1, &action_th);
    f.client.mock_all_auths().approve(&f.s2, &p_th);
    f.client.mock_all_auths().execute(&f.s1, &p_th);

    // Second execution must fail
    let res = f.client.mock_all_auths().try_execute(&f.s1, &p_th);
    assert_eq!(
        res.unwrap_err().unwrap(),
        MultisigError::ProposalAlreadyExecuted
    );
}

#[test]
fn test_emergency_cancel_threshold_guard() {
    let f = MultisigFixture::setup_2_of_3();
    // First set cancel threshold to 2
    let action_th = MultisigAction::SetCancelThreshold(ThresholdArgs { new_threshold: 2 });
    let p = f.client.mock_all_auths().propose(&f.s1, &action_th);
    f.client.mock_all_auths().approve(&f.s2, &p);
    f.client.mock_all_auths().execute(&f.s1, &p);
    assert_eq!(f.client.get_cancel_threshold(), 2);

    // Now immediate single-signer cancel must fail with CancelThresholdNotMet
    let res = f.client.mock_all_auths().try_cancel_stream_immediate(
        &f.s1,
        &Address::generate(&f.env),
        &1,
    );
    assert_eq!(
        res.unwrap_err().unwrap(),
        MultisigError::CancelThresholdNotMet
    );

    // Non-signer immediate cancel must fail with NotSigner
    let stranger = Address::generate(&f.env);
    let res = f.client.mock_all_auths().try_cancel_stream_immediate(
        &stranger,
        &Address::generate(&f.env),
        &1,
    );
    assert_eq!(res.unwrap_err().unwrap(), MultisigError::NotSigner);
}
