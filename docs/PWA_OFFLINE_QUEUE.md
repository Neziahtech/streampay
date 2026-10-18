# Progressive Web App (PWA) Mode, Offline Reads, and Pending Transaction Queue

This document specifies the offline architecture, Service Worker caching policies, mobile wallet install quirks, and the security model of the pending transaction queue for StreamPay.

---

## 1. High-Level Architecture

StreamPay is engineered to remain installable, resilient, and useful in the field even under intermittent, degraded, or completely severed network connectivity.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        StreamPay Frontend PWA                          │
│                                                                        │
│  ┌───────────────────────┐              ┌───────────────────────────┐  │
│  │   Service Worker      │              │    Offline Storage        │  │
│  │   - Cache-First (App) │              │    - Stream list cache    │  │
│  │   - SWR (Chain Data)  │              │    - Stream detail cache  │  │
│  │   - Version Inval.    │              │    - Continuous accrual   │  │
│  └───────────┬───────────┘              └─────────────┬─────────────┘  │
│              │                                        │                │
│              ▼                                        ▼                │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │               Pending Transaction Queue (CRITICAL)               │  │
│  │  - Single-use signed XDR persistence                             │  │
│  │  - Sequence Number Drift Protection (onChainSeq check)           │  │
│  │  - Expired Preconditions Detection (timebounds & ledger bounds)   │  │
│  │  - Explicit User Authorization (ZERO silent resubmissions)       │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Service Worker Strategy & Cache Invalidation

The Service Worker (`public/sw.js`) coordinates local asset availability and offline data reads across three distinct tiers:

### 2.1 Stale-While-Revalidate (SWR) for Account & Stream Data
- **Rationale**: For read requests targeting Soroban RPC simulation endpoints, indexer streams, or account APIs, pure cache-first leads to stale balance readings, while network-only breaks in the field.
- **SWR Behavior**: When an account or stream read is issued, the Service Worker immediately returns the locally cached snapshot (`caches.match`) to hydrate the UI in sub-millisecond time. Concurrently, a background fetch revalidates with the live Soroban RPC / network. If the network call succeeds, the cache is updated. If the user is offline or the RPC is unreachable, the cached data serves as a resilient offline read.

### 2.2 Cache-First for Static Assets & Application Shell
- Web app bundles, static styles (`globals.css`), fonts, icons (`/icons/*`), and the Web App Manifest (`manifest.webmanifest`) are served cache-first with network fallback.
- Navigation requests fall back to `/offline.html` when navigating while completely disconnected.

### 2.3 Versioned Cache Invalidation on Contract-ID Change
- Soroban contracts can undergo redeployments, migrations, or local/testnet environment swaps. Cache state tagged to an obsolete contract address can cause critical desynchronization (e.g., querying non-existent stream IDs or displaying phantom streams).
- **Versioning Schema**:
  ```text
  STATIC_CACHE = `streampay-static-v${VERSION}`
  DATA_CACHE   = `streampay-data-${CONTRACT_ID}-v${VERSION}`
  ```
- **Automatic Invalidation**:
  1. During the Service Worker's `activate` lifecycle hook, all existing cache keys are scanned via `caches.keys()`. Any cache prefixed with `streampay-data-` whose key does not strictly match the active `DATA_CACHE` is immediately purged via `caches.delete(key)`.
  2. The client runtime (`RegisterServiceWorker.tsx`) posts an `INVALIDATE_CONTRACT_CACHE` message to `navigator.serviceWorker.controller` whenever the active contract ID changes.
  3. `purgeStaleContractStorage()` cleans obsolete contract entries from `localStorage`.

---

## 3. The Pending Transaction Queue ("The Dangerous Part")

Signed Stellar and Soroban transactions are single-use, network-bound cryptographic envelopes. Uncontrolled deferred submission poses severe financial and operational hazards:

### 3.1 Anatomy of the Hazard

1. **Single-Use Sequence Consumption**:
   - Every transaction envelope signs over a specific source account sequence number ($S$).
   - When a transaction is included in a ledger, the source account sequence number increments.
   - If a signed transaction is held in an offline queue with sequence $S$, and the user subsequently performs *any other transaction* from another tab, mobile device, or external wallet, the on-chain sequence advances ($S_{chain} \ge S$).
   - Attempting to submit the queued envelope will immediately fail with `tx_bad_seq`.
2. **Sequence Gaps**:
   - If multiple transactions are queued or signed out of order, submitting transaction $S+2$ when the on-chain sequence is $S$ fails because sequence $S+1$ has not been consumed.
3. **Precondition Expiration (`timeBounds` & `ledgerBounds`)**:
   - Transactions built with `setTimeout(60)` or explicit time bounds specify a `maxTime`.
   - If connectivity is restored after `maxTime` has elapsed, Stellar network validators will reject the transaction with `tx_too_late`.
   - Similarly, if ledger bounds (`maxLedger`) are present and the network has advanced past `maxLedger`, the transaction is permanently invalid.
4. **Contract State Mutation Drift**:
   - Stream parameters may have shifted while offline (e.g., counterparty canceled the stream, or accrued balance was claimed by another signer).

### 3.2 Security Guarantees & Stale Submission Refusal

StreamPay enforces strict security principles for its pending transaction queue (`frontend/lib/pending-queue.ts`):

1. **ZERO Silent Resubmission**:
   - When network connectivity returns (`window.addEventListener('online')`), StreamPay **NEVER** silently fires off queued transactions.
   - Silent resubmission risks unexpected double-spends, sequence desynchronization, and silent failures that leave users unaware of on-chain state.
2. **Pre-Flight Validation Gate**:
   - Before submission is permitted, `validateQueuedTx()` checks live on-chain preconditions:
     ```ts
     const onChainSeq = BigInt(account.sequenceNumber());
     const txSeq = BigInt(tx.sourceSequence);

     if (txSeq <= onChainSeq) {
       // Refused: Sequence drift detected
       return { valid: false, status: "stale_sequence", reason: "..." };
     }

     if (currentTimeSec > tx.maxTime) {
       // Refused: Precondition expired
       return { valid: false, status: "expired_timebounds", reason: "..." };
     }
     ```
3. **Refusal with Clear UX**:
   - When preconditions fail, the queue marks the item as `stale_sequence` or `expired_timebounds`.
   - The UI disables submission and renders an explicit warning explaining *why* the transaction cannot be submitted (e.g., *"Account sequence has advanced from #100 to #102 on-chain. This signed envelope was consumed and will fail with tx_bad_seq."*).
   - The user is provided unambiguous actions: **Discard** the invalid entry, or initiate a fresh transaction with current on-chain parameters.
4. **Scoping**:
   - The queue storage key is strictly isolated by network and contract ID:
     `streampay:${NETWORK_LABEL}:${CONTRACT_ID}:${address}:pendingTxQueue`.

---

## 4. Mobile Browser & PWA Installation Quirks

Deploying Web3 applications as PWAs on mobile operating systems encounters platform-level sandbox constraints, specifically regarding browser extensions such as **Freighter**:

| Platform / Browser | Install Mechanism | Extension / Wallet Availability | Recommended User Workflow |
|---|---|---|---|
| **iOS Safari** | Manual: Share Button → *"Add to Home Screen"* | ❌ Standalone WebKit container blocks all extensions. Freighter cannot inject. | **Offline Reads**: Standalone PWA.<br>**Signing**: Open in mobile wallet dApp browser (e.g., Lobstr) or browser wallet connector. |
| **Android Chrome** | Automatic `beforeinstallprompt` banner or menu | ❌ Mobile Chrome does not support desktop Chrome extensions. | **Offline Reads**: Standalone PWA.<br>**Signing**: Chromium browsers with extension support (Kiwi, Mises) or mobile wallet dApp browser. |
| **Desktop Chrome / Brave / Edge** | Native install icon in URL bar | ✅ Freighter extension works seamlessly in standalone window. | **Full support**: Offline reads and full extension signing when online. |

### 4.1 Field Worker & Offline Read Value
Even when running in mobile standalone mode where wallet extensions cannot sign, **offline reads deliver immense utility**:
- **Field Audits**: Contractors and auditors can inspect active payment streams, deposit totals, and recipient addresses without an active data connection.
- **Continuous Accrual Calculations**: The frontend accrual engine (`computeAvailable`) runs mathematically against local wall-clock time from the cached stream snapshot (`deposit`, `startTime`, `endTime`, `withdrawn`), allowing real-time balance ticking without RPC access.
- **Deferred Queuing**: When connected to an external wallet or extension-enabled browser with spotty coverage, signed transactions are preserved in the pending queue rather than being dropped on connection loss.

---

## 5. Verification & Testing

The PWA and offline pending-queue subsystems are verified by automated test suites:
- `test/pending-queue.test.ts`:
  - Sequence drift refusal tests (`txSeq <= onChainSeq`).
  - Sequence gap refusal tests (`txSeq > onChainSeq + 1n`).
  - Precondition timebounds expiration tests (`currentTimeSec > tx.maxTime`).
  - Ledger bounds expiration tests (`currentLedger > tx.maxLedger`).
  - Offline storage round-trip and contract ID invalidation tests.
  - PWA Web App Manifest and Service Worker static asset verification.
- `test/a11y.test.ts`:
  - WCAG 2.1 AA accessibility audit ensuring all banners, drawers, and modal alerts adhere to contrast, focus ring, and ARIA guidelines.
