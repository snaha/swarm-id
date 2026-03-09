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
│   ├── key-derivation.ts      # Cryptographic utilities
│   ├── backup-encryption.ts   # AES-GCM-256 encryption for .swarmid files
│   └── account-state-snapshot.ts # Shared serialization for export & sync
├── sync/
│   └── restore-account.ts     # Swarm-based account restoration
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
import { SwarmIdClient } from "swarm-id"

// Initialize the client
const client = new SwarmIdClient({
  iframeOrigin: "https://swarm-id.local:8081",
  beeApiUrl: "http://localhost:1633",
  timeout: 30000,
  onAuthChange: (authenticated) => {
    console.log("Auth status changed:", authenticated)
  },
})

// Initialize and wait for ready
await client.initialize()

// Get the auth iframe (positioned fixed in bottom-right corner)
const iframe = client.getAuthIframe()

// Check auth status
const status = await client.checkAuthStatus()
console.log("Authenticated:", status.authenticated)

// Upload data
const result = await client.uploadData(
  "your-postage-batch-id",
  new Uint8Array([1, 2, 3, 4, 5]),
  { pin: true },
)
console.log("Uploaded:", result.reference)

// Download data
const data = await client.downloadData(result.reference)
console.log("Downloaded:", data)

// Upload file
const file = new File(["Hello World"], "hello.txt")
const fileResult = await client.uploadFile("your-postage-batch-id", file)
console.log("File uploaded:", fileResult.reference)

// Download file
const downloadedFile = await client.downloadFile(fileResult.reference)
console.log("File name:", downloadedFile.name)
console.log("File data:", downloadedFile.data)

// Cleanup
client.destroy()
```

### In the Iframe (SvelteKit `/proxy` route)

```typescript
import { initProxy } from "swarm-id/proxy"

const proxy = initProxy({
  beeApiUrl: "http://localhost:1633",
})
```

### In the Auth Popup (SvelteKit `/connect` route)

```typescript
import { initAuth } from "swarm-id/auth"

try {
  const auth = await initAuth()

  // Display app origin
  console.log("App requesting access:", auth.getAppOrigin())

  // Check if user has master key
  if (!auth.hasMasterKey()) {
    // Setup new identity
    const masterKey = await auth.setupNewIdentity()
    console.log("New identity created")
  }

  // Authenticate
  await auth.authenticate()
  console.log("Authentication successful")

  // Close popup
  auth.close(1500)
} catch (error) {
  console.error("Auth failed:", error)
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
- `getAuthIframe()` - Get the auth iframe element
- `checkAuthStatus()` - Check authentication status
- `connect()` - Open authentication popup programmatically (see [Browser Compatibility](#browser-compatibility-and-storage-access))
- `disconnect()` - Disconnect and clear authentication data
- `getConnectionInfo()` - Get connection info including upload capability

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

## Import & Export

Accounts can be exported to encrypted `.swarmid` backup files and restored via import or from Swarm.

### .swarmid File Format

Each file contains a plaintext JSON header (account metadata, type-specific fields) plus an AES-GCM-256 encrypted payload containing the account state snapshot.

```typescript
import {
  createEncryptedExport,
  decryptEncryptedExport,
  parseEncryptedExportHeader,
} from "@swarm-id/lib"

// Export (no re-auth needed — uses stored swarmEncryptionKey)
const exported = await createEncryptedExport(
  account,
  identities,
  connectedApps,
  postageStamps,
  swarmEncryptionKeyHex,
)

// Read header metadata without decrypting
const header = parseEncryptedExportHeader(fileData)

// Import (requires auth to re-derive key)
const result = await decryptEncryptedExport(fileData, swarmEncryptionKeyHex)
if (result.success) {
  console.log(result.data) // AccountStateSnapshot
}
```

### Account State Snapshots

The `serializeAccountStateSnapshot()` and `deserializeAccountStateSnapshot()` functions provide shared serialization used by both file export and Swarm sync. Connected app secrets are included in snapshots so that backups preserve app connections without requiring re-authentication.

### Swarm Sync & Restore

When a passkey auth succeeds on a new device with no local account, `restoreAccountFromSwarm()` derives the necessary keys, finds the epoch feed in Swarm, downloads and decrypts the latest account snapshot.

```typescript
import { restoreAccountFromSwarm } from "@swarm-id/lib"

const result = await restoreAccountFromSwarm(
  bee,
  masterKey,
  ethereumAddress,
  credentialId,
)
if (result) {
  console.log(result.snapshot) // AccountStateSnapshot
}
```

## Security Features

- **Origin Validation** - All postMessage calls validate sender origin
- **Parent Origin Locking** - Parent can only identify itself once
- **HMAC-SHA256 Key Derivation** - App-specific secrets derived from master key
- **Partitioned Storage** - Secrets isolated per (iframe-origin, parent-origin) pair
- **Master Key Protection** - Master key never leaves first-party context
- **Type-safe Messages** - Zod schema validation on all messages
- **Backup Encryption** - AES-GCM-256 with random IV for .swarmid files
- **appSecret Exclusion** - App secrets are never included in exports or sync snapshots

## Browser Compatibility and Storage Access

There are two ways to trigger authentication:

1. **Iframe button** - User clicks the button rendered inside the iframe (`getAuthIframe()`)
2. **Custom button** - App calls `client.connect()` from its own button

### Storage Access API

The iframe needs access to shared localStorage to read accounts, identities, and postage stamps. Browsers may partition iframe storage, requiring the [Storage Access API](https://developer.mozilla.org/en-US/docs/Web/API/Storage_Access_API) to access unpartitioned storage. This API **requires a user gesture inside the iframe**.

### Environment Compatibility

| Environment                           | Iframe button | Custom button       | Notes                                             |
| ------------------------------------- | ------------- | ------------------- | ------------------------------------------------- |
| **Production (Chrome/Firefox)**       | Yes           | Yes                 | Secure context, storage not partitioned           |
| **Localhost (Chrome, Firefox, etc.)** | Yes           | After iframe button | Iframe button requests Storage Access first       |
| **Safari (any)**                      | Yes\*         | Yes\*               | Requires disabling cross-site tracking prevention |
| **Safari private mode**               | Yes\*         | Yes\*               | Works with ITP disabled; sessions are ephemeral   |

\* Safari requires disabling cross-site tracking prevention: macOS: Settings → Privacy → uncheck "Prevent cross-site tracking". iOS: Settings → Apps → Safari → toggle off "Prevent Cross-Site Tracking" (this affects all iOS browsers since they all use WebKit). See [#167](https://github.com/snaha/swarm-id/issues/167).

### How It Works

**Production (Chrome/Firefox)**: In a secure context (HTTPS), browsers don't partition iframe storage, so both authentication methods work immediately.

**Localhost (Chrome/Firefox)**: Browsers partition iframe storage, requiring the [Storage Access API](https://developer.mozilla.org/en-US/docs/Web/API/Storage_Access_API). The iframe button triggers a user gesture inside the iframe, allowing it to request Storage Access. Once granted, the custom button also works.

**Safari**: Safari's Intelligent Tracking Prevention (ITP) partitions all storage for third-party iframes. Users must disable cross-site tracking prevention for authentication to work. See [#167](https://github.com/snaha/swarm-id/issues/167) for details.

**Safari private mode**: Works with ITP disabled, but sessions are ephemeral — all storage is cleared when the private window closes.

### Recommendation

- **Production (Chrome/Firefox)**: Either button works immediately
- **Development**: Use Chrome/Firefox with iframe button first, then custom button works
- **Safari**: Disable cross-site tracking prevention; private mode sessions are ephemeral

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
