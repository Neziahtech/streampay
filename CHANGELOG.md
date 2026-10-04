# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Contract storage keys, event shapes, and `StreamError` codes are public
interface: they are only ever appended to, never renumbered or reused.

## [Unreleased]

## [0.2.0] - 2026-10-04

### Added
- On-chain address discovery indexes: `recipient_streams` and
  `sender_streams` paginated views (append-only id lists per address,
  creation-ordered, `MAX_PAGE_SIZE = 50`).
- `withdraw_max(stream_id) -> i128` — atomically claim the full accrued
  balance in one call (no read-then-withdraw race).
- New `StreamError::NothingToWithdraw` (code 13, appended).
- `fuzz/` cargo-fuzz harness for the pure accrual math (`streamed_at`),
  with scheduled CI runs (non-blocking).
- Supply-chain CI: `cargo deny` + `cargo audit`, `npm audit`, coverage
  summary, Dependabot (cargo, npm, actions).
- Frontend ESLint gate in CI; stream persistence across sessions;
  `withdraw max` action; on-chain stream discovery via the new indexes.
- Governance: CODEOWNERS, FUNDING.yml, code of conduct, release workflow
  publishing a reproducible Wasm build with SHA-256 digests.
- `scripts/deploy_testnet.sh` one-command testnet demo + `docs/DEMO.md`.

### Changed
- `withdraw` internals refactored into shared CEI-ordered payout path
  (`authorize_withdrawal` + `pay_out`); behavior is unchanged — all
  pre-existing tests pass unmodified.
- Contract crate now also builds as `rlib` (for the fuzz harness); Wasm
  output is unaffected.

## [0.1.0] - 2026-09-13

The initial contract + frontend release, published before git tagging was
adopted (no `v0.1.0` tag exists; tagging begins with `v0.2.0`).

### Added
- Core contract: `create_stream`, `withdraw`, `cancel_stream`, `top_up`,
  `get_stream`, `available` — linear per-second streams with checked
  `u128` math, typed errors (no panics), CEI ordering, TTL maintenance.
- 40 unit + property tests with committed snapshots.
- Minimal Next.js + Freighter frontend (create, list, withdraw, top up,
  cancel).
- CI: test / fmt / clippy(-D warnings) / Wasm build; frontend
  typecheck / build.
- Docs: README, ARCHITECTURE.md, GOOD_FIRST_ISSUES.md, CONTRIBUTING.md,
  SECURITY.md. Apache-2.0.

[Unreleased]: https://github.com/Neziahtech/streampay/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Neziahtech/streampay/releases/tag/v0.2.0
[0.1.0]: https://github.com/Neziahtech/streampay/releases
