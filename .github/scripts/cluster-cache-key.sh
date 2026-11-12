#!/usr/bin/env bash
# Write the Bee cluster image cache key to $GITHUB_OUTPUT as `version`: the
# bee-compose version plus the Bee version `dev:cluster:start` pins, the only
# things the images are built from. The Bee version is read up to the next
# space, so a pre-release keeps its suffix and its own key. Guarded: an empty
# part would leave a key every run would share and no run would notice.
set -euo pipefail

version=$(pnpm -s dev:cluster --version)
test -n "$version" || { echo "::error::bee-compose printed no version"; exit 1; }
bee=$(jq -r '.scripts["dev:cluster:start"]' package.json | sed -n 's/.*BEE_VERSION=\([^ ]*\).*/\1/p')
test -n "$bee" || { echo "::error::no BEE_VERSION in dev:cluster:start"; exit 1; }
echo "version=$version-bee-$bee" >> "$GITHUB_OUTPUT"
