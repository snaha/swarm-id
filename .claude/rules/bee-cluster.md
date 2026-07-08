---
paths:
  - 'ui/**'
  - 'demo/**'
  - 'lib/**'
---

# Local Bee Development Cluster (bee-compose)

Docker-based local Bee cluster for development with postage stamps. Uses [@snaha/bee-compose](https://www.npmjs.com/package/@snaha/bee-compose).

```bash
pnpm dev:bee          # Start cluster (queen + 3 full workers = 4-node net), foreground
pnpm dev:bee:detach   # Start in background
pnpm dev:bee:stop     # Stop cluster
pnpm dev:bee:fresh    # Fresh start (purge data)
```

The scripts start a 4-node full network (`--full 4` = queen + 3 full workers).

## Pushsync needs `reachabilityOverridePublic=true` — now built into bee-compose ≥ 0.1.4

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

**Fixed in bee-compose ≥ 0.1.4** ([#11](https://github.com/snaha/bee-compose/issues/11)):
`bee/Dockerfile` recompiles Bee from source at `v${BEE_VERSION}` with
`make binary REACHABILITY_OVERRIDE_PUBLIC=true`, so non-deferred uploads replicate out of the box — no
manual override-image build needed. Cost: the **first** `bee-compose start` compiles Bee from source (a
few minutes; cached and shared across node images afterward).

> ⚠️ swarm-id pins `@snaha/bee-compose@^0.1.3` and the lockfile may still resolve to **0.1.3 (no
> override → the ~30 s hang)**. If non-deferred uploads stall locally, update to ≥ 0.1.4
> (`pnpm update @snaha/bee-compose`) and rebuild (`pnpm dev:bee:fresh`; the first start recompiles Bee).
> (On a real public gateway the override is irrelevant — reachability is genuine there.)

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
