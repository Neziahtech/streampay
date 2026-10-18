# Security policy

## Supported versions

| Version | Supported |
|---|---|
| main branch | ✅ |

## Reporting a vulnerability

StreamPay moves real funds. If you find a bug that could move funds
incorrectly, break an invariant (`0 ≤ withdrawn ≤ streamed ≤ deposit`, or the
contract-balance coverage invariant), or bypass an auth check:

1. **Do not open a public issue.**
2. Use GitHub's [private vulnerability reporting](
   https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
   on this repository — it reaches the maintainers directly and keeps the
   report confidential. If GitHub is unavailable to you, open a private
   report against any maintainer fork, or DM the handle listed in
   `.github/CODEOWNERS` — we will move the conversation to a confidential
   channel immediately.
3. Include a reproduction (test, tx traces, or a written scenario).

> Before mainnet (v1.0) we will publish a dedicated `security@` address with
> a PGP key alongside the release artifacts; until then, GitHub private
> reports are the canonical intake channel.

For **non-exploitable** findings — hardening gaps, defense-in-depth weaknesses,
or issues that are already disclosed or fixed — use the public
[security report form](.github/ISSUE_TEMPLATE/security-report.yml). It is
classified, labeled, and acknowledged automatically by the
[triage workflow](.github/workflows/security-triage.yml). Reward tiers, scope,
the loss model behind them, and the triage SLA are documented in
[`docs/BOUNTY.md`](docs/BOUNTY.md).

We aim to acknowledge within 72 hours and will credit reporters in the
release notes unless they prefer anonymity. Please give us a reasonable
window to fix before public disclosure.

## Invariants worth testing against

- Per stream: `0 ≤ withdrawn ≤ streamed ≤ deposit`.
- Global: contract token balance ≥ Σ(deposit − withdrawn) over live streams.
- Every payout path is checks-effects-interactions ordered (no reentrancy
  window on token transfers).
- All expected failures return `StreamError` codes; no panics on any input.

## CEI ordering gate

The contract's test-only CEI trace records selected persistent-storage reads
and writes, event emissions, and token-call boundaries in a stable text form.
Golden traces under `contracts/streaming-payments/test_orderings/` cover the
current payout and refund entrypoints: `withdraw`, `withdraw_max`,
`cancel_stream`, `withdraw_treasury`, `execute_scheduled`, `cancel_scheduled`,
and `reclaim_expired`, plus freeze-window withdrawal and top-up-then-withdraw
interactions. CI reruns those scenarios and fails when the observed ordering
differs from the reviewed files. The trace is explicit instrumentation at
contract-owned operation boundaries; it is not an automatic dump of every
Soroban host storage operation.

This gate proves that the instrumented scenarios retain their declared order
and that a seeded write-after-transfer regression changes the trace and fails
the test. It does not prove that every possible input or call graph is safe,
that uninstrumented storage accesses are ordered, or that a malicious token
can reenter a Soroban contract. Soroban host dispatch does not provide true
EVM-style reentrancy; the relevant risk here is a future effect-before-check
or effect-after-interaction bug that exposes stale state across a token call.
The existing malicious-token tests and serial entrypoint/race tests remain
complementary checks, not substitutes for this gate.

Run `bash scripts/cei-seeded-misordering.sh` from a clean checkout of the
committed branch to demonstrate the gate catching a deliberate CEI regression
in a temporary detached worktree. The script never mutates the checkout being
tested.
