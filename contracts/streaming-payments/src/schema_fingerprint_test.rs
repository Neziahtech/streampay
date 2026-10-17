//! Schema-fingerprint guard.
//!
//! Regenerates the canonical fingerprint from the compiled interface and
//! asserts it is byte-for-byte identical to the committed artifact at
//! `schema/fingerprint.json`. Any drift — a renamed event field, a renumbered
//! error code, a changed storage-key encoding, a new/removed record field —
//! fails here with a line-level diff.
//!
//! This is the fast, always-on half of the guard. CI additionally regenerates
//! the file via the `schema_fingerprint` example and runs `git diff --exit-code`
//! so drift is caught even if the fingerprint test were ever skipped.
//!
//! To intentionally change the interface: bump `FINGERPRINT_VERSION`, regenerate
//! with the example, and record the migration analysis in `schema/README.md`.

#![cfg(test)]

use std::format;
use std::fs;
use std::path::Path;
use std::string::String;
use std::vec::Vec;

use crate::schema_fingerprint::generate;

#[test]
fn schema_fingerprint_matches_stored() {
    let stored_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("schema/fingerprint.json");
    assert!(
        stored_path.exists(),
        "stored schema fingerprint missing at {stored_path:?}; regenerate it with \
         `cargo run -p streampay-contract --example schema_fingerprint --features schema-fingerprint`"
    );
    let stored =
        fs::read_to_string(&stored_path).expect("stored schema fingerprint must be readable");
    let generated = generate();

    assert!(
        generated == stored,
        "the public interface drifted from schema/fingerprint.json.\n\
         Regenerate with \
         `cargo run -p streampay-contract --example schema_fingerprint --features schema-fingerprint`, \
         then record the migration analysis in schema/README.md.\n{}",
        diff(&stored, &generated)
    );
}

/// Line-level diff between the stored fingerprint (`-`) and the freshly
/// generated one (`+`). Sufficient for the small, line-oriented JSON we emit.
fn diff(stored: &str, generated: &str) -> String {
    let stored_lines: Vec<&str> = stored.lines().collect();
    let generated_lines: Vec<&str> = generated.lines().collect();
    let mut out = String::new();
    let total = stored_lines.len().max(generated_lines.len());
    for i in 0..total {
        let old = stored_lines.get(i).copied().unwrap_or("<missing>");
        let new = generated_lines.get(i).copied().unwrap_or("<missing>");
        if old != new {
            out.push_str(&format!("  line {}:\n    - {old}\n    + {new}\n", i + 1));
        }
    }
    if out.is_empty() {
        // Byte difference with identical lines almost certainly means a
        // trailing-newline or CRLF difference.
        out.push_str("  (line contents match; check trailing whitespace/newlines)\n");
    }
    out
}
