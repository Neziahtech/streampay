//! Storage layout and event schema compatibility guard.
//!
//! Enforces CI verification that the StreamPay append-only interface remains
//! strictly append-only: a stored schema fingerprint (storage key shapes,
//! event payloads, error code list, and built Wasm spec) that fails on
//! modification and only updates via explicit blessed diffs.
//!
//! The guard catches:
//!   1. Renamed event field
//!   2. Changed error code number
//!   3. Altered storage key serialization
//!   4. Contract Wasm spec changes
//!
//! Bless procedure:
//!   npm run schema:bless (or STREAMPAY_SCHEMA_BLESS=1 cargo test -p streampay-contract --lib schema_guard_test)
//!   Updates to the fingerprint require a PR with migration analysis in schema/MIGRATION.md.
#![cfg(test)]

extern crate std;
use std::format;
use std::string::String;
use std::vec::Vec as StdVec;

use soroban_sdk::{
    testutils::Address as _,
    xdr::{ToXdr, WriteXdr},
    Address, BytesN, Env, Event as _, Symbol, Vec,
};

use crate::{
    errors::StreamError,
    events::*,
    governance::{GovernanceAction, GovernanceDataKey},
    policy::{PolicyDataKey, StreamPolicy},
    sponsor::SponsorKey,
    stream::{DataKey, OwnershipRole},
    StreamingPayments,
};

fn hex_str(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// Extracts the `contractspecv0` custom section from a WebAssembly binary.
fn extract_contractspecv0(wasm_bytes: &[u8]) -> Option<StdVec<u8>> {
    if wasm_bytes.len() < 8 || &wasm_bytes[0..4] != b"\0asm" {
        return None;
    }
    let mut pos = 8;
    while pos < wasm_bytes.len() {
        let section_id = wasm_bytes[pos];
        pos += 1;
        let (section_len, leb_len) = read_leb128(&wasm_bytes[pos..])?;
        pos += leb_len;
        let section_end = pos + section_len as usize;
        if section_end > wasm_bytes.len() {
            return None;
        }
        if section_id == 0 {
            let (name_len, name_leb_len) = read_leb128(&wasm_bytes[pos..])?;
            let name_start = pos + name_leb_len;
            let name_end = name_start + name_len as usize;
            if name_end <= section_end && &wasm_bytes[name_start..name_end] == b"contractspecv0" {
                return Some(wasm_bytes[name_end..section_end].to_vec());
            }
        }
        pos = section_end;
    }
    None
}

fn read_leb128(bytes: &[u8]) -> Option<(u32, usize)> {
    let mut result: u32 = 0;
    let mut shift = 0;
    let mut count = 0;
    for &byte in bytes {
        count += 1;
        result |= ((byte & 0x7F) as u32) << shift;
        if (byte & 0x80) == 0 {
            return Some((result, count));
        }
        shift += 7;
        if shift >= 35 {
            return None;
        }
    }
    None
}

/// Generates the canonical schema fingerprint representation.
pub fn generate_schema_representation(env: &Env) -> serde_json::Value {
    let governor = Address::generate(env);
    let contract_id = env.register(StreamingPayments, (governor.clone(),));
    let sender = Address::generate(env);
    let recipient = Address::generate(env);
    let token = Address::generate(env);
    let keeper = Address::generate(env);
    let admin = Address::generate(env);
    let bytes32 = BytesN::from_array(env, &[1u8; 32]);
    let signers = Vec::from_array(env, [sender.clone(), recipient.clone()]);

    // ── 1. Storage keys probe (covers all 4 key enums in the contract) ──────
    let mut storage_keys_json = std::vec![];

    // DataKey probe (21 variants)
    let datakey_cases: StdVec<(&str, &str, &str, DataKey)> = std::vec![
        (
            "NextStreamId",
            "NextStreamId",
            "instance",
            DataKey::NextStreamId
        ),
        ("Stream", "Stream(u64)", "persistent", DataKey::Stream(1)),
        (
            "RecipientStreams",
            "RecipientStreams(Address)",
            "persistent",
            DataKey::RecipientStreams(recipient.clone())
        ),
        (
            "SenderStreams",
            "SenderStreams(Address)",
            "persistent",
            DataKey::SenderStreams(sender.clone())
        ),
        (
            "NextIntentId",
            "NextIntentId",
            "instance",
            DataKey::NextIntentId
        ),
        ("Intent", "Intent(u64)", "persistent", DataKey::Intent(1)),
        (
            "SenderIntents",
            "SenderIntents(Address)",
            "persistent",
            DataKey::SenderIntents(sender.clone())
        ),
        ("Governor", "Governor", "instance", DataKey::Governor),
        (
            "PendingGovernor",
            "PendingGovernor",
            "instance",
            DataKey::PendingGovernor
        ),
        ("FeeBps", "FeeBps", "instance", DataKey::FeeBps),
        (
            "Treasury",
            "Treasury(Address)",
            "persistent",
            DataKey::Treasury(token.clone())
        ),
        (
            "StreamFee",
            "StreamFee(u64)",
            "persistent",
            DataKey::StreamFee(1)
        ),
        (
            "SchemaVersion",
            "SchemaVersion",
            "instance",
            DataKey::SchemaVersion
        ),
        (
            "ContractFrozen",
            "ContractFrozen",
            "instance",
            DataKey::ContractFrozen
        ),
        (
            "PendingUpgrade",
            "PendingUpgrade",
            "instance",
            DataKey::PendingUpgrade
        ),
        (
            "MigrationCursor",
            "MigrationCursor",
            "instance",
            DataKey::MigrationCursor
        ),
        (
            "OracleConfig",
            "OracleConfig",
            "instance",
            DataKey::OracleConfig
        ),
        (
            "OracleReport",
            "OracleReport(Address)",
            "persistent",
            DataKey::OracleReport(sender.clone())
        ),
        (
            "PendingOwnership",
            "PendingOwnership(u64)",
            "persistent",
            DataKey::PendingOwnership(1)
        ),
        (
            "PendingRateChange",
            "PendingRateChange(u64)",
            "persistent",
            DataKey::PendingRateChange(1)
        ),
        (
            "RateSegments",
            "RateSegments(u64)",
            "persistent",
            DataKey::RateSegments(1)
        ),
    ];

    let sponsor_key_cases: StdVec<(&str, &str, &str, SponsorKey)> = std::vec![
        (
            "SponsorConfig",
            "SponsorConfig(Address)",
            "persistent",
            SponsorKey::SponsorConfig(sender.clone())
        ),
        (
            "OperatorKey",
            "OperatorKey(Address)",
            "persistent",
            SponsorKey::OperatorKey(sender.clone())
        ),
        (
            "SponsorPeriod",
            "SponsorPeriod(Address)",
            "persistent",
            SponsorKey::SponsorPeriod(sender.clone())
        ),
        (
            "BeneficiaryKey",
            "BeneficiaryKey(Address)",
            "persistent",
            SponsorKey::BeneficiaryKey(recipient.clone())
        ),
        (
            "BeneficiarySpend",
            "BeneficiarySpend(Address, Address)",
            "persistent",
            SponsorKey::BeneficiarySpend(sender.clone(), recipient.clone())
        ),
        (
            "ClaimNonce",
            "ClaimNonce(Address, Address, u64)",
            "persistent",
            SponsorKey::ClaimNonce(sender.clone(), recipient.clone(), 1)
        ),
    ];

    let policy_key_cases: StdVec<(&str, &str, &str, PolicyDataKey)> = std::vec![
        ("Admin", "Admin", "instance", PolicyDataKey::Admin),
        (
            "PendingAdmin",
            "PendingAdmin",
            "instance",
            PolicyDataKey::PendingAdmin
        ),
        (
            "TimelockDelay",
            "TimelockDelay",
            "instance",
            PolicyDataKey::TimelockDelay
        ),
        (
            "Asset",
            "Asset(Address)",
            "persistent",
            PolicyDataKey::Asset(token.clone())
        ),
        (
            "QueuedAsset",
            "QueuedAsset(Address)",
            "persistent",
            PolicyDataKey::QueuedAsset(token.clone())
        ),
        (
            "StreamPolicy",
            "StreamPolicy(Address)",
            "persistent",
            PolicyDataKey::StreamPolicy(token.clone())
        ),
        (
            "GlobalStreamPolicy",
            "GlobalStreamPolicy",
            "instance",
            PolicyDataKey::GlobalStreamPolicy
        ),
    ];

    let gov_key_cases: StdVec<(&str, &str, &str, GovernanceDataKey)> = std::vec![
        ("Signers", "Signers", "instance", GovernanceDataKey::Signers),
        (
            "VetoWindow",
            "VetoWindow",
            "instance",
            GovernanceDataKey::VetoWindow
        ),
        (
            "ProposalCount",
            "ProposalCount",
            "instance",
            GovernanceDataKey::ProposalCount
        ),
        (
            "Proposal",
            "Proposal(u64)",
            "persistent",
            GovernanceDataKey::Proposal(1)
        ),
    ];

    env.as_contract(&contract_id, || {
        for (name, shape, storage_type, key) in &datakey_cases {
            if *storage_type == "instance" {
                env.storage().instance().set(key, &42u32);
                let read_back: u32 = env.storage().instance().get(key).unwrap();
                assert_eq!(read_back, 42u32);
            } else {
                env.storage().persistent().set(key, &42u32);
                let read_back: u32 = env.storage().persistent().get(key).unwrap();
                assert_eq!(read_back, 42u32);
            }

            let xdr_bytes = key.to_xdr(env);
            let mut raw_bytes = StdVec::with_capacity(xdr_bytes.len() as usize);
            for i in 0..xdr_bytes.len() {
                raw_bytes.push(xdr_bytes.get(i).unwrap());
            }

            storage_keys_json.push(serde_json::json!({
                "enum": "DataKey",
                "name": name,
                "shape": shape,
                "storage_type": storage_type,
                "xdr_sample_hex": hex_str(&raw_bytes)
            }));
        }

        for (name, shape, storage_type, key) in &sponsor_key_cases {
            env.storage().persistent().set(key, &42u32);
            let read_back: u32 = env.storage().persistent().get(key).unwrap();
            assert_eq!(read_back, 42u32);

            let xdr_bytes = key.to_xdr(env);
            let mut raw_bytes = StdVec::with_capacity(xdr_bytes.len() as usize);
            for i in 0..xdr_bytes.len() {
                raw_bytes.push(xdr_bytes.get(i).unwrap());
            }

            storage_keys_json.push(serde_json::json!({
                "enum": "SponsorKey",
                "name": name,
                "shape": shape,
                "storage_type": storage_type,
                "xdr_sample_hex": hex_str(&raw_bytes)
            }));
        }

        for (name, shape, storage_type, key) in &policy_key_cases {
            if *storage_type == "instance" {
                env.storage().instance().set(key, &42u32);
                let read_back: u32 = env.storage().instance().get(key).unwrap();
                assert_eq!(read_back, 42u32);
            } else {
                env.storage().persistent().set(key, &42u32);
                let read_back: u32 = env.storage().persistent().get(key).unwrap();
                assert_eq!(read_back, 42u32);
            }

            let xdr_bytes = key.to_xdr(env);
            let mut raw_bytes = StdVec::with_capacity(xdr_bytes.len() as usize);
            for i in 0..xdr_bytes.len() {
                raw_bytes.push(xdr_bytes.get(i).unwrap());
            }

            storage_keys_json.push(serde_json::json!({
                "enum": "PolicyDataKey",
                "name": name,
                "shape": shape,
                "storage_type": storage_type,
                "xdr_sample_hex": hex_str(&raw_bytes)
            }));
        }

        for (name, shape, storage_type, key) in &gov_key_cases {
            if *storage_type == "instance" {
                env.storage().instance().set(key, &42u32);
                let read_back: u32 = env.storage().instance().get(key).unwrap();
                assert_eq!(read_back, 42u32);
            } else {
                env.storage().persistent().set(key, &42u32);
                let read_back: u32 = env.storage().persistent().get(key).unwrap();
                assert_eq!(read_back, 42u32);
            }

            let xdr_bytes = key.to_xdr(env);
            let mut raw_bytes = StdVec::with_capacity(xdr_bytes.len() as usize);
            for i in 0..xdr_bytes.len() {
                raw_bytes.push(xdr_bytes.get(i).unwrap());
            }

            storage_keys_json.push(serde_json::json!({
                "enum": "GovernanceDataKey",
                "name": name,
                "shape": shape,
                "storage_type": storage_type,
                "xdr_sample_hex": hex_str(&raw_bytes)
            }));
        }
    });

    // ── 2. Events probe (all 40 contract events) ────────────────────────────
    struct EventCase {
        name: &'static str,
        topics: StdVec<(&'static str, &'static str)>,
        data: StdVec<(&'static str, &'static str)>,
        xdr_bytes: StdVec<u8>,
    }

    macro_rules! event_case {
        ($name:ident, topics: [$(($t_name:expr, $t_type:expr)),*], data: [$(($d_name:expr, $d_type:expr)),*], $instance:expr) => {{
            let ev = $instance;
            let contract_event = ev.to_xdr(env, &contract_id);
            let bytes = contract_event.to_xdr(soroban_sdk::xdr::Limits::none()).expect("event to xdr");
            EventCase {
                name: stringify!($name),
                topics: std::vec![$(($t_name, $t_type)),*],
                data: std::vec![$(($d_name, $d_type)),*],
                xdr_bytes: bytes,
            }
        }};
    }

    let event_cases = std::vec![
        event_case!(
            StreamCreated,
            topics: [("stream_id", "u64")],
            data: [
                ("sender", "Address"),
                ("recipient", "Address"),
                ("token", "Address"),
                ("deposit", "i128"),
                ("start_time", "u64"),
                ("end_time", "u64"),
                ("cancelable", "bool")
            ],
            StreamCreated {
                stream_id: 1,
                sender: sender.clone(),
                recipient: recipient.clone(),
                token: token.clone(),
                deposit: 1000,
                start_time: 100,
                end_time: 200,
                cancelable: true,
            }
        ),
        event_case!(
            StreamsCreated,
            topics: [("sender", "Address")],
            data: [("stream_ids", "Vec<u64>")],
            StreamsCreated {
                sender: sender.clone(),
                stream_ids: Vec::from_array(env, [1, 2]),
            }
        ),
        event_case!(
            Withdrawn,
            topics: [("stream_id", "u64")],
            data: [
                ("recipient", "Address"),
                ("amount", "i128"),
                ("withdrawn_total", "i128")
            ],
            Withdrawn {
                stream_id: 1,
                recipient: recipient.clone(),
                amount: 500,
                withdrawn_total: 500,
            }
        ),
        event_case!(
            StreamCancelled,
            topics: [("stream_id", "u64")],
            data: [
                ("cancelled_by", "Address"),
                ("recipient_amount", "i128"),
                ("sender_amount", "i128")
            ],
            StreamCancelled {
                stream_id: 1,
                cancelled_by: sender.clone(),
                recipient_amount: 300,
                sender_amount: 700,
            }
        ),
        event_case!(
            StreamToppedUp,
            topics: [("stream_id", "u64")],
            data: [
                ("sender", "Address"),
                ("amount", "i128"),
                ("new_deposit", "i128")
            ],
            StreamToppedUp {
                stream_id: 1,
                sender: sender.clone(),
                amount: 500,
                new_deposit: 1500,
            }
        ),
        event_case!(
            StreamScheduled,
            topics: [("intent_id", "u64")],
            data: [
                ("sender", "Address"),
                ("recipient", "Address"),
                ("token", "Address"),
                ("deposit", "i128"),
                ("start_time", "u64"),
                ("end_time", "u64"),
                ("cancelable", "bool"),
                ("interval", "u64"),
                ("occurrences", "u32"),
                ("fee_budget", "i128"),
                ("execute_after", "u64"),
                ("expires_at", "u64")
            ],
            StreamScheduled {
                intent_id: 1,
                sender: sender.clone(),
                recipient: recipient.clone(),
                token: token.clone(),
                deposit: 1000,
                start_time: 100,
                end_time: 200,
                cancelable: true,
                interval: 3600,
                occurrences: 5,
                fee_budget: 10,
                execute_after: 100,
                expires_at: 20000,
            }
        ),
        event_case!(
            ScheduledStreamExecuted,
            topics: [("intent_id", "u64")],
            data: [
                ("keeper", "Address"),
                ("stream_id", "u64"),
                ("occurrence_index", "u32"),
                ("occurrences_remaining", "u32"),
                ("fee_paid", "i128")
            ],
            ScheduledStreamExecuted {
                intent_id: 1,
                keeper: keeper.clone(),
                stream_id: 10,
                occurrence_index: 0,
                occurrences_remaining: 4,
                fee_paid: 10,
            }
        ),
        event_case!(
            ScheduledIntentCancelled,
            topics: [("intent_id", "u64")],
            data: [("sender", "Address"), ("refund", "i128")],
            ScheduledIntentCancelled {
                intent_id: 1,
                sender: sender.clone(),
                refund: 4040,
            }
        ),
        event_case!(
            ScheduledIntentExpired,
            topics: [("intent_id", "u64")],
            data: [("sender", "Address"), ("refund", "i128")],
            ScheduledIntentExpired {
                intent_id: 1,
                sender: sender.clone(),
                refund: 4040,
            }
        ),
        event_case!(
            FeeCharged,
            topics: [("stream_id", "u64")],
            data: [
                ("token", "Address"),
                ("payer", "Address"),
                ("amount", "i128"),
                ("fee_bps", "u32")
            ],
            FeeCharged {
                stream_id: 1,
                token: token.clone(),
                payer: sender.clone(),
                amount: 25,
                fee_bps: 25,
            }
        ),
        event_case!(
            FeeWithdrawn,
            topics: [("token", "Address")],
            data: [
                ("governor", "Address"),
                ("recipient", "Address"),
                ("amount", "i128"),
                ("withdrawn_total", "i128")
            ],
            FeeWithdrawn {
                token: token.clone(),
                governor: governor.clone(),
                recipient: recipient.clone(),
                amount: 100,
                withdrawn_total: 100,
            }
        ),
        event_case!(
            SponsorRegistered,
            topics: [("sponsor", "Address"), ("kind", "Symbol")],
            data: [
                ("token", "Address"),
                ("per_period_limit", "i128"),
                ("per_beneficiary_limit", "i128"),
                ("window_seconds", "u64")
            ],
            SponsorRegistered {
                sponsor: sender.clone(),
                kind: Symbol::new(env, "registered"),
                token: token.clone(),
                per_period_limit: 10000,
                per_beneficiary_limit: 1000,
                window_seconds: 86400,
            }
        ),
        event_case!(
            SponsorActiveSet,
            topics: [("sponsor", "Address"), ("kind", "Symbol")],
            data: [("active", "bool")],
            SponsorActiveSet {
                sponsor: sender.clone(),
                kind: Symbol::new(env, "active"),
                active: true,
            }
        ),
        event_case!(
            BeneficiaryEnrolled,
            topics: [("beneficiary", "Address"), ("kind", "Symbol")],
            data: [("public_key", "BytesN<32>")],
            BeneficiaryEnrolled {
                beneficiary: recipient.clone(),
                kind: Symbol::new(env, "enrolled"),
                public_key: bytes32.clone(),
            }
        ),
        event_case!(
            OperatorKeyRotated,
            topics: [("sponsor", "Address"), ("kind", "Symbol")],
            data: [("new_operator_key", "BytesN<32>")],
            OperatorKeyRotated {
                sponsor: sender.clone(),
                kind: Symbol::new(env, "rotated"),
                new_operator_key: bytes32.clone(),
            }
        ),
        event_case!(
            SponsorClaim,
            topics: [("sponsor", "Address"), ("kind", "Symbol"), ("stream_id", "u64")],
            data: [
                ("beneficiary", "Address"),
                ("amount", "i128"),
                ("nonce", "u64")
            ],
            SponsorClaim {
                sponsor: sender.clone(),
                kind: Symbol::new(env, "claim"),
                stream_id: 1,
                beneficiary: recipient.clone(),
                amount: 500,
                nonce: 1,
            }
        ),
        event_case!(
            PolicyInitialized,
            topics: [],
            data: [("admin", "Address")],
            PolicyInitialized { admin: admin.clone() }
        ),
        event_case!(
            PolicyAssetQueued,
            topics: [("asset", "Address")],
            data: [("allowed", "bool"), ("executable_after", "u64")],
            PolicyAssetQueued {
                asset: token.clone(),
                allowed: true,
                executable_after: 500,
            }
        ),
        event_case!(
            PolicyAssetExecuted,
            topics: [("asset", "Address")],
            data: [("allowed", "bool")],
            PolicyAssetExecuted {
                asset: token.clone(),
                allowed: true,
            }
        ),
        event_case!(
            PolicyHandoffProposed,
            topics: [("current_admin", "Address")],
            data: [("proposed_admin", "Address")],
            PolicyHandoffProposed {
                current_admin: admin.clone(),
                proposed_admin: sender.clone(),
            }
        ),
        event_case!(
            PolicyHandoffAccepted,
            topics: [("new_admin", "Address")],
            data: [],
            PolicyHandoffAccepted { new_admin: sender.clone() }
        ),
        event_case!(
            PolicyHandoffCancelled,
            topics: [("proposed_admin", "Address")],
            data: [],
            PolicyHandoffCancelled { proposed_admin: sender.clone() }
        ),
        event_case!(
            UpgradeProposed,
            topics: [("new_wasm_hash", "BytesN<32>")],
            data: [("unlock_time", "u64"), ("proposer", "Address")],
            UpgradeProposed {
                new_wasm_hash: bytes32.clone(),
                unlock_time: 1000,
                proposer: governor.clone(),
            }
        ),
        event_case!(
            UpgradeCancelled,
            topics: [("new_wasm_hash", "BytesN<32>")],
            data: [("cancelled_by", "Address")],
            UpgradeCancelled {
                new_wasm_hash: bytes32.clone(),
                cancelled_by: governor.clone(),
            }
        ),
        event_case!(
            ContractUpgraded,
            topics: [("new_wasm_hash", "BytesN<32>")],
            data: [("executed_by", "Address")],
            ContractUpgraded {
                new_wasm_hash: bytes32.clone(),
                executed_by: governor.clone(),
            }
        ),
        event_case!(
            ContractFrozenStateChanged,
            topics: [("frozen", "bool")],
            data: [("changed_by", "Address")],
            ContractFrozenStateChanged {
                frozen: true,
                changed_by: governor.clone(),
            }
        ),
        event_case!(
            StorageMigrated,
            topics: [("from_version", "u32"), ("to_version", "u32")],
            data: [
                ("start_id", "u64"),
                ("end_id", "u64"),
                ("is_complete", "bool")
            ],
            StorageMigrated {
                from_version: 1,
                to_version: 2,
                start_id: 1,
                end_id: 10,
                is_complete: true,
            }
        ),
        event_case!(
            StreamPolicySet,
            topics: [],
            data: [
                ("token", "Option<Address>"),
                ("old_policy", "Option<StreamPolicy>"),
                ("new_policy", "StreamPolicy")
            ],
            StreamPolicySet {
                token: Some(token.clone()),
                old_policy: None,
                new_policy: StreamPolicy {
                    min_rate: 1,
                    max_rate: 1000,
                    min_duration: 60,
                    max_duration: 86400,
                    min_deposit: 100,
                },
            }
        ),
        event_case!(
            OracleConfigUpdated,
            topics: [],
            data: [("threshold", "u32"), ("max_stale_seconds", "u64")],
            OracleConfigUpdated {
                threshold: 2,
                max_stale_seconds: 300,
            }
        ),
        event_case!(
            OracleTimeReported,
            topics: [("publisher", "Address")],
            data: [("reported_time", "u64"), ("ledger_time", "u64")],
            OracleTimeReported {
                publisher: sender.clone(),
                reported_time: 1000,
                ledger_time: 1005,
            }
        ),
        event_case!(
            OracleStaleFallback,
            topics: [("stream_id", "u64")],
            data: [("ledger_time", "u64")],
            OracleStaleFallback {
                stream_id: 1,
                ledger_time: 1005,
            }
        ),
        event_case!(
            OwnershipProposed,
            topics: [("stream_id", "u64")],
            data: [
                ("current_owner", "Address"),
                ("new_owner", "Address"),
                ("role", "OwnershipRole"),
                ("expires_at", "u64")
            ],
            OwnershipProposed {
                stream_id: 1,
                current_owner: sender.clone(),
                new_owner: recipient.clone(),
                role: OwnershipRole::Sender,
                expires_at: 10000,
            }
        ),
        event_case!(
            OwnershipAccepted,
            topics: [("stream_id", "u64")],
            data: [
                ("previous_owner", "Address"),
                ("new_owner", "Address"),
                ("role", "OwnershipRole")
            ],
            OwnershipAccepted {
                stream_id: 1,
                previous_owner: sender.clone(),
                new_owner: recipient.clone(),
                role: OwnershipRole::Sender,
            }
        ),
        event_case!(
            RateChangeProposed,
            topics: [("stream_id", "u64")],
            data: [
                ("proposed_by", "Address"),
                ("counterparty", "Address"),
                ("amount_per_second", "i128"),
                ("expires_at", "u64")
            ],
            RateChangeProposed {
                stream_id: 1,
                proposed_by: sender.clone(),
                counterparty: recipient.clone(),
                amount_per_second: 10,
                expires_at: 10000,
            }
        ),
        event_case!(
            RateChangeAccepted,
            topics: [("stream_id", "u64")],
            data: [
                ("accepted_by", "Address"),
                ("new_amount_per_second", "i128"),
                ("effective_from", "u64"),
                ("owed_at_change", "i128"),
                ("reserved_at_new_rate", "i128"),
                ("adjustment", "i128"),
                ("deposit", "i128")
            ],
            RateChangeAccepted {
                stream_id: 1,
                accepted_by: recipient.clone(),
                new_amount_per_second: 10,
                effective_from: 500,
                owed_at_change: 250,
                reserved_at_new_rate: 750,
                adjustment: 0,
                deposit: 1000,
            }
        ),
        event_case!(
            GovernanceSignersSet,
            topics: [("set_by", "Address")],
            data: [("signers", "Vec<Address>"), ("veto_window", "u64")],
            GovernanceSignersSet {
                set_by: governor.clone(),
                signers: signers.clone(),
                veto_window: 86400,
            }
        ),
        event_case!(
            GovernanceActionProposed,
            topics: [("proposal_id", "u64")],
            data: [
                ("proposed_by", "Address"),
                ("executable_at", "u64"),
                ("action", "GovernanceAction")
            ],
            GovernanceActionProposed {
                proposal_id: 1,
                proposed_by: sender.clone(),
                executable_at: 10000,
                action: GovernanceAction::SetFrozen(true),
            }
        ),
        event_case!(
            GovernanceActionSigned,
            topics: [("proposal_id", "u64")],
            data: [("signer", "Address"), ("signature_count", "u32")],
            GovernanceActionSigned {
                proposal_id: 1,
                signer: sender.clone(),
                signature_count: 1,
            }
        ),
        event_case!(
            GovernanceActionVetoed,
            topics: [("proposal_id", "u64")],
            data: [("vetoed_by", "Address")],
            GovernanceActionVetoed {
                proposal_id: 1,
                vetoed_by: recipient.clone(),
            }
        ),
        event_case!(
            GovernanceActionExecuted,
            topics: [("proposal_id", "u64")],
            data: [
                ("action", "GovernanceAction"),
                ("signers", "Vec<Address>"),
                ("executed_by", "Address")
            ],
            GovernanceActionExecuted {
                proposal_id: 1,
                action: GovernanceAction::SetFrozen(true),
                signers: signers.clone(),
                executed_by: sender.clone(),
            }
        ),
    ];

    let mut events_json = std::vec![];
    for case in event_cases {
        let topics_arr: StdVec<serde_json::Value> = case
            .topics
            .iter()
            .map(|(n, t)| serde_json::json!({ "name": n, "type": t }))
            .collect();
        let data_arr: StdVec<serde_json::Value> = case
            .data
            .iter()
            .map(|(n, t)| serde_json::json!({ "name": n, "type": t }))
            .collect();
        events_json.push(serde_json::json!({
            "name": case.name,
            "topics": topics_arr,
            "data": data_arr,
            "xdr_sample_hex": hex_str(&case.xdr_bytes),
        }));
    }

    // ── 3. Error codes probe (all 83 codes) ─────────────────────────────────
    let mut error_codes_json = std::vec![];
    for err in StreamError::ALL {
        let code = err.code();
        let name = format!("{:?}", err);
        let retired = code == 2 || code == 3;
        error_codes_json.push(serde_json::json!({
            "code": code,
            "name": name,
            "retired": retired,
        }));
    }

    // ── 4. Wasm spec ────────────────────────────────────────────────────────
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let wasm_path = manifest_dir.join("../../target/wasm32v1-none/release/streampay_contract.wasm");
    let wasm_spec_json = if wasm_path.exists() {
        let wasm_bytes = std::fs::read(&wasm_path).expect("read wasm");
        if let Some(spec_bytes) = extract_contractspecv0(&wasm_bytes) {
            let spec_bytes_soroban = soroban_sdk::Bytes::from_slice(env, &spec_bytes);
            let sha = env.crypto().sha256(&spec_bytes_soroban);
            let sha_arr = sha.to_array();
            serde_json::json!({
                "section_name": "contractspecv0",
                "spec_sha256": hex_str(&sha_arr),
                "spec_size_bytes": spec_bytes.len(),
                "available": true,
            })
        } else {
            serde_json::json!({
                "section_name": "contractspecv0",
                "spec_sha256": null,
                "spec_size_bytes": 0,
                "available": false,
            })
        }
    } else {
        serde_json::json!({
            "section_name": "contractspecv0",
            "spec_sha256": null,
            "spec_size_bytes": 0,
            "available": false,
        })
    };

    serde_json::json!({
        "$schema_version": 1,
        "storage_keys": storage_keys_json,
        "events": events_json,
        "error_codes": error_codes_json,
        "wasm_spec": wasm_spec_json,
    })
}

/// Computes canonical SHA-256 fingerprint from the schema JSON.
pub fn compute_schema_fingerprint(env: &Env, schema_obj: &serde_json::Value) -> String {
    let mut canonical_obj = schema_obj.clone();
    if let Some(obj) = canonical_obj.as_object_mut() {
        obj.remove("fingerprint");
    }
    let canon_str = serde_json::to_string(&canonical_obj).expect("canonical json");
    let canon_bytes = soroban_sdk::Bytes::from_slice(env, canon_str.as_bytes());
    let sha = env.crypto().sha256(&canon_bytes);
    hex_str(&sha.to_array())
}

#[test]
fn schema_fingerprint_matches_stored() {
    let env = Env::default();
    env.mock_all_auths();

    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let fingerprint_file = manifest_dir.join("../../schema/fingerprint.json");

    let mut generated = generate_schema_representation(&env);

    let stored_opt: Option<serde_json::Value> = if fingerprint_file.exists() {
        let content = std::fs::read_to_string(&fingerprint_file).expect("read fingerprint.json");
        serde_json::from_str(&content).ok()
    } else {
        None
    };

    if !generated["wasm_spec"]["available"]
        .as_bool()
        .unwrap_or(false)
    {
        if let Some(ref stored) = stored_opt {
            if let Some(stored_spec) = stored.get("wasm_spec") {
                if stored_spec["available"].as_bool().unwrap_or(false) {
                    generated["wasm_spec"] = stored_spec.clone();
                }
            }
        }
    }

    let fp = compute_schema_fingerprint(&env, &generated);
    generated["fingerprint"] = serde_json::Value::String(fp.clone());

    let bless = std::env::var("STREAMPAY_SCHEMA_BLESS").as_deref() == Ok("1")
        || std::env::var("STREAMPAY_BLESS").as_deref() == Ok("1");

    if bless {
        let schema_dir = manifest_dir.join("../../schema");
        if !schema_dir.exists() {
            std::fs::create_dir_all(&schema_dir).expect("create schema dir");
        }
        let formatted = serde_json::to_string_pretty(&generated).expect("pretty json") + "\n";
        let formatted_lf = formatted.replace("\r\n", "\n");
        std::fs::write(&fingerprint_file, formatted_lf).expect("write blessed fingerprint.json");
        std::println!("Blessed schema fingerprint: {}", fp);
        return;
    }

    assert!(
        fingerprint_file.exists(),
        "schema/fingerprint.json does not exist. Run 'npm run schema:bless' to generate and bless it."
    );

    let stored_raw = std::fs::read_to_string(&fingerprint_file).expect("read fingerprint.json");
    let stored_json: serde_json::Value =
        serde_json::from_str(&stored_raw).expect("parse stored fingerprint.json");

    let stored_fp = stored_json["fingerprint"].as_str().unwrap_or("");
    if stored_fp != fp {
        let gen_keys = serde_json::to_string_pretty(&generated["storage_keys"]).unwrap();
        let sto_keys = serde_json::to_string_pretty(&stored_json["storage_keys"]).unwrap();
        let gen_events = serde_json::to_string_pretty(&generated["events"]).unwrap();
        let sto_events = serde_json::to_string_pretty(&stored_json["events"]).unwrap();
        let gen_errors = serde_json::to_string_pretty(&generated["error_codes"]).unwrap();
        let sto_errors = serde_json::to_string_pretty(&stored_json["error_codes"]).unwrap();

        let mut diff_report = String::new();
        if gen_keys != sto_keys {
            diff_report
                .push_str("  [MISMATCH] Storage layout (keys / shapes / types / serialization)\n");
        }
        if gen_events != sto_events {
            diff_report.push_str("  [MISMATCH] Event payloads (event field names / topics / types / serialization)\n");
        }
        if gen_errors != sto_errors {
            diff_report
                .push_str("  [MISMATCH] Error codes (StreamError numeric codes or variants)\n");
        }
        if generated["wasm_spec"] != stored_json["wasm_spec"] {
            diff_report.push_str("  [MISMATCH] Built Wasm spec (contractspecv0 changed)\n");
        }

        panic!(
            "\n====================================================================\n\
             SCHEMA COMPATIBILITY GUARD FAILURE: CONTRACT INTERFACE CHANGED\n\
             ====================================================================\n\
             The append-only contract interface has been modified:\n\
             Stored fingerprint : {}\n\
             Generated          : {}\n\n\
             Divergence detected in:\n{}\n\
             StreamPay interfaces are append-only. If this change is intentional:\n\
               1. Review the diff carefully to ensure no breaking wire changes.\n\
               2. Update schema/MIGRATION.md with migration analysis for integrators.\n\
               3. Run 'npm run schema:bless' to update schema/fingerprint.json.\n\
             ====================================================================\n",
            stored_fp, fp, diff_report
        );
    }
}
