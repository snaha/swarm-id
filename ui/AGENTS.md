# UI (`ui/`)

The identity UI is a SvelteKit SPA.

- **Stack**: SvelteKit (Svelte 5 runes) + `@sveltejs/adapter-static` (pure SPA, `ssr = false`),
  Tailwind CSS v4 via `@tailwindcss/vite`, shadcn-svelte-style components (hand-written, no bits-ui)
- **Components**: shadcn-style primitives live in `src/lib/components/ui/`; app-level components
  in `src/lib/components/`; stores in `src/lib/stores/` (e.g. theming: `auto`/`light`/`dark`
  preference persisted in localStorage, applied as a `dark` class on `<html>`)
- **License headers**: enforced by eslint via `@swarm-id/eslint-rules` (`license/header` for
  TS/JS, `license/svelte-header` for Svelte — no third-party plugin);
  `pnpm --filter @swarm-id/ui format` auto-inserts them
- **`BASE_PATH`** env var sets the SvelteKit base path at build time (`/id` in deployments)
- **Wallet picker** (`src/lib/crypto/onboard.ts`): injected wallets, Coinbase Wallet, and
  WalletConnect when there is a project id. The last two need nothing installed and are the only
  routes on a browser with no wallet extension (Safari, mobile)
- **WalletConnect project id**: a committed `DEFAULT_PROJECT_ID` (`crypto/wallet-connect.ts`), not a
  secret, with `PUBLIC_WALLETCONNECT_PROJECT_ID` overriding it — same shape as `busSignalingUrl`.
  Never pass the module a blank id: it throws, at import of a module every wallet page loads. Go
  through `walletConnectOptions`
- **Local env**: `.env.example` → `.env` (gitignored) documents the `PUBLIC_*` build vars; both have
  working defaults, so an empty `.env` is fine
- **Dev mock stamp purchase** (`/dev` → Chain tab, backed by `src/lib/stores/dev-settings.svelte.ts`):
  toggles that make the **Add drive** flow's _widget_ payment method settle a mocked postage batch
  instead of a real cross-chain payment. They apply to that method only — the built-in engine
  never reads them and always buys for real. "Open widget popup" **off** simulates locally with **no `window.open`** — the
  only mode that works where popups are blocked (headless previews) or the widget origin is offline;
  **on** also opens the `fund.bzz.limo?mocked=true` popup. "Outcome" picks success vs. a failed
  purchase. Settings persist in localStorage (`dev-mock-stamp-*`) and are read by
  `drive-add-dialog.svelte`; production leaves them off.
- **Nothing dev-only ships.** Production code reaches the dev tree (`$lib/dev/*`,
  `@swarm-id/multichain/dev`) through one seam, `src/lib/payment/dev-funding.ts`, and the `/dev`
  route imports it directly; `vite build` swaps both for stubs (`stubDevOnlyModules` in
  `vite.config.ts` — a `pre` plugin, since SvelteKit's `$lib` alias resolves before any
  `resolve.alias`): the seam becomes `dev-funding.production.ts`, the route becomes
  `routes/dev/page.production.*`, a plain 404. The route's `prerender = false` alone does not keep
  it off a deployment — the adapter's `index.html` fallback serves any path where the host has a
  catch-all. Never import the dev tree from anywhere else: `import.meta.env.DEV` only kills the
  branch, the imports are static and those modules have top-level side effects, so Rollup ships
  them — the local rail, the anvil cheat codes, the dev faucet key. Verify with a build, not by
  reading: CI greps the built assets for four canaries after `pnpm build`, and no chunk may carry
  any of them.
- **Hex helpers**: byte⇄hex conversion comes from the lib — `uint8ArrayToHex`/`hexToUint8Array`
  from `@snaha/swarm-id` (0x-tolerant, throws on malformed input); `src/lib/crypto/hex.ts` keeps
  only `strip0x`/`prefix0x` to move between bare hex (how the lib and shared records store it)
  and the `0x`-prefixed form (derived keys, display). For an address use `new EthAddress(value)`
  (parse) and `.toChecksum()` (EIP-55 display) rather than raw string juggling — `EthAddress` comes
  from `@ethersphere/bee-js`, not from the lib.
