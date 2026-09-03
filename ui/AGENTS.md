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
- **Dev mock stamp purchase** (`/dev` → Chain tab, backed by `src/lib/stores/dev-settings.svelte.ts`):
  toggles that make the product **Add drive** flow settle a mocked postage batch instead of a real
  cross-chain payment. "Open widget popup" **off** simulates locally with **no `window.open`** — the
  only mode that works where popups are blocked (headless previews) or the widget origin is offline;
  **on** also opens the `swarmbucks.eth.limo?mocked=true` popup. "Outcome" picks success vs. a failed
  purchase. Settings persist in localStorage (`dev-mock-stamp-*`) and are read by
  `drive-add-dialog.svelte`; production leaves them off.
- **Hex helpers**: byte⇄hex conversion comes from the lib — `uint8ArrayToHex`/`hexToUint8Array`
  from `@snaha/swarm-id` (0x-tolerant, throws on malformed input); `src/lib/crypto/hex.ts` keeps
  only `strip0x`/`prefix0x` to move between bare hex (how the lib and shared records store it)
  and the `0x`-prefixed form (derived keys, display). For an address use `new EthAddress(value)`
  (parse) and `.toChecksum()` (EIP-55 display) rather than raw string juggling.
