#!/usr/bin/env bash
# Decodes every conformance vector with the Rust, TypeScript, and Python SDKs
# and requires all three payloads to match each other and the recorded
# expectation.
#
#   ./sdks/conformance/run.sh [output-dir]
#
# Requires: cargo (workspace installed), node + npm dependencies installed in
# sdks/typescript, and Python 3.10+.
set -euo pipefail

SDKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VECTORS="$SDKS_DIR/vectors"
OUT_DIR="${1:-$SDKS_DIR/conformance/out}"

mkdir -p "$OUT_DIR"

echo "==> TypeScript build"
(cd "$SDKS_DIR/typescript" && npm run --silent build)

echo "==> Rust decoder"
(cd "$SDKS_DIR/rust" && cargo run --quiet --example conformance -- "$VECTORS" > "$OUT_DIR/rust.json")

echo "==> TypeScript decoder"
(cd "$SDKS_DIR/typescript" && node dist/src/conformance.js "$VECTORS" > "$OUT_DIR/typescript.json")

echo "==> Python decoder"
(cd "$SDKS_DIR/python" && python3 -m streampay.conformance "$VECTORS" > "$OUT_DIR/python.json")

echo "==> Compare"
python3 "$SDKS_DIR/conformance/compare.py" "$VECTORS" "$OUT_DIR"
