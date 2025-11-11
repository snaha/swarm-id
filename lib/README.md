# Swarm ID Client Library

A TypeScript library for integrating Swarm ID authentication and Bee API operations into dApps.

## Overview

The Swarm ID library provides a secure, iframe-based authentication system for Swarm applications. It consists of three main components:

1. **SwarmIdClient** - For parent windows/dApps to interact with the authentication system
2. **SwarmIdProxy** - Runs in the iframe, handles authentication and proxies Bee API calls
3. **SwarmIdAuth** - Runs in the popup window for user authentication

## Installation

From the monorepo root:

```bash
pnpm install
```

Or directly in the lib folder:

```bash
cd lib
pnpm install
```

## Building

From the monorepo root:

```bash
# Build the library
pnpm build

# Watch mode
pnpm build:watch

# Lint code
pnpm lint

# Auto-fix linting issues
pnpm lint:fix
```

Or directly in the lib folder:

```bash
cd lib

# Build once
pnpm build

# Watch mode
pnpm build:watch

# Lint code
pnpm lint

# Auto-fix linting issues
pnpm lint:fix
```

## Project Structure

```
lib/
├── index.ts                    # Main library exports
├── types.ts                    # Zod schemas & TypeScript interfaces
├── swarm-id-client.ts         # Client for parent windows
├── swarm-id-proxy.ts          # Proxy logic for iframe
├── swarm-id-auth.ts           # Auth popup logic
├── utils/
│   └── key-derivation.ts      # Cryptographic utilities
└── tsconfig.json              # TypeScript configuration

dist/                           # Built output (generated)
├── swarm-id.esm.js            # ESM bundle
├── swarm-id.umd.js            # UMD bundle
├── swarm-id-client.js         # Individual module (ESM)
├── swarm-id-proxy.js          # Individual module (ESM)
├── swarm-id-auth.js           # Individual module (ESM)
└── *.d.ts                     # TypeScript declarations
```

## Usage

### In a Parent dApp

```typescript
import { SwarmIdClient } from 'swarm-id'

// Initialize the client
const client = new SwarmIdClient({
  iframeOrigin: 'https://swarm-id.local:8081',
  beeApiUrl: 'http://localhost:1633',
  timeout: 30000,
  onAuthChange: (authenticated) => {
    console.log('Auth status changed:', authenticated)
  }
})

// Initialize and wait for ready
await client.initialize()

// Create auth button
const container = document.getElementById('auth-container')
const button = client.createAuthButton(container, {
  backgroundColor: '#dd7200',
  color: 'white',
  padding: '10px 20px',
  borderRadius: '4px'
})

// Check auth status
const status = await client.checkAuthStatus()
console.log('Authenticated:', status.authenticated)

// Upload data
const result = await client.uploadData(
  'your-postage-batch-id',
  new Uint8Array([1, 2, 3, 4, 5]),
  { pin: true }
)
console.log('Uploaded:', result.reference)

// Download data
const data = await client.downloadData(result.reference)
console.log('Downloaded:', data)

// Upload file
const file = new File(['Hello World'], 'hello.txt')
const fileResult = await client.uploadFile(
  'your-postage-batch-id',
  file
)
console.log('File uploaded:', fileResult.reference)

// Download file
const downloadedFile = await client.downloadFile(fileResult.reference)
console.log('File name:', downloadedFile.name)
console.log('File data:', downloadedFile.data)

// Cleanup
client.destroy()
```

### In the Iframe (proxy.html)

```typescript
import { initProxy } from 'swarm-id/proxy'

const proxy = initProxy({
  beeApiUrl: 'http://localhost:1633',
  allowedOrigins: [
    'https://swarm-app.local:8080',
    // Add more allowed parent origins
  ]
})
```

### In the Auth Popup (auth.html)

```typescript
import { initAuth } from 'swarm-id/auth'

try {
  const auth = await initAuth()

  // Display app origin
  console.log('App requesting access:', auth.getAppOrigin())

  // Check if user has master key
  if (!auth.hasMasterKey()) {
    // Setup new identity
    const masterKey = await auth.setupNewIdentity()
    console.log('New identity created')
  }

  // Authenticate
  await auth.authenticate()
  console.log('Authentication successful')

  // Close popup
  auth.close(1500)
} catch (error) {
  console.error('Auth failed:', error)
}
```

## API Reference

### SwarmIdClient

#### Constructor

```typescript
new SwarmIdClient(options: ClientOptions)
```

Options:
- `iframeOrigin` (string, required) - Origin of the Swarm ID iframe
- `beeApiUrl` (string, optional) - Bee node API URL (default: 'http://localhost:1633')
- `timeout` (number, optional) - Request timeout in ms (default: 30000)
- `onAuthChange` (function, optional) - Callback for auth status changes

#### Methods

**Authentication**
- `initialize()` - Initialize the client and embed iframe
- `createAuthButton(container, styles?)` - Create auth button
- `requestAuth(styles?)` - Request authentication (opens popup)
- `checkAuthStatus()` - Check authentication status
- `isAuthenticated()` - Check if user is authenticated

**Data Operations**
- `uploadData(batchId, data, options?)` - Upload raw data
- `downloadData(reference, options?)` - Download raw data

**File Operations**
- `uploadFile(batchId, file, name?, options?)` - Upload file
- `downloadFile(reference, path?, options?)` - Download file

**Chunk Operations**
- `uploadChunk(batchId, data, options?)` - Upload chunk
- `downloadChunk(reference, options?)` - Download chunk

**Postage Operations**
- `createPostageBatch(amount, depth, options?)` - Create postage batch
- `getPostageBatch(batchId)` - Get postage batch info

**Cleanup**
- `destroy()` - Destroy client and clean up resources

### SwarmIdProxy

#### Constructor

```typescript
new SwarmIdProxy(options: ProxyOptions)
```

Options:
- `beeApiUrl` (string, required) - Bee node API URL
- `allowedOrigins` (string[], optional) - Allowed parent origins (empty = allow all)

### SwarmIdAuth

#### Constructor

```typescript
new SwarmIdAuth(options?: AuthOptions)
```

Options:
- `masterKeyStorageKey` (string, optional) - LocalStorage key for master key (default: 'swarm-master-key')

#### Methods

- `initialize()` - Initialize auth popup
- `getAppOrigin()` - Get the requesting app's origin
- `getMasterKey()` - Get the master key (truncated for display)
- `hasMasterKey()` - Check if master key exists
- `setupNewIdentity()` - Generate and store new master key
- `authenticate()` - Authenticate and send secret to iframe
- `close(delay?)` - Close popup window (default delay: 1500ms)

## Message Protocol

The library uses postMessage for secure cross-origin communication with Zod schema validation.

### Parent → Iframe Messages
- `parentIdentify` - Identify parent to iframe
- `checkAuth` - Check authentication status
- `requestAuth` - Request authentication (open popup)
- `uploadData` - Upload data request
- `downloadData` - Download data request
- (and other Bee API operations)

### Iframe → Parent Messages
- `proxyReady` - Iframe is ready
- `authStatusResponse` - Auth status response
- `authSuccess` - Authentication succeeded
- `uploadDataResponse` - Upload response with reference
- `downloadDataResponse` - Download response with data
- `error` - Error message

### Popup → Iframe Messages
- `setSecret` - Send derived secret to iframe

## Security Features

- **Origin Validation** - All postMessage calls validate sender origin
- **Parent Origin Locking** - Parent can only identify itself once
- **HMAC-SHA256 Key Derivation** - App-specific secrets derived from master key
- **Partitioned Storage** - Secrets isolated per (iframe-origin, parent-origin) pair
- **Master Key Protection** - Master key never leaves first-party context
- **Type-safe Messages** - Zod schema validation on all messages

## Development

### Code Style

- Use `undefined` instead of `null`
- No semicolons
- TypeScript strict mode
- ESLint with @typescript-eslint

### Testing

```bash
# Run linter
pnpm lint

# Auto-fix issues
pnpm lint:fix
```

## TODO

- [ ] Integrate real Bee API calls (currently simulated)
- [ ] Add unit tests
- [ ] Add integration tests
- [ ] Update HTML files to use library
- [ ] Browser compatibility testing
- [ ] Add error recovery and retry logic
- [ ] Add request cancellation support
- [ ] Add progress callbacks for uploads/downloads
- [ ] Document security model
- [ ] Publish to npm

## License

ISC
