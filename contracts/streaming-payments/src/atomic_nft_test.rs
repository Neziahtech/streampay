//! Tests for atomic stream + NFT mint linkage (issue #575).
//!
//! A hostile mock NFT stands in for the companion contract so the failure
//! classes the issue calls out — mint panics, mint returns an error, mint
//! reenters the core contract — are exercised directly. In every failure
//! case the assertions are the no-orphan invariants: no stream record, no
//! link, no NFT minted, the deposit fully back with the sender (token
//! conservation), and the stream id not consumed.
#![cfg(test)]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, testutils::Events as _,
    Address, Env, Event as _, IntoVal, InvokeError, Symbol, Val, Vec as SdkVec,
};

use crate::test::Fixture;
use crate::{StreamError, StreamNftMinted, MIN_STREAM_DEPOSIT};

const DAY: u64 = 24 * 60 * 60;
const DEPOSIT: i128 = 10_000_000_000;

// ---------------------------------------------------------------- mock NFT --

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum MockNftError {
    MintRefused = 1,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum MockKey {
    Bound,
    Mode,
    Core,
    Sender,
    Token,
    MintedTo,
    ReentryBlocked,
}

/// Behaviour modes for the mock's `mint_linked`.
pub(crate) const MODE_OK: u32 = 0;
pub(crate) const MODE_PANIC: u32 = 1;
pub(crate) const MODE_ERROR: u32 = 2;
pub(crate) const MODE_REENTER: u32 = 3;

#[contract]
pub struct MockNft;

#[contractimpl]
impl MockNft {
    pub fn __constructor(
        env: Env,
        bound: u64,
        mode: u32,
        core: Address,
        sender: Address,
        token: Address,
    ) {
        env.storage().instance().set(&MockKey::Bound, &bound);
        env.storage().instance().set(&MockKey::Mode, &mode);
        env.storage().instance().set(&MockKey::Core, &core);
        env.storage().instance().set(&MockKey::Sender, &sender);
        env.storage().instance().set(&MockKey::Token, &token);
        env.storage()
            .instance()
            .set(&MockKey::ReentryBlocked, &false);
    }

    pub fn stream_id(env: Env) -> u64 {
        env.storage().instance().get(&MockKey::Bound).unwrap()
    }

    pub fn mint_linked(env: Env, recipient: Address, _stream_id: u64) -> Result<(), MockNftError> {
        let mode: u32 = env.storage().instance().get(&MockKey::Mode).unwrap();
        match mode {
            MODE_PANIC => panic!("hostile NFT: mint panics"),
            MODE_ERROR => Err(MockNftError::MintRefused),
            MODE_REENTER => {
                // Hostile: try to start a second atomic creation from
                // inside the mint. The core's in-flight lock must refuse
                // it; record whether it did, then mint normally.
                let core: Address = env.storage().instance().get(&MockKey::Core).unwrap();
                let sender: Address = env.storage().instance().get(&MockKey::Sender).unwrap();
                let token: Address = env.storage().instance().get(&MockKey::Token).unwrap();
                let now = env.ledger().timestamp();
                let mut args: SdkVec<Val> = SdkVec::new(&env);
                args.push_back(sender.into_val(&env));
                args.push_back(recipient.clone().into_val(&env));
                args.push_back(token.into_val(&env));
                args.push_back(1_000i128.into_val(&env));
                args.push_back(now.into_val(&env));
                args.push_back((now + DAY).into_val(&env));
                args.push_back(false.into_val(&env));
                args.push_back(env.current_contract_address().into_val(&env));
                let res = env.try_invoke_contract::<Val, InvokeError>(
                    &core,
                    &Symbol::new(&env, "create_stream_with_nft"),
                    args,
                );
                let blocked = !matches!(res, Ok(Ok(_)));
                env.storage()
                    .instance()
                    .set(&MockKey::ReentryBlocked, &blocked);
                env.storage()
                    .persistent()
                    .set(&MockKey::MintedTo, &recipient);
                Ok(())
            }
            _ => {
                env.storage()
                    .persistent()
                    .set(&MockKey::MintedTo, &recipient);
                Ok(())
            }
        }
    }

    pub fn minted_to(env: Env) -> Option<Address> {
        env.storage().persistent().get(&MockKey::MintedTo)
    }

    pub fn reentry_blocked(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&MockKey::ReentryBlocked)
            .unwrap_or(false)
    }
}

#[contractclient(name = "MockNftTestClient")]
#[allow(dead_code)]
pub trait MockNftApi {
    fn stream_id(env: Env) -> u64;
    fn mint_linked(env: Env, recipient: Address, stream_id: u64) -> Result<(), MockNftError>;
    fn minted_to(env: Env) -> Option<Address>;
    fn reentry_blocked(env: Env) -> bool;
}

// ------------------------------------------------------------------ helpers --

fn register_mock(f: &Fixture, bound: u64, mode: u32) -> (Address, MockNftTestClient<'static>) {
    let addr = f.env.register(
        MockNft,
        (
            bound,
            mode,
            f.client.address.clone(),
            f.sender.clone(),
            f.token.clone(),
        ),
    );
    let client = MockNftTestClient::new(&f.env, &addr);
    (addr, client)
}

fn try_create_with_nft(f: &Fixture, nft: &Address, deposit: i128) -> Result<u64, StreamError> {
    let now = f.env.ledger().timestamp();
    match f.client.mock_all_auths().try_create_stream_with_nft(
        &f.sender,
        &f.recipient,
        &f.token,
        &deposit,
        &now,
        &(now + 10 * DAY),
        &true,
        nft,
    ) {
        Ok(Ok(id)) => Ok(id),
        Err(Ok(e)) => Err(e),
        _ => panic!("create_stream_with_nft invocation failed at the host level"),
    }
}

fn token_balance(f: &Fixture, who: &Address) -> i128 {
    soroban_sdk::token::Client::new(&f.env, &f.token).balance(who)
}

fn assert_no_orphans(f: &Fixture, mock: &MockNftTestClient) {
    // No stream record and no link were committed.
    assert!(f.client.try_get_stream(&1).is_err());
    assert_eq!(f.client.stream_nft_link(&1), None);
    // The mock never kept a mint.
    assert_eq!(mock.minted_to(), None);
    // Conservation: the sender still holds everything the fixture minted
    // (2 * DEPOSIT) and the core contract holds nothing.
    assert_eq!(token_balance(f, &f.sender), 2 * DEPOSIT);
    assert_eq!(token_balance(f, &f.client.address), 0);
}

// -------------------------------------------------------------------- tests --

#[test]
fn atomic_create_with_nft_success_links_both_ways() {
    let f = Fixture::setup();
    let (nft_addr, mock) = register_mock(&f, 1, MODE_OK);

    let id = try_create_with_nft(&f, &nft_addr, DEPOSIT).expect("atomic create succeeds");
    assert_eq!(id, 1);

    // Events must be read before any further client call: each top-level
    // invocation replaces the test event log.
    let now = f.env.ledger().timestamp();
    let created_event = crate::StreamCreated {
        stream_id: id,
        sender: f.sender.clone(),
        recipient: f.recipient.clone(),
        token: f.token.clone(),
        deposit: DEPOSIT,
        start_time: now,
        end_time: now + 10 * DAY,
        cancelable: true,
    };
    let minted_event = StreamNftMinted {
        stream_id: id,
        nft_contract: nft_addr.clone(),
        recipient: f.recipient.clone(),
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [
            created_event.to_xdr(&f.env, &f.client.address),
            minted_event.to_xdr(&f.env, &f.client.address),
        ]
    );

    // Core side of the link, and the stream itself.
    assert_eq!(f.client.stream_nft_link(&id), Some(nft_addr.clone()));
    let stream = f.client.get_stream(&id);
    assert_eq!(stream.deposit, DEPOSIT);
    assert_eq!(stream.recipient, f.recipient);

    // NFT side: minted to the recipient; its bound id is the stream id.
    assert_eq!(mock.minted_to(), Some(f.recipient.clone()));
    assert_eq!(mock.stream_id(), id);

    // Conservation on success: deposit escrowed in the core, rest with sender.
    assert_eq!(token_balance(&f, &f.sender), DEPOSIT);
    assert_eq!(token_balance(&f, &f.client.address), DEPOSIT);
}

#[test]
fn hostile_nft_panic_rolls_back_everything() {
    let f = Fixture::setup();
    let (nft_addr, mock) = register_mock(&f, 1, MODE_PANIC);

    let err = try_create_with_nft(&f, &nft_addr, DEPOSIT).unwrap_err();
    assert_eq!(err, StreamError::NftMintFailed);
    assert_no_orphans(&f, &mock);

    // The failed attempt consumed no stream id.
    let id = f.create_stream(DEPOSIT, 0, 10 * DAY, true);
    assert_eq!(id, 1);
}

#[test]
fn hostile_nft_error_rolls_back_everything() {
    let f = Fixture::setup();
    let (nft_addr, mock) = register_mock(&f, 1, MODE_ERROR);

    let err = try_create_with_nft(&f, &nft_addr, DEPOSIT).unwrap_err();
    assert_eq!(err, StreamError::NftMintFailed);
    assert_no_orphans(&f, &mock);
}

#[test]
fn nft_bound_to_other_stream_is_mismatch_and_rolls_back() {
    let f = Fixture::setup();
    // Companion bound to stream 99, but the next stream id is 1.
    let (nft_addr, mock) = register_mock(&f, 99, MODE_OK);

    let err = try_create_with_nft(&f, &nft_addr, DEPOSIT).unwrap_err();
    assert_eq!(err, StreamError::NftLinkMismatch);
    assert_no_orphans(&f, &mock);
}

#[test]
fn reentrant_atomic_create_during_mint_is_blocked() {
    let f = Fixture::setup();
    let (nft_addr, mock) = register_mock(&f, 1, MODE_REENTER);

    // The outer pair succeeds; the hostile reentry attempt inside the mint
    // was refused by the in-flight lock, so exactly one stream exists.
    let id = try_create_with_nft(&f, &nft_addr, DEPOSIT).expect("outer atomic create succeeds");
    assert_eq!(id, 1);
    assert!(mock.reentry_blocked());
    assert_eq!(mock.minted_to(), Some(f.recipient.clone()));
    assert_eq!(token_balance(&f, &f.client.address), DEPOSIT);

    // No second stream snuck in through the reentry: the next id is 2.
    let next = f.create_stream(DEPOSIT, 0, 10 * DAY, true);
    assert_eq!(next, 2);
}

#[test]
fn conservation_across_atomic_outcomes() {
    // For each hostile mode and a spread of deposits: after the call, every
    // token is accounted for — sender + core == total minted — and success
    // holds exactly `deposit` in the core while failure holds nothing.
    for mode in [MODE_OK, MODE_PANIC, MODE_ERROR] {
        // The spread starts at MIN_STREAM_DEPOSIT: below the dust floor
        // (#78) creation is rejected before the mint is ever attempted,
        // which is a different invariant than the one under test here.
        for deposit in [
            MIN_STREAM_DEPOSIT,
            MIN_STREAM_DEPOSIT + 1,
            DEPOSIT,
            3 * DEPOSIT / 2,
        ] {
            let f = Fixture::setup();
            // Fixture mints 2 * DEPOSIT and approves 10 * DEPOSIT; deposits
            // above the minted balance cannot be pulled, so cap the case.
            if deposit > 2 * DEPOSIT {
                continue;
            }
            let (nft_addr, _mock) = register_mock(&f, 1, mode);
            let result = try_create_with_nft(&f, &nft_addr, deposit);
            let core = token_balance(&f, &f.client.address);
            let sender = token_balance(&f, &f.sender);
            assert_eq!(sender + core, 2 * DEPOSIT, "mode {mode} deposit {deposit}");
            if mode == MODE_OK {
                assert!(result.is_ok());
                assert_eq!(core, deposit);
            } else {
                assert!(result.is_err());
                assert_eq!(core, 0);
                assert_eq!(sender, 2 * DEPOSIT);
            }
        }
    }
}
