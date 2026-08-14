---
paths:
  - 'ui/**'
  - 'demo/**'
  - 'lib/**'
---

# Local Bee Development Cluster (bee-compose)

Docker-based local Bee cluster for development with postage stamps, from
[@snaha/bee-compose](https://www.npmjs.com/package/@snaha/bee-compose) **>= 0.2.0**, which carries
the hybrid chain the whole repo runs on — swap disabled, no chequebook factory, Gnosis mainnet
contract addresses.

**The version floor matters.** 0.1.x expected the old DEX-less chain (`BEE_SWAP_ENABLE=true`, a
chequebook factory at `0x5FC8d326…`, its own PostageStamp); against the hybrid chain its queen
crashloops with `factory fail: abi: attempting to unmarshal an empty string`, which reads as a
broken cluster rather than a stale dependency.

```bash
pnpm dev:cluster:start          # start the cluster (what CI runs)
pnpm dev:cluster:start --fresh  # the same, from a clean chain and empty node state
pnpm dev:cluster stop
pnpm dev:cluster status
pnpm dev:cluster:logs                    # tail the queen

pnpm dev:chain:detach   # the cluster's chain alone, on :9545 (start --without-bees)
pnpm dev:chain:stop
```

`--full 4` is a 4-node full network (queen + 3 full workers).

**Bumping bee-compose needs `--pull`, not just `--fresh`.** The chain snapshot is baked into the
`bee-compose:blockchain-*` image at build time, and `--fresh` only tears down volumes — it reuses
the image it already has. So after a version bump the cluster keeps serving the OLD chain, and the
only symptom is that nodes never ingest a batch you can see on-chain (`/chainstate` looks healthy).
Use `pnpm dev:cluster:start --fresh --pull`, or delete the image. CI is immune: its image
cache is keyed on the lockfile.

`dev:cluster` is the package's own CLI off `node_modules/.bin`. `dev:chain` is the same CLI with
`--without-bees`: the identical chain container on `:9545`, no Bee nodes, for anything that needs a
chain but not a network — the fork suite and the drive e2e both do.

## Pushsync needs `reachabilityOverridePublic=true` — built into the cluster image

`deferred: false` writes (every epoch-feed, partition-lock/intent SOC, and any direct
`/bytes`/`/chunks`/`/soc` upload — note `uploadData`/`uploadChunk` are non-deferred) require Bee
**pushsync** to complete a network **receipt**. A node only stores+receipts a chunk when `IsReachable()`
is true (`kademlia.go`: reachability == `Public`; checked in `pushsync.go`'s handler). Stock
`ethersphere/bee` is compiled with `reachabilityOverridePublic="false"` (a **build-time ldflag**, not an
env var), so it relies on libp2p AutoNAT — which never confirms reachability inside a docker bridge
network. Every node's _own_ reachability stays `Unknown` → `IsReachable()` is false → the push runs out
Bee's hard `defaultTTL = 30 s` and fails with `context deadline exceeded`. Symptom: **every
SOC/non-deferred upload takes exactly ~30 s** (reads still work — the chunk is stored locally on the
origin — but replication/receipts don't), and multi-device lock/intent SOCs never become
network-readable by peers.

**Fixed, and no longer something to check** ([#11](https://github.com/snaha/bee-compose/issues/11)):
`bee/Dockerfile` recompiles Bee from source at `v${BEE_VERSION}` with
`make binary REACHABILITY_OVERRIDE_PUBLIC=true`, so non-deferred uploads replicate out of the box — no
manual override-image build needed. 0.2.0 is well past the release that added it. Cost: the **first**
`dev:cluster start` compiles Bee from source (a few minutes; cached and shared across node images
afterward). (On a real public gateway the override is irrelevant — reachability is genuine there.)

Verify after start (read-only): every node `bee_kademlia_reachability_status{...="Public"}` (NOT
`Unknown`); queen `/topology` `connected ≥ 3`; a non-deferred upload returns in <1 s and queen
`bee_pushsync_push_peer_time_count{status="success"}` increases (no `status="failure"`).

| Service        | URL                      |
| -------------- | ------------------------ |
| Queen Bee API  | `http://localhost:1633`  |
| Worker 1 API   | `http://localhost:16331` |
| Blockchain RPC | `http://localhost:9545`  |

Developer Tools at http://localhost:5500/dev provide stamp buying and sync testing.

## Known Bee Node Private Keys

| Node     | Private Key                                                        | Ethereum Address                             |
| -------- | ------------------------------------------------------------------ | -------------------------------------------- |
| Queen    | `566058308ad5fa3888173c741a1fb902c9f1f19559b11fc2738dfc53637ce4e9` | `0x26234a2ad3ba8b398a762f279b792cfacd536a3f` |
| Worker 1 | `195cf6324303f6941ad119d0a1d2e862d810078e1370b8d205552a543ff40aab` | -                                            |
