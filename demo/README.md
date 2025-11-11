# Demo2 - Swarm ID Library Demo

This folder contains a demo implementation using the Swarm ID library from `../lib/`.

## Overview

This demo shows how to integrate the Swarm ID library into a dApp for authentication and Bee API operations. It's functionally equivalent to the `popup/` demo but uses the published library instead of inline JavaScript.

## Files

- **demo.html** - Demo dApp that uses `SwarmIdClient` from the library
- **proxy.html** - Iframe proxy that uses `initProxy` from the library
- **auth.html** - Authentication popup that uses `initAuth` from the library

## Key Differences from popup/ Demo

### Using the Library

Instead of inline JavaScript, this demo imports from the built library:

```javascript
// In demo.html
import { SwarmIdClient } from '../lib/dist/swarm-id-client.js'

// In proxy.html
import { initProxy } from '../lib/dist/swarm-id-proxy.js'

// In auth.html
import { initAuth } from '../lib/dist/swarm-id-auth.js'
```

### Cleaner Code

The library handles all the complex message passing, validation, and type safety internally. The HTML files only need to:

1. Import the library modules
2. Initialize the components with configuration
3. Handle UI interactions

## Running the Demo

### Prerequisites

1. Build the library first:
   ```bash
   cd ../lib
   pnpm build
   cd ..
   ```

2. Ensure you have the local development setup:
   - SSL certificates for `swarm-app.local` and `swarm-id.local`
   - `/etc/hosts` entries for both domains
   - HTTPS servers running on ports 8080 and 8081

### Start the Servers

From the project root:

```bash
./start-servers.sh
```

This will start:
- `https://swarm-app.local:8080` - Serves the demo dApp
- `https://swarm-id.local:8081` - Serves the auth popup and proxy

### Access the Demo

Open in your browser:
```
https://swarm-app.local:8080/demo/demo.html
```

## How It Works

### 1. Demo Page (demo.html)

The demo page creates a `SwarmIdClient` instance:

```javascript
const client = new SwarmIdClient({
  iframeOrigin: 'https://swarm-id.local:8081',
  beeApiUrl: 'http://localhost:1633',
  timeout: 30000,
  onAuthChange: (authenticated) => {
    // Handle auth status changes
  }
})

await client.initialize()
```

The client automatically:
- Embeds a hidden iframe
- Handles postMessage communication
- Validates all messages with Zod schemas
- Provides a type-safe API

### 2. Proxy Iframe (proxy.html)

The proxy initializes with simple configuration:

```javascript
import { initProxy } from '../lib/dist/swarm-id-proxy.js'

const proxy = initProxy({
  beeApiUrl: 'http://localhost:1633',
  allowedOrigins: ['https://swarm-app.local:8080']
})
```

The proxy library:
- Accepts the parent's Bee API URL or uses the default
- Validates all incoming messages
- Stores app-specific secrets in partitioned localStorage
- Proxies Bee API calls (currently simulated)

### 3. Auth Popup (auth.html)

The auth popup initializes and handles authentication:

```javascript
import { initAuth } from '../lib/dist/swarm-id-auth.js'

const auth = await initAuth()

// Check if user has a master key
if (!auth.hasMasterKey()) {
  // Setup new identity
  await auth.setupNewIdentity()
}

// Authenticate
await auth.authenticate()
```

The auth library:
- Validates the opener window
- Loads or generates the master key
- Derives app-specific secrets using HMAC-SHA256
- Sends the secret to the proxy iframe

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
5. **Maintainability** - Library updates automatically benefit all users
6. **Testing** - Library code is tested independently
7. **Documentation** - See `../lib/README.md` for full API reference

## Next Steps

- Integrate real Bee API calls in the proxy (currently simulated)
- Add more Bee operations (file upload, collections, etc.)
- Implement proper error recovery
- Add progress callbacks for large uploads/downloads
- Add unit and integration tests

## Troubleshooting

### Module not found errors

Make sure you've built the library first:
```bash
cd ../lib && pnpm build
```

### CORS errors

Ensure you're accessing via the correct domains (`swarm-app.local` and `swarm-id.local`), not `localhost`.

### Authentication not working

1. Check browser console for errors
2. Verify the popup isn't being blocked
3. Clear localStorage and try again
4. Check that parent origin is in the allowed origins list

## License

ISC
