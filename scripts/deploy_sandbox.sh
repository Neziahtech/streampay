#!/usr/bin/env bash
# deploy_sandbox.sh — deploys the StreamPay contract and demo token against a local Stellar sandbox
#
# Usage:
#   ./scripts/deploy_sandbox.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC_URL="${SOROBAN_RPC_URL:-http://localhost:8000/rpc}"
FRIENDBOT_URL="${STELLAR_FRIENDBOT_URL:-http://localhost:8000/friendbot}"
NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-Standalone Network ; February 2017}"
WASM="target/wasm32v1-none/release/streampay_contract.wasm"

say() { printf "\n==> %s\n" "$*"; }
die() { printf "ERROR: %s\n" "$*" >&2; exit 1; }

# 1. Preflight checks
say "Checking prerequisites"
command -v stellar >/dev/null 2>&1 || die "stellar CLI not found"
command -v curl >/dev/null 2>&1 || die "curl not found"

# 2. Build Wasm if not present
if [ ! -f "$REPO_ROOT/$WASM" ]; then
  say "Building contract Wasm"
  (cd "$REPO_ROOT/contracts/streaming-payments" && stellar contract build)
fi
[ -f "$REPO_ROOT/$WASM" ] || die "expected Wasm at $WASM after build"

# 3. Configure local network in stellar CLI
say "Configuring sandbox network in stellar CLI"
stellar network add sandbox \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" 2>/dev/null || true

# 4. Deterministic identities matching E2E test signer fixtures
DEPLOYER_SECRET="SAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC5MY"
SENDER_SECRET="SABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNE7"
RECIPIENT_SECRET="SABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGC45"

DEPLOYER="GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR"
SENDER="GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U"
RECIPIENT="GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG"

HORIZON_URL="${STELLAR_HORIZON_URL:-http://localhost:8000}"
ASSET="DEMO:$DEPLOYER"

# Quickstart's friendbot comes up well after its RPC reports healthy, so retry
# until the account actually exists on-ledger instead of swallowing failures.
fund_account() {
  local addr="$1"
  for _ in $(seq 1 60); do
    curl -s "${FRIENDBOT_URL}?addr=${addr}" >/dev/null 2>&1 || true
    if curl -sf "${HORIZON_URL}/accounts/${addr}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  die "friendbot never funded $addr"
}

say "Funding test identities via Friendbot"
fund_account "$DEPLOYER"
fund_account "$SENDER"
fund_account "$RECIPIENT"

# 5. Deploy contract (constructor requires a governor)
say "Deploying StreamingPayments contract to sandbox"
CONTRACT_ID="$(stellar contract deploy \
  --wasm "$REPO_ROOT/$WASM" \
  --source "$DEPLOYER_SECRET" \
  --network sandbox \
  -- --governor "$DEPLOYER" | tail -n 1)"
[[ "$CONTRACT_ID" =~ ^C[A-Z2-7]{55}$ ]] || die "deploy returned no contract id (got: $CONTRACT_ID)"
echo "CONTRACT_ID=$CONTRACT_ID"

# 6. Wrap the classic DEMO asset in its SAC. The E2E fixtures derive the token
# id from DEMO:<deployer>, so the asset code and issuer must stay fixed.
say "Deploying demo SAC token ($ASSET)"
TOKEN_ID="$(stellar contract asset deploy \
  --asset "$ASSET" \
  --source "$DEPLOYER_SECRET" \
  --network sandbox 2>/dev/null | tail -n 1 || true)"
if [[ ! "$TOKEN_ID" =~ ^C[A-Z2-7]{55}$ ]]; then
  # Already deployed on a reused sandbox; look the id up instead.
  TOKEN_ID="$(stellar contract id asset --asset "$ASSET" --network sandbox | tail -n 1)"
fi
[[ "$TOKEN_ID" =~ ^C[A-Z2-7]{55}$ ]] || die "could not resolve SAC id for $ASSET"
echo "TOKEN_ID=$TOKEN_ID"

# Classic accounts can only hold a SAC balance through a trustline.
say "Opening DEMO trustlines for sender and recipient"
stellar tx new change-trust --source "$SENDER_SECRET" --line "$ASSET" --network sandbox
stellar tx new change-trust --source "$RECIPIENT_SECRET" --line "$ASSET" --network sandbox

say "Minting tokens to sender and approving contract"
stellar contract invoke \
  --id "$TOKEN_ID" --source "$DEPLOYER_SECRET" --network sandbox -- \
  mint --to "$SENDER" --amount 10000000000

# expiration_ledger is an absolute ledger sequence, not an offset.
LATEST_LEDGER="$(curl -sf -X POST "$RPC_URL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result.sequence))')"
[[ "$LATEST_LEDGER" =~ ^[0-9]+$ ]] || die "could not read latest ledger from $RPC_URL"

stellar contract invoke \
  --id "$TOKEN_ID" --source "$SENDER_SECRET" --network sandbox -- \
  approve --from "$SENDER" --spender "$CONTRACT_ID" --amount 10000000000 \
  --expiration_ledger "$((LATEST_LEDGER + 10000))"

# Write .env.local for Next.js & Playwright
cat <<ENV > "$REPO_ROOT/frontend/.env.local"
NEXT_PUBLIC_STREAMING_CONTRACT_ID=$CONTRACT_ID
NEXT_PUBLIC_SOROBAN_RPC_URL=$RPC_URL
NEXT_PUBLIC_NETWORK=LOCAL
NEXT_PUBLIC_NETWORK_PASSPHRASE=$NETWORK_PASSPHRASE
ENV

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "NEXT_PUBLIC_STREAMING_CONTRACT_ID=$CONTRACT_ID" >> "$GITHUB_ENV"
  echo "NEXT_PUBLIC_SOROBAN_RPC_URL=$RPC_URL" >> "$GITHUB_ENV"
  echo "NEXT_PUBLIC_NETWORK=LOCAL" >> "$GITHUB_ENV"
  echo "NEXT_PUBLIC_NETWORK_PASSPHRASE=$NETWORK_PASSPHRASE" >> "$GITHUB_ENV"
fi

cat <<EOF

──────────────────────────────────────────────────────────────────
  StreamPay sandbox deployment complete!

  CONTRACT_ID : $CONTRACT_ID
  TOKEN_ID    : $TOKEN_ID
  SENDER      : $SENDER
  RECIPIENT   : $RECIPIENT

  Written to frontend/.env.local
──────────────────────────────────────────────────────────────────
EOF
