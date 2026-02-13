# Swarm Identity Management

## Overview

Web-based identity and key management solution for decentralized applications on the Swarm network.

**Key Innovation**: Uses popup-based authentication flow that works across all browsers (Chrome, Firefox, Safari) without requiring Storage Access API or browser extensions. Browser-enforced storage partitioning provides cross-app isolation.

### Architecture

The system uses three main components:

1. **Trusted Domain Model**: A trusted domain (e.g., `id.ethswarm.org`) hosts keystore UI and management
2. **OAuth-style Popup Flow**: dApps trigger authentication popups that derive app-specific secrets from a master key
3. **Iframe Proxy**: Hidden iframe handles secure communication and proxies Bee API calls with partitioned storage

**Key Security Features:**
- Master key stored only in first-party context (popup window)
- App-specific secrets derived using HMAC-SHA256 key derivation
- Browser-enforced storage partitioning isolates secrets per `(iframe-origin, parent-origin)` pair
- All postMessage communication validated with Zod schemas

### Authentication Methods

- **Passkey/WebAuthn**: Browser-native credential flow for key management
- **SIWE (Sign-In with Ethereum)**: For users with existing Ethereum wallets
- Both produce signed challenges used as entropy for generating secret keys

### Key Storage

- Hierarchical structure: master key → app-specific keys → resource keys
- **Low-stakes keys** (session keys, feed keys): Can be shared with apps
- **High-stakes keys** (postage stamps, ACT keys): Extra encryption, not shared directly
- Apps request signing operations rather than accessing keys directly
- Encrypted wallet file stored locally (online Swarm sync planned for future)

### Swarm Data Primitives

- **Chunks**: 4KB max payload, content-addressed or single-owner
- **Feeds**: Mutable data pointers (owner + topic → latest reference)
- **SOC (Single Owner Chunk)**: Signed chunk with identifier
- **ACT (Access Control Trie)**: Encrypted content with grantee management
- **Postage Stamps**: Required for uploads, prove payment for storage

## Packages

- **lib/**: TypeScript library (@swarm-id/lib) for authentication and Bee API operations
- **swarm-ui/**: SvelteKit identity management UI (trusted domain) - see `docs-site/CLAUDE.md` for UI-specific guidance
- **demo/**: Demo dApp showing library integration examples
- **docs-site/**: Starlight (Astro) documentation website

## Reference Repositories

- **bee/**: The Bee project Go source code
- **bee-js/**: Custom fork with encrypted streaming chunk uploads
- **swarm-cli/**: Swarm CLI tool

## Essential Commands

### Quick Start

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000 - that's it!

- Demo app runs on port 3000
- Identity UI runs on port 5174 (Vite)
- No HTTPS, certificates, or sudo required

**Note**: `localhost` is treated as a "secure context" by all browsers, so WebAuthn/Passkeys work without HTTPS.

### Development Workflow

```bash
# Start both demo and identity UI
pnpm dev

# Or start individually
pnpm dev:swarm-ui           # Identity UI on port 5174
pnpm dev:demo               # Demo on port 3000
pnpm dev:lib                # Library watch mode (rebuilds on changes)
```

### Building

```bash
# Build everything (monorepo)
pnpm build

# Build specific packages
pnpm build:lib              # Build library only
pnpm build:demo             # Build demo app
pnpm build:swarm-ui         # Build SvelteKit UI
pnpm build:swarm-demo       # Build lib + demo (deployed to swarm-demo.snaha.net)
pnpm build:swarm-id         # Build lib + UI (deployed to swarm-id.snaha.net)

# Build bee-js (forked dependency)
pnpm build:bee-js

# Clean all build outputs
pnpm clean
```

### Code Quality

```bash
# Run all checks (used in CI)
pnpm check:all

# Individual package checks
cd lib
pnpm lint                   # Check linting
pnpm lint:fix               # Auto-fix linting issues
pnpm format                 # Format with Prettier
pnpm format:check           # Check formatting
pnpm typecheck              # TypeScript type checking

cd swarm-ui
pnpm check                  # TypeScript + Svelte checking
pnpm lint                   # ESLint + Prettier
pnpm format                 # Format code
pnpm knip                   # Find unused code
```

### Testing

```bash
# Library testing
cd lib
pnpm test                   # Run all tests
pnpm typecheck              # Type checking

# SvelteKit UI testing
cd swarm-ui
pnpm test                   # Run all tests (Vitest + Playwright)
pnpm test:unit              # Unit tests (Vitest)
pnpm test:ct                # Component tests (Playwright)
pnpm test:integration       # E2E tests (Playwright)
```

## Library Architecture (`lib/`)

### Directory Structure

```
lib/src/
├── index.ts                    # Main library exports
├── types.ts                    # TypeScript interfaces
├── schemas.ts                  # Zod validation schemas
├── swarm-id-client.ts          # SwarmIdClient for parent windows/dApps
├── swarm-id-proxy.ts           # SwarmIdProxy for iframe
├── utils/
│   ├── key-derivation.ts       # HMAC-SHA256 key derivation
│   ├── hex.ts                  # Hex encoding utilities
│   ├── url.ts                  # URL parsing utilities
│   ├── constants.ts            # Shared constants
│   ├── batch-utilization.ts    # Postage batch tracking
│   ├── storage-managers.ts     # Storage abstraction
│   ├── ttl.ts                  # TTL cache utilities
│   └── versioned-storage.ts    # Versioned storage utilities
├── proxy/
│   ├── index.ts                # Proxy exports
│   ├── types.ts                # Proxy type definitions
│   ├── upload-data.ts          # Data upload with chunking
│   ├── upload-encrypted-data.ts # Encrypted data upload
│   ├── download-data.ts        # Data download with assembly
│   ├── chunking.ts             # Basic chunking
│   ├── chunking-encrypted.ts   # Encrypted chunking
│   ├── mantaray.ts             # Mantaray manifest handling
│   ├── mantaray-encrypted.ts   # Encrypted manifests
│   ├── act/                    # Access Control Trie implementation
│   │   ├── act.ts              # Main ACT logic
│   │   ├── crypto.ts           # ACT cryptography
│   │   ├── grantee-list.ts     # Grantee management
│   │   └── history.ts          # ACT history tracking
│   └── feeds/                  # Feed implementations
│       └── epochs/             # Epoch-based feeds
│           ├── index.ts        # Exports
│           ├── types.ts        # Type definitions
│           ├── epoch.ts        # Epoch logic
│           ├── finder.ts       # Feed lookup
│           ├── async-finder.ts # Async feed lookup
│           └── updater.ts      # Feed updates
├── sync/
│   ├── index.ts                # Sync exports
│   ├── types.ts                # Sync type definitions
│   ├── sync-account.ts         # Account synchronization
│   ├── key-derivation.ts       # Sync key derivation
│   ├── serialization.ts        # Data serialization
│   └── store-interfaces.ts     # Store abstractions
└── storage/
    ├── debounced-uploader.ts   # Batched uploads
    └── utilization-store.ts    # Stamp utilization tracking
```

### Core Components

1. **SwarmIdClient** (`swarm-id-client.ts`) - Used by parent dApp windows
   - Embeds hidden iframe from trusted domain
   - Creates auth buttons and handles authentication flow
   - Proxies Bee API calls to iframe
   - Returns responses to dApp

2. **SwarmIdProxy** (`swarm-id-proxy.ts`) - Runs in iframe
   - Receives app-specific secrets from auth popup
   - Stores secrets in partitioned localStorage (isolated per parent origin)
   - Proxies Bee API calls with authentication
   - Signs operations using derived keys

### Message Protocol

All cross-origin communication uses `postMessage` with Zod schema validation:

- **Parent → Iframe**: `parentIdentify`, `checkAuth`, `requestAuth`, `uploadData`, `downloadData`, etc.
- **Iframe → Parent**: `proxyReady`, `authStatusResponse`, `authSuccess`, `uploadDataResponse`, `error`, etc.
- **Popup → Iframe**: `setSecret` (sends app-specific derived secret)

### Key Derivation Hierarchy

```
Master Key (from Passkey/SIWE challenge)
    │
    ├─> App-Specific Secret (HMAC-SHA256 with app origin)
    │       │
    │       ├─> Low-stakes keys (feed keys, session keys)
    │       │   → Can be shared directly with apps
    │       │
    │       └─> High-stakes keys (postage stamps, ACT keys)
    │           → Extra encryption, never shared
    │           → Apps request signing operations
```

### Build Output

```
lib/dist/
├── swarm-id.esm.js         # Main ESM bundle
├── swarm-id.esm.js.map     # Source map
└── *.d.ts                  # TypeScript declarations
```

## Deployment

### Live Demos

- **Demo App**: https://swarm-demo.snaha.net (serves `demo/build/`)
- **Identity UI**: https://swarm-id.snaha.net (serves `swarm-id-build/`)

Both deployed to Digital Ocean App Platform as static sites. See `docs/DEPLOYMENT.md` for details.

### Build Artifacts

**`demo/build/`** (Demo App)
- `index.html` - Demo app
- `lib/` - Library files

**`swarm-id-build/`** (Identity UI)
- SvelteKit app files including prerendered routes: `/proxy`, `/connect`
- `lib/` - Library files

## bee-js Fork

The project depends on a forked version of bee-js with encrypted streaming chunked upload/download:

```bash
# Located at: bee-js/ (git submodule)
# GitHub: https://github.com/agazso/bee-js/tree/feat/encrypted-chunk-streams

# Build bee-js
cd bee-js
npm install
npm run build
```

The library (`lib/package.json`) links to this local fork:
```json
"dependencies": {
  "@ethersphere/bee-js": "link:../bee-js"
}
```

## Local Bee Development Cluster (FDP Play)

For local development with postage stamps, use FDP Play (Docker-based). Requires Docker to be running.

### Starting the Cluster

```bash
# Start cluster (queen + 1 worker) - attached mode shows logs
pnpm dev:bee

# Or run detached (background)
pnpm dev:bee:detach

# View logs
pnpm dev:bee:logs

# Stop cluster
pnpm dev:bee:stop

# Fresh start (pull latest images, purge data)
pnpm dev:bee:fresh
```

### Endpoints

| Service | URL |
|---------|-----|
| Queen Bee API | `http://localhost:1633` |
| Worker 1 API | `http://localhost:11633` |
| Blockchain RPC | `http://localhost:9545` |
| Blockchain WS | `ws://localhost:9546` |

### Developer Tools (/dev route)

The Identity UI includes a Developer Tools page at http://localhost:5174/dev with:

- **Overview**: Quick start guide, local Bee endpoint links with copy buttons
- **Stamps**: Buy postage stamps from the local Bee node using pre-funded signer keys
- **Sync**: Manually trigger account sync to test postage stamp utilization tracking

### Buying a Postage Stamp

Use the Developer Tools UI:

1. Navigate to http://localhost:5174/dev
2. Go to the **Stamps** tab
3. Click **Buy Stamp** with the default settings
4. Copy the batch ID and signer key for use in your code

Or use the Bee API directly:

```bash
# Buy stamp (amount=10000000, depth=17)
curl -X POST "http://localhost:1633/stamps/10000000/17"
# Returns: {"batchID": "...", "txHash": "..."}

# Wait ~30 seconds for stamp to become usable, then verify:
curl "http://localhost:1633/stamps/<batchID>"
# Look for "usable": true
```

### Known Bee Node Private Keys

| Node | Private Key | Ethereum Address |
|------|-------------|------------------|
| Queen | `566058308ad5fa3888173c741a1fb902c9f1f19559b11fc2738dfc53637ce4e9` | `0x26234a2ad3ba8b398a762f279b792cfacd536a3f` |
| Worker 1 | `195cf6324303f6941ad119d0a1d2e862d810078e1370b8d205552a543ff40aab` | - |

### Client-Side Stamp Signing

```typescript
import { Stamper } from '@ethersphere/bee-js'

// Use the queen's key (owns the stamp batch)
const queenKey = '566058308ad5fa3888173c741a1fb902c9f1f19559b11fc2738dfc53637ce4e9'
const batchId = '<your-batch-id>'
const depth = 17

// Create stamper - signs chunks client-side
const stamper = Stamper.fromBlank(queenKey, batchId, depth)

// Stamp a chunk
const envelope = stamper.stamp(chunk)
```

### Pre-funded Blockchain Wallets

10 test wallets with 1000 ETH + BZZ each at genesis:

| # | Address | Private Key |
|---|---------|-------------|
| 0 | `0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1` | `0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d` |
| 1 | `0xFFcf8FDEE72ac11b5c542428B35EEF5769C409f0` | `0x6cbed15c793ce57650b9877cf6fa156fbef513c4e6134f022a85b1ffdd59b2a1` |

## Code Style

### General

- **TypeScript Execution**: Use `pnpx tsx` instead of `npx ts-node`
- **No semicolons** - follow the no-semicolon style
- **Conventional commits**: `feat:`, `fix:`, `docs:`, etc.

### Type Safety

- **Never use `null`** - always use `undefined` for optional/missing values
  - Exception: When `null` comes from external libraries or APIs
  - Return types should be `T | undefined`, never `T | null`
- **Never use `any`** - use proper TypeScript types, generics, union types, or `unknown`

### Import Conventions

- **Never use dynamic imports**: Always use static imports at the top of the file
  - `import Foo from '$lib/foo'` at top of file
  - `const foo = await import('$lib/foo')` inside a function
- **Omit file extensions** in import statements

### Constants

- **Use constants instead of hardcoded numbers**: Always define magic numbers as named constants
  - Bad: `setTimeout(() => {...}, 5000)` or `if (value > 100)`
  - Good: `const TIMEOUT_MS = 5000; setTimeout(() => {...}, TIMEOUT_MS)`
  - Exceptions: 0, 1, -1, and 2 are acceptable when meaning is obvious
  - Use SCREAMING_SNAKE_CASE for constant names

## Naming Conventions

- **File naming**: Use kebab-case for all file names (e.g., `user-profile.ts`, `email-template.svelte`)
- **Directory naming**: Use kebab-case for directory names (e.g., `email-templates/`, `user-settings/`)

## swarm-ui Specific

### Svelte 5 Runes

This project uses Svelte 5 with runes for reactive state management:

- Use `$state()` for reactive variables
- Use `$derived()` for computed values
- Use `$effect()` for side effects

### Design System (Diete)

- Uses Diete design system for UI components (`swarm-ui/src/lib/components/ui/`)
- Full documentation at https://diete.design
- Always prefer Diete components over custom HTML elements
- Use CSS custom properties for spacing: `--padding`, `--half-padding`, `--double-padding`

### Icons (Carbon Icons)

- Library: `carbon-icons-svelte`
- **Always use direct imports**:
  - `import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'`
  - `import { ArrowRight } from 'carbon-icons-svelte'` (causes SSR issues)
- Browse icons at https://carbondesignsystem.com/guidelines/icons/library/

Usage examples:
```svelte
<Information size={20} />
<Wallet size={20} />
<ArrowRight size={16} />
<Copy size={20} />
<Checkmark size={20} />
```

### Layout Components

- **Vertical** uses `--vertical-gap` (NOT `--gap`)
- **Horizontal** uses `--horizontal-gap` (NOT `--gap`)
- Alignment: `--vertical-align-items`, `--vertical-justify-content`, `--horizontal-align-items`, `--horizontal-justify-content`
- Style properties can be passed directly: `<Divider --divider-color="black" />`

Examples:
```svelte
<Vertical --vertical-gap="var(--padding)" --vertical-align-items="start">
  <Typography>Content</Typography>
</Vertical>

<Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
  <Button>Click</Button>
</Horizontal>
```

### Component Properties Over CSS

Always use component properties first, only resort to custom CSS if the property doesn't exist:
```svelte
<!-- Good -->
<Typography font="mono">code</Typography>
<Typography variant="small">small text</Typography>
<Button variant="ghost">Click</Button>

<!-- Bad -->
<Typography class="monospace">code</Typography>
<Typography style="font-size: 0.875rem;">small text</Typography>
<Button class="ghost-button">Click</Button>
```

## Pre-commit Requirements

**IMPORTANT**: Before committing any changes, you MUST run and pass:

- `pnpm format` - Formats code with Prettier
- `pnpm lint` - Checks code style and quality with ESLint and Prettier
- `pnpm check` - Runs Svelte Kit sync and TypeScript type checking
- `pnpm knip` - Finds unused files, dependencies, and exports

**Quick check**: Use `pnpm check:all` to run all the above checks at once (used in CI).

## Design-to-Code Workflow (Figma MCP)

This project uses the **Figma Desktop MCP** (Model Context Protocol) server, which connects Claude Code directly to the Figma desktop app for real-time design access.

### Prerequisites

1. **Figma desktop app** must be running with the design file open
2. **Figma MCP server** must be configured in Claude Code's MCP settings

### Available Tools

#### 1. `get_design_context` - Primary tool for code generation

Extracts design data from a Figma node and returns structured information optimized for generating UI code.

```
Parameters:
  nodeId          - Node ID (e.g., "123:456"). If omitted, uses currently selected node.
  artifactType    - WEB_PAGE_OR_APP_SCREEN, COMPONENT_WITHIN_A_WEB_PAGE_OR_APP_SCREEN,
                    REUSABLE_COMPONENT, or DESIGN_SYSTEM
  taskType        - CREATE_ARTIFACT, CHANGE_ARTIFACT, or DELETE_ARTIFACT
  clientLanguages - e.g., "html,css,typescript"
  clientFrameworks - e.g., "svelte"
```

#### 2. `get_screenshot` - Visual reference

Returns a screenshot/image of a Figma node.

#### 3. `get_variable_defs` - Design tokens

Returns variable definitions (colors, spacing, typography) for a node.

#### 4. `get_metadata` - Structure overview

Returns the node tree structure in XML format (IDs, layer types, names, positions, sizes).

### Extracting Node IDs from Figma URLs

```
https://figma.com/design/:fileKey/:fileName?node-id=1-2
→ nodeId = "1:2"  (replace hyphen with colon)
```

### Workflow

1. Open design in Figma desktop app
2. Select the frame/component to implement
3. Ask Claude Code to implement it
4. Claude Code calls `get_design_context` → generates Svelte 5 code
5. Preview in browser → screenshot → visual comparison
6. Iterate until implementation matches design

### Example Prompts

```
"Implement the currently selected Figma frame as a Svelte 5 component"

"Implement this Figma design: https://figma.com/design/abc123/MyFile?node-id=42-100"

"Get the variable definitions from the selected Figma node"
```

## Testing Best Practices

- **Unit tests** (`*.test.ts`): Business logic, utilities, stores (Vitest)
- **Component tests** (`*.ct.spec.ts`): Component behavior in real browsers (Playwright)
- **E2E tests** (`tests/*.test.ts`): Full application workflows (Playwright)
- Use hardcoded expected values instead of regex patterns in assertions
- Test cross-browser compatibility for user interaction components
- Run `pnpm check` before committing

## Troubleshooting

### Demo not loading
```bash
# Check if ports are in use
lsof -i :3000 -i :5174

# Ensure both servers are running
pnpm dev
```

### Authentication popup blocked
- Allow popups for localhost in browser settings
- Some browsers block popups by default

### WebAuthn not working
- Ensure you're on `localhost` (not 127.0.0.1)
- Check browser supports WebAuthn
- `localhost` is a secure context, so HTTPS is not required

### Library changes not reflected
```bash
# Rebuild library
cd lib && pnpm build

# Or use watch mode for auto-rebuild
cd lib && pnpm build:watch
```

## Documentation

- **README.md**: Full project docs, architecture, deployment
- **docs/**: Proposals and research documents
  - Swarm-Identity-Management-Proposal.md
  - Multi-Device-Stamp-Coordination-Research.md
  - DEPLOYMENT.md
- **The-Book-of-Swarm.pdf**: Comprehensive Swarm documentation

Each package folder contains its own README.md with package-specific documentation.
