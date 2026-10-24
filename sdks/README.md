# StreamPay client SDKs

Typed clients for the StreamPay Soroban contract, generated from one canonical
spec.

| Language | Package | Status |
|---|---|---|
| TypeScript | [`@streampay/sdk`](./typescript) (workspace only, not on npm) | in this change |
| Rust | `streampay-sdk` | follow-up PR |
| Python | `streampay-sdk` | follow-up PR |

The Rust and Python clients were split out of this change so each language can
be reviewed against the shared spec on its own. The spec and generator land
first; each SDK then adds only its package, runtime, and test suite.

## Layout

```text
sdks/
  spec/streampay.spec.json     canonical contract IR + sha256 fingerprint
  spec/FINGERPRINT             sha256 of the canonical JSON
  generator/check_contract_surface.py
                               derives the IR from the Rust contract; coverage tests
  generator/generate.py        IR -> TypeScript (generated.ts + methods.ts)
  vectors/                     shared conformance fixtures (tx + events + result)
  typescript/                  generated bindings + runtime + tests
  Makefile                     generate / check / test / vectors
```

## The contract is the source of truth

`sdks/spec/streampay.spec.json` is checked in, but it is **derived**, not
hand-maintained:

```bash
python3 sdks/generator/check_contract_surface.py --write-spec
```

parses `contracts/streaming-payments/src/*.rs` and rewrites the IR from the
contract's own surface:

* every `pub fn` in the `#[contractimpl]` block (the deploy-time
  `__constructor` is not a client operation), with ordered arguments, argument
  types, return types, and fallibility
* every `#[contracttype]` struct/enum reachable from an entrypoint or event
* event names, topic symbols, topic fields, and data fields
* numeric constants clients need (`MAX_PAGE_SIZE`, `MAX_BATCH`, fee bounds, …)

The normal (no-flag) run is the CI gate: it re-derives the IR and reports any
drift. `sdks/generator/test_contract_surface.py` additionally fails when the
spec's operation set is smaller than the contract's, and when an entrypoint
named by the contract's own `surface.rs` branch registry is missing. That makes
the coverage claim structural: adding a contract entrypoint without extending
the spec is a red build, not a documentation bug.

### Error codes come from the catalog

The generator does **not** restate `StreamError`. It reads the canonical catalog
in `frontend/lib/errors.ts`, which `tooling/generate-error-catalog.mjs`
generates from `contracts/streaming-payments/src/errors.rs` and CI already gates
for drift. A new error code therefore reaches the SDK by regenerating the
catalog, and the SDK regeneration check fails until the client is refreshed.

## Generation, not hand-writing

```bash
make -C sdks generate      # rewrite generated.ts + methods.ts
make -C sdks check         # guard + coverage tests + "regeneration is a no-op"
```

Generated files carry the spec fingerprint in their header. Hand edits inside
`generated.ts` / `methods.ts` are overwritten; add behaviour in `client.ts`,
`events.ts`, or the spec.

## Conformance vectors

`sdks/vectors/*.json` contains signed transaction envelopes, contract-event
XDR, and result ScVals, plus the canonical decode every SDK must produce. The
fixtures are deterministic: fixed key seeds, fixed fee, no time bounds.

```bash
make -C sdks vectors       # rebuild the fixtures
make -C sdks test          # TypeScript decodes every fixture to its expectation
```

The vectors are language-agnostic. The TypeScript suite consumes them today;
the Rust and Python follow-ups will consume the same files, and their decoders
must equal the recorded expectation before they land.

## Versioning policy

The SDK tracks the contract release line (currently `0.3.0`).

* **Patch** (`0.3.1`): runtime/documentation fixes, no wire changes.
* **Minor** (`0.4.0`): new contract entrypoints/events/errors, or additive SDK
  helpers. Previously generated code keeps working because Soroban only appends
  API surface.
* **Major** (`1.0.0`): breaking wire changes, including removals, renames,
  re-typed arguments/returns, renumbered errors, or event topic changes. While
  in `0.x`, a breaking contract change bumps the **minor** position and is
  called out in `CHANGELOG.md`.
* Every language shares the version. Published versions are immutable;
  deprecate rather than overwrite.
* `SPEC_FINGERPRINT` is exported by every SDK. Indexers and bots can assert it
  matches the deployment they are talking to.

## Publishing

None of the packages is on a public registry yet. `@streampay/sdk` is **not**
published to npm, so the install path is the workspace or an `npm pack`
tarball (see [`typescript/README.md`](./typescript/README.md#install)).

If the project decides to publish, the StreamPay maintainers (the Neziahtech
organisation owners) own the release: they hold the npm scope and decide the
release path. The SDK PR itself does not publish or claim a registry presence.

## Known limitations

* **TypeScript** decodes nested `Result` values from batch entrypoints as
  `{ ok } | { error }`; the `Err` arm carries the `StreamError` name from the
  catalog.
* There is no live-network test. CI uses recorded vectors and an in-process
  fake RPC, so it is deterministic and never needs funded testnet accounts.
