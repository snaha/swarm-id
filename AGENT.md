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

```bash
pnpm install          # Install dependencies
pnpm dev              # Start demo (port 3000) + identity UI (port 5174)
pnpm build            # Build everything
pnpm check:all        # Run all CI checks (format, lint, typecheck, knip)
pnpm test             # Run tests across packages
pnpm clean            # Clean all build outputs
```

`localhost` is a secure context, so WebAuthn/Passkeys work without HTTPS.

## Library Architecture (`lib/`)

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

## Deployment

- **Demo App**: https://swarm-demo.snaha.net
- **Identity UI**: https://swarm-id.snaha.net

Both deployed to Digital Ocean App Platform as static sites. See `docs/DEPLOYMENT.md` for details.

## bee-js Fork

The project depends on a forked version of bee-js (`bee-js/` submodule) with encrypted streaming chunked upload/download. Build with `pnpm build:bee-js`. The library links to this local fork via `"@ethersphere/bee-js": "link:../bee-js"`.

## Local Bee Development Cluster (FDP Play)

Docker-based local Bee cluster for development with postage stamps.

```bash
pnpm dev:bee          # Start cluster (queen + 1 worker)
pnpm dev:bee:detach   # Start in background
pnpm dev:bee:stop     # Stop cluster
pnpm dev:bee:fresh    # Fresh start (pull latest, purge data)
```

| Service | URL |
|---------|-----|
| Queen Bee API | `http://localhost:1633` |
| Worker 1 API | `http://localhost:11633` |
| Blockchain RPC | `http://localhost:9545` |

Developer Tools at http://localhost:5174/dev provide stamp buying and sync testing.

### Known Bee Node Private Keys

| Node | Private Key | Ethereum Address |
|------|-------------|------------------|
| Queen | `566058308ad5fa3888173c741a1fb902c9f1f19559b11fc2738dfc53637ce4e9` | `0x26234a2ad3ba8b398a762f279b792cfacd536a3f` |
| Worker 1 | `195cf6324303f6941ad119d0a1d2e862d810078e1370b8d205552a543ff40aab` | - |

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

This project uses the **Figma Desktop MCP** server for real-time design access. The Figma desktop app must be running with the design file open.

The primary tool is `get_design_context` — extracts design data from a Figma node for generating UI code. Pass `clientLanguages: "html,css,typescript"` and `clientFrameworks: "svelte"`.

**Extracting Node IDs from URLs**: `https://figma.com/design/:fileKey/:fileName?node-id=1-2` → nodeId = `"1:2"` (replace hyphen with colon).

## Testing Best Practices

- **Unit tests** (`*.test.ts`): Business logic, utilities, stores (Vitest)
- **Component tests** (`*.ct.spec.ts`): Component behavior in real browsers (Playwright)
- **E2E tests** (`tests/*.test.ts`): Full application workflows (Playwright)
- Use hardcoded expected values instead of regex patterns in assertions
- Test cross-browser compatibility for user interaction components

## Troubleshooting

- **Demo not loading**: Check ports with `lsof -i :3000 -i :5174`, ensure `pnpm dev` is running
- **Popup blocked**: Allow popups for localhost in browser settings
- **WebAuthn not working**: Use `localhost` (not 127.0.0.1) — it's a secure context, no HTTPS needed
- **Library changes not reflected**: Rebuild with `pnpm build:lib` or use `pnpm dev:lib` for watch mode

## Documentation

- **README.md**: Full project docs, architecture, deployment
- **docs/**: Proposals and research documents (DEPLOYMENT.md, proposals)
- **The-Book-of-Swarm.pdf**: Comprehensive Swarm documentation

Each package folder contains its own README.md with package-specific documentation.
