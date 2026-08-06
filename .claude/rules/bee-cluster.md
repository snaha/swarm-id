---
paths:
  - 'ui/**'
  - 'demo/**'
  - 'lib/**'
---

# Local Bee Development Cluster (bee-compose)

Docker-based local Bee cluster for development with postage stamps. Uses [@snaha/bee-compose](https://www.npmjs.com/package/@snaha/bee-compose).

> ⚠️ **Do not run `pnpm dev:bee*` against the hybrid chain — use `pnpm dev:local`.**
> The `dev:bee*` scripts run the **published** `@snaha/bee-compose`, which still expects the old
> DEX-less chain: `BEE_SWAP_ENABLE=true`, a chequebook factory at `0x5FC8d326…`, and its own
> PostageStamp address. Pointed at the hybrid chain those settings recreate the queen into a
> crashloop —
> `failed to build bee node error="factory fail: abi: attempting to unmarshal an empty string"` —
> because PR #19 removed the factory. It looks like a broken cluster, not a wrong command.
>
> `pnpm dev:local` uses `vendor/bee-compose` (swap disabled, no factory, Gnosis mainnet addresses),
> and also starts the payment source chain and the local solver. `pnpm dev:local:fresh` resets the
> chain to its baked snapshot; `pnpm dev:local:stop` tears it down.
>
> The `dev:bee*` scripts remain because CI (`integration-tests.yml`) uses them, where the npm
> package brings its own matching chain and is self-consistent.

```bash
pnpm dev:local        # cluster + both chains + solver + UI + demo  ← use this
pnpm dev:local:fresh  # the same, from a clean chain and empty node state
pnpm dev:local:stop   # tear the containers down

pnpm dev:bee          # CI's path; see the warning above before running locally
pnpm dev:bee:detach
pnpm dev:bee:stop
pnpm dev:bee:fresh
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

Developer Tools at http://localhost:5500/dev provide chain funding, batch creation and sync
testing. The **Chain** tab is where the faucet and batch actions live (the old Stamps tab and its
node-owned-batch workflow are gone).

## Known Bee Node Private Keys

| Node     | Private Key                                                        | Ethereum Address                             |
| -------- | ------------------------------------------------------------------ | -------------------------------------------- |
| Queen    | `566058308ad5fa3888173c741a1fb902c9f1f19559b11fc2738dfc53637ce4e9` | `0x26234a2ad3ba8b398a762f279b792cfacd536a3f` |
| Worker 1 | `195cf6324303f6941ad119d0a1d2e862d810078e1370b8d205552a543ff40aab` | -                                            |
