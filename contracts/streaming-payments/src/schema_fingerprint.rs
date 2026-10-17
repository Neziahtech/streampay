//! Canonical, append-only schema fingerprint for StreamPay's public interface.
//!
//! The fingerprint is generated mechanically from the compiled contract
//! interface — the same XDR spec entries the `#[contracttype]`,
//! `#[contracterror]` and `#[contractevent]` derives embed in the Wasm's
//! `contractspecv0` section — plus a probe that serializes every storage-key
//! variant and describes every emitted event. It is committed as
//! `schema/fingerprint.json` and enforced by CI: a regeneration-and-diff step
//! fails the build the instant the published surface drifts.
//!
//! # What is guarded
//!
//! - **error codes** — every [`StreamError`] variant's stable numeric wire code
//!   and name (renumbering or renaming any variant changes the file);
//! - **storage keys** — every [`DataKey`] variant's shape *and* its actual
//!   serialized `ScVal` XDR, so changing how a key encodes changes the file;
//! - **stored records** — the field names and types of every `#[contracttype]`
//!   value;
//! - **events** — each event's topic/data parameter names and types.
//!
//! Documentation comments are intentionally *not* part of the fingerprint, so
//! editing a doc never trips the guard; only the interface itself does.
//!
//! Nothing here should ever change except by adding new entries at the bottom.
//! Editing an existing entry is a breaking interface change and must be
//! accompanied by a version bump and migration analysis (see `schema/README.md`).
//!
//! # Regenerating
//!
//! ```text
//! cargo run -p streampay-contract --example schema_fingerprint --features schema-fingerprint
//! ```
//!
//! The module is compiled only for tests and for the `schema-fingerprint`
//! feature, so it never touches the Wasm build.

#![cfg(any(test, feature = "schema-fingerprint"))]

use std::format;
use std::string::String;
use std::vec::Vec;

use soroban_sdk::xdr::{
    Limits, ReadXdr, ScSpecEntry, ScSpecEventParamLocationV0, ScSpecTypeDef, ScSpecUdtUnionCaseV0,
    ToXdr,
};
use soroban_sdk::{Address, Bytes, Env};

use crate::errors::StreamError;
use crate::events;
use crate::stream::{DataKey, Stream, StreamStatus};
use crate::treasury::{FeeScan, StreamFeeRecord, Treasury, TreasuryStatus};

/// The schema version recorded in `fingerprint.json`. Bump this (and the
/// matching `version` field is regenerated automatically) every time an
/// accepted interface change is made, so downstream integrators can detect
/// that the published surface moved; record the migration notes in
/// `schema/README.md` / the PR.
pub const FINGERPRINT_VERSION: u32 = 1;

/// A fixed, deterministic sample address used when serializing key variants
/// that carry an `Address`. It is the all-zero contract id
/// (`CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4`); the actual
/// bytes never matter, only that they are stable across regenerations.
const SAMPLE_ADDRESS: &str = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

/// A fixed sample stream id for the `u64`-carrying key variants.
const SAMPLE_STREAM_ID: u64 = 1;

/// Generate the canonical fingerprint as pretty, stable JSON (LF newlines,
/// trailing newline). Deterministic: running it twice always yields identical
/// bytes.
#[must_use]
pub fn generate() -> String {
    let env = Env::default();
    let sample = Address::from_str(&env, SAMPLE_ADDRESS);

    // Bind each spec to a local so the `&[u8]` slices below outlive the call.
    let err_spec = StreamError::spec_xdr();
    let data_key_spec = DataKey::spec_xdr();
    let stream_spec = Stream::spec_xdr();
    let stream_status_spec = StreamStatus::spec_xdr();
    let treasury_spec = Treasury::spec_xdr();
    let stream_fee_spec = StreamFeeRecord::spec_xdr();
    let treasury_status_spec = TreasuryStatus::spec_xdr();
    let fee_scan_spec = FeeScan::spec_xdr();

    let ev_created = events::StreamCreated::spec_xdr();
    let ev_withdrawn = events::Withdrawn::spec_xdr();
    let ev_cancelled = events::StreamCancelled::spec_xdr();
    let ev_topped_up = events::StreamToppedUp::spec_xdr();
    let ev_fee_charged = events::FeeCharged::spec_xdr();
    let ev_fee_withdrawn = events::FeeWithdrawn::spec_xdr();

    let mut out = String::new();
    out.push_str("{\n");
    out.push_str(&format!("  \"version\": {FINGERPRINT_VERSION},\n"));
    out.push_str(
        "  \"description\": \"Append-only fingerprint of the StreamPay public interface. Regenerate with `cargo run -p streampay-contract --example schema_fingerprint --features schema-fingerprint`; never edit by hand.\",\n",
    );

    // ------------------------------------------------------------- errors
    out.push_str("  \"errors\": [\n");
    let error_lines = match decode(err_spec.as_slice()) {
        ScSpecEntry::UdtErrorEnumV0(e) => e
            .cases
            .iter()
            .map(|c| format!("    {{ \"code\": {}, \"name\": \"{}\" }}", c.value, c.name))
            .collect::<Vec<_>>(),
        other => panic!("StreamError spec is not an error enum: {other:?}"),
    };
    out.push_str(&error_lines.join(",\n"));
    out.push_str("\n  ],\n");

    // ------------------------------------------------------ storage keys
    let keys: Vec<(&str, DataKey)> = std::vec![
        ("NextStreamId", DataKey::NextStreamId),
        ("Stream(u64)", DataKey::Stream(SAMPLE_STREAM_ID)),
        (
            "RecipientStreams(Address)",
            DataKey::RecipientStreams(sample.clone())
        ),
        (
            "SenderStreams(Address)",
            DataKey::SenderStreams(sample.clone())
        ),
        ("Governor", DataKey::Governor),
        ("PendingGovernor", DataKey::PendingGovernor),
        ("FeeBps", DataKey::FeeBps),
        ("Treasury(Address)", DataKey::Treasury(sample.clone())),
        ("StreamFee(u64)", DataKey::StreamFee(SAMPLE_STREAM_ID)),
    ];
    out.push_str("  \"storage_keys\": [\n");
    let key_lines = keys
        .iter()
        .map(|(variant, key)| {
            format!(
                "    {{ \"variant\": \"{variant}\", \"encoded\": \"{}\" }}",
                encode_key(&env, key)
            )
        })
        .collect::<Vec<_>>();
    out.push_str(&key_lines.join(",\n"));
    out.push_str("\n  ],\n");

    // --------------------------------------------------- stored records
    let records: Vec<(&str, &[u8])> = std::vec![
        ("DataKey", data_key_spec.as_slice()),
        ("Stream", stream_spec.as_slice()),
        ("StreamStatus", stream_status_spec.as_slice()),
        ("Treasury", treasury_spec.as_slice()),
        ("StreamFeeRecord", stream_fee_spec.as_slice()),
        ("TreasuryStatus", treasury_status_spec.as_slice()),
        ("FeeScan", fee_scan_spec.as_slice()),
    ];
    out.push_str("  \"storage_records\": [\n");
    let record_lines = records
        .iter()
        .map(|(name, spec)| record_json(name, spec))
        .collect::<Vec<_>>();
    out.push_str(&record_lines.join(",\n"));
    out.push_str("\n  ],\n");

    // ------------------------------------------------------------- events
    let event_specs: Vec<(&str, &[u8])> = std::vec![
        ("StreamCreated", ev_created.as_slice()),
        ("Withdrawn", ev_withdrawn.as_slice()),
        ("StreamCancelled", ev_cancelled.as_slice()),
        ("StreamToppedUp", ev_topped_up.as_slice()),
        ("FeeCharged", ev_fee_charged.as_slice()),
        ("FeeWithdrawn", ev_fee_withdrawn.as_slice()),
    ];
    out.push_str("  \"events\": [\n");
    let event_lines = event_specs
        .iter()
        .map(|(name, spec)| event_json(name, spec))
        .collect::<Vec<_>>();
    out.push_str(&event_lines.join(",\n"));
    out.push_str("\n  ]\n");

    out.push_str("}\n");
    out
}

/// Serialize a `DataKey` the way the host stores it: convert to a `Val`, then
/// to its `ScVal` XDR form (the exact bytes that land in the ledger key).
fn encode_key(env: &Env, key: &DataKey) -> String {
    let bytes: Bytes = key.clone().to_xdr(env);
    let len = bytes.len() as usize;
    let mut buf = std::vec![0u8; len];
    bytes.copy_into_slice(&mut buf);
    hex(&buf)
}

/// Decode one embedded `ScSpecEntry`.
fn decode(spec: &[u8]) -> ScSpecEntry {
    ScSpecEntry::from_xdr(spec, Limits::none()).expect("contract spec XDR must decode")
}

/// Render one `#[contracttype]` value as a single JSON object line.
fn record_json(name: &str, spec: &[u8]) -> String {
    match decode(spec) {
        ScSpecEntry::UdtStructV0(s) => {
            let fields = s
                .fields
                .iter()
                .map(|f| format!("{}: {}", f.name, type_name(&f.type_)))
                .collect::<Vec<_>>();
            format!(
                "    {{ \"kind\": \"struct\", \"name\": \"{name}\", \"fields\": [{}] }}",
                quoted_list(&fields)
            )
        }
        ScSpecEntry::UdtUnionV0(u) => {
            let cases = u
                .cases
                .iter()
                .map(|c| match c {
                    ScSpecUdtUnionCaseV0::VoidV0(v) => format!("\"{}\"", v.name),
                    ScSpecUdtUnionCaseV0::TupleV0(t) => {
                        let types = t
                            .type_
                            .iter()
                            .map(|x| format!("\"{}\"", type_name(x)))
                            .collect::<Vec<_>>();
                        format!(
                            "{{ \"case\": \"{}\", \"types\": [{}] }}",
                            t.name,
                            types.join(", ")
                        )
                    }
                })
                .collect::<Vec<_>>();
            format!(
                "    {{ \"kind\": \"union\", \"name\": \"{name}\", \"cases\": [{}] }}",
                cases.join(", ")
            )
        }
        ScSpecEntry::UdtEnumV0(e) => {
            let cases = e
                .cases
                .iter()
                .map(|c| format!("{{ \"case\": \"{}\", \"value\": {} }}", c.name, c.value))
                .collect::<Vec<_>>();
            format!(
                "    {{ \"kind\": \"enum\", \"name\": \"{name}\", \"cases\": [{}] }}",
                cases.join(", ")
            )
        }
        other => panic!("unexpected spec entry for record {name}: {other:?}"),
    }
}

/// Render one `#[contractevent]` value as a single JSON object line.
fn event_json(name: &str, spec: &[u8]) -> String {
    match decode(spec) {
        ScSpecEntry::EventV0(e) => {
            let topics = e
                .params
                .iter()
                .filter(|p| p.location == ScSpecEventParamLocationV0::TopicList)
                .map(param_name_type)
                .collect::<Vec<_>>();
            let data = e
                .params
                .iter()
                .filter(|p| p.location == ScSpecEventParamLocationV0::Data)
                .map(param_name_type)
                .collect::<Vec<_>>();
            format!(
                "    {{ \"name\": \"{name}\", \"topics\": [{}], \"data\": [{}] }}",
                quoted_list(&topics),
                quoted_list(&data)
            )
        }
        other => panic!("unexpected spec entry for event {name}: {other:?}"),
    }
}

/// `name: type` for one event parameter.
fn param_name_type(p: &soroban_sdk::xdr::ScSpecEventParamV0) -> String {
    format!("{}: {}", p.name, type_name(&p.type_))
}

/// Rust-like rendering of an XDR spec type, stable across regenerations.
fn type_name(t: &ScSpecTypeDef) -> String {
    match t {
        ScSpecTypeDef::Val => "val".into(),
        ScSpecTypeDef::Bool => "bool".into(),
        ScSpecTypeDef::Void => "void".into(),
        ScSpecTypeDef::Error => "error".into(),
        ScSpecTypeDef::U32 => "u32".into(),
        ScSpecTypeDef::I32 => "i32".into(),
        ScSpecTypeDef::U64 => "u64".into(),
        ScSpecTypeDef::I64 => "i64".into(),
        ScSpecTypeDef::Timepoint => "timepoint".into(),
        ScSpecTypeDef::Duration => "duration".into(),
        ScSpecTypeDef::U128 => "u128".into(),
        ScSpecTypeDef::I128 => "i128".into(),
        ScSpecTypeDef::U256 => "u256".into(),
        ScSpecTypeDef::I256 => "i256".into(),
        ScSpecTypeDef::Bytes => "bytes".into(),
        ScSpecTypeDef::String => "string".into(),
        ScSpecTypeDef::Symbol => "symbol".into(),
        ScSpecTypeDef::Address => "Address".into(),
        ScSpecTypeDef::MuxedAddress => "MuxedAddress".into(),
        ScSpecTypeDef::Option(o) => format!("Option<{}>", type_name(&o.value_type)),
        ScSpecTypeDef::Result(r) => format!(
            "Result<{}, {}>",
            type_name(&r.ok_type),
            type_name(&r.error_type)
        ),
        ScSpecTypeDef::Vec(v) => format!("Vec<{}>", type_name(&v.element_type)),
        ScSpecTypeDef::Map(m) => format!(
            "Map<{}, {}>",
            type_name(&m.key_type),
            type_name(&m.value_type)
        ),
        ScSpecTypeDef::Tuple(t) => {
            let types = t.value_types.iter().map(type_name).collect::<Vec<_>>();
            format!("({})", types.join(", "))
        }
        ScSpecTypeDef::BytesN(b) => format!("BytesN<{}>", b.n),
        ScSpecTypeDef::Udt(u) => format!("{}", u.name),
    }
}

/// Join already-safe strings into a JSON string array.
fn quoted_list(items: &[String]) -> String {
    items
        .iter()
        .map(|s| format!("\"{s}\""))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Lowercase hex encoding.
fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}
