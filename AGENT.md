# Swarm Identity Management

Web-based identity and key management for decentralized applications on the Swarm network.

**Key Innovation**: Popup-based authentication flow using shared localStorage. In production (secure context), storage works immediately for Chrome/Firefox. On localhost, Chrome/Firefox can request shared storage access via Storage Access API (requires clicking iframe button first). Safari operates in download-only mode — auth works, but uploads are disabled due to ITP storage partitioning ([#167](https://github.com/snaha/swarm-id/issues/167)). Safari private mode: sessions are ephemeral (lost when the private window closes).

## Architecture

1. **Trusted Domain Model**: A trusted domain (e.g., `id.ethswarm.org`) hosts keystore UI and management
2. **OAuth-style Popup Flow**: dApps trigger authentication popups that derive app-specific secrets from the account's master key
3. **Iframe Proxy**: Hidden iframe handles secure communication and proxies Bee API calls

**Security**: Master key in first-party context only, HMAC-SHA256 key derivation, all postMessage validated with Zod schemas.

### Account Model

A single-level **account** is the unit apps connect to — there is no separate "identity" tier. The account is the aggregate root and owns, as one nested document, its **connected apps** and **postage stamps**. `account.id` is the address apps connect to; the account private key is mnemonic-equivalent and stays first-party only (apps get a derived per-app secret, never the master key, and must request permission for high-stakes signing). Want independent keypairs? Create separate accounts. An account may hold multiple postage batches — a default one (stores account data + app data by default) with optional per-app overrides.

Account state syncs across a user's devices via a snapshot published to a Swarm feed, merged with last-writer-wins per app and a union of stamps/devices ([#337](https://github.com/snaha/swarm-id/issues/337)/[#338](https://github.com/snaha/swarm-id/issues/338)/[#339](https://github.com/snaha/swarm-id/issues/339)).

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

- **lib/**: TypeScript library (@snaha/swarm-id) — auth and Bee API operations
- **ui/**: `@swarm-id/ui` — next-generation identity UI (standalone product, active redesign target)
- **swarm-ui/**: legacy SvelteKit identity management UI (trusted domain) — being superseded by `ui/`
- **demo/**: Demo dApp showing library integration
- **docs-site/**: Starlight (Astro) documentation website

## Commands

```bash
pnpm install          # Install dependencies
pnpm dev:new          # Start the new identity UI (:5500) + demo (:3500) against it
pnpm dev:legacy       # Start the legacy identity UI (:5510) + demo (:3000) against it
pnpm dev              # Alias for dev:legacy
pnpm build            # Build everything
pnpm check:all        # All CI checks (format, lint, typecheck, knip)
pnpm clean            # Clean build outputs
```

`localhost` is a secure context — WebAuthn/Passkeys work without HTTPS.

## IMPORTANT: Pre-commit Requirements

Before committing, you MUST pass `pnpm check:all` which runs filtered checks across packages:

- **@snaha/swarm-id**: `format:check`, `lint`, `typecheck`, `test`
- **swarm-identity**: `lint`, `check`, `knip`
- **@swarm-id/ui**: `lint` (includes license headers), `check`, `knip`

## New UI (`ui/`)

The new identity UI is a fresh SvelteKit product replacing `swarm-ui/` screen by screen.

- **Stack**: SvelteKit (Svelte 5 runes) + `@sveltejs/adapter-static` (pure SPA, `ssr = false`),
  Tailwind CSS v4 via `@tailwindcss/vite`, shadcn-svelte-style components (hand-written, no bits-ui)
- **Components**: shadcn-style primitives live in `src/lib/components/ui/`; app-level components
  in `src/lib/components/`; stores in `src/lib/stores/` (e.g. theming: `auto`/`light`/`dark`
  preference persisted in localStorage, applied as a `dark` class on `<html>`)
- **Toolchain**: versions are pinned to match `swarm-ui` (eslint 9, vite 7, svelte 5.48,
  vite-plugin-svelte 6) — do NOT bump these independently of the rest of the monorepo
- **License headers**: enforced by eslint (`eslint-plugin-notice` + shared svelte rule);
  `pnpm --filter @swarm-id/ui format` auto-inserts them
- **`BASE_PATH`** env var sets the SvelteKit base path at build time (`/id` in deployments)

## Library Core (`lib/`)

- **SwarmIdClient** (`swarm-id-client.ts`) — dApp-side: embeds hidden iframe, creates auth buttons, proxies Bee API calls
- **SwarmIdProxy** (`swarm-id-proxy.ts`) — iframe-side: reads auth from shared localStorage (via storage events), signs operations

### Message Protocol

All cross-origin communication via `postMessage` with Zod validation:

- **Parent → Iframe**: `parentIdentify`, `checkAuth`, `requestAuth`, `uploadData`, `downloadData`
- **Iframe → Parent**: `proxyReady`, `authStatusResponse`, `authSuccess`, `uploadDataResponse`, `error`

Authentication uses storage events: popup writes to localStorage → storage event fires in iframe → iframe authenticates.

## Code Style

- **Format after editing**: Run `pnpm exec prettier --write <file>` on files you modify
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

## Version control conventions

- Use conventional commits
- Don't use the issue number in branch names

## Deployment

GitHub Pages (`gh-pages` branch, CNAME `swarm.snaha.net`) hosts the latest `main` build of every
app at root paths, plus per-PR previews under `…/pr-N/` (`deploy-main-pages.yml` /
`deploy-preview.yml`):

| Path                           | App                             |
| ------------------------------ | ------------------------------- |
| `swarm.snaha.net/id/`          | new UI (`ui/`)                  |
| `swarm.snaha.net/id-legacy/`   | legacy UI (`swarm-ui/`)         |
| `swarm.snaha.net/demo/`        | demo, run against the new `/id` |
| `swarm.snaha.net/demo-legacy/` | demo, run against `/id-legacy`  |
| `swarm.snaha.net/docs/`        | docs site                       |

DigitalOcean (`deploy-do.yml`, push to main) keeps the canonical legacy domains:

- **Demo**: https://swarm-demo.snaha.net
- **Identity UI (legacy)**: https://swarm-id.snaha.net
