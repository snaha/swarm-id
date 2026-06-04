---
paths:
  - 'swarm-ui/**'
  - 'demo/**'
  - 'lib/**'
---

# Local Bee Development Cluster (bee-compose)

Docker-based local Bee cluster for development with postage stamps. Uses [@snaha/bee-compose](https://www.npmjs.com/package/@snaha/bee-compose).

```bash
pnpm dev:bee          # Start cluster (queen + 3 full workers = 4-node net), foreground
pnpm dev:bee:detach   # Start in background
pnpm dev:bee:stop     # Stop cluster
pnpm dev:bee:fresh    # Fresh start (purge data); does NOT --pull (see below)
```

The scripts start a 4-node full network (`--full 4` = queen + 3 full workers).

## CRITICAL: the Bee image must be built with `REACHABILITY_OVERRIDE_PUBLIC=true`

`deferred: false` writes (every epoch-feed, partition-lock SOC, and any direct `/bytes`/`/chunks`/`/soc`
upload) require Bee **pushsync** to complete a network **receipt**. A node only stores+receipts a chunk
when `IsReachable()` is true (`kademlia.go`: reachability == `Public`; checked in `pushsync.go`'s
handler). Stock `ethersphere/bee` is compiled with `reachabilityOverridePublic="false"` (a **build-time
ldflag**, not an env var), so it relies on libp2p AutoNAT — which never confirms reachability inside a
docker bridge network. Every node's _own_ reachability stays `Unknown` → `IsReachable()` is false → no
node ever stores a forwarded chunk → the push runs out Bee's hard `defaultTTL = 30 s` and fails with
`context deadline exceeded`. Symptom: **every SOC/non-deferred upload takes exactly ~30 s** (the chunk
is only stored locally on the origin, so reads work but replication/receipts don't), and multi-device
lock SOCs never become network-readable by peers.

bee-compose 0.1.1's node image is `FROM ethersphere/bee:<ver>` (stock) and does **not** rebuild with the
override — so out of the box pushsync is broken. Upstream fix tracked at
**https://github.com/snaha/bee-compose/issues/11**. Until that ships, build a local override base image
(the Bee Makefile supports the flag) before starting the cluster:

```bash
# from a bee source checkout (e.g. ./bee):
make docker-build REACHABILITY_OVERRIDE_PUBLIC=true BEE_IMAGE=ethersphere/bee:<ver> PLATFORM=linux/amd64
# force node images to rebuild on the override base, then start fresh WITHOUT --pull:
docker rmi -f bee-compose:queen-<ver> bee-compose:worker-1-<ver> bee-compose:worker-2-<ver> bee-compose:worker-3-<ver>
pnpm exec bee-compose start --full 4 --fresh
```

Do **NOT** use `--pull`: bee-compose's node services are local-build images, so `compose pull` errors
(`pull access denied`), and pulling would also replace the local override base with stock Bee.

Verify after start (read-only): every node `bee_kademlia_reachability_status{...="Public"}` (NOT
`Unknown`); queen `/topology` `connected ≥ 3`; a non-deferred upload returns in <1 s and queen
`bee_pushsync_push_peer_time_count{status="success"}` increases (no `status="failure"`).

| Service        | URL                      |
| -------------- | ------------------------ |
| Queen Bee API  | `http://localhost:1633`  |
| Worker 1 API   | `http://localhost:16331` |
| Blockchain RPC | `http://localhost:9545`  |

Developer Tools at http://localhost:5174/dev provide stamp buying and sync testing.

## Known Bee Node Private Keys

| Node     | Private Key                                                        | Ethereum Address                             |
| -------- | ------------------------------------------------------------------ | -------------------------------------------- |
| Queen    | `566058308ad5fa3888173c741a1fb902c9f1f19559b11fc2738dfc53637ce4e9` | `0x26234a2ad3ba8b398a762f279b792cfacd536a3f` |
| Worker 1 | `195cf6324303f6941ad119d0a1d2e862d810078e1370b8d205552a543ff40aab` | -                                            |
