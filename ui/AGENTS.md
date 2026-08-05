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
- **Purchases simulate themselves off mainnet, and there is no toggle for it.** The widget's
  cross-chain payment cannot complete on a dev chain, so **Add drive** settles locally there; on
  mainnet it always pays for real. `chainIdentity()` decides, by genesis hash — a dev chain reports
  the same chain id as mainnet on purpose, and an unreachable probe counts as **not** mainnet, so
  the flow stays exercisable with no chain at all (a production build never simulates, whatever the
  chain says). The settlement is **real**: `src/lib/dev/simulate-purchase.ts` creates an actual
  batch owned by the account's postage signer, so the drive can be extended and resized like any
  bought one; the simulation never opens a window. The one thing still chosen by hand is `/dev` →
  Chain tab → **Outcome** (success vs. a failed purchase, `dev-mock-stamp-result` in localStorage),
  which `drives.test.ts` uses to exercise the error path.
- **The payment leg is a swappable rail** (`payment/payment-rail.ts`) — what carries money from
  whatever chain the user holds funds on to xDAI at the batch-owner address. Production has one,
  Relay Protocol, and it cannot run locally at all: Relay is an intent/solver network, so the quote
  comes from a hosted API and the delivery is an off-chain solver paying out on real Gnosis.
  `resolvePaymentRail()` (`payment/resolve-rail.ts`) picks; the contract module is a leaf so the
  rails can import from it without an initialisation cycle. Off mainnet it returns the **dev rail**
  (`dev/local-payment-rail.ts`) when the local source chain is up (`pnpm dev:local`, chain 31337):
  the wallet signs a genuine deposit there and the baked faucet plays solver, delivering the xDAI.
  The wallet needs no setup — the chain reaches it through the flow's own `wallet_addEthereumChain`
  path, and the rail tops up whatever account connects, so no key is imported. With no source chain
  there is no rail — funding falls back to a silent faucet transfer
  and the payment screens never open, which is what keeps the drive e2e suites chain-only. The dev
  rail rehearses the payment UX and nothing more; Relay's pricing, routing, step model and refund
  semantics stay untested by it. Everything downstream of a rail is the same production code either
  way.
- **Paid drive operations are node-less**: extend and resize go straight to the PostageStamp
  contract signed by the derived postage signer (`payment/postage-onchain.ts`,
  `payment/drive-operation.ts`), with funding injected as a seam — the payment rail above, or the
  local faucet when there is none. See `docs/Postage-On-Chain-Engine.md` and
  `docs/Drive-Payment-Flow.md`.
- **There is one chain and one settings preset** (`postageChain()` in
  `payment/postage-onchain.ts`): the **baked hybrid chain** (chain 100 — a real BZZ market from a
  mainnet fork with the Swarm contracts deployed on top, committed to the repo in
  `vendor/bee-compose`, no internet needed) is driven with the production addresses, which is what
  makes it worth testing on. Run it as the Bee cluster's chain (`pnpm dev:bee`, RPC `:9545`) or
  standalone (`pnpm dev:chain`, `:8545`), and point the drive e2e at whichever with
  `CHAIN_RPC_URL`. An endpoint that is not mainnet never falls back to the public RPCs, so a failed
  call cannot silently read or write real mainnet.
- **Hex helpers**: byte⇄hex conversion comes from the lib — `uint8ArrayToHex`/`hexToUint8Array`
  from `@snaha/swarm-id` (0x-tolerant, throws on malformed input); `src/lib/crypto/hex.ts` keeps
  only `strip0x`/`prefix0x` to move between bare hex (how the lib and shared records store it)
  and the `0x`-prefixed form (ethers keys, display). For an address use `new EthAddress(value)`
  (parse) and `.toChecksum()` (EIP-55 display) rather than raw string juggling.
