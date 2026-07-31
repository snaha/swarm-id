# @swarm-id/multichain

Gnosis-side machinery for postage batch payments: BZZ/xDAI transfers and
approvals, `createBatch` / `topUp` / `increaseDepth` against the PostageStamp
contract, batch reads, and the SushiSwap V3 xDAI→BZZ leg — all signable with a
locally held private key (the account's derived postage signer), no Bee node
and no connected wallet required on the Gnosis side.

Consumed by `ui/` for the drive extend/resize flows (see
[docs/Postage-On-Chain-Engine.md](../docs/Postage-On-Chain-Engine.md) and
[docs/Drive-Payment-Flow.md](../docs/Drive-Payment-Flow.md)). The cross-chain
payment leg (Relay Protocol) lives in `ui/`, not here — this package starts
where funds arrive on Gnosis.

## Provenance

Vendored and extended from
[`@upcoming/multichain-library`](https://github.com/ethersphere/multichain-library)
(ISC, by the Ethersphere/Swarm developers — the machinery behind the
fund.bzz.limo widget), per the conclusion on
[#309](https://github.com/snaha/swarm-id/issues/309): _"use the multichain
library for this (with our own UI)."_ Adapted files carry a provenance header.

Deliberate changes from upstream:

- **Injectable chain + addresses** (`MultichainSettings` presets
  `gnosisMainnetSettings()` / `localAnvilSettings()`) instead of a hardcoded
  viem `gnosis` chain and mainnet constants — the same code signs correctly
  against the bee-compose anvil chain (id 4020), which is what makes local
  testing possible at all.
- **New PostageStamp operations**: `topUpBatch`, `increaseDepth`, and the read
  side (`getPostageBatch`, `getRemainingBalance`,
  `getPostageWriteConstraints`). Upstream only has `createBatch`.
- **Selector pinning**: unit tests assert every ABI entry against selectors
  verified on the deployed contract, so an ABI typo cannot reach a wallet.
- The duplicated FeeTooLow retry loops are extracted (`write-retry.ts`), the
  receipt/balance waiters take their cadence from settings (anvil mines every
  5s; mainnet polling is slower), and dropped modules we do not use (USDC,
  token prices, multi-transfer, the deprecated Sushi HTTP API quote).

## Local testing / mocking

Two legs cannot exist locally — Relay (cross-chain) and SushiSwap (no DEX on
anvil). Everything else runs for real:

- `localAnvilSettings()` targets the bee-compose chain (RPC `:9545`,
  PostageStamp + BZZ TestToken deployed by the cluster).
- `src/dev.ts` mocks the funding leg: the well-known queen dev account
  (prefunded ~100 xDAI + 100k BZZ) transfers gas and BZZ to any address
  (`fundLocalAccount`) and creates owner-key batches mirroring the production
  roles (`createLocalBatch` — queen pays, your key owns). Never import it in
  production code.
- Swap functions throw a descriptive error on the local chain; mock that leg
  with `fundLocalAccount` instead.

```bash
pnpm dev:bee:detach                                  # repo root — starts anvil (+ cluster)
pnpm --filter @swarm-id/multichain test              # unit tests, no chain needed
pnpm --filter @swarm-id/multichain test:integration  # full lifecycle on anvil, auto-skips without it
```

The integration suite (`test/integration/postage-lifecycle.test.ts`) exercises
fund → createBatch(owner=derived key) → approve → topUp → increaseDepth →
non-owner revert, asserting on-chain state after each step.
