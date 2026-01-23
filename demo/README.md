# Swarm ID Library Demo

This folder contains a demo implementation using the Swarm ID library from `../lib/`.

## Overview

This demo shows how to integrate the Swarm ID library into a dApp for authentication and Bee API operations.

## Files

- **index.html** - Demo dApp that uses `SwarmIdClient` from the library
- **build.js** - Build script that bundles the demo with the library
- **lib/** - Symlink to `../lib/dist` for local development

## Local Development

From the project root:

```bash
pnpm install
pnpm dev
```

Then open http://localhost:3000

No HTTPS or certificates required - `localhost` is a secure context.

## Using the Library

The demo imports from the library:

```javascript
import { SwarmIdClient } from '/lib/swarm-id-client.js'
```

The library handles all the complex authentication, message passing, validation, and type safety internally. The demo HTML only needs to:

1. Import the library module
2. Initialize the client with configuration
3. Handle UI interactions

## Building for Production

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

The demo is deployed to **swarm-demo.snaha.net** using DigitalOcean App Platform.

## How It Works

The demo creates a `SwarmIdClient` instance:

```javascript
const client = new SwarmIdClient({
  iframeOrigin: 'http://localhost:5174',  // or production URL
  iframePath: '/proxy',
  timeout: 60000,
  onAuthChange: (authenticated) => {
    // Handle auth status changes
  },
  metadata: {
    name: 'My App',
    description: 'App description',
  },
})

await client.initialize()
```

The client automatically:
- Embeds a hidden iframe to the identity site
- Handles secure postMessage communication
- Validates all messages with Zod schemas
- Provides a type-safe API for authentication and Bee operations

## API Examples

### Upload Data

```javascript
const data = new TextEncoder().encode('Hello, Swarm!')
const result = await client.uploadData(data, { pin: true, encrypt: true })
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

### Connect/Disconnect

```javascript
// Open auth popup
client.connect()

// Disconnect
await client.disconnect()
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
