# Swarm ID Library Demo

This folder contains a demo implementation using the Swarm ID library from `../lib/`.

## Overview

This demo shows how to integrate the Swarm ID library into a dApp for authentication and Bee API operations.

## Files

- **demo.html** - Demo dApp that uses `SwarmIdClient` from the library (built as `index.html`)
- **build.js** - Build script that bundles the demo with the library

## Using the Library

The demo imports from the built library:

```javascript
import { SwarmIdClient } from '../lib/dist/swarm-id-client.js'
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
1. Build the Bee.js fork
2. Build the Swarm ID library
3. Bundle the demo with environment configuration
4. Output to `demo/build/index.html`

## Deployment

The demo is deployed to **swarm-demo.snaha.net** using DigitalOcean App Platform. The deployment configuration is in `.do-app-demo.yaml` at the project root.

## Local Development

For local development, you need:
- SSL certificates for `swarm-app.local` and `swarm-id.local`
- `/etc/hosts` entries for both domains
- HTTPS servers running on ports 8080 and 8081

Start the servers from project root:
```bash
./start-servers.sh
```

Then access the demo at: `https://swarm-app.local:8080/demo/`

## How It Works

The demo creates a `SwarmIdClient` instance:

```javascript
const client = new SwarmIdClient({
  iframeOrigin: window.__ID_DOMAIN__ || 'https://swarm-id.snaha.net',
  beeApiUrl: 'http://localhost:1633',
  timeout: 30000,
  onAuthChange: (authenticated) => {
    // Handle auth status changes
  }
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
const result = await client.uploadData(
  'your-postage-batch-id',
  data,
  { pin: true }
)
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

### Create Auth Button

```javascript
const container = document.getElementById('auth-container')
const button = client.createAuthButton(container, {
  backgroundColor: '#dd7200',
  color: 'white',
  padding: '12px 24px',
  borderRadius: '6px'
})
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

### CORS errors in local development

Ensure you're accessing via the correct domains (`swarm-app.local` and `swarm-id.local`), not `localhost`.

### Authentication not working

1. Check browser console for errors in both the demo and identity site
2. Verify the identity site iframe can load (check network tab)
3. Clear localStorage and cookies, then try again
4. Ensure both sites are served over HTTPS in local development

## License

ISC
