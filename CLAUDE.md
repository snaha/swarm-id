# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Swarm Identity Management** - A cross-browser compatible authentication and identity management system for Swarm dApps. This monorepo implements an OAuth-style popup authentication flow that works across Chrome, Firefox, and Safari without requiring browser extensions or the Storage Access API.

## Architecture

The system uses three main components:

1. **Trusted Domain Model**: A trusted domain (`swarm-id.local`) hosts authentication UI and keystore management
2. **OAuth-style Popup Flow**: dApps trigger authentication popups that derive app-specific secrets from a master key
3. **Iframe Proxy**: Hidden iframe handles secure communication and proxies Bee API calls with partitioned storage

**Key Security Features:**
- Master key stored only in first-party context (popup window)
- App-specific secrets derived using HMAC-SHA256 key derivation
- Browser-enforced storage partitioning isolates secrets per `(iframe-origin, parent-origin)` pair
- All postMessage communication validated with Zod schemas

## Monorepo Structure

This is a pnpm monorepo with workspace packages:

- **lib/** - TypeScript library for Swarm ID authentication (`@swarm-id/lib`)
  - Builds ES6 modules to `lib/dist/`
  - Distributed as separate module files, not bundled

- **demo/** - Demo app (`@swarm-id/demo`)
  - Simple HTML files with standard ES6 module imports
  - Build copies library files to `demo/build/lib/`
  - Deployed to swarm-demo.snaha.net

- **popup/** - OAuth-style popup demos (local development only, not deployed)
  - Original proof-of-concept implementation
  - Used for local testing only

- **swarm-ui/** - SvelteKit-based identity management UI (`swarm-identity`)
  - Full production app with Svelte 5
  - Deployed to swarm-id.snaha.net

- **bee-js/** - Bee.js library (linked dependency)

**Workspace config:** `pnpm-workspace.yaml`, root `package.json`

## Build Process

### Library Distribution

The library is built as ES6 modules (not bundled):

```bash
cd lib
pnpm build    # Outputs to lib/dist/
```

Output files:
- `swarm-id-client.js` (~60KB)
- `swarm-id-proxy.js` (~350KB, includes zod)
- `swarm-id-auth.js` (~3.4KB)
- TypeScript definitions (`.d.ts`)
- Source maps (`.js.map`)

### Demo App Build

Build script (`demo/build.js`):
1. Copies `lib/dist/` → `demo/build/lib/`
2. Injects environment config into HTML files
3. No inline bundling - HTML files use `<script type="module">` imports

```bash
pnpm build:swarm-demo
# or
cd demo && pnpm build
```

### Identity UI Build

Build script (`build-swarm-id.js`):
1. Builds SvelteKit app → `swarm-ui/build/`
2. Copies SvelteKit build → `swarm-id-build/`
3. Copies `lib/dist/` → `swarm-id-build/lib/`
4. Processes proxy/auth HTML files (injects config only)

```bash
pnpm build:swarm-id
# or
pnpm build:lib && pnpm build:swarm-ui && node build-swarm-id.js
```

### Key Differences from Previous Approach

**Old approach (problematic):**
- Inline bundled library code into HTML files
- 400KB HTML files with embedded JavaScript
- Complex regex-based string replacement
- Issues with special characters ($&, backticks, template strings)

**New approach (current):**
- Standard ES6 module imports: `import { initProxy } from '/lib/swarm-id-proxy.js'`
- Small HTML files (3-12KB)
- Library files served separately from `/lib/` directory
- Proper source maps and debugging
- Industry-standard pattern

## Commands

### Monorepo Commands (from root)

```bash
# Install all workspace dependencies
pnpm install

# Build everything
pnpm build

# Build specific apps (includes dependencies)
pnpm build:swarm-demo    # Builds lib + demo
pnpm build:swarm-id      # Builds lib + swarm-ui + processes proxy files

# Clean all builds
pnpm clean

# Development
pnpm dev:lib             # Watch mode for library
pnpm dev:swarm-ui        # Dev server for SvelteKit
```

### Individual Package Commands

**Library (lib/):**
```bash
cd lib
pnpm build          # Build library
pnpm build:watch    # Watch mode
pnpm lint           # Lint code
pnpm typecheck      # Type checking
```

**Demo (demo/):**
```bash
cd demo
pnpm build          # Copies library to build/lib/, injects config
```

**SvelteKit UI (swarm-ui/):**
```bash
cd swarm-ui
pnpm dev            # Dev server with hot reload
pnpm build          # Production build
pnpm test           # Run all tests
pnpm check          # Type checking
```

### Local Development Setup

**Prerequisites:**
1. Install mkcert: `brew install mkcert && mkcert -install`
2. Generate SSL certificates: `mkcert swarm-app.local swarm-id.local`
3. Configure `/etc/hosts`:
   ```
   127.0.0.1  swarm-app.local
   127.0.0.1  swarm-id.local
   ```

**Start development servers:**

**Option 1: Quick start (no demo build needed!)**
```bash
cd lib && pnpm build    # Build library
./start-servers.sh      # Start both HTTPS servers
```

**Option 2: Full build (with SvelteKit UI)**
```bash
pnpm build             # Build everything
./start-servers.sh     # Start both HTTPS servers
```

**Option 3: Dev mode (with hot reload)**
```bash
cd swarm-ui && pnpm dev &   # Start SvelteKit dev server
./start-servers-dev.sh       # Start HTTPS proxy servers
```

**Access demos:**
- Library demo (recommended): `https://swarm-app.local:8080/demo.html`
- Popup demo (experimental): `https://swarm-app.local:8080/popup/demo.html`
- Identity UI: `https://swarm-id.local:8081/`

**How it works:**
- Servers map `/lib/*` → `lib/dist/*` automatically
- Demo HTML files served from `demo/` (source files, not build)
- No build step needed for local development!
- Optional: Build SvelteKit UI for full identity management features

## Code Architecture

### Library Structure (lib/src/)

```
lib/src/
├── index.ts                    # Main library exports
├── types.ts                    # Zod schemas & TypeScript interfaces
├── swarm-id-client.ts         # SwarmIdClient for parent windows/dApps
├── swarm-id-proxy.ts          # SwarmIdProxy for iframe
├── swarm-id-auth.ts           # SwarmIdAuth for popup window
├── utils/
│   └── key-derivation.ts      # HMAC-SHA256 key derivation utilities
└── proxy/                     # Bee API proxy implementations
    ├── upload-data.ts         # Data upload with chunking
    ├── upload-encrypted-data.ts  # Encrypted data upload
    ├── download-data.ts       # Data download with assembly
    ├── chunking.ts            # Basic chunking
    └── chunking-encrypted.ts  # Encrypted chunking
```

**Three main classes:**

1. **SwarmIdClient** (`swarm-id-client.ts`) - Used by parent dApp windows
   - Embeds hidden iframe
   - Creates auth buttons
   - Provides API for Bee operations (upload/download data, files, chunks)
   - Handles postMessage communication with iframe

2. **SwarmIdProxy** (`swarm-id-proxy.ts`) - Runs in the iframe
   - Receives app-specific secrets from auth popup
   - Stores secrets in partitioned localStorage
   - Proxies Bee API calls with authentication
   - Validates all incoming messages from parent

3. **SwarmIdAuth** (`swarm-id-auth.ts`) - Runs in the popup window
   - Loads/generates master key from localStorage
   - Derives app-specific secrets using HMAC-SHA256
   - Sends secret to iframe via postMessage
   - Closes popup after authentication

### SvelteKit UI Structure (swarm-ui/src/)

The swarm-ui package is a separate SvelteKit application with Svelte 5 (runes). See `swarm-ui/CLAUDE.md` for detailed guidance specific to that codebase, including:
- Svelte 5 runes patterns (`$state`, `$derived`, `$effect`)
- Diete design system usage
- TypeScript strict mode conventions
- Pre-commit requirements

### Message Protocol

All cross-origin communication uses postMessage with Zod validation. Key message types:

**Parent → Iframe:**
- `parentIdentify` - Identify parent to iframe
- `checkAuth` - Check authentication status
- `requestAuth` - Request authentication (open popup)
- `uploadData`, `downloadData` - Bee API operations

**Iframe → Parent:**
- `proxyReady` - Iframe is ready
- `authStatusResponse`, `authSuccess` - Auth status updates
- `uploadDataResponse`, `downloadDataResponse` - Operation responses
- `error` - Error messages

**Popup → Iframe:**
- `setSecret` - Send derived app-specific secret

### Key Derivation

App-specific secrets are derived deterministically using HMAC-SHA256:

```typescript
// In popup window (swarm-id-auth.ts)
const appSecret = await deriveSecret(masterKey, appOrigin)
// masterKey: stored in swarm-id.local localStorage
// appOrigin: e.g., "https://swarm-app.local:8080"
// → appSecret: unique per app, deterministic
```

This ensures:
- Each app gets a unique secret
- Same master key + app origin = same secret (deterministic)
- No cross-app secret leakage

### Bee Integration

The library integrates with Bee nodes for Swarm storage:

**Data Operations:**
- Upload/download raw data with optional encryption
- Chunking support for large data (4KB max per chunk)
- File upload/download with metadata

**Postage Operations:**
- Create postage batches (required for uploads)
- Query postage batch status

**Encryption Support:**
- Optional encryption for uploads (`encrypt: true`)
- Encrypted references are 128 hex chars (64 bytes)
- Regular references are 64 hex chars (32 bytes)

## Development Conventions

### TypeScript

- Use TypeScript strict mode
- Never use `any` - use `unknown` or proper types
- **Never use `null` - always use `undefined` for optional/missing values**
  - Exceptions: External libraries/APIs, Supabase/SQL data
- Omit file extensions in imports (`.js`, `.ts`)
- Never use dynamic imports - always static imports at top of file

### Code Style (lib/)

- No semicolons
- Use `undefined` instead of `null`
- ESLint with @typescript-eslint
- Run `pnpm lint` and `pnpm typecheck` before committing

### File Naming

- Use kebab-case for all files and directories
- Svelte components: kebab-case filename, PascalCase component name

### Package Manager

- **Always use `pnpm`**, never npm or yarn
- Node >=22, pnpm >=10 required

## Testing

- Unit tests with Vitest (`.test.ts`)
- Component tests with Playwright (`.ct.spec.ts`)
- E2E tests with Playwright (`tests/*.test.ts`)

Run tests from the appropriate package directory.

## Local Development Workflow

**Simplest approach** (no demo build required):
```bash
# 1. Build library once
cd lib && pnpm build
cd ..

# 2. Start servers
./start-servers.sh

# 3. Access demos
# https://swarm-app.local:8080/demo.html
```

**Development with live reload:**
```bash
# Terminal 1: Auto-rebuild library on changes
cd lib && pnpm build:watch

# Terminal 2: Start servers
./start-servers.sh
```

**SvelteKit development:**
```bash
# Terminal 1: SvelteKit dev server
cd swarm-ui && pnpm dev

# Terminal 2: HTTPS proxy servers
./start-servers-dev.sh
```

**Key points:**
- Servers map `/lib/*` → `lib/dist/*` automatically
- No need to build demo app for local development
- Build only needed for production deployment

## Common Issues

**Certificate errors:**
- Reinstall mkcert CA: `mkcert -install`
- Regenerate certificates: `mkcert swarm-app.local swarm-id.local`

**Popup blocked:**
- Allow popups for `swarm-app.local` in browser settings
- Ensure popup is triggered by user action

**Module not found:**
- Build the library first: `cd lib && pnpm build`

**CORS errors:**
- Use correct domains (`swarm-app.local`/`swarm-id.local`), not `localhost`

## Deployment

### Production Environments

**swarm-demo.snaha.net** (Demo App)
- Deploys `demo/build/` directory
- Static site on Digital Ocean App Platform
- Build command: `pnpm install && pnpm build:swarm-demo`
- Output directory: `demo/build`
- Config: `.do-app-demo.yaml`

**swarm-id.snaha.net** (Identity UI)
- Deploys `swarm-id-build/` directory
- Static site on Digital Ocean App Platform
- Build command: `pnpm install && pnpm build:swarm-id`
- Output directory: `swarm-id-build`
- Config: `.do-app-id.yaml`

### Environment Variables

Both apps use environment variables (injected at build time):

```javascript
window.__APP_DOMAIN__ = 'https://swarm-demo.snaha.net'
window.__ID_DOMAIN__ = 'https://swarm-id.snaha.net'
window.__BEE_API_URL__ = 'http://localhost:1633'
```

These are injected into HTML files during build by `demo/build.js` and `build-swarm-id.js`.

### CORS Configuration

Both servers whitelist each other:
- Demo app allows requests from identity app
- Identity app allows iframe embedding from demo app
- Configured via response headers in build scripts

See `docs/DEPLOYMENT.md` for detailed deployment instructions.

## Related Documentation

- `README.md` - Overall project setup and architecture
- `docs/DEPLOYMENT.md` - Deployment guide for Digital Ocean App Platform
- `lib/README.md` - Library API reference and usage
- `popup/README.md` - Popup authentication flow details
- `demo/README.md` - Demo implementation guide
- `swarm-ui/CLAUDE.md` - SvelteKit UI development guidance
- `swarm-ui/docs/proposal.md` - Full PoC proposal with user flows

## Important Context

**This project is exploratory** - it implements multiple approaches to Swarm identity management:
1. OAuth-style popup flow (popup/, demo/, lib/)
2. Passkey/WebAuthn-based identity (swarm-ui/)
3. SIWE (Sign-In with Ethereum) integration

**Current status:**
- Library uses standard ES6 module imports (not inline bundling)
- Demo HTML files are small (~3-12KB) and import from `/lib/`
- Library files (~8MB with source maps) served separately
- Production deployments working on Digital Ocean

The library (`lib/`) currently simulates Bee API calls. Real Bee integration is a TODO item.
