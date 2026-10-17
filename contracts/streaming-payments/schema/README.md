# Public interface fingerprint (append-only)

`fingerprint.json` is the canonical, committed description of the contract's
public interface surface. It exists so that any change to that surface is
caught in CI and must be accompanied by an explicit, reviewed decision instead
of slipping in silently.

The fingerprint captures three classes of interface:

- **Error codes** — every variant of `StreamError` with its numeric code.
- **Storage keys** — every `DataKey` variant, both its shape and the exact
  XDR bytes it serializes to on-chain (so a reordering or encoding change is a
  visible diff, not a silent one).
- **Storage records and events** — every `#[contracttype]` value and every
  `#[contractevent]`, with the names and types of their fields, cases, topics,
  and data payloads.

## Files

- `fingerprint.json` — the canonical fingerprint. Human-readable, one entry per
  line, so `git diff` shows precisely what changed. **Do not edit it by hand.**
  The `version` field is the single source of truth for the schema version.

## Generating

The fingerprint is produced by the `schema_fingerprint` example, which decodes
the interface descriptions the SDK emits at compile time (the `spec_xdr()` of
each `#[contracttype]`, `#[contracterror]`, and `#[contractevent]`) and encodes
sample values of every `DataKey` with `Env::default()`:

```
cargo run -p streampay-contract --example schema_fingerprint --features schema-fingerprint
```

That overwrites `fingerprint.json` in place. The feature is host-only and is
never enabled for the release Wasm build, so none of this diagnostic code ships
on-chain.

## Enforcement

`schema_fingerprint_test::schema_fingerprint_matches_stored` regenerates the
fingerprint in memory and compares it against the committed file, failing with a
line-level diff on any mismatch. CI runs the test suite, so interface drift
fails the build.

The generator deliberately does **not** include doc comments or other
documentation in the fingerprint: editing a comment never trips the guard, only
a change to the interface itself does.

## Changing the interface

The fingerprint is append-only: once a version is published, existing entries
must not be altered in place. When an interface change is genuinely required:

1. Update the interface in `src/`.
2. Regenerate: `cargo run -p streampay-contract --example schema_fingerprint --features schema-fingerprint`.
3. Bump `FINGERPRINT_VERSION` in `src/schema_fingerprint.rs` and the matching
   `version` in `fingerprint.json`.
4. Add migration notes describing the change and its impact on existing
   integrators/state in the PR description (or a dedicated doc).

The diff produced by step 2 is the authoritative record of what changed.
