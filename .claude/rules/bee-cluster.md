---
paths:
  - "swarm-ui/**"
  - "demo/**"
  - "lib/**"
---

# Local Bee Development Cluster (FDP Play)

Docker-based local Bee cluster for development with postage stamps.

```bash
pnpm dev:bee          # Start cluster (queen + 1 worker)
pnpm dev:bee:detach   # Start in background
pnpm dev:bee:stop     # Stop cluster
pnpm dev:bee:fresh    # Fresh start (pull latest, purge data)
```

| Service | URL |
|---------|-----|
| Queen Bee API | `http://localhost:1633` |
| Worker 1 API | `http://localhost:11633` |
| Blockchain RPC | `http://localhost:9545` |

Developer Tools at http://localhost:5174/dev provide stamp buying and sync testing.

## Known Bee Node Private Keys

| Node | Private Key | Ethereum Address |
|------|-------------|------------------|
| Queen | `566058308ad5fa3888173c741a1fb902c9f1f19559b11fc2738dfc53637ce4e9` | `0x26234a2ad3ba8b398a762f279b792cfacd536a3f` |
| Worker 1 | `195cf6324303f6941ad119d0a1d2e862d810078e1370b8d205552a543ff40aab` | - |
