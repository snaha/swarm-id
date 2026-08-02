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

## Local testing

Two local chains, both answering as Gnosis (100). Prefer the baked one — it is
offline and it is what the Bee cluster follows; use a live fork only when the
chain as it is _right now_ matters.

### Baked chain — a real BZZ market, **no internet**

`vendor/bee-compose/blockchain/state.gnosis.json` carries the **real** BZZ
token and the **real** SushiSwap pools taken from a Gnosis mainnet fork, with
the Swarm contracts deployed from source on top at their mainnet addresses. So
the whole production path — swap, approve, createBatch, topUp, increaseDepth —
runs offline against a genuine market, and `createBatch` keeps working
indefinitely (see `vendor/bee-compose/blockchain/HYBRID-CHAIN.md` for why a
plain mainnet dump does not).

```bash
pnpm dev:chain:detach     # anvil --load-state <snapshot> --chain-id 100
pnpm test:fork            # full purchase path, offline
pnpm dev:chain:stop
```

The one leg this cannot reproduce is the cross-chain bridge, so the initial
xDAI is minted with anvil's `setBalance`; everything downstream is genuine.

Two things to know about the baked chain:

- **It is stateful.** Every run buys BZZ from the real (thin) pool and moves
  its price, so the suites take an `evm_snapshot` and rewind afterwards.
  Restarting the container also restores the snapshot exactly.
- **It is a point in time.** Prices, the storage cost and the pool's liquidity
  are frozen at the block it was baked from. Re-baking lives with the snapshot,
  in bee-compose: `pnpm bake` there.

### A Bee cluster on the same chain

bee-compose runs its nodes against this very snapshot, pointed at the same
contract addresses, so a batch bought through the multichain path is one the
nodes actually ingest and can be uploaded with —
`ui/tests/gnosis-cluster.test.ts` is the proof.

### Live Gnosis fork

To test against the chain as it is right now rather than the baked snapshot:

```bash
pnpm dev:fork:detach      # anvil --fork-url https://rpc.gnosischain.com
pnpm test:fork
pnpm dev:fork:stop
```

`simulateWidgetPurchase` (in `src/dev.ts`) reproduces the multichain widget's
Gnosis-side step list on a fork: a throwaway payer receives xDAI, swaps it for
BZZ, approves, creates the batch owned by the destination, and hands its
leftovers over — the same role split the widget has in production.

### bee-compose anvil — fast and offline

No DEX exists there, so BZZ cannot be bought:

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
