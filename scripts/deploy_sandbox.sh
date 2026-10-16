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

fund_account() {
  local addr="$1"
  curl -sf "${FRIENDBOT_URL}?addr=${addr}" >/dev/null || true
}

say "Funding test identities via Friendbot"
fund_account "$DEPLOYER"
fund_account "$SENDER"
fund_account "$RECIPIENT"

# 5. Deploy contract
say "Deploying StreamingPayments contract to sandbox"
CONTRACT_ID="$(stellar contract deploy \
  --wasm "$REPO_ROOT/$WASM" \
  --source "$DEPLOYER_SECRET" \
  --network sandbox | tail -n 1)"
[ -n "$CONTRACT_ID" ] || die "deploy returned no contract id"
echo "CONTRACT_ID=$CONTRACT_ID"

# 6. Create demo asset & mint
say "Creating demo SAC token"
SALT="$(date +%s%N 2>/dev/null || date +%s)"
TOKEN_ID="$(stellar contract asset create \
  --source "$DEPLOYER_SECRET" \
  --network sandbox \
  --issuer "$DEPLOYER" \
  --max-alpha4 "DEMO" \
  --amount 10000000000 | tail -n 1)"
echo "TOKEN_ID=$TOKEN_ID"

say "Minting tokens to sender and approving contract"
stellar contract invoke \
  --id "$TOKEN_ID" --source "$DEPLOYER_SECRET" --network sandbox -- \
  mint --to "$SENDER" --amount 10000000000

stellar contract invoke \
  --id "$TOKEN_ID" --source "$SENDER_SECRET" --network sandbox -- \
  approve --spender "$CONTRACT_ID" --amount 10000000000 --expiration_ledger +50000

# Write .env.local for Next.js & Playwright
cat <<ENV > "$REPO_ROOT/frontend/.env.local"
NEXT_PUBLIC_STREAMING_CONTRACT_ID=$CONTRACT_ID
NEXT_PUBLIC_SOROBAN_RPC_URL=$RPC_URL
NEXT_PUBLIC_NETWORK=LOCAL
NEXT_PUBLIC_NETWORK_PASSPHRASE=$NETWORK_PASSPHRASE
ENV

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
