# StreamPay frontend

Minimal Next.js (App Router, TypeScript) UI for the StreamPay contract:
connect Freighter, create streams, withdraw accrued funds (single amount,
atomic **withdraw max**, or **claim for free** through a sponsor relay),
top up, cancel — with on-chain discovery so the list survives reloads and
shows streams you didn't create in this session.

Recipients can route claims to a delayed alternate payout address. The new
destination requires a second confirmation after 24 hours.

It also ships **opt-in fee-aware claim scheduling**: a recipient can defer a
claim and have StreamPay submit it when the Soroban inclusion fee drops under a
budget they set, with a hard deadline fallback. See
[`../docs/FEE_AWARE_CLAIMS.md`](../docs/FEE_AWARE_CLAIMS.md) for the constraints
(what fee data is observable, and why a deferred claim is never *lost*).

## Routes

| Route | What it does |
|---|---|
| `/` | Connect, single and CSV batch creation forms (asset selector: **native XLM** or an entered token contract id), delayed payout destination proposal with a live countdown, stream list with per-row actions and on-chain discovery |
| `/stream/[id]` | Stream detail: progress, live `available` polling, withdrawal panel, **Withdraw max**, **Claim for free** through a sponsor relay, fee-aware claim scheduling, and cancel. Read-only-safe without a wallet; contract errors decode to `StreamError` names |
| `GET /accrual/[id]` | Computed accrual curve time-series API (`?from&to&step`) with ETag/304 caching, honest staleness headers, and shared RPC rate budgets |
| `/docs` | Public interactive API documentation page (Swagger UI) rendering OpenAPI 3.1 spec |

### Stream Detail & Withdrawal Panel (`/stream/[id]`)

The stream detail route provides a dedicated UX for inspecting stream accrual and claiming funds:
- **Accrual & Balance Polling**: Polls the on-chain `available` balance every 15 seconds, complemented by a 1-second client-side linear accrual interpolator and a manual **↻ Refresh** trigger.
- **Auto-Prefilling**: When a recipient views an active stream, the withdrawal input is automatically prefilled with the currently accrued balance. A **Prefill Max** shortcut button allows updating the input to match newly accrued funds.
- **Client-Side Over-Withdrawal Guard**: Validates amounts before transaction dispatch. If the specified amount exceeds the accrued `available` balance, submission is disabled with a visible warning banner, preventing failed transactions and saving gas fees.
- **Withdraw Max**: Invokes `withdraw_max` for atomic on-chain settlement of all accrued balance without race conditions.
- **Error Decoding**: Unpacks Soroban contract errors into descriptive names (e.g., `AmountExceedsAvailable (code 6)`, `WithdrawAmountNonPositive (code 4)`).

## Setup

```bash
cd frontend
cp .env.example .env.local   # then fill in NEXT_PUBLIC_STREAMING_CONTRACT_ID
npm install
npm run dev                  # http://localhost:3000
```

Requires the [Freighter](https://www.freighter.app/) browser extension and a
funded account on the configured network (default: testnet — use the
[friendbot](https://developers.stellar.org/docs/dev-tools/tutorials/friendbot)).
Pick an asset on the create form:

- **Native XLM** — resolved to the network's Stellar Asset Contract
  (`stellar contract id asset --asset native`); override with
  `NEXT_PUBLIC_NATIVE_XLM_CONTRACT_ID` for other networks.
- **Token contract (USDC-style)** — the asset's `C…` SAC id, e.g. a custom
  testnet asset.

For a one-command deployed contract + demo stream, see
[`../docs/DEMO.md`](../docs/DEMO.md).

## Notes

- `npm run lint` + `npm run typecheck` + `npm run build` + `npm audit` +
  `npm test` run in CI. `npm test` includes the sponsorship wire-parity
  vectors (frozen message XDR + digest shared with the Rust suite).
- `npm run lint` + `npm run typecheck` + `npm test` + `npm run build` +
  `npm audit` run in CI.
- `npm test` runs the pure scheduler/fee-stats unit tests and the recorded
  fee-series replay simulation (vitest, node environment).
- Every mutating call follows: build → simulate → Freighter sign → send → poll.
- Create/top-up first read the token's `allowance` and ask Freighter to sign
  a `token.approve` **only when it is short** — so a first stream with a new
  asset costs one extra signature instead of failing at simulation.
- Read-only calls (`get_stream`, `available`, the index views, `allowance`)
  simulate against the RPC without signing.
- Contract errors decode to `StreamError` names; the generated
  [error catalog](../docs/errors.md) is the authority for names and wire codes.
- A payout change needs a second recipient signature after 24 hours; the active
  destination is used by `withdraw`, `withdraw_max`, and the accrued recipient
  leg of `cancel_stream`. Destinations cannot be the streaming contract and
  must support every asset used by the recipient's streams; issued assets need
  the corresponding trustline. Generic SEP-41 tokens do not support a uniform
  trustline preflight, so an unreceivable payout fails atomically.
- Amounts are **smallest token units** (stroops for classic assets).
- The batch form accepts `address,rate,duration` CSV rows. Rate is an integer
  in smallest token units per second; duration is integer seconds. Each
  deposit is computed as `rate × duration`, uses the shared token selected in
  the form, and starts immediately. The contract creates all rows atomically
  in one transaction; approve the total deposits plus any configured fees.
- Practical batch size is limited by the network's transaction resource budget;
  an oversized batch fails simulation without creating a partial batch.
- A batch emits one `StreamsCreated` event with all ids (rather than a
  `StreamCreated` event per row); when fees are enabled, each charged stream
  still emits its individual `FeeCharged` event.
- The stream list persists per-address cache in `localStorage` (scoped by
  network); on-chain indexes are the source for discovery, cache is only a
  convenience.
- A bar at the top of every page names the network (`TESTNET` / `PUBLIC`) and
  the streaming contract from `NEXT_PUBLIC_NETWORK` and
  `NEXT_PUBLIC_STREAMING_CONTRACT_ID`, linking to the block explorer. When
  Freighter is on a different network it raises a dismissible warning with the
  fix, instead of the mismatch surfacing later as a signing error
  (`lib/network.ts`, `components/NetworkBadge.tsx`).
