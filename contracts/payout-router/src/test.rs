//! Tests for the payout router against the REAL streaming contract.
#![cfg(test)]

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Event as _, IntoVal, Symbol, Vec,
};
use streampay_contract::{
    test_client::StreamingPaymentsClient, HookEventClass, HookFailurePolicy, StreamingPayments,
};

use crate::{
    PayoutActive, PayoutBound, PayoutCleared, PayoutRouter, PayoutRouterClient, RouterError,
    BIND_DELAY_SECS,
};

const DAY: u64 = 86_400;
const DEPOSIT: i128 = 10_000_000_000;

struct F {
    env: Env,
    token: Address,
    streaming: StreamingPaymentsClient<'static>,
    router: PayoutRouterClient<'static>,
    sender: Address,
    recipient: Address,
    payout: Address,
    governor: Address,
}

impl F {
    fn new() -> Self {
        let mut env = Env::default();
        env.set_config(soroban_sdk::testutils::EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        let token = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let payout = Address::generate(&env);
        let governor = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&sender, &(5 * DEPOSIT));

        let streaming_id = env.register(StreamingPayments, (governor.clone(),));
        let streaming = StreamingPaymentsClient::new(&env, &streaming_id);
        StellarAssetClient::new(&env, &token).approve(
            &sender,
            &streaming_id,
            &(5 * DEPOSIT),
            &1_000_000u32,
        );
        let router_id = env.register(PayoutRouter, (streaming_id,));
        let router = PayoutRouterClient::new(&env, &router_id);
        F {
            env,
            token,
            streaming,
            router,
            sender,
            recipient,
            payout,
            governor,
        }
    }

    fn now(&self) -> u64 {
        self.env.ledger().timestamp()
    }

    fn advance(&self, secs: u64) {
        self.env.ledger().with_mut(|l| l.timestamp += secs);
    }

    fn set_time(&self, t: u64) {
        self.env.ledger().with_mut(|l| l.timestamp = t);
    }

    fn stream(&self, cancelable: bool) -> u64 {
        let now = self.now();
        self.streaming.create_stream(
            &self.sender,
            &self.recipient,
            &self.token,
            &DEPOSIT,
            &now,
            &(now + 20 * DAY),
            &cancelable,
        )
    }

    fn hook(&self, id: u64, policy: HookFailurePolicy) {
        self.streaming.register_hook(
            &self.recipient,
            &id,
            &HookEventClass::Withdraw,
            &self.router.address,
            &Symbol::new(&self.env, "on_withdraw"),
            &policy,
        );
    }

    /// Stream with the hook registered (Revert policy) and an ACTIVE binding.
    fn active_stream(&self) -> u64 {
        let id = self.stream(true);
        self.hook(id, HookFailurePolicy::Revert);
        self.router.propose(&id, &self.payout);
        self.advance(BIND_DELAY_SECS);
        self.router.confirm(&id);
        id
    }

    fn bal(&self, who: &Address) -> i128 {
        TokenClient::new(&self.env, &self.token).balance(who)
    }
}

fn router_err<T: core::fmt::Debug, C: core::fmt::Debug>(
    r: Result<Result<T, C>, Result<RouterError, soroban_sdk::InvokeError>>,
) -> RouterError {
    r.unwrap_err().unwrap()
}

#[test]
fn none_to_pending_emits_bound_and_view() {
    let f = F::new();
    let id = f.stream(true);
    let view = f.router.binding(&id);
    assert_eq!(
        (view.active, view.pending, view.activates_at),
        (None, None, 0)
    );

    let t0 = f.now();
    let at = f.router.propose(&id, &f.payout);
    assert_eq!(at, t0 + BIND_DELAY_SECS);
    let ev = PayoutBound {
        stream_id: id,
        recipient: f.recipient.clone(),
        payout: f.payout.clone(),
        activates_at: at,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.router.address),
        [ev.to_xdr(&f.env, &f.router.address)]
    );
    let view = f.router.binding(&id);
    assert_eq!(view.active, None);
    assert_eq!(view.pending, Some(f.payout.clone()));
    assert_eq!(view.activates_at, at);
}

#[test]
fn confirm_boundary_second_and_event() {
    let f = F::new();
    let id = f.stream(true);
    let at = f.router.propose(&id, &f.payout);

    // Immediately, and one second before the boundary: not ready.
    assert_eq!(
        router_err(f.router.try_confirm(&id)),
        RouterError::BindingNotReady
    );
    f.set_time(at - 1);
    assert_eq!(
        router_err(f.router.try_confirm(&id)),
        RouterError::BindingNotReady
    );
    // Still pending, nothing active.
    assert_eq!(f.router.binding(&id).active, None);

    // Exactly at the boundary: confirmed.
    f.set_time(at);
    f.router.confirm(&id);
    let ev = PayoutActive {
        stream_id: id,
        recipient: f.recipient.clone(),
        payout: f.payout.clone(),
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.router.address),
        [ev.to_xdr(&f.env, &f.router.address)]
    );
    let view = f.router.binding(&id);
    assert_eq!(view.active, Some(f.payout.clone()));
    assert_eq!(view.pending, None);
    assert_eq!(view.activates_at, 0);

    // The pending entry is gone: a second confirm has nothing to confirm.
    assert_eq!(
        router_err(f.router.try_confirm(&id)),
        RouterError::NoPending
    );
}

#[test]
fn pending_never_routes_withdraw() {
    let f = F::new();
    let id = f.stream(true);
    f.hook(id, HookFailurePolicy::Revert);
    f.router.propose(&id, &f.payout);
    // Even past the delay, an unconfirmed binding does not route.
    f.advance(2 * BIND_DELAY_SECS);
    let before = f.bal(&f.recipient);
    f.streaming.withdraw(&id, &1_000_000);
    assert_eq!(f.bal(&f.recipient), before + 1_000_000);
    assert_eq!(f.bal(&f.payout), 0);
}

#[test]
fn active_routes_withdraw() {
    let f = F::new();
    let id = f.active_stream();
    let before = f.bal(&f.recipient);
    f.streaming.withdraw(&id, &1_000_000);
    assert_eq!(f.bal(&f.payout), 1_000_000);
    assert_eq!(f.bal(&f.recipient), before);
}

#[test]
fn active_routes_withdraw_max() {
    let f = F::new();
    let id = f.active_stream();
    let before = f.bal(&f.recipient);
    let got = f.streaming.withdraw_max(&id);
    assert!(got > 0);
    assert_eq!(f.bal(&f.payout), got);
    assert_eq!(f.bal(&f.recipient), before);
}

#[test]
fn active_routes_withdraw_many() {
    let f = F::new();
    let id1 = f.active_stream();
    // Second stream: hooked but unbound, lands at the recipient.
    let id2 = f.stream(true);
    f.hook(id2, HookFailurePolicy::Revert);
    f.advance(DAY);
    let before = f.bal(&f.recipient);
    let mut ids = Vec::new(&f.env);
    ids.push_back(id1);
    ids.push_back(id2);
    let out = f.streaming.withdraw_many(&f.recipient, &ids, &true);
    let e1 = out.get(0).unwrap();
    let e2 = out.get(1).unwrap();
    assert_eq!(f.bal(&f.payout), e1.amount);
    assert_eq!(f.bal(&f.recipient), before + e2.amount);
}

#[test]
fn recipient_signature_covers_the_nested_transfer() {
    // Real (non-mocked-all) auth: only the recipient signs, for withdraw plus
    // the nested token.transfer. No other signer is needed.
    let f = F::new();
    let id = f.active_stream();
    let amount = 1_000_000i128;
    f.env.mock_auths(&[MockAuth {
        address: &f.recipient,
        invoke: &MockAuthInvoke {
            contract: &f.streaming.address,
            fn_name: "withdraw",
            args: (id, amount).into_val(&f.env),
            sub_invokes: &[MockAuthInvoke {
                contract: &f.token,
                fn_name: "transfer",
                args: (f.recipient.clone(), f.payout.clone(), amount).into_val(&f.env),
                sub_invokes: &[],
            }],
        },
    }]);
    f.streaming.withdraw(&id, &amount);
    assert_eq!(f.bal(&f.payout), amount);
}

#[test]
fn repropose_replaces_pending_and_restarts_delay() {
    let f = F::new();
    let id = f.stream(true);
    let first = f.router.propose(&id, &f.payout);
    f.advance(DAY - 10);
    let other = Address::generate(&f.env);
    let second = f.router.propose(&id, &other);
    assert_eq!(second, f.now() + BIND_DELAY_SECS);
    assert!(second > first);
    let view = f.router.binding(&id);
    assert_eq!(view.pending, Some(other.clone()));
    assert_eq!(view.activates_at, second);
    // The first deadline no longer opens the gate.
    f.set_time(first);
    assert_eq!(
        router_err(f.router.try_confirm(&id)),
        RouterError::BindingNotReady
    );
    f.set_time(second);
    f.router.confirm(&id);
    assert_eq!(f.router.binding(&id).active, Some(other));
}

#[test]
fn repropose_while_active_keeps_old_route_until_confirm() {
    let f = F::new();
    let id = f.active_stream();
    let other = Address::generate(&f.env);
    f.router.propose(&id, &other);
    let view = f.router.binding(&id);
    assert_eq!(view.active, Some(f.payout.clone()));
    assert_eq!(view.pending, Some(other.clone()));
    f.streaming.withdraw(&id, &1_000);
    assert_eq!(f.bal(&f.payout), 1_000);
    assert_eq!(f.bal(&other), 0);
    f.advance(BIND_DELAY_SECS);
    f.router.confirm(&id);
    f.streaming.withdraw(&id, &2_000);
    assert_eq!(f.bal(&other), 2_000);
}

#[test]
fn cancel_from_pending() {
    let f = F::new();
    let id = f.stream(true);
    f.router.propose(&id, &f.payout);
    f.router.cancel(&id);
    let ev = PayoutCleared {
        stream_id: id,
        recipient: f.recipient.clone(),
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.router.address),
        [ev.to_xdr(&f.env, &f.router.address)]
    );
    let view = f.router.binding(&id);
    assert_eq!(
        (view.active, view.pending, view.activates_at),
        (None, None, 0)
    );
    f.advance(BIND_DELAY_SECS);
    assert_eq!(
        router_err(f.router.try_confirm(&id)),
        RouterError::NoPending
    );
}

#[test]
fn cancel_from_active_returns_claims_to_recipient() {
    let f = F::new();
    let id = f.active_stream();
    f.router.cancel(&id);
    let view = f.router.binding(&id);
    assert_eq!((view.active, view.pending), (None, None));
    let before = f.bal(&f.recipient);
    f.streaming.withdraw(&id, &5_000);
    assert_eq!(f.bal(&f.recipient), before + 5_000);
    assert_eq!(f.bal(&f.payout), 0);
}

#[test]
fn cancel_clears_pending_and_active_together() {
    let f = F::new();
    let id = f.active_stream();
    f.router.propose(&id, &Address::generate(&f.env));
    f.router.cancel(&id);
    let view = f.router.binding(&id);
    assert_eq!(
        (view.active, view.pending, view.activates_at),
        (None, None, 0)
    );
}

#[test]
fn cancel_with_nothing_is_no_binding() {
    let f = F::new();
    let id = f.stream(true);
    assert_eq!(router_err(f.router.try_cancel(&id)), RouterError::NoBinding);
    // An unknown stream id also has no binding (and does not trap).
    assert_eq!(
        router_err(f.router.try_cancel(&999)),
        RouterError::NoBinding
    );
}

#[test]
fn propose_rejects_bad_payouts() {
    let f = F::new();
    let id = f.stream(true);
    assert_eq!(
        router_err(f.router.try_propose(&id, &f.recipient)),
        RouterError::PayoutIsRecipient
    );
    assert_eq!(
        router_err(f.router.try_propose(&id, &f.streaming.address)),
        RouterError::PayoutIsStreaming
    );
    assert_eq!(
        router_err(f.router.try_propose(&id, &f.router.address)),
        RouterError::PayoutIsRouter
    );
    assert_eq!(f.router.binding(&id).pending, None);
}

#[test]
fn propose_rejects_unknown_stream() {
    let f = F::new();
    assert_eq!(
        router_err(f.router.try_propose(&42, &f.payout)),
        RouterError::StreamUnavailable
    );
}

#[test]
fn propose_rejects_inactive_stream() {
    let f = F::new();
    let id = f.stream(true);
    f.streaming.cancel_stream(&f.sender, &id);
    assert_eq!(
        router_err(f.router.try_propose(&id, &f.payout)),
        RouterError::StreamNotActive
    );
}

#[test]
fn confirm_rejects_if_stream_ended_meanwhile() {
    let f = F::new();
    let id = f.stream(true);
    f.router.propose(&id, &f.payout);
    f.streaming.cancel_stream(&f.sender, &id);
    f.advance(BIND_DELAY_SECS);
    assert_eq!(
        router_err(f.router.try_confirm(&id)),
        RouterError::StreamNotActive
    );
}

#[test]
fn confirm_without_pending_is_rejected() {
    let f = F::new();
    let id = f.stream(true);
    assert_eq!(
        router_err(f.router.try_confirm(&id)),
        RouterError::NoPending
    );
}

#[test]
fn only_the_recipient_can_propose_confirm_cancel() {
    let f = F::new();
    let id = f.stream(true);
    let attacker = Address::generate(&f.env);

    // propose signed by a stranger (sender included): auth failure.
    for who in [&attacker, &f.sender] {
        f.env.mock_auths(&[MockAuth {
            address: who,
            invoke: &MockAuthInvoke {
                contract: &f.router.address,
                fn_name: "propose",
                args: (id, attacker.clone()).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert!(f.router.try_propose(&id, &attacker).is_err());
    }
    assert_eq!(f.router.binding(&id).pending, None);

    // confirm / cancel signed by a stranger.
    f.env.mock_all_auths();
    f.router.propose(&id, &f.payout);
    f.advance(BIND_DELAY_SECS);
    f.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &f.router.address,
            fn_name: "confirm",
            args: (id,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.router.try_confirm(&id).is_err());
    f.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &f.router.address,
            fn_name: "cancel",
            args: (id,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.router.try_cancel(&id).is_err());
    assert_eq!(f.router.binding(&id).pending, Some(f.payout.clone()));
}

#[test]
fn on_withdraw_rejects_direct_callers() {
    let f = F::new();
    let id = f.active_stream();
    let attacker = Address::generate(&f.env);
    // Neither the recipient nor a stranger may call the hook entry point; only
    // the streaming contract (as direct caller) satisfies its auth check.
    for who in [&attacker, &f.recipient] {
        f.env.mock_auths(&[MockAuth {
            address: who,
            invoke: &MockAuthInvoke {
                contract: &f.router.address,
                fn_name: "on_withdraw",
                args: (id, 1_000i128).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert!(f.router.try_on_withdraw(&id, &1_000).is_err());
    }
    assert_eq!(f.bal(&f.payout), 0);
}

#[test]
fn on_withdraw_unbound_and_nonpositive_amounts_are_noops() {
    let f = F::new();
    let id = f.active_stream();
    // Driven by the streaming contract's own address via mock_all_auths.
    f.router.on_withdraw(&777, &1_000); // never bound
    f.router.on_withdraw(&id, &0); // zero amount
    f.router.on_withdraw(&id, &-5); // negative amount
    assert_eq!(f.bal(&f.payout), 0);
}

#[test]
fn missing_keys_never_trap_on_read_or_ttl_paths() {
    let f = F::new();
    // Every read path touches TTL only after an existence check.
    for id in [0u64, 1, u64::MAX] {
        let v = f.router.binding(&id);
        assert_eq!((v.active, v.pending, v.activates_at), (None, None, 0));
        f.router.on_withdraw(&id, &10);
        assert_eq!(
            router_err(f.router.try_confirm(&id)),
            RouterError::NoPending
        );
        assert_eq!(router_err(f.router.try_cancel(&id)), RouterError::NoBinding);
    }
}

#[test]
fn entries_survive_long_gaps_with_ttl_extension() {
    let f = F::new();
    let id = f.stream(true);
    f.router.propose(&id, &f.payout);
    // Move ledgers forward by about 20 days of ledgers; reads extend the TTL.
    for _ in 0..4 {
        f.env.ledger().with_mut(|l| l.sequence_number += 400_000);
        assert_eq!(f.router.binding(&id).pending, Some(f.payout.clone()));
    }
}

#[test]
fn advance_blocks_propose_and_confirm() {
    let f = F::new();
    let id = f.stream(true);
    f.streaming
        .set_receivables_config(&f.governor, &5_000, &100);
    let lender = Address::generate(&f.env);
    StellarAssetClient::new(&f.env, &f.token).mint(&lender, &DEPOSIT);

    // Pending created first, advance drawn second: confirm must refuse.
    f.router.propose(&id, &f.payout);
    f.streaming
        .draw_advance(&id, &lender, &1_000_000_000, &5_000);
    f.advance(BIND_DELAY_SECS);
    assert_eq!(
        router_err(f.router.try_confirm(&id)),
        RouterError::AdvanceActive
    );
    // A fresh propose is refused too.
    assert_eq!(
        router_err(f.router.try_propose(&id, &f.payout)),
        RouterError::AdvanceActive
    );
}

#[test]
fn recipient_change_makes_forward_fail_and_new_recipient_can_cancel() {
    let f = F::new();
    let id = f.active_stream();
    let new_owner = Address::generate(&f.env);
    f.streaming
        .propose_ownership_transfer(&f.recipient, &id, &new_owner);
    f.streaming.accept_ownership_transfer(&new_owner, &id);

    // Stored recipient no longer holds the stream: confirm of a stale pending
    // is refused, and the Revert-policy claim reverts instead of half-routing.
    f.advance(DAY);
    f.env.mock_auths(&[MockAuth {
        address: &new_owner,
        invoke: &MockAuthInvoke {
            contract: &f.streaming.address,
            fn_name: "withdraw",
            args: (id, 1_000i128).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.streaming.try_withdraw(&id, &1_000).is_err());

    // The old (stored) recipient can no longer clear the binding.
    f.env.mock_auths(&[MockAuth {
        address: &f.recipient,
        invoke: &MockAuthInvoke {
            contract: &f.router.address,
            fn_name: "cancel",
            args: (id,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.router.try_cancel(&id).is_err());

    // The current recipient clears the stale binding through the router.
    f.env.mock_auths(&[MockAuth {
        address: &new_owner,
        invoke: &MockAuthInvoke {
            contract: &f.router.address,
            fn_name: "cancel",
            args: (id,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    f.router.cancel(&id);
    f.env.mock_all_auths();
    let ev = PayoutCleared {
        stream_id: id,
        recipient: new_owner.clone(),
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.router.address),
        [ev.to_xdr(&f.env, &f.router.address)]
    );
    let before = f.bal(&new_owner);
    f.streaming.withdraw(&id, &1_000);
    assert_eq!(f.bal(&new_owner), before + 1_000);
}

#[test]
fn confirm_refuses_after_recipient_change() {
    let f = F::new();
    let id = f.stream(true);
    f.router.propose(&id, &f.payout);
    let new_owner = Address::generate(&f.env);
    f.streaming
        .propose_ownership_transfer(&f.recipient, &id, &new_owner);
    f.streaming.accept_ownership_transfer(&new_owner, &id);
    f.advance(BIND_DELAY_SECS);
    assert_eq!(
        router_err(f.router.try_confirm(&id)),
        RouterError::RecipientChanged
    );
}

#[test]
fn cancel_when_stream_unreadable_uses_stored_recipient() {
    // A binding for a stream id the streaming contract does not know cannot be
    // created by propose; plant one by pointing a second router at nothing.
    let f = F::new();
    let id = f.stream(true);
    f.router.propose(&id, &f.payout);
    // Re-point: a fresh router whose "streaming" address is a plain account.
    let bogus = Address::generate(&f.env);
    let r2 = PayoutRouterClient::new(&f.env, &f.env.register(PayoutRouter, (bogus,)));
    assert_eq!(router_err(r2.try_cancel(&id)), RouterError::NoBinding);
    // Directly seed an entry in r2 to exercise the unreadable-stream branch.
    f.env.as_contract(&r2.address, || {
        f.env.storage().persistent().set(
            &crate::DataKey::Pending(id),
            &crate::Pending {
                payout: f.payout.clone(),
                recipient: f.recipient.clone(),
                token: f.token.clone(),
                activates_at: 0,
            },
        );
    });
    r2.cancel(&id);
    assert_eq!(r2.binding(&id).pending, None);
}

#[test]
fn emit_and_continue_policy_also_routes_when_forward_succeeds() {
    let f = F::new();
    let id = f.stream(true);
    f.hook(id, HookFailurePolicy::EmitAndContinue);
    f.router.propose(&id, &f.payout);
    f.advance(BIND_DELAY_SECS);
    f.router.confirm(&id);
    let before = f.bal(&f.recipient);
    f.streaming.withdraw(&id, &1_000);
    // Streaming paid the recipient 1_000, router forwarded it on.
    assert_eq!(f.bal(&f.payout), 1_000);
    assert_eq!(f.bal(&f.recipient), before);
}

#[test]
fn revert_policy_reverts_claim_when_forward_fails() {
    // Recipient holds exactly what was streamed to them; a lender intercept
    // (advance drawn AFTER binding) makes gross > net, so the forward lacks
    // funds and the whole claim reverts instead of half-routing.
    let f = F::new();
    let id = f.active_stream();
    f.streaming
        .set_receivables_config(&f.governor, &5_000, &100);
    let lender = Address::generate(&f.env);
    StellarAssetClient::new(&f.env, &f.token).mint(&lender, &DEPOSIT);
    f.streaming
        .draw_advance(&id, &lender, &1_000_000_000, &10_000);
    // Drain the recipient's advance proceeds so the shortfall is real.
    let sink = Address::generate(&f.env);
    let held = f.bal(&f.recipient);
    TokenClient::new(&f.env, &f.token).transfer(&f.recipient, &sink, &held);
    f.advance(DAY);
    assert!(f.streaming.try_withdraw(&id, &1_000_000).is_err());
    assert_eq!(f.bal(&f.payout), 0);
}
