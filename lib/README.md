# @snaha/swarm-id

TypeScript library for integrating Swarm ID authentication and Bee API operations into dApps.

## Overview

The Swarm ID library provides a secure, iframe-based authentication system for Swarm applications. It consists of two main components:

1. **SwarmIdClient** — For parent windows/dApps to interact with the authentication system
2. **SwarmIdProxy** — Runs in the iframe, handles authentication and proxies Bee API calls

Authentication is handled by the SvelteKit identity management UI ([ui](../ui/)).

## Installation

```bash
# Using pnpm (recommended)
pnpm add @snaha/swarm-id

# Using npm
npm install @snaha/swarm-id
```

## Basic Usage

```typescript
import { SwarmIdClient } from "@snaha/swarm-id"

// 1. Create the client
const client = new SwarmIdClient({
  iframeOrigin: "https://swarm-id.snaha.net",
  metadata: {
    name: "My dApp",
    description: "A demo Swarm application",
  },
  onConnectionChange: (info) => {
    console.log(
      "Connection changed:",
      info.identity?.name,
      "canUpload=",
      info.canUpload,
    )
  },
})

// 2. Initialize (creates hidden iframe; populates client.connectionInfo)
await client.initialize()

// 3a. Option A: Use iframe authentication button
// The iframe will show a connect/disconnect button automatically

// 3b. Option B: Manual authentication with connect()
// Opens the authentication page in a new window/tab (useful for custom UI)
await client.connect()

// 4. Read current connection state synchronously
const info = client.connectionInfo

// 5. Upload data (requires authentication AND upload capability — a connected
//    user can still have canUpload=false with no postage stamp and no
//    subsidised gateway)
if (info.identity && info.canUpload) {
  const result = await client.uploadData(
    new TextEncoder().encode("Hello, Swarm!"),
  )
  console.log("Uploaded:", result.reference)
}

// 6. Cleanup when done
client.destroy()
```

## Documentation

Full documentation is available at **[swarm.snaha.net/docs](https://swarm.snaha.net/docs)**:

- [Quick Start](https://swarm.snaha.net/docs/getting-started) — Installation and integration guide
- [Architecture](https://swarm.snaha.net/docs/architecture) — How the system works, key hierarchy, backup & recovery
- [API Reference](https://swarm.snaha.net/docs/api) — Complete SwarmIdClient API documentation

## License

[Apache 2.0](../LICENSE)
