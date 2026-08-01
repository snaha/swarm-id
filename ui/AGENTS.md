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
- **Dev mock stamp purchase** (`/dev` → Stamps tab, backed by `src/lib/stores/dev-settings.svelte.ts`):
  toggles that make the product **Add drive** flow settle without a real cross-chain payment.
  When `gnosisRpcUrl` points at the bee-compose chain the settlement is **real** —
  `src/lib/dev/simulate-purchase.ts` creates an actual batch owned by the account's postage signer
  (the queen account plays the widget's temp wallet), so the resulting drive can be extended and
  resized like any bought one. Against any other chain it falls back to a fabricated batch id,
  which keeps the add-drive flow exercisable but leaves the drive backed by nothing. "Open widget
  popup" **off** simulates with **no `window.open`** — the only mode that works where popups are
  blocked (headless previews) or the widget origin is offline; **on** also opens the
  `fund.bzz.limo?mocked=true` popup. "Outcome" picks success vs. a failed purchase. Settings
  persist in localStorage (`dev-mock-stamp-*`) and are read by `drive-add-dialog.svelte`;
  production leaves them off.
- **Paid drive operations are node-less**: extend and resize go straight to the PostageStamp
  contract signed by the derived postage signer (`payment/postage-onchain.ts`,
  `payment/drive-operation.ts`), with funding injected as a seam — the in-app payment flow in
  production, a local faucet in dev. See `docs/Postage-On-Chain-Engine.md` and
  `docs/Drive-Payment-Flow.md`.
- **Chain settings follow the chain id, never the URL** (`postageChain()` in
  `payment/postage-onchain.ts`): the endpoint is probed once per URL and the preset chosen from
  what it answers. That is what lets a **localhost fork of Gnosis** (`pnpm dev:fork`, chain 100
  with the real contracts and real SushiSwap pools) be driven with the production addresses —
  the closest local setup to production, and the one to use when the swap matters. A local URL
  answering as Gnosis never falls back to the public RPCs, so a failed call cannot silently read
  or write real mainnet. bee-compose (chain 4020) stays the fast offline option.
- **Hex helpers**: byte⇄hex conversion comes from the lib — `uint8ArrayToHex`/`hexToUint8Array`
  from `@snaha/swarm-id` (0x-tolerant, throws on malformed input); `src/lib/crypto/hex.ts` keeps
  only `strip0x`/`prefix0x` to move between bare hex (how the lib and shared records store it)
  and the `0x`-prefixed form (ethers keys, display). For an address use `new EthAddress(value)`
  (parse) and `.toChecksum()` (EIP-55 display) rather than raw string juggling.
