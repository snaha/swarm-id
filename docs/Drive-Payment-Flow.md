# Drive payment flow — paying for storage in-app, from any chain

Status: **implemented.** This describes how BZZ and xDAI reach the derived batch-owner address. What
is then done with them on Gnosis is [`Postage-On-Chain-Engine.md`](./Postage-On-Chain-Engine.md),
consumed here as a library.

## What it is

Buying, extending and resizing a drive are paid for **inside the identity UI**, with no external
fund.bzz.limo popup and no Bee node. The user connects a wallet, picks a source chain and token, sees
a quoted cost, and signs **one** transaction. Everything after that — cross-chain delivery of xDAI to
the batch-owner address, the Gnosis-side xDAI→BZZ swap, and the postage operations themselves — runs
in `ui/`, signed by the owner key.

The screens follow Figma file `1UCqrAPBp5jBG4IXjp4bEg`, page "Current", section STORAGE: the extend
and resize dialogs, the method chooser, wallet connect, the pay screen with its expandable cost
breakdown, chain-switch and approval waits, progress, success and failure.

Two properties hold throughout:

- **No temp wallet.** Every intermediate balance parks at an address the account controls, so an
  abandoned flow is recoverable by re-running the funds check.
- **The two keys never cross.** The payment wallet signs exactly one source-chain transaction and
  never sees the owner key; the owner key only ever signs on Gnosis. The payment wallet is unrelated
  to the account's access method, so passkey and password users connect any wallet just to pay.

## Position in the stack

```
  drive-extend-dialog.svelte / drive-resize-dialog.svelte     phases: form | pending | error
        │                                                     (branch on funding.pending first)
        ▼
  drive-operation.ts ── FundingNeed ──▶ funding-request.svelte.ts ──▶ payment-dialog.svelte
        │                                    │  resolvePaymentRail()      (rail-agnostic screens)
        │                                    ▼
        │                              payment-rail.ts ◀── gnosis-direct.ts | relay.ts | dev rail
        │                                                  (leaf module: imports no rail)
        ├── funding.ts        quoteFunding — sizes the Gnosis side; swapDeliveredXdai
        └── postage-onchain.ts / chain.ts       ── Postage-On-Chain-Engine.md
```

## The rail seam

The multichain widget's UI is neither forked nor embedded: it is React, and its PostageStamp ABI
contains only `createBatch`, so it cannot top up or dilute at all.

The widget still exists as its own **method**, not as a rail: on a purchase's payment screen the
method picker offers **Pay with crypto** — the proven fund.bzz.limo popup flow
(`multichain-widget.ts`), which settles the whole batch itself — beside **Pay with crypto in app
(experimental)**, the flow this document describes. Extend and resize cannot take the widget (it
only creates batches), so there the picker offers the in-app method alone.

Instead the payment leg is a **`PaymentRail`** (`ui/src/lib/payment/payment-rail.ts`): `chains`,
`tokens(chainId)`, `quote()`, `execute()`, plus `switchWalletChain`. A rail's quote reduces to an
opaque `handle` that only the rail which produced it consumes, which is what lets more than one
implementation exist. The module is deliberately a **leaf** — it imports no rail, so rails can import
values from it with no initialisation cycle.

`resolve-rail.ts` picks and composes, dispatching **per token, not per chain** (a chain-level claim
silently removed Gnosis USDC from the picker):

- **Gnosis direct** (`gnosis-direct.ts`) — resolved first for any endpoint answering as chain 100, so
  it claims native xDAI there. The destination is the source, so the wallet simply sends xDAI to the
  batch-owner address and the operation continues into the same swap. It is the cheapest route by a
  wide margin, has the fewest moving parts, and is the only one that is genuinely the same code
  locally — routing it through a cross-chain network would pay that network to move money across
  zero chains.
- **Relay** (`relay.ts`) — the bridged rail, a thin wrapper over `@relayprotocol/relay-sdk` (plain TS
  core, no React, public mainnet API, no API key). It is the same rail the widget uses, proven for
  Gnosis with xDAI output. SDK progress callbacks map onto the step model; on failure the SDK error
  surfaces verbatim, and Relay-level refund semantics are the SDK's own.
- **The dev rail** (`ui/src/lib/dev/local-payment-rail.ts`) — only off mainnet, in a dev build, with
  a local source chain answering. See [Dev and testing](#dev-and-testing).

Source chains mirror the widget's: Ethereum, Polygon, Optimism, Arbitrum, Base, Gnosis. Token lists
are a static table per chain (native plus the obvious stablecoin); Relay's chain/currency metadata
call buys nothing for a six-chain, two-token picker.

**When no rail resolves, that is an error.** The app never funds an operation itself: money does not
arrive without a screen, a signature and a record of who paid.

## Quoting — `funding.ts`

`quoteFunding` sizes the Gnosis side, which is the rail-independent half; the rail quotes the source
side. `swapDeliveredXdai` lives here too, turning delivered xDAI into the BZZ the operation needs.

1. From the operation: `plurNeeded` (per-chunk amount `<< depth`) → `bzzNeeded` (1 BZZ = 1e16 PLUR).
2. `quoteXdaiInForBzzOut(bzzNeeded)` from `@swarm-id/multichain` (Sushi V3 `quoteExactOutputSingle`),
   × 1.2 (`SWAP_BUFFER_NUMERATOR` / `_DENOMINATOR`), mirroring the widget's 20% buffer. The swap
   executes exact-**input**, so the buffer is spent buying BZZ rather than left over: the surplus
   lands as BZZ at the owner address and the next operation's funds check consumes it.
3. Add the gas budget (`gasBudgetXdai`: the bundle's gas limit at the chain's current gas price,
   doubled, and never below the `GAS_BUDGET_FLOOR_XDAI = 0.005` floor — a transaction needs a balance
   of `gas × maxFeePerGas` to be sendable, so a flat budget strands the operation in a gas spike)
   minus the owner address's existing xDAI, floored at 0 — **plus `SWAP_GAS_XDAI = 0.002` whenever a
   swap will run**. The swap is signed by the owner key and pays for itself out of the same balance, before any
   of the operations the gas budget covers; without that term the swap spends the budget back down and
   the funds re-check immediately afterwards rejects a payment that in fact succeeded.
4. The rail's own quote for the selected source chain and token. Relay is asked for an
   `EXACT_OUTPUT` trade from the payment wallet to `recipient: ownerAddress` on `toChainId: 100` in
   native xDAI, for `amount: totalXdai`; the direct and dev rails price it themselves, having no
   route to shop for.
5. Surfaced as the source-token cost, the USD total, and the breakdown rows — an xDAI gas line and an
   xBZZ value line, each also priced in the source token.

**Owner residuals are consumed first.** The funds check subtracts existing owner BZZ and xDAI from
`bzzNeeded`/`totalXdai`; when they already cover the operation, payment is skipped entirely and
execution starts straight away. This matters most on the recovery path — a delivery whose swap never
ran would otherwise be paid for twice.

The swap leg itself is `swapXdaiToBzz({ originPrivateKey, amountXdai, recipient })` from
`@swarm-id/multichain`: exact-input, 0.5% slippage bound, 10-minute deadline. Quoting exact-output to
size the xDAI and then executing exact-input is deliberate — the top-up uses the PLUR that actually
arrived, so slight over-delivery becomes slightly longer lifespan rather than stranded BZZ, leaving
at most `< 2^depth` PLUR of dust.

## The flow

`drive-operation.ts` raises a `FundingNeed` mid-operation and calls the `RequestFunding` seam.
`createFundingRequester` answers it one way only: surface the payment screens for the resolved rail
and wait, or fail when there is none. `payment-dialog.svelte` owns the screens and is handed a
`PaymentRail` — it never knows which one.

```
                 ┌ no rail → throw: there is no route, and no free settlement
FundingNeed ─────┤
                 └ rail → method → connecting → configure (chain/token/quote) →
                          switching → approving → relaying → resolve()
                          → back into the engine: swap → approve → topUp [→ increaseDepth]
```

The pending request carries the need, its rail **and** the Gnosis-side quote as one `PendingPayment`,
so the dialog receives values it can rely on rather than optionals it must re-check. The quote
travels with it for a second reason: the amount the rail is asked to deliver has to be the one
`swapDeliveredXdai` later spends, and two independent quotes of the same need drift as the pool moves.

- Connect and chain-switch waits follow the attempt-guard rule (`.claude/rules/attempt-guard.md`):
  cancellable, with `attempt.guard` on every await before a side effect.
- Everything from the moment the user signs the source-chain transaction runs **outside** the attempt
  guard (spend-must-record, with the standard comment), so the flow finishes even if the dialog
  unmounts; the drive record lands via the engine's reconcile.
- Steps map to progress labels on one card — "Cross-swap xDAI on Relay" → "Swapping xDAI to BZZ" →
  "Extending lifespan" / "Increasing size".
- Chain switching requests `wallet_switchEthereumChain` when the selected chain differs from the
  wallet's; while pending, the balance shows "–" and the button spins.

In the drive dialogs, "payment" is not a phase. A pending funding request is already distinct state
(`funding.pending`) and the dialogs branch on it before their own `form | pending | error`. Proceed
runs the engine preflight and funds check; a shortfall raises the payment screens as dialog-sized
cards, not a popup; once funds land the engine continues to `pending`, then success or error. On
open, the engine's chain-truth reconciliation runs first.

## Slippage and liquidity

On-chain BZZ liquidity on Gnosis is shallow — roughly $10k in total, with the deepest pool about $9k
in SushiSwap V3 BZZ/USDC. So:

- Always quote before enabling Pay, and refuse in words when the Sushi quote's price impact exceeds
  `MAX_PRICE_IMPACT_PERCENT` (5%). Since the pool exposes no spot oracle, `quoteFunding` prices a
  small reference trade (`IMPACT_REFERENCE_BZZ_PLUR`) alongside the real one and compares the fills.
  The size dropdown itself offers every larger size, so the refusal catches a too-large jump rather
  than the dropdown preventing it — [#543](https://github.com/snaha/swarm-id/issues/543).
- The pay screen's USD total uses the rail's own pricing data (`currencyIn.amountUsd` for Relay; the
  dev rail derives it from the xDAI figure, xDAI being a dollar stablecoin). No third-party feed.
- The **dialogs'** cost estimates come from `bzz-price.ts`, which asks the same Sushi pool what BZZ
  costs in xDAI and takes xDAI as the dollar — so the forms agree with the screen they lead to. It
  caches a rate rather than a quote, per minute, because the extend dialog re-derives its estimate on
  every keystroke and `quoteExactOutputSingle` is an RPC round-trip. A near-spot reference trade
  carries none of a large trade's price impact, so the estimate reads slightly low for big resizes;
  the 5% refusal bounds how far off it can be, and every screen prefixes it with "~".

## Failure handling

| Failure point                          | State after                                | Recovery                                |
| -------------------------------------- | ------------------------------------------ | --------------------------------------- |
| Quote fails / no route                 | nothing spent                              | retry, other token or chain             |
| User rejects source tx                 | nothing spent                              | back to the pay screen                  |
| Relay leg fails                        | per Relay SDK semantics (refunded or held) | retry re-quotes; "View details"         |
| xDAI delivered, swap fails             | xDAI parked at owner                       | funds check consumes residual on retry  |
| Swap done, approve or topUp fails      | BZZ parked at owner                        | same                                    |
| Chain cannot bundle (no 7702 delegate) | nothing spent — refused in preflight       | nothing to recover                      |
| Anything after payment, dialog closed  | funds and state on chain                   | next dialog open reconciles and resumes |

Value is never parked deliberately. The quote requests exactly what the operation needs plus the swap
buffer, which the exact-input swap turns into a little surplus BZZ rather than xDAI. Both kinds of
residual are consumed before the next request: BZZ by `fundingShortfall`, and xDAI above the gas
budget by `quoteFunding`, which subtracts it from what the rail is asked to deliver.

### Resize cannot half-finish

A resize is one atomic EIP-7702 transaction: the compensating top-up and the depth increase land
together or not at all. A chain without the delegate is refused in preflight, before anything is
charged, rather than served by a second orchestration path — so the "payment succeeded, only the
depth increase is pending" state the earlier design worried about (#392) is unreachable, and there
is no partial-failure copy to get right.

Because the engine also inverts the old dilute-first ordering, a drive can never come out of a
resize shorter-lived than it went in.

## Dev and testing

Relay cannot be reproduced locally. It is an intent/solver network, so quotes come from a hosted API
and deliveries from off-chain solvers paying out on real Gnosis. Two rails stand in:

- **Gnosis direct**, against any endpoint answering as chain 100 — no bridge, no solver, no invented
  price, and the same code as production. `resolvePaymentRail()` offers it first, so it is what a
  local payment normally takes.
- **The local rail**, under `pnpm dev:local`, which adds a bare anvil on chain 31337 and a solver
  that fills from it. The wallet signs a real deposit there, the faucet then plays solver and delivers
  the xDAI, and the real Sushi swap runs on top. This is what makes the
  method → connect → configure → wallet-approval half of the flow exercisable at all. The chain is
  offered to the wallet through the `wallet_addEthereumChain` path already in the flow, but the
  **money is not**: no rail funds the payer, so the connected wallet must already hold what it pays
  with (/dev → Chain → Faucet, or anvil's first key).

A green local run must never be read as "the payment path works". The local rail rehearses the UX
only — Relay's pricing, routing, real step model (an ERC-20 source needs an approve before the
deposit) and refund semantics stay untested.

Tests that do not need a payment fund the postage signer **out of band** first (`fundPostageSigner` in
`ui/tests/helpers.ts`, the same chain faucet a developer uses by hand). The operation then finds the
funds already at the owner address, `ensureFunded` short-circuits, and no payment screen opens —
because nothing needs paying for, not because a rail was suppressed.
`ui/tests/payment-rail.test.ts` is the suite that deliberately does not prefund, so the screens open
and the rail runs end to end: method → connect → configure → pay, then a real deposit on the source
chain, the solver's delivery, the real Sushi swap and the real `createBatch`. Isolated component
tests would re-cover those same screens with nothing behind them, so that tier is not planned.

`relay.live.test.ts` contract-tests Relay's **quote** against the live API (`pnpm test:live` in CI).
Everything downstream of it — routing, the real step model, delivery, refunds — is proven only
against the dev rail, so Relay's **delivery** leg has never actually run; a production canary is
tracked in [#542](https://github.com/snaha/swarm-id/issues/542).

One delivery hazard is worth knowing while reading this: a native transfer to an address that has
authorised an EIP-7702 delegate executes that delegate's fallback, so the 21 000 gas a transfer to a
plain EOA costs is not enough and the transfer reverts. Every postage signer authorises the delegate
permanently on its first bundled operation, so from a drive's second paid operation onward the
recipient is a delegated address. `estimateTransferGas` (`multichain/src/rpc.ts`) estimates rather
than assumes; whether Relay's own solver does is what the canary has to establish.

## Out of scope

- Fiat payment. The method dropdown reserves the slot.
- Contributing `mode=topup` upstream to `ethersphere/multichain-widget`.

## Files and tests

| Path                                           | Role                                         |
| ---------------------------------------------- | -------------------------------------------- |
| `ui/src/lib/payment/payment-rail.ts`           | the `PaymentRail` contract (leaf module)     |
| `ui/src/lib/payment/relay.ts`                  | bridged rail over `@relayprotocol/relay-sdk` |
| `ui/src/lib/payment/gnosis-direct.ts`          | same-chain rail, native xDAI on Gnosis       |
| `ui/src/lib/payment/resolve-rail.ts`           | per-token composition and selection          |
| `ui/src/lib/payment/funding.ts`                | `quoteFunding`, `swapDeliveredXdai`          |
| `ui/src/lib/payment/bzz-price.ts`              | BZZ→USD rate for the dialogs' cost estimates |
| `ui/src/lib/payment/funding-request.svelte.ts` | `createFundingRequester`, `PendingPayment`   |
| `ui/src/lib/components/payment-dialog.svelte`  | the payment screens, rail-agnostic           |
| `ui/src/lib/dev/local-payment-rail.ts`         | local stand-in rail                          |

- Units: `funding.test.ts`, `resolve-rail.test.ts`, `gnosis-direct.test.ts`,
  `local-payment-rail.test.ts`.
- Live contract test: `relay.live.test.ts` (`pnpm test:live`).
- E2E: `ui/tests/payment-rail.test.ts` (payment screens end to end),
  `ui/tests/drive-onchain.test.ts` (the engine's flows).
