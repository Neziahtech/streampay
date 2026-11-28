//! Emergency state migration to a new contract instance (issue #569).
//!
//! The break-glass path for the two failures an in-place upgrade cannot fix:
//! a critical vulnerability in the deployed instance (where upgrading keeps
//! the compromised address, its authorizations and its history) and an
//! instance whose state has grown past what an upgrade can safely carry.
//! It is deliberately distinct from the proxy upgrade (#48) and from schema
//! versioning (#202): those change the code or the layout *in place*; this
//! module moves the *state* to a fresh instance and proves, on-chain, that
//! what arrived is exactly what left.
//!
//! # The protocol
//!
//! **Export (source instance).** Governance begins an export — through the
//! two-key timelock of #119 once governance is bootstrapped
//! ([`GovernanceAction::BeginMigrationExport`]), or directly by the governor
//! before bootstrap, mirroring how `set_frozen` treats risk-reducing admin
//! actions. Beginning an export **freezes the source immediately**: a
//! snapshot taken against live traffic would be a snapshot of nothing in
//! particular. Page zero (the contract globals) is written by the begin call
//! itself; the operator then submits the remaining records in pages. Every
//! record the operator supplies is **checked against this instance's own
//! storage** before it is hashed in — the operator transports records, it
//! cannot author them — and records must arrive in strictly increasing
//! record-key order, so a record can be neither duplicated nor silently
//! reordered. Finalizing folds the page roots into one Merkle root, which is
//! published on-chain in the export session and in the
//! [`MigrationExported`] event.
//!
//! **Import (target instance).** The target must be *fresh* (no streams, no
//! intents). Beginning an import reads the source's published session back
//! **cross-contract** and commits the target to that root and nonce; the
//! root is marked consumed at once, so the same snapshot can never be
//! imported twice into this instance, and the session itself makes a second
//! import of anything impossible. Each imported page is verified three
//! ways: the page root must bind into the committed root (Merkle proof over
//! page roots), the page root must equal what the source instance currently
//! publishes for that page (a second cross-contract read), and every record
//! must carry a valid Merkle proof against the page root. Only then are the
//! records written — through the same storage helpers the live paths use,
//! so an imported stream is indistinguishable from a native one. Pages may
//! arrive in any order but each exactly once. Finalizing asserts page,
//! record and **value** conservation: the total value imported equals the
//! total exported, where a record's value is its outstanding escrow
//! (stream `deposit - withdrawn`, intent remaining escrow, dispute bond,
//! treasury collectible). The target stays frozen after finalization until
//! governance unfreezes it — opening traffic is a separate, visible act.
//!
//! # What a record is
//!
//! The snapshot mirrors the `tools/streampay-state` model: streams,
//! scheduled intents, per-stream disputes and fee records, per-token
//! treasury accounting, sponsor configurations, stream policies (global and
//! per-asset), and one globals record (governor, fee rate, schema version,
//! id counters). Two honest limitations, both consequences of on-chain
//! enumerability: sponsor *beneficiary consent keys* and per-period spend
//! windows are keyed by addresses no on-chain index enumerates, so they do
//! not travel — beneficiaries re-enroll on the new instance (a signature,
//! not a fund movement); and **token custody does not move with the
//! records**: the escrow balances themselves must be transferred to the new
//! instance as an operational step, with [`ExportSession::total_value`] as
//! the amount to reconcile against. State migration moves the ledger's
//! meaning; the runbook moves the money, and the conservation total is what
//! proves the two agree.
//!
//! The operator procedure around this protocol is
//! `docs/emergency-migration.md`.
//!
//! # Merkle construction
//!
//! Leaf: `sha256(0x00 ‖ xdr(record))`. Node: `sha256(0x01 ‖ left ‖ right)`.
//! An odd node at any level is promoted unchanged. The final root is the
//! same tree built over the page roots as leaves. Deterministic for a given
//! record set and page split, and the split itself is committed by the
//! per-page roots the source stores.

use soroban_sdk::{contractclient, contracttype, xdr::ToXdr, Address, Bytes, BytesN, Env, Vec};

use crate::dispute::{self, Dispute};
use crate::errors::StreamError;
use crate::events::{MigrationExported, MigrationFinalized, MigrationImported};
use crate::policy::{self, StreamPolicy};
use crate::schedule::{self, ScheduledIntent};
use crate::sponsor::{self, SponsorConfig};
use crate::stream::{self, DataKey, Stream, TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS};
use crate::surface::{self, Branch};
use crate::treasury::{self, StreamFeeRecord, Treasury};

/// Maximum records per migration page. Bounds the hashing and storage work
/// of a single invocation; an export of N records takes ceil(N / 32) pages.
pub const MAX_MIGRATION_PAGE_RECORDS: u32 = 32;

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Storage keys for the emergency-migration module. A dedicated enum,"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " following the governance/policy/sponsor pattern, so migration state"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " can never collide with the stream wire format."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MigrationDataKey {
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The export session on this (source) instance (instance storage)."
    )]
    ExportSession,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Record key of the last record appended to the export, enforcing"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " the strictly increasing page order (instance storage). Kept out of"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `ExportSession` itself: it is internal to the export, and its"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " dynamic `Bytes` shape must not reach the contract surface."
    )]
    ExportLastKey,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Merkle root of one exported page (persistent storage)."
    )]
    ExportPageRoot(u32),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The import session on this (target) instance (instance storage)."
    )]
    ImportSession,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Whether one page has been imported (persistent storage)."
    )]
    ImportPageDone(u32),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " A migration root already consumed by an import into this"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " instance, mapped to its export nonce (persistent storage)."
    )]
    ConsumedRoot(BytesN<32>),
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " The contract-wide values that travel as page zero's single record:"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " everything about the instance that is not keyed by an id or address."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationGlobals {
    pub governor: Address,
    pub fee_bps: u32,
    pub schema_version: u32,
    pub next_stream_id: u64,
    pub next_intent_id: u64,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " One state record in a migration snapshot. The variants mirror the"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " `tools/streampay-state` snapshot model, extended with the policy and"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " sponsor state that tool reads over RPC."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MigrationRecord {
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Page zero's record; written by `migration_begin_export` itself."
    )]
    Globals(MigrationGlobals),
    Stream(Stream),
    Intent(ScheduledIntent),
    Dispute(Dispute),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Per-stream fee record: stream id and its stored fee record."
    )]
    Fee(u64, StreamFeeRecord),
    #[cfg_attr(not(target_family = "wasm"), doc = " Per-token treasury accounting.")]
    Treasury(Address, Treasury),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " A sponsor's budget configuration, keyed by the sponsor address."
    )]
    Sponsor(Address, SponsorConfig),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " A stream policy: `None` is the global default, `Some(token)` the"
    )]
    #[cfg_attr(not(target_family = "wasm"), doc = " per-asset policy for that token.")]
    Policy(Option<Address>, StreamPolicy),
}

#[cfg_attr(not(target_family = "wasm"), doc = " Export lifecycle phase.")]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExportPhase {
    #[cfg_attr(not(target_family = "wasm"), doc = " Pages are still being appended.")]
    Exporting,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The root is computed and published; the export is immutable."
    )]
    Exported,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " The export session published by a source instance. This struct is"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " the cross-contract interface: a target instance reads it to commit"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " to the root it will import against."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExportSession {
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Monotonic export counter on the source; replayed roots pair with it."
    )]
    pub nonce: u64,
    pub phase: ExportPhase,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The published Merkle root; `None` until finalization."
    )]
    pub root: Option<BytesN<32>>,
    pub pages: u32,
    pub records: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Total outstanding escrow value across all exported records."
    )]
    pub total_value: i128,
    pub started_by: Address,
    pub started_at: u64,
}

#[cfg_attr(not(target_family = "wasm"), doc = " Import lifecycle phase.")]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ImportPhase {
    #[cfg_attr(not(target_family = "wasm"), doc = " Pages are still being imported.")]
    Importing,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Conservation asserted; the migration is complete and irreversible."
    )]
    Imported,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " The import session on a target instance: the commitment it made to"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " one source root, and its progress against that commitment."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImportSession {
    pub source: Address,
    pub nonce: u64,
    pub root: BytesN<32>,
    pub pages: u32,
    pub records: u64,
    pub total_value: i128,
    pub pages_done: u32,
    pub records_done: u64,
    pub value_done: i128,
    pub phase: ImportPhase,
    pub started_by: Address,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " A Merkle inclusion proof for one record within its page: the sibling"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " hashes from the leaf level up to (but excluding) the page root. The"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " leaf index is the record's position within the page."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationProof {
    pub siblings: Vec<BytesN<32>>,
}

/// The read interface an importing instance uses against its source. The
/// source is this same contract at another address; these three views are
/// the whole trust surface of the import — everything else is proofs.
#[contractclient(name = "MigrationSourceClient")]
pub trait MigrationSourceApi {
    fn migration_export(env: Env) -> Option<ExportSession>;
    fn migration_page_root(env: Env, page: u32) -> Option<BytesN<32>>;
    fn is_frozen(env: Env) -> bool;
}

// ---------------------------------------------------------------------------
// Hashing and Merkle trees
// ---------------------------------------------------------------------------

fn sha256(env: &Env, data: &Bytes) -> BytesN<32> {
    BytesN::from_array(env, &env.crypto().sha256(data).to_array())
}

/// Domain-separated leaf hash of one record.
pub fn leaf_hash(env: &Env, record: &MigrationRecord) -> BytesN<32> {
    let mut data = Bytes::new(env);
    data.push_back(0x00);
    data.append(&record.clone().to_xdr(env));
    sha256(env, &data)
}

pub(crate) fn node_hash(env: &Env, left: &BytesN<32>, right: &BytesN<32>) -> BytesN<32> {
    let mut data = Bytes::new(env);
    data.push_back(0x01);
    data.append(&Bytes::from_array(env, &left.to_array()));
    data.append(&Bytes::from_array(env, &right.to_array()));
    sha256(env, &data)
}

/// Merkle root over `leaves` (at least one). Odd nodes are promoted
/// unchanged, so the tree — and therefore the root — is a pure function of
/// the leaf sequence.
pub fn merkle_root(env: &Env, leaves: &Vec<BytesN<32>>) -> BytesN<32> {
    let mut level = leaves.clone();
    while level.len() > 1 {
        let mut next = Vec::new(env);
        let mut i = 0u32;
        while i < level.len() {
            if i + 1 < level.len() {
                next.push_back(node_hash(
                    env,
                    &level.get_unchecked(i),
                    &level.get_unchecked(i + 1),
                ));
            } else {
                next.push_back(level.get_unchecked(i));
            }
            i += 2;
        }
        level = next;
    }
    level.get_unchecked(0)
}

/// Verifies an inclusion proof: folds `leaf` up through `siblings` at
/// position `index` in a tree of `count` leaves and compares against
/// `root`. Mirrors [`merkle_root`]'s promotion rule: the last node of an
/// odd-sized level is promoted unchanged and consumes no sibling at that
/// level, so a proof's length depends on the leaf's position.
pub fn merkle_verify(
    env: &Env,
    root: &BytesN<32>,
    leaf: &BytesN<32>,
    index: u32,
    count: u32,
    siblings: &Vec<BytesN<32>>,
) -> bool {
    if count == 0 || index >= count {
        return false;
    }
    let mut acc = leaf.clone();
    let mut idx = index;
    let mut level_len = count;
    let mut i = 0u32;
    while level_len > 1 {
        let promoted = idx == level_len - 1 && !level_len.is_multiple_of(2);
        if !promoted {
            if i >= siblings.len() {
                return false;
            }
            let sibling = siblings.get_unchecked(i);
            acc = if idx.is_multiple_of(2) {
                node_hash(env, &acc, &sibling)
            } else {
                node_hash(env, &sibling, &acc)
            };
            i += 1;
        }
        idx /= 2;
        level_len = level_len.div_ceil(2);
    }
    i == siblings.len() && &acc == root
}

// ---------------------------------------------------------------------------
// Record keys, values and storage fidelity
// ---------------------------------------------------------------------------

fn address_key_bytes(env: &Env, address: &Address) -> Bytes {
    // StrKey form is fixed-width (56 chars) for account and contract
    // addresses, and its lexicographic order is a perfectly good canonical
    // order: export ordering needs determinism and duplicate detection, not
    // any particular ranking of addresses.
    let text = address.to_string();
    let mut buf = [0u8; 56];
    text.copy_into_slice(&mut buf[..text.len() as usize]);
    Bytes::from_slice(env, &buf[..text.len() as usize])
}

fn key_with_id(env: &Env, rank: u8, id: u64) -> Bytes {
    let mut key = Bytes::new(env);
    key.push_back(rank);
    for byte in id.to_be_bytes() {
        key.push_back(byte);
    }
    key
}

fn key_with_address(env: &Env, rank: u8, address: &Address) -> Bytes {
    let mut key = Bytes::new(env);
    key.push_back(rank);
    key.append(&address_key_bytes(env, address));
    key
}

/// The canonical sort key of a record. Export pages must be in strictly
/// increasing key order across the whole export, which makes every record
/// appear at most once and gives the snapshot a canonical shape: two
/// exports of the same state produce the same pages and the same root.
pub fn record_key(env: &Env, record: &MigrationRecord) -> Bytes {
    match record {
        MigrationRecord::Globals(_) => key_with_id(env, 0, 0),
        MigrationRecord::Stream(s) => key_with_id(env, 1, s.id),
        MigrationRecord::Intent(i) => key_with_id(env, 2, i.id),
        MigrationRecord::Dispute(d) => key_with_id(env, 3, d.stream_id),
        MigrationRecord::Fee(id, _) => key_with_id(env, 4, *id),
        MigrationRecord::Treasury(token, _) => key_with_address(env, 5, token),
        MigrationRecord::Sponsor(sponsor, _) => key_with_address(env, 6, sponsor),
        MigrationRecord::Policy(token, _) => match token {
            None => key_with_id(env, 7, 0),
            Some(token) => key_with_address(env, 8, token),
        },
    }
}

/// Lexicographic byte comparison (Soroban `Bytes` has no `Ord`).
fn bytes_gt(a: &Bytes, b: &Bytes) -> bool {
    let len = a.len().min(b.len());
    let mut i = 0u32;
    while i < len {
        let (x, y) = (a.get_unchecked(i), b.get_unchecked(i));
        if x != y {
            return x > y;
        }
        i += 1;
    }
    a.len() > b.len()
}

/// The outstanding escrow value a record carries — the quantity the
/// conservation check sums. Fee records carry none: fees are accounted
/// inside the treasury totals, and counting them twice would break the
/// equality this function exists to prove.
pub fn record_value(record: &MigrationRecord) -> Result<i128, StreamError> {
    match record {
        MigrationRecord::Globals(_) => Ok(0),
        // Terminal streams hold nothing: a cancelled stream's remainder was
        // split at cancellation and a depleted stream paid out in full, so
        // only a live stream's un-withdrawn deposit is still in escrow.
        MigrationRecord::Stream(s) => match s.status {
            crate::stream::StreamStatus::Active => s
                .deposit
                .checked_sub(s.withdrawn)
                .filter(|v| *v >= 0)
                .ok_or(StreamError::MathOverflow),
            _ => Ok(0),
        },
        MigrationRecord::Intent(i) => i.remaining_escrow(),
        MigrationRecord::Dispute(d) => Ok(d.bond),
        MigrationRecord::Fee(_, _) => Ok(0),
        MigrationRecord::Treasury(_, t) => t.collectible(),
        MigrationRecord::Sponsor(_, _) => Ok(0),
        MigrationRecord::Policy(_, _) => Ok(0),
    }
}

/// Export-side fidelity check: the record the operator supplied must be
/// *the* record this instance stores. The operator is a transport, never a
/// source of truth — a fabricated, stale or mis-keyed record is refused
/// before it can enter the snapshot.
fn verify_against_storage(env: &Env, record: &MigrationRecord) -> Result<(), StreamError> {
    let mismatch = || surface::reject(Branch::MigrationExportRecordMismatch);
    match record {
        MigrationRecord::Globals(_) => Err(mismatch()),
        MigrationRecord::Stream(s) => match stream::get_stream_record(env, s.id) {
            Ok(stored) if &stored.stream == s => Ok(()),
            _ => Err(mismatch()),
        },
        MigrationRecord::Intent(i) => match schedule::get_intent(env, i.id) {
            Ok(stored) if &stored == i => Ok(()),
            _ => Err(mismatch()),
        },
        MigrationRecord::Dispute(d) => match dispute::get_dispute_opt(env, d.stream_id) {
            Some(stored) if &stored == d => Ok(()),
            _ => Err(mismatch()),
        },
        MigrationRecord::Fee(id, record) => match treasury::get_stream_fee_record(env, *id) {
            Some(stored) if &stored == record => Ok(()),
            _ => Err(mismatch()),
        },
        MigrationRecord::Treasury(token, t) => {
            if &treasury::get_treasury(env, token) == t {
                Ok(())
            } else {
                Err(mismatch())
            }
        }
        MigrationRecord::Sponsor(address, cfg) => match sponsor::get_config(env, address) {
            Some(stored) if &stored == cfg => Ok(()),
            _ => Err(mismatch()),
        },
        MigrationRecord::Policy(token, p) => match policy::get_stream_policy(env, token.clone()) {
            Some(stored) if &stored == p => Ok(()),
            _ => Err(mismatch()),
        },
    }
}

/// Import-side write: a proof-verified record lands through the same
/// storage helpers the live paths use, so imported state needs no special
/// casing anywhere else in the contract.
fn write_record(env: &Env, record: &MigrationRecord) {
    match record {
        MigrationRecord::Globals(g) => {
            env.storage()
                .instance()
                .set(&DataKey::Governor, &g.governor);
            treasury::set_fee_bps(env, g.fee_bps);
            env.storage()
                .instance()
                .set(&DataKey::SchemaVersion, &g.schema_version);
            env.storage()
                .persistent()
                .set(&DataKey::NextStreamId, &g.next_stream_id);
            env.storage()
                .persistent()
                .set(&DataKey::NextIntentId, &g.next_intent_id);
        }
        MigrationRecord::Stream(s) => {
            stream::put_stream(env, s);
            stream::index_stream(env, s);
        }
        MigrationRecord::Intent(i) => {
            schedule::put_intent(env, i);
            schedule::index_intent(env, i);
        }
        MigrationRecord::Dispute(d) => dispute::put_dispute(env, d),
        MigrationRecord::Fee(id, record) => treasury::put_stream_fee_record(env, *id, record),
        MigrationRecord::Treasury(token, t) => treasury::put_treasury(env, token, t),
        MigrationRecord::Sponsor(address, cfg) => sponsor::put_config(env, address, cfg),
        MigrationRecord::Policy(token, p) => {
            // The policy setter also publishes the legacy `StreamPolicySet`
            // event; during an import that event is truthful (the policy
            // *is* being set on this instance) and keeps indexers whole.
            let _ = policy::set_stream_policy(env, token.clone(), p.clone());
        }
    }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

pub fn export_session(env: &Env) -> Option<ExportSession> {
    env.storage()
        .instance()
        .get(&MigrationDataKey::ExportSession)
}

fn put_export_session(env: &Env, session: &ExportSession) {
    env.storage()
        .instance()
        .set(&MigrationDataKey::ExportSession, session);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

fn export_last_key(env: &Env) -> Bytes {
    env.storage()
        .instance()
        .get(&MigrationDataKey::ExportLastKey)
        .expect("export last key is written with the session")
}

fn put_export_last_key(env: &Env, key: &Bytes) {
    env.storage()
        .instance()
        .set(&MigrationDataKey::ExportLastKey, key);
}

pub fn import_session(env: &Env) -> Option<ImportSession> {
    env.storage()
        .instance()
        .get(&MigrationDataKey::ImportSession)
}

fn put_import_session(env: &Env, session: &ImportSession) {
    env.storage()
        .instance()
        .set(&MigrationDataKey::ImportSession, session);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

pub fn page_root(env: &Env, page: u32) -> Option<BytesN<32>> {
    env.storage()
        .persistent()
        .get(&MigrationDataKey::ExportPageRoot(page))
}

fn put_page_root(env: &Env, page: u32, root: &BytesN<32>) {
    let key = MigrationDataKey::ExportPageRoot(page);
    env.storage().persistent().set(&key, root);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// The globals record for this instance as it stands right now. This is
/// exactly what [`begin_export`] writes as page zero; after the export
/// begins the instance is frozen, so the value an operator reads here is
/// the value page zero carries — which is what an importing operator needs
/// to assemble page zero's import call.
pub fn current_globals(env: &Env) -> MigrationGlobals {
    MigrationGlobals {
        governor: treasury::governor(env),
        fee_bps: treasury::current_fee_bps(env),
        schema_version: stream::schema_version(env),
        next_stream_id: env
            .storage()
            .persistent()
            .get(&DataKey::NextStreamId)
            .unwrap_or(1),
        next_intent_id: env
            .storage()
            .persistent()
            .get(&DataKey::NextIntentId)
            .unwrap_or(1),
    }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// Begins an export: opens the session and writes page zero (the globals
/// record) itself. The caller (a `lib.rs` entry point or the governance
/// dispatcher) is responsible for authorization and for freezing the
/// contract — freezing is the direct path's `apply_set_frozen`, shared with
/// `set_frozen` and governance, so the freeze audit trail is not split.
/// Returns the export nonce.
pub fn begin_export(env: &Env, actor: &Address) -> Result<u64, StreamError> {
    if export_session(env).is_some() {
        return Err(surface::reject(Branch::MigrationBeginSessionActive));
    }
    let globals = current_globals(env);
    let record = MigrationRecord::Globals(globals);
    let root = merkle_root(env, &Vec::from_array(env, [leaf_hash(env, &record)]));
    put_page_root(env, 0, &root);

    let nonce = 1u64; // one export per instance: the session is never cleared.
    put_export_session(
        env,
        &ExportSession {
            nonce,
            phase: ExportPhase::Exporting,
            root: None,
            pages: 1,
            records: 1,
            total_value: 0,
            started_by: actor.clone(),
            started_at: env.ledger().timestamp(),
        },
    );
    put_export_last_key(env, &record_key(env, &record));
    Ok(nonce)
}

/// Appends one page of operator-supplied records to the export. Every
/// record is verified against this instance's own storage and must sort
/// strictly after the previous page's last record. Returns the page index.
pub fn export_page(env: &Env, records: &Vec<MigrationRecord>) -> Result<u32, StreamError> {
    let mut session =
        export_session(env).ok_or_else(|| surface::reject(Branch::MigrationNoSession))?;
    if session.phase != ExportPhase::Exporting {
        return Err(surface::reject(Branch::MigrationBeginSessionActive));
    }
    if records.is_empty() || records.len() > MAX_MIGRATION_PAGE_RECORDS {
        return Err(surface::reject(Branch::MigrationPageTooLarge));
    }

    let mut leaves = Vec::new(env);
    let mut last_key = export_last_key(env);
    let mut page_value: i128 = 0;
    let mut i = 0u32;
    while i < records.len() {
        let record = records.get_unchecked(i);
        verify_against_storage(env, &record)?;
        let key = record_key(env, &record);
        if !bytes_gt(&key, &last_key) {
            return Err(surface::reject(Branch::MigrationExportPageOutOfOrder));
        }
        last_key = key;
        page_value = page_value
            .checked_add(record_value(&record)?)
            .ok_or(StreamError::MathOverflow)?;
        leaves.push_back(leaf_hash(env, &record));
        i += 1;
    }

    let page = session.pages;
    put_page_root(env, page, &merkle_root(env, &leaves));
    session.pages += 1;
    session.records += records.len() as u64;
    session.total_value = session
        .total_value
        .checked_add(page_value)
        .ok_or(StreamError::MathOverflow)?;
    put_export_last_key(env, &last_key);
    put_export_session(env, &session);
    Ok(page)
}

/// Finalizes the export: folds the page roots into the published root.
/// After this call the snapshot is immutable — the source is frozen and the
/// session refuses further pages.
pub fn finalize_export(env: &Env) -> Result<BytesN<32>, StreamError> {
    let mut session =
        export_session(env).ok_or_else(|| surface::reject(Branch::MigrationNoSession))?;
    if session.phase != ExportPhase::Exporting {
        return Err(surface::reject(Branch::MigrationBeginSessionActive));
    }
    let mut roots = Vec::new(env);
    let mut page = 0u32;
    while page < session.pages {
        // Every page below `session.pages` was written with its root; a
        // missing root here would be storage corruption, and the session
        // check above is the honest failure for it.
        let root =
            page_root(env, page).ok_or_else(|| surface::reject(Branch::MigrationNoSession))?;
        roots.push_back(root);
        page += 1;
    }
    let root = merkle_root(env, &roots);
    session.root = Some(root.clone());
    session.phase = ExportPhase::Exported;
    put_export_session(env, &session);

    MigrationExported {
        source: env.current_contract_address(),
        nonce: session.nonce,
        root: root.clone(),
        records: session.records,
        total_value: session.total_value,
        pages: session.pages,
    }
    .publish(env);
    Ok(root)
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/// Begins an import into this (fresh) instance: reads the source's
/// published export cross-contract, commits this instance to its root, and
/// consumes the root immediately. Returns the committed root.
pub fn begin_import(
    env: &Env,
    actor: &Address,
    source: &Address,
) -> Result<BytesN<32>, StreamError> {
    if let Some(existing) = import_session(env) {
        return Err(match existing.phase {
            ImportPhase::Importing => surface::reject(Branch::MigrationBeginSessionActive),
            ImportPhase::Imported => surface::reject(Branch::MigrationImportRootConsumed),
        });
    }
    // Freshness: the id counters are the instance's whole history. A target
    // that has handed out even one stream or intent id is not a blank
    // instance, and importing into it would interleave two histories under
    // the same ids.
    let next_stream: u64 = env
        .storage()
        .persistent()
        .get(&DataKey::NextStreamId)
        .unwrap_or(1);
    let next_intent: u64 = env
        .storage()
        .persistent()
        .get(&DataKey::NextIntentId)
        .unwrap_or(1);
    if next_stream != 1 || next_intent != 1 {
        return Err(surface::reject(Branch::MigrationImportTargetNotFresh));
    }

    let client = MigrationSourceClient::new(env, source);
    let source_session = client
        .migration_export()
        .ok_or_else(|| surface::reject(Branch::MigrationNoSession))?;
    if source_session.phase != ExportPhase::Exported || !client.is_frozen() {
        return Err(surface::reject(Branch::MigrationSourceExportNotFinal));
    }
    let root = source_session
        .root
        .clone()
        .ok_or_else(|| surface::reject(Branch::MigrationSourceExportNotFinal))?;
    if env
        .storage()
        .persistent()
        .has(&MigrationDataKey::ConsumedRoot(root.clone()))
    {
        return Err(surface::reject(Branch::MigrationImportRootConsumed));
    }

    env.storage().persistent().set(
        &MigrationDataKey::ConsumedRoot(root.clone()),
        &source_session.nonce,
    );
    put_import_session(
        env,
        &ImportSession {
            source: source.clone(),
            nonce: source_session.nonce,
            root: root.clone(),
            pages: source_session.pages,
            records: source_session.records,
            total_value: source_session.total_value,
            pages_done: 0,
            records_done: 0,
            value_done: 0,
            phase: ImportPhase::Importing,
            started_by: actor.clone(),
        },
    );
    Ok(root)
}

/// Imports one page: verifies the page root against the committed root and
/// against the source's own published page root, verifies every record's
/// proof, and only then writes the records.
pub fn import_page(
    env: &Env,
    page: u32,
    page_siblings: &Vec<BytesN<32>>,
    records: &Vec<MigrationRecord>,
    proofs: &Vec<MigrationProof>,
) -> Result<(), StreamError> {
    let mut session =
        import_session(env).ok_or_else(|| surface::reject(Branch::MigrationNoSession))?;
    if session.phase != ImportPhase::Importing {
        return Err(surface::reject(Branch::MigrationBeginSessionActive));
    }
    if page >= session.pages {
        return Err(surface::reject(Branch::MigrationImportPageOutOfRange));
    }
    let done_key = MigrationDataKey::ImportPageDone(page);
    if env.storage().persistent().has(&done_key) {
        return Err(surface::reject(Branch::MigrationImportPageReplay));
    }
    if records.is_empty() || records.len() > MAX_MIGRATION_PAGE_RECORDS {
        return Err(surface::reject(Branch::MigrationPageTooLarge));
    }
    if proofs.len() != records.len() {
        return Err(surface::reject(Branch::MigrationImportProofInvalid));
    }

    // The page root is trusted only when two independent reads agree: the
    // source instance still publishes it, and it folds into the root this
    // instance committed to when the import began.
    let client = MigrationSourceClient::new(env, &session.source);
    let source_page_root = client
        .migration_page_root(&page)
        .ok_or_else(|| surface::reject(Branch::MigrationImportRootMismatch))?;
    if !merkle_verify(
        env,
        &session.root,
        &source_page_root,
        page,
        session.pages,
        page_siblings,
    ) {
        return Err(surface::reject(Branch::MigrationImportRootMismatch));
    }

    let mut page_value: i128 = 0;
    let mut i = 0u32;
    while i < records.len() {
        let record = records.get_unchecked(i);
        let leaf = leaf_hash(env, &record);
        let proof = proofs.get_unchecked(i);
        if !merkle_verify(
            env,
            &source_page_root,
            &leaf,
            i,
            records.len(),
            &proof.siblings,
        ) {
            return Err(surface::reject(Branch::MigrationImportProofInvalid));
        }
        page_value = page_value
            .checked_add(record_value(&record)?)
            .ok_or(StreamError::MathOverflow)?;
        i += 1;
    }

    // All proofs verified before any write: a page lands whole or not at
    // all (and a failing invocation would roll back regardless — the order
    // documents the intent and keeps the trace honest).
    let mut i = 0u32;
    while i < records.len() {
        write_record(env, &records.get_unchecked(i));
        i += 1;
    }

    env.storage().persistent().set(&done_key, &true);
    env.storage()
        .persistent()
        .extend_ttl(&done_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    session.pages_done += 1;
    session.records_done += records.len() as u64;
    session.value_done = session
        .value_done
        .checked_add(page_value)
        .ok_or(StreamError::MathOverflow)?;
    put_import_session(env, &session);
    Ok(())
}

/// Finalizes the import: asserts page, record and value conservation
/// against the commitment made in [`begin_import`], then closes the
/// migration. The instance stays frozen; unfreezing is governance's
/// separate, visible act.
pub fn finalize_import(env: &Env) -> Result<(), StreamError> {
    let mut session =
        import_session(env).ok_or_else(|| surface::reject(Branch::MigrationNoSession))?;
    if session.phase != ImportPhase::Importing {
        return Err(surface::reject(Branch::MigrationBeginSessionActive));
    }
    if session.pages_done != session.pages || session.records_done != session.records {
        return Err(surface::reject(Branch::MigrationFinalizeImportIncomplete));
    }
    if session.value_done != session.total_value {
        return Err(surface::reject(Branch::MigrationConservationTotalMismatch));
    }
    session.phase = ImportPhase::Imported;
    put_import_session(env, &session);

    MigrationImported {
        source: session.source.clone(),
        nonce: session.nonce,
        root: session.root.clone(),
        records: session.records,
        total_value: session.total_value,
        pages: session.pages,
    }
    .publish(env);
    MigrationFinalized {
        source: session.source.clone(),
        nonce: session.nonce,
        root: session.root.clone(),
    }
    .publish(env);
    Ok(())
}
