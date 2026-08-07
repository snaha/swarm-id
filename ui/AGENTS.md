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
- **Buying a drive is a real on-chain purchase, and nothing simulates it.** **Add drive** runs
  `runPurchase` (`payment/drive-operation.ts`) through the same funding seam as extend and resize,
  so it inherits the payment screens, the rail below and the 7702 bundle rather than having a second
  way to pay. The derived postage signer buys the batch it will own — no throwaway creator wallet,
  no ownership handover, no dust. The consequence is that **a purchase needs a reachable chain**:
  the old fabricated settlement let it complete without one, and the e2e suites that relied on that
  now seed a chain and skip without one.
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
- **Everything dev-only in that arrangement sits behind one seam**, `payment/dev-funding.ts`, which
  `vite build` swaps for `dev-funding.production.ts` (a `pre` plugin in `vite.config.ts`, not a
  `resolve.alias` — SvelteKit's `$lib` alias resolves first). Without the swap the local rail, the
  faucet, and the anvil cheat codes and dev private key behind `@swarm-id/multichain/dev` ship in
  the entry bundle: `import.meta.env.DEV` kills the _branch_, but the imports are static and those
  modules have top-level side effects, so Rollup keeps them anyway. **Production code must reach
  dev helpers only through this seam** — importing `$lib/dev/*` directly puts them back in the
  bundle, which is how `crypto/onboard.ts` was doing it. The `/dev` route imports them directly on
  purpose and keeps its own lazily-loaded chunk. Verify with a build, never by reading:
  `grep -rl anvil_setBalance ui/build` must only ever match a `nodes/*.js` route chunk.
- **Paid drive operations are node-less**: extend and resize go straight to the PostageStamp
  contract signed by the derived postage signer (`payment/postage-onchain.ts`,
  `payment/drive-operation.ts`), with funding injected as a seam — the payment rail above, or the
  local faucet when there is none. See `docs/Postage-On-Chain-Engine.md` and
  `docs/Drive-Payment-Flow.md`.
- **…and atomic**: where the chain has the EIP-7702 delegate — which includes Gnosis mainnet —
  extend runs as one transaction (approve + topUp) and resize as one (approve + topUp +
  increaseDepth), via `bundledExtend`/`bundledResize`. **The order is load-bearing and atomicity
  does NOT relax it**: `increaseDepth` checks the floor before any compensation, so diluting first
  reverts the whole bundle. `supportsBundling()` gates it, so a chain without the delegate falls
  back to the sequential path — which is also where `SizeIncreasePendingError` and its #392 copy
  still apply, and which `drive-onchain.test.ts` covers by clearing the delegate. The delegation
  is **permanent**: the postage signer reads as a contract afterwards.
- **There is one chain and one settings preset** (`postageChain()` in
  `payment/postage-onchain.ts`): the **baked hybrid chain** (chain 100 — a real BZZ market from a
  mainnet fork with the Swarm contracts deployed on top, committed to the repo in
  `vendor/bee-compose`, no internet needed) is driven with the production addresses, which is what
  makes it worth testing on. Run it as the Bee cluster's chain (`pnpm dev:local`, RPC `:9545` —
  NOT `pnpm dev:bee`, which crashes the queen against this chain) or standalone (`pnpm dev:chain`,
  `:8545`), and point the drive e2e at whichever with
  `CHAIN_RPC_URL`. An endpoint that is not mainnet never falls back to the public RPCs, so a failed
  call cannot silently read or write real mainnet.
- **Hex helpers**: byte⇄hex conversion comes from the lib — `uint8ArrayToHex`/`hexToUint8Array`
  from `@snaha/swarm-id` (0x-tolerant, throws on malformed input); `src/lib/crypto/hex.ts` keeps
  only `strip0x`/`prefix0x` to move between bare hex (how the lib and shared records store it)
  and the `0x`-prefixed form (ethers keys, display). For an address use `new EthAddress(value)`
  (parse) and `.toChecksum()` (EIP-55 display) rather than raw string juggling.
