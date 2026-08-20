# UI (`ui/`)

The identity UI is a SvelteKit SPA.

- **Stack**: SvelteKit (Svelte 5 runes) + `@sveltejs/adapter-static` (pure SPA, `ssr = false`),
  Tailwind CSS v4 via `@tailwindcss/vite`, shadcn-svelte-style components (hand-written, no bits-ui)
- **Components**: shadcn-style primitives live in `src/lib/components/ui/`; app-level components
  in `src/lib/components/`; stores in `src/lib/stores/` (e.g. theming: `auto`/`light`/`dark`
  preference persisted in localStorage, applied as a `dark` class on `<html>`)
- **License headers**: enforced by eslint (`eslint-plugin-notice` + shared svelte rule);
  `pnpm --filter @swarm-id/ui format` auto-inserts them
- **`BASE_PATH`** env var sets the SvelteKit base path at build time (`/id` in deployments)
- **Dev tooling** (`/dev`, dev-server only — `prerender = false` keeps it out of every build). Its
  **Chain** tab is the local-chain workbench: a faucet, drive/batch creation, batch import by id, and
  the endpoint switch. Two things to know before using it. **Nothing is mocked** — buying, extending
  and resizing are real transactions against whatever chain the app is pointed at, so the only
  safeguard is the configured endpoint (the dev helpers refuse anything but a _proven_ dev chain,
  by genesis hash, not by "not mainnet"). And **Simulate failure**
  (`src/lib/payment/fault-injection.ts`) arms a single-shot fault at a point where money has already
  moved; it is how the resume paths are exercised, including from `tests/drive-resume.test.ts`.
- **Hex helpers**: byte⇄hex conversion comes from the lib — `uint8ArrayToHex`/`hexToUint8Array`
  from `@snaha/swarm-id` (0x-tolerant, throws on malformed input); `src/lib/crypto/hex.ts` keeps
  only `strip0x`/`prefix0x` to move between bare hex (how the lib and shared records store it)
  and the `0x`-prefixed form (derived keys, display). For an address use `new EthAddress(value)`
  (parse) and `.toChecksum()` (EIP-55 display) rather than raw string juggling.
