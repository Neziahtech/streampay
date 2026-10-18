## What

<!-- One or two sentences: what changes and why. Link issues with "Fixes #N". -->

## Contract impact

- [ ] No public API change (signatures / error codes / events)
- [ ] Error codes appended (not renumbered)
- [ ] Error catalog entries reviewed (remediations and client mapping verified)
- [ ] New behavior covered by tests
- [ ] `docs/ARCHITECTURE.md` updated if a design decision changed

## Checklist (CI runs all of these)

- [ ] `cargo fmt --all -- --check`
- [ ] `cargo clippy --all-targets -- -D warnings`
- [ ] `cargo test -p streampay-contract`
- [ ] `cd frontend && npm run typecheck && npm run build` (if frontend touched)
