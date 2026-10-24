# Testnet lifecycle canary

The scheduled workflow runs a fresh StreamPay lifecycle on Stellar testnet:

1. Ensure the bot sender account and a separate, deterministic recipient
   derived from the bot key exist through Friendbot; the derived recipient key
   never leaves the runner.
2. Approve the native XLM Stellar Asset Contract, create a cancelable stream,
   wait for accrual, withdraw a partial amount, withdraw the maximum available,
   then cancel.
3. Build contract calls with the frontend's signing-free
   `frontend/lib/stellar-ops.ts` operation builders and submit each transaction
   only after Soroban RPC simulation succeeds.

Each run starts a newly created stream and never depends on stream ids or state
from an earlier run. The recipient account is stable so testnet claim proceeds
remain recoverable. The bot secret key is used only as a GitHub Actions secret.
Set these repository settings to enable live runs:

- Secret `STREAMPAY_CANARY_SECRET_KEY`: the testnet bot's Stellar secret key.
- Variable `STREAMPAY_CANARY_CONTRACT_ID`: deployed testnet StreamPay contract.
- Optional variable `STREAMPAY_CANARY_TOKEN_ID`: SEP-41 token contract id; by
  default the testnet native XLM Stellar Asset Contract is used.
- Optional variable `STREAMPAY_CANARY_RPC_URL`: alternate testnet Soroban RPC.
- Optional secret `ONCALL_WEBHOOK_URL`: Slack/Discord-compatible on-call
  webhook. If it is absent, the exact alert is still written to the workflow
  summary and uploaded evidence artifact.

Use the workflow's `force_failure` dispatch input to verify the simulation
failure alert without contacting Friendbot or submitting a transaction. The
alert and JSON artifact include the exact step, failure class, RPC excerpt,
unsigned transaction/operation XDR when available, commit, actor, and workflow
run URL. If a stage fails after stream creation, the runner attempts a cleanup
cancellation and reports any cleanup failure separately.

Local validation (Node.js 22.6+):

```bash
cd tools/canary
npm ci
npm test
npm run typecheck
npm run canary
```

The live command requires the same environment values as the workflow. It
writes `canary-result.json` in the current directory and exits non-zero on
failure.
