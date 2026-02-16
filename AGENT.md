# Swarm Identity Management

Web-based identity and key management for decentralized applications on the Swarm network.

**Key Innovation**: Popup-based authentication flow that works across all browsers without Storage Access API or extensions. Browser-enforced storage partitioning provides cross-app isolation.

## Architecture

1. **Trusted Domain Model**: A trusted domain (e.g., `id.ethswarm.org`) hosts keystore UI and management
2. **OAuth-style Popup Flow**: dApps trigger authentication popups that derive app-specific secrets from a master key
3. **Iframe Proxy**: Hidden iframe handles secure communication and proxies Bee API calls with partitioned storage

**Security**: Master key in first-party context only, HMAC-SHA256 key derivation, browser-enforced storage partitioning per `(iframe-origin, parent-origin)`, all postMessage validated with Zod schemas.

### Authentication

- **Passkey/WebAuthn**: Browser-native credential flow
- **SIWE (Sign-In with Ethereum)**: For existing wallet users
- Both produce signed challenges as entropy for key generation

### Key Hierarchy

```
Master Key (from Passkey/SIWE challenge)
    ├─> App-Specific Secret (HMAC-SHA256 with app origin)
    │       ├─> Low-stakes keys (feed, session) → shared with apps
    │       └─> High-stakes keys (stamps, ACT) → never shared, apps request signing
```

### Swarm Data Primitives

- **Chunks**: 4KB max, content-addressed or single-owner
- **Feeds**: Mutable data pointers (owner + topic → latest reference)
- **SOC**: Signed chunk with identifier
- **ACT**: Encrypted content with grantee management
- **Postage Stamps**: Required for uploads, prove payment for storage

## Packages

- **lib/**: TypeScript library (@swarm-id/lib) — auth and Bee API operations
- **swarm-ui/**: SvelteKit identity management UI (trusted domain)
- **demo/**: Demo dApp showing library integration
- **docs-site/**: Starlight (Astro) documentation website
- **bee-js/**: Forked bee-js submodule with encrypted streaming chunks. Build: `pnpm build:bee-js`. Linked via `"@ethersphere/bee-js": "link:../bee-js"`.

## Commands

```bash
pnpm install          # Install dependencies
pnpm dev              # Start demo (:3000) + identity UI (:5174)
pnpm build            # Build everything
pnpm check:all        # All CI checks (format, lint, typecheck, knip)
pnpm clean            # Clean build outputs
```

`localhost` is a secure context — WebAuthn/Passkeys work without HTTPS.

## IMPORTANT: Pre-commit Requirements

Before committing, you MUST pass `pnpm check:all` which runs filtered checks across packages:
- **@swarm-id/lib**: `format:check`, `lint`, `typecheck`, `test`
- **swarm-identity**: `lint`, `check`, `knip`

## Library Core (`lib/`)

- **SwarmIdClient** (`swarm-id-client.ts`) — dApp-side: embeds hidden iframe, creates auth buttons, proxies Bee API calls
- **SwarmIdProxy** (`swarm-id-proxy.ts`) — iframe-side: receives secrets from popup, stores in partitioned localStorage, signs operations

### Message Protocol

All cross-origin communication via `postMessage` with Zod validation:
- **Parent → Iframe**: `parentIdentify`, `checkAuth`, `requestAuth`, `uploadData`, `downloadData`
- **Iframe → Parent**: `proxyReady`, `authStatusResponse`, `authSuccess`, `uploadDataResponse`, `error`
- **Popup → Iframe**: `setSecret`

## Code Style

- **No semicolons**
- **Never use `null`** — use `undefined` (exception: external library APIs)
- **Never use `any`** — use proper types, generics, `unknown`
- **Never use dynamic imports** — static imports at top of file only
- **No magic numbers** — use SCREAMING_SNAKE_CASE constants (0, 1, -1, 2 excepted)
- **Omit file extensions** in imports
- **kebab-case** for all file and directory names
- **Conventional commits**: `feat:`, `fix:`, `docs:`, etc.
- **TypeScript execution**: Use `pnpx tsx` (not `npx ts-node`)

## Testing

- Unit tests (`*.test.ts`): Vitest
- Component tests (`*.ct.spec.ts`): Playwright
- E2E tests (`tests/*.test.ts`): Playwright

## Deployment

- **Demo**: https://swarm-demo.snaha.net
- **Identity UI**: https://swarm-id.snaha.net
- Details: @docs/DEPLOYMENT.md
