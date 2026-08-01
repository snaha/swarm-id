#!/usr/bin/env bash
# Copyright 2026 The Swarm Authors. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Start a Bee node following the baked Gnosis chain, so a batch bought through
# the multichain path can actually be uploaded with. Run from the repo root:
#
#   pnpm dev:gnosis            # foreground
#   pnpm dev:gnosis:detach
#   pnpm dev:gnosis:stop
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FIXTURE="$ROOT/multichain/test/fixtures/gnosis-fork-state.json"
KEYS_SRC="$ROOT/node_modules/@snaha/bee-compose/bee/data/queen/keys"

[ -f "$FIXTURE" ] || { echo "missing $FIXTURE — run pnpm dev:chain:bake" >&2; exit 1; }

# Bee must start scanning at the block the state was baked at: earlier blocks
# do not exist here, and later ones are where our batches land.
POSTAGE_STAMP_START_BLOCK="$(node -e "
  const fs = require('node:fs')
  const state = JSON.parse(fs.readFileSync('$FIXTURE', 'utf8'))
  process.stdout.write(String(parseInt(state.block.number, 16)))
")"

# Reuse bee-compose's dev identity rather than minting another one: its address
# is known, so the chain can be funded before the node looks.
if [ ! -f "$HERE/data/keys/swarm.key" ]; then
  [ -d "$KEYS_SRC" ] || { echo "missing $KEYS_SRC — run pnpm install" >&2; exit 1; }
  mkdir -p "$HERE/data/keys"
  cp "$KEYS_SRC"/*.key "$HERE/data/keys/"
  chmod 600 "$HERE/data/keys"/*.key
fi
BEE_WALLET_ADDRESS="0x$(node -e "
  const fs = require('node:fs')
  const keystore = JSON.parse(fs.readFileSync('$HERE/data/keys/swarm.key', 'utf8'))
  process.stdout.write(keystore.address)
")"

echo "chain     : baked Gnosis state @ block $POSTAGE_STAMP_START_BLOCK (offline)"
echo "bee wallet: $BEE_WALLET_ADDRESS"

export POSTAGE_STAMP_START_BLOCK BEE_WALLET_ADDRESS
exec docker compose -f "$HERE/compose.yml" "$@"
