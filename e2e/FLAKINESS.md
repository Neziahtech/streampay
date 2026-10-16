# E2E Flakiness Analysis & 20-Run Stability Evidence

## Flakiness Budget & CI Constraints
End-to-end tests against blockchain networks (specifically Soroban and Stellar Core) face asynchronous consensus timing, discrete ledger boundaries, transaction resource simulation, and state isolation challenges.

Per the flakiness budget requirement, this suite was designed to pass **20 consecutive runs** without a single flake or timing-dependent failure.

---

## Documented Flake Causes and Architectural Fixes

### 1. Zero Accrual / Immediate Withdrawal Flake (`NothingToWithdraw #13`)
* **Flake Cause**:
  When a stream is initialized, linear accrual is governed on-chain by `env.ledger().timestamp()`. If an end-to-end test creates a stream and immediately dispatches `withdraw_max` before a new ledger is closed, `now <= start_time`, meaning accrued amount is strictly `0`. The contract method reverts with `Error(Contract, #13)` (`NothingToWithdraw`).
* **Architectural Fix**:
  Implemented `waitForAccrual(streamId, minUnits = 1n)` in `e2e/fixtures/seeded-streams.ts`. The test explicitly queries the simulation endpoint until `available >= minUnits`, proving that a ledger boundary has closed with an advanced timestamp prior to clicking "Withdraw max" or submitting a withdrawal transaction.

### 2. Time Synchronization Flake (`StartTimeInPast #6`)
* **Flake Cause**:
  In `frontend/lib/stellar.ts`: `const start = Math.floor(Date.now() / 1000) + 1`. If the container or runner clock drifts slightly ahead of the host system, or if the local sandbox ledger timestamp is ahead of wall-clock time, `start_time < env.ledger().timestamp()`, causing `create_stream` to revert with `StartTimeInPast (#6)`.
* **Architectural Fix**:
  In client stream creation and seeded fixtures, start time calculation applies a deterministic forward offset (`Math.floor(Date.now() / 1000) + 2` or past timestamp for seeded streams).

### 3. Over-Withdrawal Flake (`AmountExceedsAvailable #10`)
* **Flake Cause**:
  Tests attempting partial withdrawals with hardcoded amounts (e.g. `500000`) before sufficient ledger seconds have elapsed revert with `AmountExceedsAvailable (#10)`.
* **Architectural Fix**:
  The primary user journey leverages atomic `withdraw_max`, which calculates and claims the exact available accrued units on-chain in one atomic transaction. Where manual amounts are tested, the amount is bounded by `readAvailable(streamId)`.

### 4. Account Sequence Number Collisions (`txBAD_SEQ`)
* **Flake Cause**:
  Running test cases concurrently or reusing a single account across parallel workers increments the account sequence number on-chain, causing racing transactions to fail with sequence errors.
* **Architectural Fix**:
  `playwright.config.ts` enforces `workers: 1` and `fullyParallel: false`. Distinct, deterministic keypairs are provisioned for `deployer`, `sender`, and `recipient` with dedicated sequence tracking.

### 5. Dev-Mode Freighter Bypass Handshake Race
* **Flake Cause**:
  When the page loads, React components asynchronously call `isConnected()`, `requestAccess()`, and `getAddress()`. If the wallet shim is injected too late or relies on asynchronous extension loading, the UI can remain stuck in a disconnected state.
* **Architectural Fix**:
  Injected the deterministic signer via `page.addInitScript()` before any page DOM or JavaScript executes. Both the synchronous `window.freighter = true` property and the `window.addEventListener("message")` protocol for `@stellar/freighter-api` are registered immediately, producing instant, deterministic handshakes and cryptographic signatures.

### 6. Sandbox Network Startup Race Condition
* **Flake Cause**:
  CI steps starting before Soroban RPC and Friendbot inside the service container are ready to serve requests encounter `ECONNREFUSED`.
* **Architectural Fix**:
  The sandbox fixture incorporates an active healthcheck poller with exponential backoff on `/friendbot` and `/rpc`, ensuring full node readiness before test execution begins.

---

## 20 Consecutive Green Run Verification

The suite was executed through 20 consecutive runs against the headless browser and sandbox network using Playwright's `--repeat-each=20` flag:

```bash
npm run test:e2e -- --repeat-each=20
```

All 20 consecutive iterations passed cleanly with zero flakes.
