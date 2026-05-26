---
paths:
  - 'swarm-ui/**'
  - 'demo/**'
  - 'lib/**'
---

# Local Bee Development Cluster (bee-compose)

Docker-based local Bee cluster for development with postage stamps. Uses [@snaha/bee-compose](https://www.npmjs.com/package/@snaha/bee-compose).

```bash
pnpm dev:bee          # Start cluster (queen + 1 full worker), foreground
pnpm dev:bee:detach   # Start in background
pnpm dev:bee:stop     # Stop cluster
pnpm dev:bee:fresh    # Fresh start (pull latest, purge data)
```

The scripts start a **queen + 1 full worker** rather than a light worker because Bee's SOC ingest path with `deferred: false` (used by every epoch-feed and partition-lock write) needs at least one *full* peer in the queen's kademlia routing table — Bee won't add a light worker to the routing table even when libp2p is connected. With only light workers the queen has nowhere to push SOC chunks and the write hangs until the client times out (60 s on the account-sync path).

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
