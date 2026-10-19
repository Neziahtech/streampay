#![cfg(test)]

use crate::MultisigContract;
use crate::MultisigContractClient;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::StellarAssetClient,
    vec, Address, Env, IntoVal, Symbol, Val, Vec,
};
use streampay_contract::{
    StreamingPayments, StreamingPaymentsClient, StreamStatus,
};

fn setup_multisig(env: &Env, threshold: u32) -> (MultisigContractClient, Address, Address, Address) {
    let s1 = Address::generate(env);
    let s2 = Address::generate(env);
    let s3 = Address::generate(env);
    let contract_id = env.register(
        MultisigContract,
        (vec![env, s1.clone(), s2.clone(), s3.clone()], threshold),
    );
    let client = MultisigContractClient::new(env, &contract_id);
    (client, s1, s2, s3)
}

#[test]
fn test_multisig_stream_lifecycle_integration() {
    let env = Env::default();
    env.mock_all_auths();

    // 1. Setup Stellar Asset Contract token
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let token = sac.address();
    let token_client = StellarAssetClient::new(&env, &token);

    // 2. Setup StreamingPayments contract
    let governor = Address::generate(&env);
    let streaming_id = env.register(StreamingPayments, (governor,));
    let streaming_client = StreamingPaymentsClient::new(&env, &streaming_id);

    // 3. Setup 2-of-3 Multisig as sender
    let (multisig_client, signer_a, signer_b, signer_c) = setup_multisig(&env, 2);
    let multisig_addr = multisig_client.address.clone();
    let recipient = Address::generate(&env);

    let initial_deposit: i128 = 10_000;
    token_client.mint(&multisig_addr, &initial_deposit);
    assert_eq!(token_client.balance(&multisig_addr), initial_deposit);

    // 4. Multisig approves StreamingPayments contract as spender
    let approve_args: Vec<Val> = vec![
        &env,
        multisig_addr.clone().into_val(&env),
        streaming_id.clone().into_val(&env),
        initial_deposit.into_val(&env),
        100_000u32.into_val(&env),
    ];
    let pid_approve = multisig_client.propose(
        &signer_a,
        &token,
        &Symbol::new(&env, "approve"),
        &approve_args,
    );
    multisig_client.approve(&signer_b, &pid_approve);
    multisig_client.execute(&signer_a, &pid_approve);

    // 5. Multisig creates a payment stream: 1,000 units over 100 seconds
    let now = 1_000u64;
    env.ledger().set_timestamp(now);
    let start_time = now;
    let end_time = now + 100;
    let stream_deposit: i128 = 1_000;

    let create_args: Vec<Val> = vec![
        &env,
        multisig_addr.clone().into_val(&env),
        recipient.clone().into_val(&env),
        token.clone().into_val(&env),
        stream_deposit.into_val(&env),
        start_time.into_val(&env),
        end_time.into_val(&env),
        true.into_val(&env), // cancelable
    ];

    let pid_stream = multisig_client.propose(
        &signer_a,
        &streaming_id,
        &Symbol::new(&env, "create_stream"),
        &create_args,
    );
    multisig_client.approve(&signer_b, &pid_stream);
    let stream_id_val = multisig_client.execute(&signer_a, &pid_stream);
    let stream_id: u64 = stream_id_val.into_val(&env);

    assert_eq!(stream_id, 1);
    let stream = streaming_client.get_stream(&stream_id);
    assert_eq!(stream.sender, multisig_addr);
    assert_eq!(stream.recipient, recipient);
    assert_eq!(stream.deposit, stream_deposit);
    assert_eq!(stream.status, StreamStatus::Active);

    // Balance after deposit: 10,000 - 1,000 = 9,000
    assert_eq!(token_client.balance(&multisig_addr), 9_000);

    // 6. Fast forward halfway through the stream: 50 seconds elapsed
    env.ledger().set_timestamp(now + 50);

    // 7. Verify a single signer cannot cancel directly without multisig threshold
    // Signer A calling StreamingPayments directly with their own address must fail
    let direct_cancel_res = streaming_client.try_cancel_stream(&signer_a, &stream_id);
    assert!(direct_cancel_res.is_err());

    // 8. Cancellation through 2-of-3 Multisig
    let cancel_args: Vec<Val> = vec![
        &env,
        multisig_addr.clone().into_val(&env),
        stream_id.into_val(&env),
    ];
    let pid_cancel = multisig_client.propose(
        &signer_a,
        &streaming_id,
        &Symbol::new(&env, "cancel_stream"),
        &cancel_args,
    );
    // Signer C approves (signer A + signer C reaches threshold 2)
    multisig_client.approve(&signer_c, &pid_cancel);
    multisig_client.execute(&signer_c, &pid_cancel);

    let cancelled_stream = streaming_client.get_stream(&stream_id);
    assert_eq!(cancelled_stream.status, StreamStatus::Cancelled);

    // Pro-rata split: 50 seconds out of 100 seconds = 500 units accrued
    // Recipient receives 500 units, Multisig sender refunded 500 units
    assert_eq!(token_client.balance(&recipient), 500);
    assert_eq!(token_client.balance(&multisig_addr), 9_500);
}

#[test]
fn test_withdraw_to_multisig_recipient_integration() {
    let env = Env::default();
    env.mock_all_auths();

    // 1. Setup SAC token
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let token = sac.address();
    let token_client = StellarAssetClient::new(&env, &token);

    // 2. Setup StreamingPayments contract
    let governor = Address::generate(&env);
    let streaming_id = env.register(StreamingPayments, (governor,));
    let streaming_client = StreamingPaymentsClient::new(&env, &streaming_id);

    // 3. Setup 2-of-3 Multisig as RECIPIENT
    let (multisig_recipient, signer_a, signer_b, _signer_c) = setup_multisig(&env, 2);
    let recipient_multisig_addr = multisig_recipient.address.clone();

    // 4. Regular sender funds and creates stream to multisig recipient
    let sender = Address::generate(&env);
    token_client.mint(&sender, &2_000);
    token_client.approve(&sender, &streaming_id, &2_000, &100_000);

    let now = 5_000u64;
    env.ledger().set_timestamp(now);

    let stream_id = streaming_client.create_stream(
        &sender,
        &recipient_multisig_addr,
        &token,
        &2_000,
        &now,
        &(now + 100),
        &false,
    );

    // Advance 75 seconds (75% accrued = 1,500 units)
    env.ledger().set_timestamp(now + 75);

    // 5. Multisig recipient proposes withdraw_max
    let withdraw_args: Vec<Val> = vec![&env, stream_id.into_val(&env)];
    let pid_withdraw = multisig_recipient.propose(
        &signer_a,
        &streaming_id,
        &Symbol::new(&env, "withdraw_max"),
        &withdraw_args,
    );

    multisig_recipient.approve(&signer_b, &pid_withdraw);
    multisig_recipient.execute(&signer_a, &pid_withdraw);

    // Tokens were paid directly into multisig recipient address!
    assert_eq!(token_client.balance(&recipient_multisig_addr), 1_500);
}
