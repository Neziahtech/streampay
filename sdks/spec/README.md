# Canonical spec

`streampay.spec.json` is the single input to every generated client.

## Contents

* `functions` — name, documentation, ordered arguments (names + IR types),
  return type, whether the call is fallible (`error`), required auth, and
  whether it mutates state
* `structs` / `enums` — contract types used by entrypoints
* `events` — event name, topic symbol, topic fields, data fields (this is the
  exact layout `#[contractevent]` emits: `[symbol(topic), topic fields…]` plus
  a symbol-keyed data map)
* `errors` — `StreamError` names and stable numeric codes
* `constants` — `MAX_DURATION_SECONDS`, `MAX_PAGE_SIZE` (with their Rust type)

IR types are a small language: `address`, `bool`, `i128`, `u64`, `u32`,
`void`, `Stream`, `StreamStatus`, and `{ "vec": "u64" }`.

## The spec is the contract

`sdks/generator/check_contract_surface.py` parses the contract sources
(`lib.rs`, `stream.rs`, `events.rs`, `errors.rs`) and fails when the IR drifts
from them. It also verifies `FINGERPRINT`, the sha256 of the canonical JSON
(sorted keys, compact separators). CI runs the guard and then
`generate.py --check`, so neither the spec nor the clients can silently fall
behind the contract.

## Changing the contract

1. Update the contract and its tests.
2. Update `streampay.spec.json` to match (only after the contract change is
   intentional — the guard is what makes this safe).
3. Run `python3 sdks/generator/check_contract_surface.py --update-fingerprint`.
4. Run `make -C sdks generate` (needs `rustfmt`).
5. Rebuild the vectors if the wire shape changed: `make -C sdks vectors`.
6. Run `make -C sdks check test conformance`.

Removing or renaming anything is a breaking contract change; bump the SDK
minor/major version per [`../README.md`](../README.md#versioning-policy).

## Provenance

The IR is authored from the Rust sources and cross-checked in both directions
by the guard: it compares parsed contract functions/types/events/errors to the
IR, not just a hash. `SPEC_FINGERPRINT` is embedded in every SDK and in every
vector, so a mismatch between a client and a fixture fails loudly.
