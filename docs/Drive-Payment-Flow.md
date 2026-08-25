# Drive payment flow — paying for storage in-app, from any chain

Status: **implemented.** This describes how BZZ and xDAI reach the derived batch-owner address. What
is then done with them on Gnosis is [`Postage-On-Chain-Engine.md`](./Postage-On-Chain-Engine.md),
consumed here as a library.

## What it is

Buying, extending and resizing a drive can be paid for **inside the identity UI**, with no external
popup and no Bee node. The user connects a wallet, picks a source chain and token, sees a quoted cost,
and signs **one** transaction. Everything after that — cross-chain delivery of xDAI to the batch-owner
address, the Gnosis-side xDAI→BZZ swap, and the postage operations themselves — runs in `ui/`, signed
by the owner key.

That is the **built-in** method, and it is new. The fund.bzz.limo popup it was written to replace is
still offered beside it, still the default, and still the proven path — see
[The method chooser](#the-method-chooser).

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
  drive-add-dialog.svelte                                     (branch on funding.pending first)
        │                                                     … + unconfirmed, on the widget path
        ▼
  drive-operation.ts ── FundingNeed ──▶ funding-request.svelte.ts ──▶ payment-dialog.svelte
        │                                    │  resolvePaymentRail()      (rail-agnostic screens)
        │                                    ▼                                    │
        │       payment-rail.ts ◀── gnosis-direct.ts | relay.ts | dev rail        │ onUseWidget
        │                           (leaf module: imports no rail)                ▼
        │                                                              multichain-widget.ts
        ├── funding.ts        quoteFunding — sizes the Gnosis side; swapDelivered  (popup, add only)
        └── postage-onchain.ts / chain.ts       ── Postage-On-Chain-Engine.md
```

## The method chooser

Two methods, in this order:

| Method                                     | What it is                                                            | Offered for            |
| ------------------------------------------ | --------------------------------------------------------------------- | ---------------------- |
| `Pay with crypto (fund.bzz.limo)`          | the external widget popup, which settles and creates the batch itself | buying a drive         |
| `Pay with crypto (built in, experimental)` | everything the rest of this document describes                        | buy, extend and resize |

**The widget leads, and is selected by default.** It is the settlement path the legacy UI has used
all along; the built-in engine beside it is new, has not been through a mainnet season, and says so
in its own label.

The widget's UI is neither forked nor embedded — it is React, and it is reached as a popup on its own
origin. Two properties of it decide where it can be offered at all:

- **It can only create a batch.** Its PostageStamp ABI carries `createBatch` alone, so it cannot top
  up or dilute. Extend and resize therefore list the built-in method only, exactly as they did before
  the chooser had a second entry.
- **It settles on Gnosis mainnet only.** So local development is the built-in method's, and
  [Dev and testing](#dev-and-testing) is written for that.

It is also not a rail, and does not go through the seam below at all: it returns a fully created
`BatchEvent`, which `stampFromBatch` turns straight into the drive record. Choosing it therefore has
to **leave** the engine operation — `cancel({ reason: 'use-widget' })` fails the pending request with
a typed `UseWidgetError`, which the add-drive dialog catches beside `PaymentCancelledError` and
answers by opening the popup. Nothing has been spent at that point: the funding seam is raised before
`beforeSpend` and before the first spending transaction, so abandoning there costs nothing. The error
is its own type precisely so no generic catch reads a deliberate change of method as a cancel.

Because the widget picks the size and lifespan **inside** the popup, the add-drive form's selection is
only a pre-payment estimate on that path; the real lifespan is derived from the amount that settled.
The method screen says so.

## The rail seam

The payment leg of the built-in method is a **`PaymentRail`** (`ui/src/lib/payment/payment-rail.ts`):
`chains`, `tokens(chainId)`, `quote()`, `execute()`, plus `switchWalletChain`. A rail's quote reduces
to an opaque `handle` that only the rail which produced it consumes, which is what lets more than one
implementation exist. The module is deliberately a **leaf** — it imports no rail, so rails can import
values from it with no initialisation cycle.

`resolve-rail.ts` picks and composes, dispatching **per token, not per chain** (a chain-level claim
silently removed Gnosis USDC from the picker):

- **Gnosis direct** (`gnosis-direct.ts`) — resolved for any endpoint answering as chain 100. The destination is the source,
  so the wallet simply sends xDAI to the batch-owner address and the operation continues into the
  same swap. It is the cheapest route there will ever be — no bridge fee, no solver spread, nobody
  between signing and delivery — and it is genuinely the same code locally, where the baked chain
  answers as Gnosis.

- **Relay** (`relay.ts`) — the bridged rail, a thin wrapper over `@relayprotocol/relay-sdk` (plain TS
  core, no React, public mainnet API, no API key). It is the same rail the widget uses, proven for
  Gnosis with xDAI output. SDK progress callbacks map onto the step model; on failure the SDK error
  surfaces verbatim, and Relay-level refund semantics are the SDK's own. One delivery is bounded at
  ten minutes (`EXECUTE_TIMEOUT_MS`, far past a slow cross-chain fill) — an SDK that stops reporting
  altogether has to surface as a failed payment, which is a state the flow can recover from, rather
  than a spinner whose only exit is a reload.
- **The dev rail** (`ui/src/lib/dev/local-payment-rail.ts`) — only off mainnet, in a dev build, with
  a local source chain answering. See [Dev and testing](#dev-and-testing).

Source chains mirror the widget's: Ethereum, Polygon, Optimism, Arbitrum, Base, Gnosis. Token lists
are a static table per chain (native plus the obvious stablecoin); Relay's chain/currency metadata
call buys nothing for a six-chain, two-token picker.

### What it accepts, and the second leg

Four assets: **xDAI, WXDAI, USDC and BZZ**. Those are the ones with a real route
to BZZ on Gnosis — notably not WETH, which has no BZZ pool at all and whose
two-hop alternative runs through pools holding a few hundred dollars between
them, so offering it would mean quoting trades that mostly cannot fill.

BZZ is the cheapest of the four by construction: it is already what the
operation spends, so no pool is touched and there is no slippage. USDC is next,
being the token adjacent to the deep pool.

A token leg is sized from `bzzPlur` — an exact-output quote in that token —
rather than by converting the xDAI figure. Converting would price a swap nobody
makes and pay the spread twice. It then takes the same 1.2× buffer the xDAI leg
does (`withSwapBuffer`, one definition in `funding.ts`): the quote is
exact-output and the swap that follows is exact-input at a later price, so
without the headroom any adverse move under-delivers — and only after the token
has been spent. BZZ takes none: it runs no swap, so nothing can move against it.

A shortfall that is only gas has no BZZ leg at all, and gas is native by
definition, so the token quotes refuse it in words ("This payment only covers
transaction gas, which is paid in xDAI"). Quoted anyway it was a zero-amount
Sushi trade, which reverts, and a zero-value BZZ transfer with Pay enabled.

**Paying in anything but xDAI is two transactions.** A token cannot pay for its
own swap: the owner key still has to sign the swap and the postage calls
afterwards, and a token balance pays for neither. So the rail sends the gas as
native xDAI first, then the token. Gas **first** is deliberate — it is the
cheaper leg, so a wallet rejection costs the smaller one, where the reverse
order would park the token at an address that cannot yet spend it. The gas leg
is skipped entirely when the owner is already funded, and an xDAI payment stays
one transaction because a single transfer covers both.

What the rail delivered travels back with the settlement (`PaymentQuote.delivers`
→ `FundingQuote.paidWith`/`paidAmount`, through `settleWith`), because
`swapDelivered` spends exactly that: paying in USDC and then swapping xDAI would
fail at the far end of a payment that had already succeeded.

`settleWith` is asymmetric, and deliberately: a token leg is swapped whole, so
the rail's figure is the one to spend, while the native leg keeps the **caller's**
`xdaiForBzzWei`. The rail is only asked to deliver what is missing, and the swap
input also contains the xDAI already parked at the owner address — which the
rail never carried and cannot see. Settling that side from the delivery swapped
one buffer less than the operation needs, and, where the residual exceeded the
swap input, a negative amount.

An endpoint that cannot be **proven** to be Gnosis resolves no rail at all. `resolve-rail.ts` is
where that judgement lives, kept apart from the leaf so a future rail can be added to the choice
without either module importing the other.

**When no rail resolves, that is an error.** The app never funds an operation itself: money does not
arrive without a screen, a signature and a record of who paid.

## Quoting — `funding.ts`

`quoteFunding` sizes the Gnosis side, which is the rail-independent half; the rail quotes the source
side. `swapDelivered` lives here too, turning delivered xDAI into the BZZ the operation needs.

1. From the operation: `plurNeeded` (per-chunk amount `<< depth`) → `bzzNeeded` (1 BZZ = 1e16 PLUR).
2. `quoteXdaiInForBzzOut(bzzNeeded)` from `@swarm-id/multichain` (Sushi V3 `quoteExactOutputSingle`),
   × 1.2 (`SWAP_BUFFER_NUMERATOR` / `_DENOMINATOR`), mirroring the widget's 20% buffer. The swap
   executes exact-**input**, so the buffer is spent buying BZZ rather than left over: the surplus
   lands as BZZ at the owner address and the next operation's funds check consumes it.
3. Add `GAS_BUDGET_XDAI = 0.005` (approve + topUp + increaseDepth at 1 gwei, with headroom) minus the
   owner address's existing xDAI, floored at 0 — **plus `SWAP_GAS_XDAI = 0.002` whenever a swap will
   run**. The swap is signed by the owner key and pays for itself out of the same balance, before any
   of the operations the gas budget covers; without that term the swap spends the budget back down and
   the funds re-check immediately afterwards rejects a payment that in fact succeeded.
   The balance behind both this term and the surplus below is read **live, here**, never taken from
   the `FundingNeed`: the need is captured once, before the first payment screen, and every re-price
   after a failed attempt reuses it — so a gas leg that landed and then failed to swap was charged
   for a second time, while the same read was crediting it as surplus.
4. The rail's own quote for the selected source chain and token. Relay is asked for an
   `EXACT_OUTPUT` trade from the payment wallet to `recipient: ownerAddress` on `toChainId: 100` in
   native xDAI, for `amount: totalXdai`; the direct and dev rails price it themselves and
   synchronously, having no route to shop for — on the direct one the user pays exactly what must
   arrive, because nothing takes a cut in between, and gas is the wallet's own business, which it
   prices itself.
5. Surfaced as the source-token cost, the USD total, and the breakdown rows — an xDAI gas line and an
   xBZZ value line, each also priced in the source token.

**Owner residuals are consumed first.** The funds check subtracts existing owner BZZ and xDAI from
`bzzNeeded`/`totalXdai`; when they already cover the operation, no payment is taken and execution
starts straight away — either because the funds check found no shortfall and never raised the seam,
or because the built-in method's quote came back zero and settled the request on the spot. This
matters most on the recovery path — a delivery whose swap never ran would otherwise be paid for twice.

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
                 │
FundingNeed ─────┤        ┌ widget → UseWidgetError → the add dialog opens the popup
                 └ rail → method
                          └ built in → quote → connecting → configure (chain/token/quote) →
                             switching → approving → relaying → resolve()
                             → back into the engine: swap → approve → topUp [→ increaseDepth]
```

**The dialog opens before anything is priced.** The pending request carries the need and its rail,
not a quote: the default method is settled entirely by fund.bzz.limo and needs nothing from
`quoteFunding`, so pricing ahead of the choice held an empty dialog behind an RPC round-trip nobody
had asked for. The built-in method prices itself the moment it is chosen — or, on extend and resize
where it is the only method listed, the moment the dialog opens.

Two consequences of moving that quote:

- **Nothing is ever asked to pay zero.** `quoteFunding` subtracts what the owner address already
  holds, and a result of `xdaiWei === 0n` means the operation is already covered. That used to skip
  the screens entirely; now the built-in path settles the request with that quote the instant it
  comes back, so the swap still runs and no pay screen appears. (The commoner case — the funds check
  finding no shortfall at all — still never reaches this seam.)
- **A failed quote takes out one method, not the dialog.** It leaves the built-in entry listed but
  disabled with the quoter's own words beside it, and the chooser falls back to the widget, which
  prices nothing through us and is unaffected. Where the built-in method is the only one (extend,
  resize) it stays choosable and the screen offers a retry instead. Note this is genuinely an RPC or
  routing failure: price impact is **carried** on the quote, not thrown — see
  [Slippage, routing and liquidity](#slippage-routing-and-liquidity).

Whichever quote the payment is finally made against travels back through `resolve(settled)`, because
the amount the rail is asked to deliver has to be the one `swapDelivered` later spends, and two
independent quotes of the same need drift as the pool moves.

- Connect and chain-switch waits follow the attempt-guard rule (`.claude/rules/attempt-guard.md`):
  cancellable, with `attempt.guard` on every await before a side effect.
- Everything from the moment the user signs the source-chain transaction runs **outside** the attempt
  guard (spend-must-record, with the standard comment), so the flow finishes even if the dialog
  unmounts; the drive record lands via the engine's reconcile. The settlement handed back to
  `resolve()` is likewise not attempt-gated — see [Cancelling a payment](#cancelling-a-payment).
- Steps map to progress labels on one card — "Cross-swap xDAI on Relay" → "Swapping xDAI to BZZ" →
  "Extending lifespan" / "Increasing size".
- Chain switching requests `wallet_switchEthereumChain` when the selected chain differs from the
  wallet's; while pending, the balance shows "–" and the button spins. A wallet that answers "I have
  no such chain" is offered `wallet_addEthereumChain` and then asked to **switch again** — adding is
  not switching, and the wallets that do only the first would otherwise have the payment signed on
  whichever network was there before.

In the drive dialogs, "payment" is not a phase. A pending funding request is already distinct state
(`funding.pending`) and the dialogs branch on it before their own `form | pending | error`. Proceed
runs the engine preflight and funds check; a shortfall raises the payment screens as dialog-sized
cards, not a popup; once funds land the engine continues to `pending`, then success or error. On
open, the engine's chain-truth reconciliation runs first.

The add-drive dialog carries one phase more, and only the widget path reaches it: `unconfirmed`, for
a popup that closed without a recognised `batch` message. That is genuinely ambiguous — the purchase
may have gone through and its message been missed — so it is neither a success nor a cancel, and the
copy tells the user not to pay again without checking.

## Slippage, routing and liquidity

On-chain BZZ liquidity on Gnosis is shallow, and unevenly spread. BZZ has exactly two live pools on
SushiSwap V3, both at the 0.3% tier:

| Pool      | BZZ side     | Other side  |
| --------- | ------------ | ----------- |
| BZZ/WXDAI | ~19,600 BZZ  | ~167 WXDAI  |
| BZZ/USDC  | ~142,000 BZZ | ~3,055 USDC |

**The swap is therefore routed, not direct.** A drive is a bigger trade than those figures suggest —
at the current price a depth-24 drive with a year of lifespan is ~823 BZZ — and against 167 WXDAI
that is not a purchase, it is a market move. Every quote prices both the direct WXDAI/BZZ pool and
the WXDAI→USDC→BZZ path, and the cheaper one is the one executed (`bestExactOutput` /
`bestExactInput` in `multichain/src/sushi.ts`). The saving is not marginal: measured against mainnet,
a 206 BZZ purchase is 5.7% cheaper routed, an 823 BZZ one 23%, and a 3,292 BZZ one **75%** (150 xDAI
against 603).

Routing is what makes the guard below passable at all. Direct-only, a depth-22 drive with a year of
lifespan already exceeded the 5% refusal, and a depth-26 one exceeded it by a factor of sixty — so
the only purchase mainnet would accept was the smallest size at the shortest lifespan.

A route that reverts drops out rather than failing the quote, since a pool can be missing or simply
too thin to fill a given size; only both failing is an error. That fallback is a safety net, **not**
how local development is meant to run: the baked chain carries both routes from
[`@snaha/bee-compose` #28](https://github.com/snaha/bee-compose/pull/28) — released as **0.3.0**,
the version the repo pins — onward, and against that
snapshot a local purchase picks the same route as mainnet and prices within 0.06% of it. Against an
older snapshot — which carries only BZZ/WXDAI — the fallback keeps the flow working, but every
purchase is then priced the expensive way and a large drive is refused locally while mainnet accepts
it. If local and production disagree about a price, check the snapshot's vintage first.

So:

- Always quote before enabling Pay, and refuse in words when the Sushi quote's price impact exceeds
  `MAX_PRICE_IMPACT_PERCENT` (5%). Since the pool exposes no spot oracle, `quoteFunding` prices a
  small reference trade (`IMPACT_REFERENCE_BZZ_PLUR`) alongside the real one and compares the fills.
  It **carries** the figure on the quote rather than throwing it: the refusal belongs to the swap,
  and the pay screen applies it (`priceImpactRefusal`) once the token is known. **Paying in BZZ is
  exempt** — it touches no pool, so refusing it for a price it never pays would have left the one
  user who could comfortably afford a large resize unable to make it.
  The reference is **one whole BZZ**, not a dust amount: the route may pass through USDC, whose six
  decimals round a fraction of a cent to zero mid-path, and a reference priced through a different
  pool than the real trade measures the spread between two pools rather than one trade's own impact.
  The size dropdown itself offers every larger size, so the refusal catches a too-large jump rather
  than the dropdown preventing it — [#543](https://github.com/snaha/swarm-id/issues/543).
- The pay screen's USD total uses the rail's own pricing data (`currencyIn.amountUsd` for Relay; the
  direct and dev rails derive it from the xDAI figure, xDAI being a dollar stablecoin). No
  third-party feed. A **token** payment's gas leg is part of that total, being xDAI and so a dollar
  as well, and the headline names both legs ("10.84 USDC + 0.005 xDAI gas") — one figure for two
  transactions would be short of the bill, and the breakdown rows beneath it are each priced in the
  asset that pays them so they sum to it.
- The **dialogs'** cost estimates come from `bzz-price.ts`, which asks the same routed quote what BZZ
  costs in xDAI and takes xDAI as the dollar — so the forms agree with the screen they lead to. It
  caches a rate rather than a quote, per minute, because the extend dialog re-derives its estimate on
  every keystroke and `quoteExactOutputSingle` is an RPC round-trip. A near-spot reference trade
  carries none of a large trade's price impact, so the estimate reads slightly low for big resizes;
  the 5% refusal bounds how far off it can be, and every screen prefixes it with "~".
- Those estimates are all a per-chunk amount `<< depth`, and the **depth is the chain's** —
  `previewResize`'s `currentDepth` in the resize dialog, `chainDepth()` once per open in both. A
  record lagging a resize that landed in a lost session is out by a factor of two for each step it
  missed, which is also what the engine would then charge. Only the depth is fetched; the per-chunk
  amount re-derives locally, so nothing here costs an RPC per keystroke.

## Failure handling

| Failure point                            | State after                                          | Recovery                                                     |
| ---------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| Quote fails / no route                   | nothing spent                                        | retry, other token or chain                                  |
| User rejects source tx                   | nothing spent                                        | back to the pay screen                                       |
| Rail leg fails or times out              | unknown until the owner address is read              | the pay screen re-prices before offering Pay again (below)   |
| xDAI delivered, swap fails               | xDAI parked at owner                                 | funds check consumes residual on retry                       |
| Swap done, approve or topUp fails        | BZZ parked at owner                                  | same                                                         |
| topUp done, increaseDepth fails (resize) | unbundled path only: lifespan extended, size pending | see below                                                    |
| User cancels mid-approval                | the wallet may still be holding the signature        | the request stays open; an approval still settles it (below) |
| Anything after payment, dialog closed    | funds and state on chain                             | next dialog open reconciles and resumes                      |
| Purchase sent, confirmation times out    | the batch is paid for and named                      | recorded from `CreatePendingError`; reconciled on next open  |

Value is never parked deliberately. The quote requests exactly what the operation needs plus the swap
buffer, which the exact-input swap turns into a little surplus BZZ rather than xDAI. Both kinds of
residual are consumed before the next request: BZZ by `fundingShortfall`, and xDAI above the gas
budget by `quoteFunding`, which subtracts it from what the rail is asked to deliver.

### Retrying a failed payment

A rail reporting failure is not evidence that nothing was delivered. The common case is the opposite:
the transfer lands and the confirmation wait times out — the direct rail says so in as many words
("It may still land"), and Relay's own execute is bounded the same way. Offering Pay again at the
price the screen already shows would charge the full amount a second time while the first payment
sits at the owner address.

So a failed attempt re-prices before Pay comes back: `quoteFunding` runs again for the same need, and
because it subtracts the owner address's surplus xDAI, the retry asks only for what is genuinely
still missing. When it comes back **zero** the first payment covered the operation, and the dialog
settles the request instead of taking a second one. From the first attempt onward this re-price runs
ahead of every source-side quote, so switching chain or token cannot slip back to the stale figure;
while it is in flight Pay stays disabled, and a re-price that itself fails leaves it disabled rather
than offering a price nobody can vouch for.

The re-priced quote is what settles the request (`resolve(settled)`), keeping the property that the
amount the rail was asked to deliver is the amount `swapDelivered` then spends.

### Cancelling a payment

Before anything is signed, Cancel is exactly what it says: the request is rejected with
`PaymentCancelledError` and the drive dialog returns to its form. Choosing fund.bzz.limo travels the
same wire and is deliberately **not** the same thing: it rejects with `UseWidgetError`, so the add
dialog opens the popup instead of returning to a form the user did not ask for.

Once the source-chain transaction is with the wallet it is not, and the flow does not pretend
otherwise — nothing here can withdraw a prompt the wallet is showing, and a user who then approves
has genuinely paid. `cancel({ reason: 'payment-in-flight' })` therefore takes the **screens** away
without rejecting the **request**: the execute is still awaited in the background, and the
settlement is handed on ungated by the attempt, so an approval that follows a cancel still swaps,
spends and records exactly as it would have. The drive dialog shows "Waiting for the payment…"
meanwhile, and the wait screens say plainly that cancelling cannot stop a payment already approved.

From that moment the requester **remembers** the payment is in flight, and a plain `cancel()` — a
closed drive dialog, an unmounted component — leaves the settlement armed rather than rejecting it.
None of those can call the wallet back either, and disarming there dropped the approval that
followed. Only the payment's own outcome ends the wait:

| Outcome of the in-flight execute  | `cancel(…)`                                | The operation                                                |
| --------------------------------- | ------------------------------------------ | ------------------------------------------------------------ |
| approved                          | — (`resolve` with the settled quote)       | swaps, spends and records                                    |
| rejected in the wallet            | `{ reason: 'wallet-rejected' }`            | ends as an ordinary cancel — nothing was sent                |
| broadcast, confirmation timed out | `{ reason: 'payment-unconfirmed', error }` | fails with the rail's own words; the retry re-prices (above) |

The timeout is deliberately **not** a cancel. The transfer was broadcast, so treating it as "nothing
was delivered" clean-cancelled a payment that then landed; failing with the rail's message
("It may still land") puts the drive dialog on its error screen instead, whose Try again re-prices
and absorbs whatever arrived. `TimeoutError` is what tells the two apart — never the message text.

### Resize partial failure

On any chain with the EIP-7702 delegate — which includes Gnosis mainnet — the resize is one atomic
transaction, so the top-up and the depth increase land together or not at all. What follows applies
only to the unbundled fallback.

Because the engine inverts the old dilute-first ordering, a drive can never come out of a resize
shorter-lived than it went in. The reachable partial state is the benign inverse: **payment
succeeded, the lifespan got longer, and only the depth increase is pending**. `runResize` throws a
typed `SizeIncreasePendingError` for it, and `DriveDialogStatus` renders it with a neutral `tone`
rather than a red warning — nothing shrank, so a warning icon would send the user looking for damage
that did not happen. The drive row needs no warning state either.

That wording is earned only when a top-up actually landed. A resize that lets the lifespan shorten
has `topUpAmount === 0`, so nothing was paid, nothing grew, and a retry costs exactly what this
attempt did — nothing. The same failure there is an ordinary error in the ordinary red tone, saying
so; the neutral copy would otherwise tell the user their money went somewhere it did not.

Retrying it is **not yet free**. `runResize` re-derives `resizePlan` from the live remaining balance,
which the top-up has just increased, so a keep-lifespan retry asks for a second top-up sized against
the grown figure — for a depth step of one, exactly twice the first. Chain state alone cannot fix
this: a batch topped up for a pending resize is indistinguishable from one that always held that
balance, so resuming needs the target depth persisted on the record. Tracked, along with the dialog
copy that currently promises otherwise, in
[#541](https://github.com/snaha/swarm-id/issues/541).

## Dev and testing

**Locally only one method really settles, and it is the built-in one over the direct rail.**
fund.bzz.limo settles on Gnosis mainnet against the mainnet PostageStamp; pointed at a local chain it
has nothing to settle on. Relay cannot be reproduced locally either — it is an intent/solver network,
so quotes come from a hosted API and deliveries from off-chain solvers paying out on real Gnosis. So
everything below — and every chain-bound test — exercises the built-in path over the direct rail, and
the widget's own settlement is only ever proven on mainnet.

What the default method has instead, off mainnet, is a simulation: `/dev` → **Chain** → **Simulated
purchase** makes `openStampPurchaseWidget` fabricate the settled batch — or an error — in place of
the payment, which is what keeps that method's own screens reachable at all here. The batch exists
nowhere on chain, so extend and resize cannot act on it; the toggles reach nothing but the widget,
and are off in production.

What can be exercised locally, for the built-in method, is the two rails that stand in for Relay:

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

Chain id alone cannot keep the local chain and the real one apart — it answers 100 on purpose, so a
wallet that already has real Gnosis configured satisfies a switch to 100 without ever seeing the
local RPC, and the transfer that follows would move REAL xDAI to an address only this machine holds
the key for. `walletChainRefusal` compares **genesis hashes**, which a chain cannot borrow, and fails
closed: a wallet that will not say which chain it is on is refused unless the app's own endpoint is
proven mainnet.

The comparison is against the **endpoint's own** genesis (carried on `ChainIdentity`), not against
"is either side mainnet". Two chains that are both not mainnet are still two chains, and a wallet
left on Ethereum — or on yesterday's anvil — matched a dev endpoint on every question but that one,
which is the same transfer into nowhere as the mainnet case with less to show for it.

The `/dev` faucet hands out all four assets, because the baked chain stocks it
with them (bee-compose #28, in 0.3.0) — testing a token payment otherwise starts
with trading for the token, on the very pools the test is about.

A green local run therefore says nothing about the bridged rail. `relay.live.test.ts` contract-tests
Relay's **quote** against the live API (`pnpm test:live` in CI) — the only thing that catches our
request or response mapping drifting from theirs. Everything downstream of it, routing and the real
step model and delivery and refunds, is not covered here at all; a production canary is tracked in
[#542](https://github.com/snaha/swarm-id/issues/542).

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

- **Extending or resizing through fund.bzz.limo.** Its ABI cannot, so those dialogs list one method.
  Contributing `mode=topup` upstream to `ethersphere/multichain-widget` would change that, and is not
  planned here.
- **Retiring either method.** Which one eventually wins is a decision for after the built-in engine
  has a mainnet season behind it; until then both are shipped and the older one leads.
- Fiat payment. The method dropdown reserves the slot.

## Files and tests

| Path                                           | Role                                         |
| ---------------------------------------------- | -------------------------------------------- |
| `ui/src/lib/payment/payment-rail.ts`           | the `PaymentRail` contract (leaf module)     |
| `ui/src/lib/payment/relay.ts`                  | bridged rail over `@relayprotocol/relay-sdk` |
| `ui/src/lib/payment/gnosis-direct.ts`          | same-chain rail, native xDAI on Gnosis       |
| `ui/src/lib/payment/resolve-rail.ts`           | per-token composition and selection          |
| `ui/src/lib/payment/funding.ts`                | `quoteFunding`, `swapDelivered`              |
| `ui/src/lib/payment/bzz-price.ts`              | BZZ→USD rate for the dialogs' cost estimates |
| `ui/src/lib/payment/funding-request.svelte.ts` | `createFundingRequester`, `PendingPayment`   |
| `ui/src/lib/components/payment-dialog.svelte`  | the method chooser and payment screens       |
| `ui/src/lib/payment/multichain-widget.ts`      | the fund.bzz.limo popup and its messages     |
| `ui/src/lib/dev/local-payment-rail.ts`         | local stand-in rail                          |

- Units: `funding.test.ts` (the quote's arithmetic, `priceImpactRefusal`, and which figure
  `settleWith` hands the swap), `resolve-rail.test.ts`, `gnosis-direct.test.ts` (the genesis-hash
  refusals, the token leg's buffer, and the gas-only refusals), `payment-rail.test.ts` (formatting,
  and add-then-switch), `funding-request.svelte.test.ts` (which quote settles the request, and what
  each kind of cancel — the widget choice included — does to a payment already in flight),
  `multichain-widget.test.ts` (the widget's message parsing, which is the untrusted half of that
  path), `local-payment-rail.test.ts`, `relay.test.ts` (the delivery bound).
- Live contract test: `relay.live.test.ts` (`pnpm test:live`).
- E2E: `ui/tests/payment-rail.test.ts` (payment screens end to end),
  `ui/tests/drive-onchain.test.ts` (the engine's flows).
