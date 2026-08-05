# Drive Payment Flow (in-app, multichain) — Spec

Status: **implemented**, with the §6 copy work outstanding — see §9. The design sections are kept
as the record of why the flow is shaped this way; where the code has since moved on, the text has
been corrected rather than left as the original proposal. Depends on
[Postage-On-Chain-Engine.md](Postage-On-Chain-Engine.md) (owner-key signing, preflights,
`resizePlan`, reconcile — consumed as a library here).
Related issues: [#309](https://github.com/snaha/swarm-id/issues/309) — its conclusion comment
("use the multichain library for this (with our own UI)") is the direction this spec implements.

## 1. Goal

Replace the external fund.bzz.limo popup **for extend/resize funding** with an **in-app payment
flow** matching the Figma designs: the user connects a wallet inside our UI, picks a source chain +
token, sees a quoted cost, signs ONE transaction, and our UI handles everything else — cross-chain
delivery of xDAI to the derived batch-owner address, the Gnosis-side xDAI→BZZ swap, and the
on-chain postage operations signed by the owner key.

Figma (file `1UCqrAPBp5jBG4IXjp4bEg`, page "Current", section STORAGE):

| Screen                                        | Node                                    | Notes                                                                                                                                                                                                     |
| --------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extend dialog (empty / filled)                | `130:35224` / `130:36725`               | count+unit stepper, "Estimated until <date>", "Estimated cost ~X USD", Proceed                                                                                                                            |
| Resize dialog (empty / filled / lifespan-off) | `130:28635` / `130:32906` / `130:34891` | size dropdown (only larger sizes), "Keep current lifespan" toggle, "Lifespan reduced to ~X" when off                                                                                                      |
| Payment method chooser                        | `130:51335`                             | "Method: Pay with crypto" dropdown (future: fiat), "Connect wallet →"                                                                                                                                     |
| Wallet connect pending                        | `130:53149`                             | "Check your wallet — approve the connection", Cancel                                                                                                                                                      |
| Pay screen                                    | `130:53383` / `138:21118`               | connected-wallet chip, Chain select, Token select, "N available", "Estimated cost" expandable → breakdown rows `0.060 xDAI` / `0.578 xBZZ` priced in source token, "~X USD total", "Pay with your wallet" |
| Waiting for chain switch                      | `138:20305`                             | balance shows "–", button spinner "Check your wallet"                                                                                                                                                     |
| Payment approval pending                      | `138:21686`                             | "Check your wallet — approve the payment", Cancel                                                                                                                                                         |
| Progress                                      | `135:8159`                              | spinner + step label "Cross-swap xDAI on Relay"                                                                                                                                                           |
| Success                                       | `135:8950`                              | "Purchase completed!" / Done                                                                                                                                                                              |
| Failure                                       | `135:9633`                              | "Purchase failed — try again or use another payment method", View details, Retry                                                                                                                          |
| Resize partial-failure                        | `481:14324` / `481:14846`               | **copy must change** — see §6                                                                                                                                                                             |

## 2. Architecture decision

We do NOT fork or embed the multichain widget UI (React; no topup/dilute capability — its
PostageStamp ABI contains only `createBatch`). Instead:

- **Cross-chain leg: Relay Protocol** via `@relayprotocol/relay-sdk` (new `ui/` dependency; plain
  TS core, no React needed; public mainnet API, no API key). This is the same rail the widget uses
  (`createClient({ baseApiUrl: MAINNET_RELAY_API })`, `relayClient.actions.execute`), proven for
  Gnosis with xDAI output.
- **Gnosis-side legs from the in-repo `@swarm-id/multichain` package** (`multichain/`, vendored
  and extended from `@upcoming/multichain-library` per #309 — see its README for provenance):
  SushiSwap V3 xDAI→BZZ swap (`swapXdaiToBzz`, quotes both directions), `approveBzz`,
  `topUpBatch`, `increaseDepth`, batch reads, and waiters — signed by the derived owner key,
  chain-injectable so the identical code runs against bee-compose anvil.
- **No temp wallet** (unlike the widget): Relay delivers native xDAI directly to the owner address;
  the owner key executes the Gnosis side. Every intermediate balance parks at an address we
  control, so any abandoned flow is recoverable by re-running the funds check.
- **Wallet connection**: reuse the `web3-onboard` stack already in `ui/` (eth-wallet access method,
  `ui/src/lib/crypto/eth-wallet.ts`) with a payment-scoped connect. The payment wallet only ever
  signs the ONE source-chain transaction; it never sees the owner key and is unrelated to the
  account's access method (passkey/password users connect any wallet just for paying).

Source chains (mirror the widget config): Ethereum, Polygon, Optimism, Arbitrum, Base, Gnosis.
Token lists are a static table per chain (native + the obvious stablecoin) rather than Relay's
chain/currency metadata as first planned — the metadata call bought nothing for a six-chain,
two-token picker. Paying from Gnosis itself still goes through the same Relay quote (Relay handles
same-chain swaps) — one code path.

**Since implementation: the rail is a seam.** Relay is one implementation of a `PaymentRail`
interface, not the only possible one, because Relay cannot run locally at all — it is an
intent/solver network, so quotes come from a hosted API and deliveries from off-chain solvers
paying out on real Gnosis. See §7.

## 3. Modules

### 3.1 `ui/src/lib/payment/funding.ts` (planned as `quote.ts`)

The quoting pipeline. It landed split in two rather than as one module: `quoteFunding` sizes the
Gnosis side (steps 1–3 below) and the rail quotes the source side (step 4), because only the
Gnosis half is rail-independent. `swapDeliveredXdai` lives here too — the leg that turns delivered
xDAI into the BZZ the operation needs.

1. From the operation: `plurNeeded` (per-chunk amount << depth) → `bzzNeeded` (1 BZZ = 1e16 PLUR).
2. `@swarm-id/multichain`'s `quoteXdaiInForBzzOut(bzzNeeded)` (Sushi V3 `quoteExactOutputSingle`),
   × `SWAP_BUFFER = 1.2` (mirrors the widget's 20% buffer; leftover xDAI stays at the owner
   address as future gas — never refunded).
3. Add `GAS_BUDGET_XDAI = 0.005` (covers approve + topUp + increaseDepth at 1 gwei with headroom)
   minus the owner address's existing xDAI balance (floor at 0).
4. Relay quote: `{ user: paymentWallet, recipient: ownerAddress, toChainId: 100, toCurrency:
native xDAI (zero address), tradeType: EXACT_OUTPUT, amount: totalXdai }` for the selected
   source chain/token.
5. Surface: source-token cost, USD total, and the breakdown rows (xDAI gas line, xBZZ value line —
   each also priced in the source token) exactly as Figma `138:21118` shows.

Owner residual balances are consumed first: the funds check subtracts existing owner BZZ/xDAI from
`bzzNeeded`/`totalXdai`; if residuals already cover the operation, skip payment entirely and go
straight to execution (engine spec §4).

### 3.2 The rail: `payment-rail.ts` + `relay.ts` + `resolve-rail.ts`

Planned as a single `relay.ts`; implemented as a seam, so a second rail can exist locally.

- **`payment-rail.ts`** — the `PaymentRail` contract: `chains`, `tokens(chainId)`, `quote()`,
  `execute()`, plus `switchWalletChain`. A rail's quote reduces to an opaque `handle` only the rail
  that produced it consumes, which is what lets a non-Relay implementation exist at all. This
  module is deliberately a **leaf**: it imports no rail, so rails can import values from it with no
  initialisation cycle.
- **`relay.ts`** — the production rail. Thin wrapper over `@relayprotocol/relay-sdk`: client
  singleton, SDK progress callbacks mapped onto our step model. On failure the SDK error surfaces
  verbatim; Relay-level refund semantics are the SDK's own.
- **`resolve-rail.ts`** — picks. A production build always returns the Relay rail whatever chain it
  is pointed at; on Gnosis mainnet (by genesis hash) likewise. Only off mainnet, in a dev build,
  with a local source chain answering, does it return the dev rail — and with no source chain it
  returns `undefined`, meaning "no rail: fund from the faucet and never open the payment screens".

### 3.3 Swap leg

Provided by `@swarm-id/multichain`: `swapXdaiToBzz({ originPrivateKey, amountXdai, recipient })` —
exact-input xDAI→BZZ with a 0.5% slippage bound and 10-minute deadline (the exact-input shape is
deliberate: quote exact-output to SIZE the xDAI, execute exact-input, then top up with the PLUR
that actually arrived — slight over-delivery becomes slightly longer lifespan, never stranded
BZZ beyond `< 2^depth` PLUR dust). Wrap the wait in `withTimeout` in the orchestrator.

### 3.4 The orchestrator: `funding-request.svelte.ts` + `payment-dialog.svelte`

Planned as one `payment-flow.svelte.ts`; implemented as two, split along the seam the engine
already had. `drive-operation.ts` raises a `FundingNeed` mid-operation and calls the
`RequestFunding` seam; `createFundingRequester` decides what answers it — a resolved rail (surface
the payment screens and wait) or none (silent faucet transfer). `payment-dialog.svelte` owns the
screens and is rail-agnostic: it is handed a `PaymentRail` and never knows which one.

The pending request carries the need **and** its rail as one `PendingPayment` value, so the dialog
receives a rail it can rely on rather than an optional it would have to re-check.

Phases, as implemented:

```
                 ┌ no rail → faucet transfer, screens never open
FundingNeed ─────┤
                 └ rail → method → connecting → configure (chain/token/quote) →
                          switching → approving → relaying → resolve()
                          → back into the engine: swap → approve → topUp [→ increaseDepth]
```

- `connect`/chain-switch waits follow the attempt-guard rule
  (`.claude/rules/attempt-guard.md`): cancellable, `attempt.guard` on every await before a side
  effect.
- Everything from the moment the user signs the source-chain tx runs OUTSIDE the attempt guard
  (spend-must-record rule, with the standard comment) — the flow finishes even if the dialog
  unmounts; the drive record lands via the engine's reconcile.
- Steps map to progress labels: "Cross-swap xDAI on Relay" → "Swapping xDAI to BZZ" →
  "Extending lifespan" / "Increasing size". One card, label cycles (Figma `135:8159` pattern).
- Chain switching: request `wallet_switchEthereumChain` when the selected chain ≠ wallet chain;
  while pending, show the `138:20305` state (balance "–", spinner button).

### 3.5 Dialog rewiring

`drive-extend-dialog.svelte` / `drive-resize-dialog.svelte`: phases are
`'form' | 'pending' | 'error'` — three, not the four planned. "Payment" never became a dialog phase
because a pending funding request is already a distinct piece of state (`funding.pending`), and the
dialogs branch on it before their own phase. The form's Proceed runs the engine preflight + funds
check; a shortfall raises the payment screens (dialog-sized cards per Figma, not a popup); once
funds land the engine continues and the dialog shows `'pending'` → success/close or error.
Resume on open: engine chain-truth reconciliation first (engine spec §4.2.4).

## 4. Slippage & liquidity guardrails

On-chain BZZ liquidity on Gnosis is shallow (~$10k total; deepest pool ≈ $9k SushiSwap V3
BZZ/USDC). Therefore:

- Always quote before enabling Pay; refuse (with wording, not a revert) when the Sushi quote's
  price impact exceeds `MAX_PRICE_IMPACT = 5%`. **Done** — `quoteFunding` prices a small reference
  trade alongside the real one and compares the fills, since the pool exposes no spot oracle.
- Soft-cap suggested resize jumps in the size dropdown to keep single-swap BZZ amounts small.
  **Not done** — the dropdown offers every larger size. The 5% impact refusal catches the bad case
  after the fact, with wording, rather than the dropdown preventing it; whether that is enough is a
  design call, not a correctness one.
- The quote's USD total uses the rail's own pricing data; no separate price oracle. **Done** for
  Relay (`currencyIn.amountUsd`); the dev rail derives USD from the xDAI figure, xDAI being a
  dollar stablecoin.

## 5. Failure handling

| Failure point                            | State after                                                                 | Recovery                               |
| ---------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------- |
| Quote fails / no route                   | nothing spent                                                               | retry, other token/chain               |
| User rejects source tx                   | nothing spent                                                               | back to pay screen                     |
| Relay leg fails                          | per Relay SDK semantics (source funds refunded or held — surface SDK error) | Retry re-quotes; "View details"        |
| xDAI delivered, swap fails               | xDAI parked at owner                                                        | funds check consumes residual on retry |
| Swap done, approve/topUp fails           | BZZ parked at owner                                                         | same                                   |
| topUp done, increaseDepth fails (resize) | lifespan extended, size pending                                             | free retry — engine resume; see §6     |
| Anything after payment + dialog closed   | funds/state on chain                                                        | next dialog open reconciles + resumes  |

Never leave BZZ parked deliberately: the quote requests exactly what the operation needs (plus the
swap buffer, which lands as xDAI, not BZZ). Enforce fund-exact-spend-immediately — the funds check
must refuse to request more BZZ than the operation's cost.

## 6. #392 / design feedback — partial-failure copy

The designed "Lifespan decreased" modal (`481:14324` / `481:14846`, from
[#392](https://github.com/snaha/swarm-id/issues/392)) assumes the old dilute-first ordering. The
engine inverts the order (contract floor check — engine spec §2), so that state is unreachable.
The reachable partial state is: **payment succeeded, lifespan got longer, size increase pending,
retry is free**. Status:

1. **Done.** `runResize` throws a typed `SizeIncreasePendingError` when `increaseDepth` fails —
   which by then can only mean everything payable already landed — carrying the wording "Your
   payment went through and the drive's lifespan is longer. The size increase did not finish — try
   again to complete it. No additional payment is needed." Retry / Close structure kept.
2. **Done.** `DriveDialogStatus` gained a `tone`; this state renders as a neutral notice rather
   than a red warning, because a warning icon sends the user looking for damage that did not
   happen.
3. **Done by construction.** Nothing shrank, so the drive row needs no warning state; re-opening
   Increase size resumes from chain truth (`alreadyResized` / live remaining balance), skipping
   whatever already landed and asking for no second payment.
4. **Open:** no "Learn more" body describing the corrected sequence, and the Figma nodes still show
   the unreachable "Lifespan decreased" design — coordinate with design on #392.
5. **Open:** no e2e for the injected-failure path. The resume half is covered
   (`drive-onchain.test.ts` "an interrupted resize resumes from chain truth without paying twice");
   what is untested is the dialog presenting this specific copy.

## 7. Dev/testing

- **The payment leg is a swappable rail** (`ui/src/lib/payment/payment-rail.ts`), chosen by
  `resolvePaymentRail()`. Relay cannot be reproduced locally — it is an intent/solver network, so
  the quote comes from a hosted API and the delivery is an off-chain solver paying out on real
  Gnosis. Two local modes stand in:
  - **No rail** (no local source chain running): funding transfers the needed xDAI+BZZ straight
    from the chain's faucet (`fundLocalAccount` in `@swarm-id/multichain`'s dev.ts), the payment
    screens never open, and the orchestrator from the `gnosis` phase onward runs for real —
    headless-CI-safe, and what the drive e2e suites use.
  - **Local rail** (`pnpm dev:local`, which adds a bare anvil on chain 31337 and the solver that fills from it): the wallet signs a
    real deposit there, the faucet then plays solver and delivers the xDAI, and the real Sushi swap
    runs on top. This is what makes the `method → connect → configure → wallet-approval` half of
    §3.4 exercisable at all. The wallet needs no setup — the chain is offered to it through the
    `wallet_addEthereumChain` path already in the flow, and the rail funds whatever account
    connects, so no key is ever imported. It rehearses the UX only — Relay's pricing, routing, real
    step model (an ERC-20 source needs an approve before the deposit) and refund semantics stay
    untested, so a green local run must never be read as "the payment path works". See the README's
    "Paying for storage locally".
    Note the e2e consequence: which of the two modes is live depends on whether a source chain
    happens to be running, so a test that needs funding would behave differently on a developer's
    machine than in CI. Today no drive e2e is affected — their operations are covered by the batch
    owner's residual balances, so `requestFunding` is never called and no rail is ever resolved (both
    the `dev:local` and the bare-CI arrangement pass). A future test that does need funding should
    pin the mode rather than inherit it.
- **Open:** component tests (`*.ct.spec.ts`) for the payment screens — method → connect → configure
  transitions, quote rendering with the breakdown rows, chain-switch waiting state, error surface.
  A working injected-provider Playwright harness exists (it drove the manual verification of this
  flow end to end) but is not in the suite; it needs a source-chain reachability guard first.
- **Open:** e2e for resize with an injected `increaseDepth` failure → the §6 dialog → retry
  completes without new payment.
- **Open:** one production canary before release — a real small extend on mainnet against a
  throwaway batch (manual, documented in the PR). Nothing has yet exercised real Relay.

## 8. Out of scope

- Migrating **batch purchase** (add drive) off the fund.bzz.limo popup onto this flow — designed
  for later; this spec must keep `multichain-widget.ts` working for purchase.
- Fiat payment method (the method dropdown reserves the slot).
- Contributing `mode=topup` upstream to `ethersphere/multichain-widget` — worthwhile parallel
  track, tracked outside this spec.

## 9. Acceptance criteria

- [x] Extend and resize run fully in-app: one wallet signature on the source chain, no external
      popup, no Bee node.
- [x] Screens match the Figma nodes listed in §1 (structure and states; exact copy may be refined
      with design).
- [x] Quote shows source-token cost, USD total, and the xDAI/xBZZ breakdown; Pay is disabled on
      no-route or excessive price impact.
- [x] Payment wallet never signs anything on Gnosis; owner key never signs anything on the source
      chain — the rail's `execute` is the wallet's only signature, and the owner key is only ever
      passed to `@swarm-id/multichain` calls bound to Gnosis settings.
- [x] Every post-payment failure is recoverable: residual owner balances are detected and consumed
      on retry (`fundingShortfall`); interrupted flows resume after reload (engine spec §4.2.4).
- [x] Resize partial failure shows the corrected copy (§6) and retry completes without a second
      payment.
- [x] `pnpm check:all` clean; the drive e2e suite passes against the local chain.

Open:

- The rail has never been exercised against **real Relay** — no production canary yet (§7's last
  bullet). Everything proven locally is proven against the dev rail, whose prices are invented and
  whose step list is shorter than Relay's. This is the single largest untested surface.
- No e2e for the §6 copy, and no Figma update for it (§6.4, §6.5).
- The size dropdown has no soft cap (§4).
