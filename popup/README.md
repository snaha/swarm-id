# Swarm ID - OAuth-Style Popup Authentication

This folder contains an OAuth-style authentication flow that works across all browsers (Chrome, Firefox, Safari) without requiring the Storage Access API.

## Architecture

```
┌─────────────────────────────────────────────┐
│ swarm-app.local (dApp)                      │
│                                             │
│ [Login with Swarm ID] button                │
│        ↓                                    │
│ 1. Opens popup: swarm-id.local/popup/auth   │
│ 2. Has hidden iframe: swarm-id.local/popup/proxy │
└─────────────────────────────────────────────┘
                    ↓
        Opens popup window
                    ↓
┌─────────────────────────────────────────────┐
│ Popup: swarm-id.local/popup/auth.html       │
│                                             │
│ [Authenticate] button                       │
│        ↓                                    │
│ 1. Get master identity from localStorage    │
│ 2. Derive app secret = derive(master, app)  │
│ 3. postMessage → iframe with secret         │
│ 4. Close popup                              │
└─────────────────────────────────────────────┘
                    ↓
         postMessage (secret)
                    ↓
┌─────────────────────────────────────────────┐
│ Iframe: swarm-id.local/popup/proxy.html     │
│                                             │
│ Receives secret                             │
│ Stores in partitioned localStorage          │
│ Ready to proxy Bee API calls                │
└─────────────────────────────────────────────┘
```

## How It Works

### 1. Master Identity Storage (First-Party)

The **popup window** opens at `swarm-id.local` which is a **first-party context**. This means:
- ✅ No storage partitioning
- ✅ Full access to localStorage/IndexedDB
- ✅ Works identically in Chrome, Firefox, and Safari

The master identity key is stored in `swarm-id.local`'s localStorage:
```javascript
localStorage.getItem('swarm-master-key')
```

### 2. App-Specific Secret Derivation

Using HMAC-SHA256, the popup derives a unique secret for each app:
```javascript
const appSecret = await deriveSecret(masterKey, appOrigin);
// Example:
// masterKey: "abc123..."
// appOrigin: "https://swarm-app.local:8080"
// → appSecret: "def456..." (unique per app)
```

This ensures:
- ✅ Each app gets a unique secret
- ✅ Secrets are deterministic (same master + app = same secret)
- ✅ No cross-app secret leakage

### 3. Secret Transfer (postMessage)

The popup sends the secret to the hidden iframe:
```javascript
iframe.contentWindow.postMessage(
  {
    type: 'setSecret',
    appOrigin: 'https://swarm-app.local:8080',
    secret: 'def456...'
  },
  'https://swarm-id.local:8081'
);
```

### 4. Partitioned Storage (Per-App)

The iframe stores the secret in **partitioned localStorage**:
```javascript
// Storage key: swarm-secret-https://swarm-app.local:8080
localStorage.setItem(`swarm-secret-${appOrigin}`, secret);
```

Browser partitioning means:
- ✅ Each `(iframe-origin, parent-origin)` pair gets isolated storage
- ✅ Different dApps can't access each other's secrets
- ✅ Security through browser-enforced isolation

### 5. Proxying Bee API Calls

When the dApp wants to upload/download:
```javascript
// dApp → iframe
window.postMessage(
  { type: 'uploadChunk', data: [1,2,3,4,5] },
  'https://swarm-id.local:8081'
);

// iframe:
// 1. Get secret from partitioned localStorage
// 2. Call bee-js with secret
// 3. Return response to dApp
```

## Files

### `auth.html` - Authentication Popup

**Purpose**: Allow user to authenticate and derive app-specific secrets

**Features**:
- Beautiful authentication UI
- Loads master identity from first-party localStorage
- "Set up new identity" button for first-time users
- Derives app-specific secret using HMAC-SHA256
- Sends secret to iframe via postMessage
- Auto-closes after authentication

**URL**: `https://swarm-id.local:8081/popup/auth.html?origin=<app-origin>`

### `proxy.html` - Hidden Iframe Proxy

**Purpose**: Store app-specific secrets and proxy Bee API calls

**Features**:
- Receives secrets from auth popup
- Stores in partitioned localStorage (one per app)
- Provides `checkAuth()` method via postMessage
- Proxies `uploadChunk` and `downloadChunk` requests
- Origin validation for security
- Visual status indicator (for debugging)

**Embedded in**: dApp pages (hidden iframe)

### `demo.html` - Demo dApp Page

**Purpose**: Demonstrate the complete authentication and API flow

**Features**:
- "Login with Swarm ID" button
- Hidden iframe embedding `proxy.html`
- Authentication status display
- Upload chunk test (text → Swarm)
- Download chunk test (reference → data)
- Full upload + download test with verification

**URL**: `https://swarm-app.local:8080/popup/demo.html`

### `key-derivation.js` - Crypto Utilities

**Purpose**: Cryptographic functions for key derivation

**Functions**:
- `deriveSecret(masterKey, appOrigin)` - Derive app-specific secret using HMAC-SHA256
- `generateMasterKey()` - Generate random master key for testing
- `verifySecret(masterKey, appOrigin, expectedSecret)` - Verify derivation
- `utils.hexToUint8Array()` - Convert hex string to bytes
- `utils.uint8ArrayToHex()` - Convert bytes to hex string

**Usage**:
```javascript
import { deriveSecret, generateMasterKey } from './key-derivation.js';

const masterKey = await generateMasterKey();
const secret = await deriveSecret(masterKey, 'https://swarm-app.local:8080');
```

## Testing

### Prerequisites

1. Both servers running:
   ```bash
   ./start-servers.sh
   ```

2. Hosts configured:
   ```
   127.0.0.1  swarm-app.local
   127.0.0.1  swarm-id.local
   ```

### Test Flow

1. **Open demo page**:
   ```
   https://swarm-app.local:8080/popup/demo.html
   ```

2. **First-time setup**:
   - Click "Login with Swarm ID"
   - Popup opens at swarm-id.local
   - No identity found → Click "Set one up"
   - Master key generated and stored
   - Click "Authenticate"
   - Secret derived and sent to iframe
   - Popup closes
   - Demo page shows "Authenticated ✓"

3. **Upload test**:
   - Enter text in textarea
   - Click "Upload Chunk"
   - Chunk uploaded via iframe proxy
   - Reference hash displayed

4. **Download test**:
   - Copy reference hash
   - Paste in download input
   - Click "Download Chunk"
   - Original data displayed

5. **Subsequent logins**:
   - Refresh page or open new tab
   - Click "Login with Swarm ID"
   - Popup opens with existing identity
   - Click "Authenticate" (no setup needed)
   - Instant authentication

### Verify Cross-Browser Compatibility

**Test in each browser**:

#### Chrome
- Should work perfectly
- Check DevTools → Application → Storage to verify partitioning

#### Firefox
- Should work perfectly
- Check DevTools → Storage → Local Storage to verify partitioning

#### Safari
- Should work perfectly (this is the main goal!)
- Check Develop → Storage to verify popup has unpartitioned access
- Verify iframe has partitioned storage

## Security Features

### 1. Origin Validation

**Popup validates iframe**:
```javascript
const iframeOrigin = new URL(iframe.src).origin;
if (iframeOrigin !== 'https://swarm-id.local:8081') {
  throw new Error('Invalid iframe origin');
}
```

**Iframe validates parent**:
```javascript
const ALLOWED_PARENT_ORIGINS = [
  'https://swarm-app.local:8080',
  // Add more allowed origins
];

if (!ALLOWED_PARENT_ORIGINS.includes(event.origin)) {
  console.warn('Rejected message from unauthorized origin');
  return;
}
```

### 2. Secret Scope Isolation

Each app gets a unique derived secret:
```javascript
// App A: https://app-a.local
const secretA = deriveSecret(masterKey, 'https://app-a.local');

// App B: https://app-b.local
const secretB = deriveSecret(masterKey, 'https://app-b.local');

// secretA !== secretB (cryptographically unique)
```

Browser partitioning provides additional isolation:
- App A's iframe cannot read App B's secret from localStorage
- Each `(iframe, parent)` pair has separate storage

### 3. Master Key Protection

The master key **never leaves** first-party context:
- ✅ Stored in swarm-id.local localStorage (first-party)
- ✅ Only accessed in popup window (first-party)
- ✅ Never sent to iframe
- ✅ Never sent to dApp

Only derived secrets are sent to iframes.

### 4. Popup → Iframe Communication

Secure window reference:
```javascript
// Popup finds iframe via window.opener
const parentWindow = window.opener;
const iframes = parentWindow.document.querySelectorAll('iframe');
const targetIframe = findMatchingIframe(iframes);

// postMessage with origin validation
targetIframe.contentWindow.postMessage(message, PROXY_ORIGIN);
```

## API Reference

### Iframe Proxy API

The iframe responds to these postMessage types:

#### `checkAuth`

Check if user is authenticated for this app.

**Request**:
```javascript
{
  type: 'checkAuth',
  requestId: 'msg-1'
}
```

**Response**:
```javascript
{
  type: 'checkAuthResponse',
  requestId: 'msg-1',
  authenticated: true
}
```

#### `uploadChunk`

Upload a chunk to Swarm.

**Request**:
```javascript
{
  type: 'uploadChunk',
  requestId: 'msg-2',
  data: [1, 2, 3, 4, 5] // Array of bytes
}
```

**Response**:
```javascript
{
  type: 'uploadChunkResponse',
  requestId: 'msg-2',
  reference: 'abc123...' // Swarm reference hash
}
```

#### `downloadChunk`

Download a chunk from Swarm.

**Request**:
```javascript
{
  type: 'downloadChunk',
  requestId: 'msg-3',
  reference: 'abc123...'
}
```

**Response**:
```javascript
{
  type: 'downloadChunkResponse',
  requestId: 'msg-3',
  data: [1, 2, 3, 4, 5] // Array of bytes
}
```

### Iframe Notifications

The iframe sends these notifications (no requestId):

#### `proxyReady`

Sent when iframe is initialized and ready.

```javascript
{
  type: 'proxyReady'
}
```

#### `authSuccess`

Sent when authentication is successful.

```javascript
{
  type: 'authSuccess',
  origin: 'https://swarm-app.local:8080'
}
```

## Future Enhancements

### Phase 2: bee-js Integration

Replace simulated upload/download with actual bee-js calls:

```javascript
import { Bee } from '@ethersphere/bee-js';

const bee = new Bee('http://localhost:1633');

async function handleUploadChunk(data, appSecret) {
  // Use appSecret for signing SOC/Feeds
  const reference = await bee.uploadData(postageBatchId, data);
  return reference;
}
```

### Phase 3: Postage Stamp Management

Store postage batch IDs in iframe's partitioned storage:

```javascript
localStorage.setItem(
  `swarm-postage-${appOrigin}`,
  postageBatchId
);
```

### Phase 4: SOC and Feed Signing

Use app-specific secrets to sign Single-Owner Chunks and Feeds:

```javascript
import { SOCWriter } from '@ethersphere/bee-js';

const socWriter = new SOCWriter({
  signer: {
    // Use appSecret as signing key
    sign: (data) => signWithSecret(data, appSecret)
  }
});
```

### Phase 5: Multi-Identity Support

Allow users to manage multiple Swarm identities:

```javascript
// Store multiple identities
const identities = JSON.parse(localStorage.getItem('swarm-identities') || '{}');
identities['identity-1'] = { name: 'Personal', key: '...' };
identities['identity-2'] = { name: 'Work', key: '...' };

// Let user choose which identity to use for authentication
```

## Troubleshooting

### Popup blocked

**Problem**: Browser blocks popup window

**Solution**:
- Check browser popup settings
- Allow popups for swarm-app.local
- Ensure login button uses `window.open()` (not programmatic open)

### Authentication fails

**Problem**: "Could not find proxy iframe in parent window"

**Solution**:
- Verify iframe exists in parent page
- Check iframe `src` matches expected origin
- Ensure iframe has loaded before opening popup

### Secrets not persisting

**Problem**: Need to login on every page reload

**Solution**:
- Check browser isn't in private/incognito mode
- Verify localStorage isn't being cleared
- Check iframe's partitioned storage in DevTools

### Cross-origin errors

**Problem**: postMessage rejected due to origin mismatch

**Solution**:
- Verify all origins use HTTPS (not HTTP)
- Check origin strings match exactly (including port)
- Add origins to `ALLOWED_PARENT_ORIGINS` in proxy.html

## Browser Compatibility

| Browser | Popup (First-Party) | Iframe (Partitioned) | Overall |
|---------|--------------------|--------------------|---------|
| Chrome  | ✅ Yes | ✅ Yes | ✅ Works |
| Firefox | ✅ Yes | ✅ Yes | ✅ Works |
| Safari  | ✅ Yes | ✅ Yes | ✅ Works |
| Edge    | ✅ Yes | ✅ Yes | ✅ Works |

**Key Insight**: This architecture works because:
- Popup uses **first-party** localStorage (no partitioning)
- Iframe uses **partitioned** localStorage (browser-enforced isolation)
- No Storage Access API needed!

## License

MIT
