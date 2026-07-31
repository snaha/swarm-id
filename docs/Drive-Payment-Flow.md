# Drive Payment Flow (in-app, multichain) — Spec

Status: ready for implementation. Depends on
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
Token lists come from Relay's chain/currency metadata. Paying from Gnosis itself still goes through
the same Relay quote (Relay handles same-chain swaps) — one code path.

## 3. Modules

### 3.1 `ui/src/lib/payment/quote.ts`

The quoting pipeline, pure functions + one Relay call, cached briefly like `chain-price.ts`:

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

### 3.2 `ui/src/lib/payment/relay.ts`

Thin wrapper over `@relayprotocol/relay-sdk`: client singleton, `executePayment(quote, wallet,
onProgress)` mapping SDK progress callbacks onto our step model. All awaits wrapped in
`withTimeout` with generous bounds; Relay delivery is minutes-scale worst case. On failure surface
the SDK error verbatim behind "View details" (Figma `135:9633`); Relay-level refund semantics are
the SDK's own — consult its error surface during implementation, do not guess.

### 3.3 Swap leg

Provided by `@swarm-id/multichain`: `swapXdaiToBzz({ originPrivateKey, amountXdai, recipient })` —
exact-input xDAI→BZZ with a 0.5% slippage bound and 10-minute deadline (the exact-input shape is
deliberate: quote exact-output to SIZE the xDAI, execute exact-input, then top up with the PLUR
that actually arrived — slight over-delivery becomes slightly longer lifespan, never stranded
BZZ beyond `< 2^depth` PLUR dust). Wrap the wait in `withTimeout` in the orchestrator.

### 3.4 `ui/src/lib/payment/payment-flow.svelte.ts` (orchestrator)

State machine consumed by the dialogs. Phases:

```
method → connect → configure (chain/token/quote) → wallet-approval →
relay (cross-chain) → gnosis (swap → approve → topUp [→ increaseDepth]) →
success | failure
```

- `connect`/`wallet-approval`/chain-switch waits follow the attempt-guard rule
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

`drive-extend-dialog.svelte` / `drive-resize-dialog.svelte`: phases become
`'form' | 'payment' | 'pending' | 'error'`. The form's Proceed runs the engine preflight + funds
check; short funds → `'payment'` (embed the payment screens per Figma — they are dialog-sized
cards, not a popup); once funds land → `'pending'` (engine execution) → success/close or error.
Resume on open: engine chain-truth reconciliation first (engine spec §4.2.4).

## 4. Slippage & liquidity guardrails

On-chain BZZ liquidity on Gnosis is shallow (~$10k total; deepest pool ≈ $9k SushiSwap V3
BZZ/USDC). Therefore:

- Always quote before enabling Pay; refuse (with wording, not a revert) when the Sushi quote's
  price impact exceeds `MAX_PRICE_IMPACT = 5%`.
- Soft-cap suggested resize jumps in the size dropdown to keep single-swap BZZ amounts small;
  surface the estimated BZZ prominently.
- The quote's USD total uses Relay's pricing data; no separate price oracle.

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
retry is free**. Required actions:

1. Replace the modal copy: headline like "Size increase pending", body "Your payment went through
   and extended the drive's lifespan. The size increase didn't complete — retry to finish it. No
   additional payment is needed." Keep Retry / Close + Learn more structure.
2. The "Learn more" body must describe the corrected sequence (top-up first, then resize).
3. After Close, the drive row needs no warning state (nothing was lost and nothing shrank), but
   re-opening Increase size must detect the half-done state and offer to finish (engine resume
   handles detection; the dialog pre-selects the pending target size and skips payment).
4. Coordinate with design (issue comment on #392) to update the Figma nodes.

## 7. Dev/testing

- **Mock payment** dev toggle (extends the existing `dev-settings.svelte.ts` mock-purchase
  pattern): skips wallet-connect/Relay entirely and transfers the quoted xDAI+BZZ from the queen
  account (`fundLocalAccount` in `@swarm-id/multichain`'s dev.ts) — the whole orchestrator from
  the `gnosis` phase onward
  runs for real against bee-compose anvil, headless-CI-safe.
- Component tests (`*.ct.spec.ts`) for the payment screens: method → connect → configure state
  transitions, quote rendering with the breakdown rows, chain-switch waiting state, error surface.
- Playwright e2e with mock payment: extend end-to-end; resize end-to-end; resize with injected
  increaseDepth failure → corrected partial-failure dialog → retry completes without new payment.
- One production canary before release: a real small extend on mainnet against a throwaway batch
  (manual, documented in the PR).

## 8. Out of scope

- Migrating **batch purchase** (add drive) off the fund.bzz.limo popup onto this flow — designed
  for later; this spec must keep `multichain-widget.ts` working for purchase.
- Fiat payment method (the method dropdown reserves the slot).
- Contributing `mode=topup` upstream to `ethersphere/multichain-widget` — worthwhile parallel
  track, tracked outside this spec.

## 9. Acceptance criteria

- [ ] Extend and resize run fully in-app: one wallet signature on the source chain, no external
      popup, no Bee node.
- [ ] Screens match the Figma nodes listed in §1 (structure and states; exact copy may be refined
      with design).
- [ ] Quote shows source-token cost, USD total, and the xDAI/xBZZ breakdown; Pay is disabled on
      no-route or excessive price impact.
- [ ] Payment wallet never signs anything on Gnosis; owner key never signs anything on the source
      chain.
- [ ] Every post-payment failure is recoverable: residual owner balances are detected and consumed
      on retry; interrupted flows resume after reload.
- [ ] Resize partial failure shows the corrected copy (§6) and retry completes without a second
      payment.
- [ ] Mock-payment e2e suite passes on bee-compose anvil; `pnpm check:all` clean.
