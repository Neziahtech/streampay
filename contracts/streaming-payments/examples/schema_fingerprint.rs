//! Regenerate `schema/fingerprint.json` from the compiled contract interface.
//!
//! This is the authoritative generator invoked by CI and by contributors when
//! an intentional interface change lands. Run it as:
//!
//! ```text
//! cargo run -p streampay-contract --example schema_fingerprint --features schema-fingerprint
//! ```
//!
//! The output is deterministic (LF newlines, trailing newline), so CI can
//! regenerate it and `git diff --exit-code` the result to catch any drift the
//! in-crate `schema_fingerprint_matches_stored` test might have missed.

use std::fs;
use std::path::Path;

use streampay_contract::schema_fingerprint::generate;

fn main() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("schema/fingerprint.json");
    let fingerprint = generate();
    fs::write(&path, fingerprint).expect("failed to write schema fingerprint");
    println!("wrote {}", path.display());
}
