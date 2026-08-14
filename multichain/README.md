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

- **Injectable chain + addresses** (`MultichainSettings`, built with
  `gnosisMainnetSettings()`) instead of a hardcoded viem `gnosis` chain and
  mainnet constants — an EIP-155 signature carries the chain id, so it has to
  come from whatever the endpoint reports, which is what makes local testing
  possible at all.
- **New PostageStamp operations**: `topUpBatch`, `increaseDepth`, and the read
  side (`getPostageBatch`, `getRemainingBalance`,
  `getPostageWriteConstraints`). Upstream only has `createBatch`.
- **Atomic bundles** (`postage-bundle.ts`): the same operations as ONE EIP-7702
  transaction — `bundleExtend` (approve + topUp) and `bundleResize` (approve +
  topUp + increaseDepth), gated on `supportsBundling()`. The owner EOA
  authorises `Simple7702Account` and sends to itself, so `msg.sender` stays the
  batch owner. Order is load-bearing regardless of atomicity; see
  `docs/Postage-On-Chain-Engine.md` §4.4.
- **A solver wire format** (`local-solver-protocol.ts`): the calldata a
  cross-chain deposit carries its own delivery instruction in, so the off-chain
  half that fills it can stay stateless. The process that reads it lands with
  the local payment rail in `ui/`.
- **Selector pinning**: unit tests assert every ABI entry against selectors
  verified on the deployed contract, so an ABI typo cannot reach a wallet.
- The duplicated FeeTooLow retry loops are extracted (`write-retry.ts`), the
  receipt/balance waiters take their cadence from settings (anvil mines every
  5s; mainnet polling is slower), and dropped modules we do not use (USDC,
  token prices, multi-transfer, the deprecated Sushi HTTP API quote).

## Local testing

One local chain: the snapshot bee-compose bakes and its cluster runs on. It
answers as Gnosis (100) — deliberately, so the production addresses resolve —
which also means the chain id cannot tell it apart from mainnet. Genesis can;
`chainIdentity()` in `ui/` is where that check lives.

### Baked chain — a real BZZ market, **no internet**

The snapshot `@snaha/bee-compose` ships (`blockchain/state.gnosis.json`) carries the **real** BZZ
token and the **real** SushiSwap pools taken from a Gnosis mainnet fork, with
the Swarm contracts deployed from source on top at their mainnet addresses. So
the whole production path — swap, approve, createBatch, topUp, increaseDepth —
runs offline against a genuine market, and `createBatch` keeps working
indefinitely (see [HYBRID-CHAIN.md](https://github.com/snaha/bee-compose/blob/main/blockchain/HYBRID-CHAIN.md)
for why a plain mainnet dump does not).

```bash
pnpm dev:chain:detach     # the baked chain on :9545, no Bee nodes
pnpm test:fork            # full purchase path, offline
pnpm dev:chain:stop
```

The one leg this cannot reproduce is the cross-chain bridge — Relay is an
intent/solver network, so its quote comes from a hosted API and its delivery is
an off-chain solver paying out on real Gnosis, none of which can see a local
chain. Here the initial xDAI is simply minted with anvil's `setBalance`;
everything downstream is genuine.

Two things to know about the baked chain:

- **It is stateful, and nothing rewinds it.** Every run buys BZZ from the real
  (thin) pool and moves its price a little. The suites deliberately do not
  `evm_revert`: a Bee node following the chain records the block it has
  processed and never re-scans below it, so a rewind desyncs any running
  cluster permanently. Restarting the container restores the snapshot;
  rebuilding it lives in bee-compose.
- **It is a point in time.** Prices, the storage cost and the pool's liquidity
  are frozen at the block it was baked from. Re-baking lives with the snapshot,
  in bee-compose.

### A Bee cluster on the same chain

bee-compose runs its nodes against this very snapshot, pointed at the same
contract addresses, so a batch bought through the multichain path is one the
nodes actually ingest and can be uploaded with —
`ui/tests/gnosis-cluster.test.ts` is the proof.

### The purchase, simulated

`simulateWidgetPurchase` (in `src/dev.ts`) reproduces the multichain widget's
Gnosis-side step list: a throwaway payer receives xDAI, swaps it for BZZ,
approves, creates the batch owned by the destination, and hands its leftovers
over — the same role split the widget has in production. `fundLocalAccount`
handles the other half, transferring from the chain's dev faucet rather than
trading, since only the purchase is worth spending a real pool on. Never import
`src/dev.ts` in production code.

```bash
pnpm dev:cluster:start                       # repo root — cluster and its chain
pnpm --filter @swarm-id/multichain test      # unit tests, no chain needed
```
