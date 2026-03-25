# @snaha/swarm-id

TypeScript library for integrating Swarm ID authentication and Bee API operations into dApps.

## Overview

The Swarm ID library provides a secure, iframe-based authentication system for Swarm applications. It consists of two main components:

1. **SwarmIdClient** — For parent windows/dApps to interact with the authentication system
2. **SwarmIdProxy** — Runs in the iframe, handles authentication and proxies Bee API calls

Authentication is handled by the SvelteKit identity management UI ([swarm-ui](../swarm-ui/)).

## Installation

```bash
# Using pnpm (recommended)
pnpm add @snaha/swarm-id

# Using npm
npm install @snaha/swarm-id
```

## Basic Usage

```typescript
import { SwarmIdClient } from '@snaha/swarm-id'

// 1. Create the client
const client = new SwarmIdClient({
  iframeOrigin: 'https://swarm-id.snaha.net',
  metadata: {
    name: 'My dApp',
    description: 'A demo Swarm application',
  },
  onAuthChange: (authenticated) => {
    console.log('Auth status:', authenticated)
  },
})

// 2. Initialize (creates hidden iframe)
await client.initialize()

// 3a. Option A: Use iframe authentication button
// The iframe will show a connect/disconnect button automatically

// 3b. Option B: Manual authentication with connect()
// Open authentication page in new window/browser tab (useful for custom UI)
const authUrl = client.connect()
console.log('Authentication opened at:', authUrl)

// 4. Check if user is authenticated
const status = await client.checkAuthStatus()

// 5. Upload data (after authentication)
if (status.authenticated) {
  const result = await client.uploadData(new TextEncoder().encode('Hello, Swarm!'))
  console.log('Uploaded:', result.reference)
}

// 6. Cleanup when done
client.destroy()
```

## Documentation

Full documentation is available at **[swarm-docs.snaha.net](https://swarm-docs.snaha.net)**:

- [Quick Start](https://swarm-docs.snaha.net/getting-started) — Installation and integration guide
- [Architecture](https://swarm-docs.snaha.net/architecture) — How the system works, key hierarchy, backup & recovery
- [API Reference](https://swarm-docs.snaha.net/api) — Complete SwarmIdClient API documentation

## License

[Apache 2.0](../LICENSE)
