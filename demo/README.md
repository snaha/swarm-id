# Swarm ID Library Demo

This folder contains a demo implementation using the Swarm ID library from `../lib/`.

## Overview

This demo shows how to integrate the Swarm ID library into a dApp for authentication and Bee API operations.

## Files

- **src/routes/** - SvelteKit pages (main demo, feeds, SOC, storage, access control)
- **src/lib/stores/** - Svelte 5 stores (client, log, sidebar)
- **src/lib/components/** - Shared UI components
- **svelte.config.js** - SvelteKit config with `@sveltejs/adapter-static`
- **vite.config.ts** - Vite configuration

## Using the Library

The demo imports from the library via workspace link:

```typescript
import { SwarmIdClient } from '@swarm-id/lib'
```

The library handles all the complex authentication, message passing, validation, and type safety internally. The demo HTML only needs to:

1. Import the library module
2. Initialize the client with configuration
3. Handle UI interactions

## Building the Demo

From the project root:

```bash
pnpm build:swarm-demo
```

This will:

1. Build the Swarm ID library
2. Build the SvelteKit demo app with Vite
3. Output static files to `demo/build/`

## Deployment

The demo is deployed to **swarm-demo.snaha.net** using DigitalOcean App Platform. The deployment configuration is in `.do/swarm-demo-app.yaml`.

## Local Development

From the project root:

```bash
pnpm install
pnpm dev
```

Then open http://localhost:3000

No HTTPS or certificates required - `localhost` is a secure context.

**Note:** Safari requires disabling cross-site tracking prevention. See [#167](https://github.com/snaha/swarm-id/issues/167) for details.

## How It Works

The client is configured in `src/lib/stores/client.svelte.ts` using Svelte 5 runes:

```typescript
import { SwarmIdClient } from '@swarm-id/lib'

const client = new SwarmIdClient({
  iframeOrigin: proxyOrigin,
  iframePath: '/proxy',
  timeout: 60000,
  onAuthChange: async (auth: boolean) => {
    // Handle auth status changes
  },
  metadata: {
    name: 'Swarm ID Demo',
    description: 'Demo application showcasing Swarm ID authentication',
    icon: BEE_ICON,
  },
  containerId: 'swarm-id-button',
})

await client.initialize()
```

The client automatically:

- Embeds a hidden iframe to the identity site
- Handles secure postMessage communication
- Validates all messages with Zod schemas
- Provides a type-safe API for authentication and Bee operations

The identity management (authentication, key derivation, storage) is handled by the Swarm ID UI at `swarm-id.snaha.net` (see `../swarm-ui/`)

## API Examples

### Upload Data

```javascript
const data = new TextEncoder().encode('Hello, Swarm!')
const result = await client.uploadData('your-postage-batch-id', data, { pin: true })
console.log('Reference:', result.reference)
```

### Download Data

```javascript
const data = await client.downloadData('reference-hash')
const text = new TextDecoder().decode(data)
console.log('Downloaded:', text)
```

### Check Auth Status

```javascript
const status = await client.checkAuthStatus()
if (status.authenticated) {
  console.log('User is authenticated')
}
```

### Get Auth Iframe

```javascript
// The iframe is automatically positioned in the bottom-right corner
const iframe = client.getAuthIframe()
```

## Benefits of Using the Library

1. **Type Safety** - Full TypeScript support with type definitions
2. **Validation** - Zod schemas validate all messages at runtime
3. **Cleaner Code** - No need to write postMessage boilerplate
4. **Error Handling** - Built-in error handling and timeouts
5. **Secure** - Cross-origin communication with iframe isolation
6. **Maintainability** - Library updates automatically benefit all users
7. **Documentation** - See `../lib/README.md` for full API reference

## Troubleshooting

### Build errors

Make sure you've installed dependencies and built the library:

```bash
pnpm install
pnpm build:swarm-demo
```

### Authentication not working

1. Check browser console for errors
2. Verify the identity site iframe can load (check network tab)
3. Clear localStorage and try again
4. Allow popups for localhost in browser settings

## License

ISC
