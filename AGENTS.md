# Swarm Identity Management

Web-based identity and key management for decentralized applications on the Swarm network.

**Key Innovation**: Popup-based authentication flow using shared localStorage. In production (secure context), storage works immediately for Chrome/Firefox. On localhost, Chrome/Firefox can request shared storage access via Storage Access API (requires clicking iframe button first). Safari operates in download-only mode — auth works, but uploads are disabled due to ITP storage partitioning ([#167](https://github.com/snaha/swarm-id/issues/167)). Safari private mode: sessions are ephemeral (lost when the private window closes).

## Architecture

1. **Trusted Domain Model**: A trusted domain (e.g., `id.ethswarm.org`) hosts keystore UI and management
2. **OAuth-style Popup Flow**: dApps trigger authentication popups that derive app-specific secrets from a master key
3. **Iframe Proxy**: Hidden iframe handles secure communication and proxies Bee API calls

**Security**: Master key in first-party context only, HMAC-SHA256 key derivation, all postMessage validated with Zod schemas.

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
- **ui/**: `@swarm-id/ui` — SvelteKit identity UI (trusted domain), hosts the keystore UI and management
- **demo/**: Demo dApp showing library integration
- **docs-site/**: Starlight (Astro) documentation website

## Commands

```bash
pnpm install          # Install dependencies
pnpm dev              # Start the identity UI (:5500) + demo (:3500) against it
pnpm dev:local        # …plus the Bee cluster, both chains and the payment solver
pnpm build            # Build everything
pnpm check:all        # All CI checks (format, lint, typecheck, knip)
pnpm clean            # Clean build outputs
```

`localhost` is a secure context — WebAuthn/Passkeys work without HTTPS.

## IMPORTANT: Pre-commit Requirements

Before committing, you MUST pass `pnpm check:all` which runs filtered checks across packages:

- **@snaha/swarm-id**: `format:check`, `lint`, `typecheck`, `test`
- **@swarm-id/multichain**: `format:check`, `lint`, `typecheck`, `test`
- **@swarm-id/ui**: `lint` (includes license headers), `check`, `knip`, `test`
- **@swarm-id/demo**: `lint`, `check`, `knip`

Chain-backed suites are NOT in `check:all` — they need a chain running, and are skipped
automatically without one: `pnpm test:fork` (needs `pnpm dev:chain:detach`) and
`pnpm --filter @swarm-id/ui test:e2e` (needs `pnpm dev:local`).

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
- **Monorepo version pinning**: toolchain versions are pinned across the monorepo (eslint 9,
  vite 7, svelte 5.48, vite-plugin-svelte 6) — do NOT bump these in one package independently
  of the rest of the monorepo
- **Timeouts: use `withTimeout`** (`lib/src/utils/promise.ts`) — never `Promise.race` work against
  `rejectAfter` or an inline `setTimeout` rejection: when the work wins, the losing timer stays
  armed and leaks its handle. `withTimeout(work, ms, message)` clears the timer and rejects with
  `TimeoutError`, so discriminate timeouts with `instanceof TimeoutError`, not by message.
  `rejectAfter` is deprecated and kept only for the public API.

## Testing

- Unit tests (`*.test.ts`): Vitest
- Component tests (`*.ct.spec.ts`): Playwright
- E2E tests (`tests/*.test.ts`): Playwright
- **TDD for `lib/` fixes**: when fixing a bug in `lib/`, always work TDD-style if
  applicable — write a failing test that reproduces the bug first, then fix, then
  confirm the test passes (pure refactors/docs are exempt)

## Version control conventions

- Use [conventional commits](https://www.conventionalcommits.org/) (e.g. `feat:`, `fix:`, `chore:`)
- Keep PR titles and descriptions concise
- Omit the issue number from branch names and titles
- When a PR resolves an issue, reference it with a closing keyword (e.g. `Closes #53`) so GitHub closes the issue automatically on merge
- Keep a **linear history**: rebase onto `main` to update a branch or resolve a conflict — never merge `main` into the branch. Rebasing a branch that is already pushed ends in `git push --force-with-lease`.

## Deployment

GitHub Pages (`gh-pages` branch, CNAME `swarm.snaha.net`) hosts the latest `main` build of every
app at root paths, plus per-PR previews under `…/pr-N/` (`deploy-main-pages.yml` /
`deploy-preview.yml`):

| Path                    | App                     |
| ----------------------- | ----------------------- |
| `swarm.snaha.net/id/`   | identity UI (`ui/`)     |
| `swarm.snaha.net/demo/` | demo, run against `/id` |
| `swarm.snaha.net/docs/` | docs site               |

DigitalOcean (`deploy-do.yml`, push to main) keeps the canonical domains:

- **Identity UI (`ui/`)**: https://swarm-id.snaha.net
- **Demo**: https://swarm-demo.snaha.net, run against swarm-id.snaha.net
