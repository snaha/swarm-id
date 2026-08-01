#!/usr/bin/env bash
# Copyright 2026 The Swarm Authors. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Re-bake the offline Gnosis chain fixture. NEEDS INTERNET (it forks mainnet);
# replaying the result does not. Run from the repo root: pnpm dev:chain:bake
set -euo pipefail

FIXTURE_DIR="$(cd "$(dirname "$0")/../test/fixtures" && pwd)"
FIXTURE="$FIXTURE_DIR/gnosis-fork-state.json"
UPSTREAM="${GNOSIS_RPC_URL:-https://rpc.gnosischain.com}"
IMAGE=ghcr.io/foundry-rs/foundry:stable
CONTAINER=gnosis-fork-bake
WORK="$(mktemp -d)"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> forking $UPSTREAM"
docker run -d --rm --name "$CONTAINER" -p 8545:8545 -v "$WORK:/state" \
  --entrypoint anvil "$IMAGE" \
  --fork-url "$UPSTREAM" --host 0.0.0.0 --port 8545 \
  --dump-state /state/gnosis.json >/dev/null

until curl -sf -m 2 -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
  http://localhost:8545 >/dev/null 2>&1; do sleep 1; done

echo "==> warming every path the offline chain must serve"
pnpx tsx "$(dirname "$0")/bake-fork-state.ts"

echo "==> stopping the fork so it writes its dump"
docker stop "$CONTAINER" >/dev/null
for _ in $(seq 1 30); do [ -s "$WORK/gnosis.json" ] && break; sleep 1; done
[ -s "$WORK/gnosis.json" ] || { echo "anvil wrote no state dump" >&2; exit 1; }

echo "==> merging contracts that were only read"
GNOSIS_RPC_URL="$UPSTREAM" pnpx tsx "$(dirname "$0")/bake-fork-state.ts" \
  --merge-only "$WORK/gnosis.json"

mv "$WORK/gnosis.json" "$FIXTURE"
echo "==> wrote $FIXTURE ($(wc -c <"$FIXTURE" | tr -d ' ') bytes)"
echo "    verify with: pnpm dev:chain:detach && pnpm test:fork"
