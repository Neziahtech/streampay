# StreamPay client SDKs

Typed clients for the StreamPay Soroban contract, generated from one canonical
spec:

| Language | Package | Runtime deps |
|---|---|---|
| Rust | [`streampay-sdk`](./rust) | `stellar-xdr`, `stellar-strkey`, `serde_json` |
| TypeScript | [`@streampay/sdk`](./typescript) | `@stellar/stellar-sdk` |
| Python | [`streampay-sdk`](./python) | none (stdlib only) |

Each client has typed entrypoints with argument encoding and result decoding,
contract-event decoding, and index-pagination helpers. The same conformance
vectors are decoded by all three in CI.

## Layout

```text
sdks/
  spec/streampay.spec.json     canonical contract IR + sha256 fingerprint
  generator/generate.py        IR -> generated.rs / generated.ts / _generated.py
  generator/check_contract_surface.py
                               schema guard: IR vs the Rust contract sources
  vectors/                     shared conformance fixtures (tx + events + result)
  rust/                        generated bindings + runtime + tests
  typescript/                  generated bindings + client + scripts/tests
  python/                      generated bindings + client + tests
  conformance/run.sh           runs all three decoders and diffs them
  Makefile                     generate / check / test / conformance
```

## Generation, not hand-writing

The contract is the source of truth. `sdks/spec/streampay.spec.json` is a
checked-in IR (functions, argument types, structs, enums, events, error codes,
constants) with a sha256 fingerprint. Everything language-specific is emitted
from it:

```bash
make -C sdks generate      # rewrite the three generated files
make -C sdks check         # guard + "regeneration is a no-op" CI gate
```

`check_contract_surface.py` parses `contracts/streaming-payments/src/*.rs` and
fails when the IR and the contract disagree on:

* function names, argument names/types, return types, fallibility
* `Stream` fields, `StreamStatus` cases, constants
* `StreamError` variant names and numeric codes
* event names, topic symbols, topic fields, data fields
* the recorded fingerprint

So a contract change cannot silently ship stale clients: either the spec is
updated (and the clients regenerated), or CI fails.

The generator also runs `rustfmt` on the Rust output, which keeps
`cargo fmt --check` green without hand-editing generated files. CI installs
rustfmt for the spec job.

### Escape hatches

Generated code is not a cage:

* **Rust:** `Client` is transport-agnostic. Implement `Transport` once
  (RPC client, test double, hardware signer service) and every typed method
  works. `vectors::decode_vector` is public if you need the conformance
  decoder in your own tooling.
* **TypeScript:** every `encode*Args` / `decode*Result` / `decodeStreamPayEvent`
  helper is exported, so you can compose calls in your own transaction builder
  instead of using `StreamPayClient`. A custom `Signer` covers Freighter,
  server keys, or remote signing.
* **Python:** `build_invoke_envelope` + `read_scval_b64` are public, so you can
  use the typed codecs without the bundled RPC client. `Client` accepts any
  signer with `public_key()` and `sign(envelope, passphrase)`.

Hand edits inside generated files are overwritten. Add behaviour in the runtime
files (`client.*`, `xdr.py`, `lib.rs`) or via the spec, never in
`generated.*` / `_generated.py`.

## Conformance

`sdks/vectors/*.json` contains signed transaction envelopes, contract-event
XDR, and result ScVals, plus the canonical decode every SDK must produce. See
[`vectors/README.md`](./vectors/README.md) for provenance and the canonical
format. The event payloads are copied verbatim from the values the contract's
own Rust tests emitted (test snapshots); the envelopes are real signed Soroban
invoke transactions built from the same values.

```bash
make -C sdks conformance
# or: ./sdks/conformance/run.sh
```

The runner executes the Rust, TypeScript, and Python decoders independently,
then requires **all three to equal each other and the recorded expectation**.
CI runs this on every SDK change.

## Versioning policy

The three packages share one version and track the contract release line
(currently `0.3.0`), released from a tag of the form `sdk-v0.3.0`.

* **Patch** (`0.3.1`): runtime/documentation fixes, no wire changes.
  Generated bindings are byte-identical to `0.3.0`.
* **Minor** (`0.4.0`): new contract entrypoints/events/errors, or additive SDK
  helpers. The spec fingerprint changes; previously generated code keeps
  working because Soroban only appends API surface.
* **Major** (`1.0.0`): breaking wire changes, including removals, renames,
  re-typed arguments/returns, renumbered errors, or event topic changes. While
  in `0.x`, a breaking contract change bumps the **minor** position and is
  called out in `CHANGELOG.md`.
* All three packages always share a version. `version-check` in the publish
  workflow enforces this and that the tag matches.
* Published versions are immutable. Yank/deprecate instead of overwriting;
  deprecations are announced one minor release before removal.
* `SPEC_FINGERPRINT` is exported by every SDK. Indexers and bots can assert it
  matches the deployment they are talking to.

## Publishing

`.github/workflows/sdk-publish.yml` publishes all three packages from a
`sdk-v*` tag:

1. `version-check` — Rust/npm/PyPI versions agree and match the tag.
2. `crates` — `cargo publish` with `CARGO_REGISTRY_TOKEN`.
3. `npm` — `npm publish --access public --provenance` with `NPM_TOKEN`.
4. `testpypi` — builds sdist + wheel and uploads to TestPyPI with
   `TEST_PYPI_API_TOKEN`; also available via **workflow_dispatch** (the
   test-publish demonstration path that never touches PyPI proper).
5. `pypi` — protected `pypi` environment, `PYPI_API_TOKEN`.

Nothing is uploaded from CI pull requests. Packaging is verified without
network credentials on every SDK CI run:

```bash
make -C sdks publish-dry-run
# cargo publish --dry-run / npm publish --dry-run / python -m build + twine check
```

### One-time registry setup

* crates.io: create the crate name, add `CARGO_REGISTRY_TOKEN`.
* npm: create the `@streampay` scope, add `NPM_TOKEN` (automation token).
* TestPyPI/PyPI: register `streampay-sdk`, add the tokens above. Prefer
  [trusted publishing](https://docs.pypi.org/trusted-publishers/) in the `pypi`
  environment; the workflow already grants `id-token: write`.

## Known limitations (documented, not hidden)

* **Rust** ships a transport trait, not an HTTP transport. Typed calls,
  event decoding, pagination, and vector decoding are complete and tested;
  wiring a specific RPC/signing stack is the documented escape hatch.
* **Python** decodes envelopes before Soroban transaction data is attached
  (unsigned/simulate-time envelopes). `read_envelope_b64` raises a clear error
  for `ext v1` rather than guessing.
* **Write results** in the Python client are decoded from the simulation
  response after the transaction is included. The transaction status is
  checked; the returned value is the pre-inclusion simulation result.
* The Rust crate and Python package have no live-network test. CI tests use
  recorded vectors and an in-process fake RPC, so they are deterministic and
  never need funded testnet accounts.
