# Swarm Identity Management

Web-based identity and key management for decentralized applications on the Swarm network.

**Key Innovation**: Popup-based authentication flow using shared localStorage. The proxy iframe reads the trusted domain's first-party store whenever the embedding page is **same-site**, which is every context we run: the local rig (`localhost:3500` + `localhost:5500` — ports do not affect _site_), GitHub Pages (`swarm.snaha.net/id` + `/demo`, and the per-PR previews under it — one origin), and DigitalOcean (`swarm-demo.snaha.net` / `swarm-id.snaha.net`, both under `snaha.net`). No Storage Access API is involved, on localhost or anywhere else.

Where the two are genuinely cross-site, or the browser partitions regardless (Safari ITP, strict privacy settings), the iframe gets its own partitioned store and the connect popup hands it the account's synced projection (stamps incl. signer keys) instead — uploads keep working, and the session is kept in that partition's own store until it is disconnected or its 30 days are up ([#635](https://github.com/snaha/swarm-id/issues/635)), rather than re-handshaking on every page load ([#277](https://github.com/snaha/swarm-id/issues/277), [docs/Account-Bus.md](docs/Account-Bus.md)). That handover needs the popup to be opened **by the iframe**, so `window.opener` points back at it: the proxy's own auth button always does this, and `SwarmIdClient.connect()` does it whenever the iframe cannot prove its store is shared — it asks the storage, not the user agent ([#613](https://github.com/snaha/swarm-id/issues/613), `lib/src/utils/storage-probe.ts`).

**Verified on real Safari** ([#584](https://github.com/snaha/swarm-id/issues/584)): measured on iOS 18.7 / Safari 26.6 against the DO deployment, ITP partitions the iframe, the `window.opener` handover reaches it, the hydrated view builds a working stamper (`uploadMode: user-stamp`), and a chunk uploads and reads back byte-identical. The device id also held across a reload. A **Safari private window** passes the same five checks, upload included; its partitioned store is still discarded when the window closes, which is by design. Still unrun on a device: the ~30-day eviction horizon ([#570](https://github.com/snaha/swarm-id/issues/570)) — two loads in one sitting says nothing about it.

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

- **lib/** ([AGENTS.md](lib/AGENTS.md)): TypeScript library (`@snaha/swarm-id`) — auth and Bee API operations
- **ui/** ([AGENTS.md](ui/AGENTS.md)): `@swarm-id/ui` — SvelteKit identity UI (trusted domain), hosts the keystore UI and management
- **demo/**: Demo dApp showing library integration
- **docs-site/** ([AGENTS.md](docs-site/AGENTS.md)): Starlight (Astro) documentation website
- **signaling/**: `@swarm-id/signaling` — account-bus signaling and relay server

Each package's own `AGENTS.md` holds what applies inside it, and is deliberately not repeated
here: two copies of a rule is one copy that goes stale. `CLAUDE.md` imports them so they load
with this file.

## Commands

```bash
pnpm install          # Install dependencies
pnpm dev              # Start the identity UI (:5500) + demo (:3500) against it
pnpm build            # Build everything
pnpm check:all        # All CI checks (format, lint, typecheck, knip)
pnpm clean            # Clean build outputs
```

`localhost` is a secure context — WebAuthn/Passkeys work without HTTPS.

## IMPORTANT: Pre-commit Requirements

Before committing, you MUST pass `pnpm check:all` which runs filtered checks across packages:

- **`@snaha/swarm-id`**: `format:check`, `lint`, `typecheck`, `test`
- **`@swarm-id/ui`**: `lint` (includes license headers), `check`, `knip`
- **`@swarm-id/demo`**: `lint`, `check`, `knip`, `test`

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
- **Recursive scripts: `pnpm -r run <script>`** — a bare `pnpm -r <script>` resolves to a
  built-in pnpm command whenever the names collide (pnpm 11 added a built-in `clean`)
- **Timeouts: use `withTimeout`** (`lib/src/utils/promise.ts`, exported from the package) — never
  `Promise.race` work against an inline `setTimeout` rejection: when the work wins, the losing
  timer stays armed and leaks its handle. `withTimeout(work, ms, message)` clears the timer and
  rejects with `TimeoutError`, so discriminate timeouts with `instanceof TimeoutError`, not by
  message.
- **JSON-RPC: use `jsonRpcCall`/`jsonRpcBatch`** (`lib/src/utils/json-rpc.ts`, exported from
  `@snaha/swarm-id`) — never a hand-rolled `fetch` + envelope read. Reach for a null-tolerant
  variant only where `null` is a real outcome. A deadline rejects with `TimeoutError`, as above,
  and every rejection from them names the endpoint, so `error.message` can be shown as-is.
  `@swarm-id/multichain` keeps a verbatim copy of the envelope checks; change one, change both.

## Testing

- Unit tests (`*.test.ts`): Vitest
- Component tests (`*.ct.spec.ts`): Playwright
- E2E tests (`tests/*.test.ts`): Playwright

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
