# Postage On-Chain Engine — Spec

Status: **implemented** — see §10 for what is verified and what is still open. The design sections
below are kept as the record of why the engine is shaped the way it is; where the code has since
moved on, the text has been corrected rather than left as the original proposal.
Related issues: [#309](https://github.com/snaha/swarm-id/issues/309) (top up / dilute checkboxes),
[#392](https://github.com/snaha/swarm-id/issues/392) (resize partial failure),
[#463](https://github.com/snaha/swarm-id/issues/463) (partition-state reaction to dilute — out of
scope here, see §9).
Companion spec: [Drive-Payment-Flow.md](Drive-Payment-Flow.md) (how BZZ/xDAI reach the owner
address; consumes this spec's API).

## 1. Goal

Make drive **extend** (lifespan top-up) and **resize** (depth increase + compensating top-up) work
**without a Bee node owning the batch**, by building, signing, and submitting Gnosis Chain
transactions directly from `ui/`, signed with the derived batch-owner key the UI already holds.

Today `ui/src/lib/payment/bee.ts` calls the Bee node's `topUpBatch`/`diluteBatch`, which only work
when the _node_ owns the batch. Production batches are owned by the account's derived postage
signer (`derivePostageSigner`, `ui/src/lib/payment/purchase.ts`), so those calls can never work in
production.

## 2. On-chain ground truth (verified 2026-07-31)

PostageStamp contract on Gnosis: `0x45a1502382541Cd610CC9068e88727426b696293` (Sourcify-verified,
byte-identical to `ethersphere/storage-incentives` master `src/PostageStamp.sol`). The lib already
reads it (`lib/src/utils/postage-contract.ts`).

| Fact                                                                                                                                                                                                                                                                                                                                                                                           | Consequence                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `topUp(bytes32 batchId, uint256 topupAmountPerChunk)` — selector `0xb67644b9` — is **permissionless**. Pulls BZZ via `transferFrom(msg.sender)`; total pulled = `amountPerChunk << depth`. Reverts: `BatchDoesNotExist`, `BatchExpired`, `BatchTooSmall` (depth ≤ 16, never for product batches), `InsufficientBalance` (resulting per-chunk balance below minimum), `TransferFailed`, paused. | Caller needs BZZ + a prior ERC-20 `approve` to the PostageStamp contract, plus xDAI gas. We sign with the owner key (it must sign resize anyway).                               |
| `increaseDepth(bytes32 batchId, uint8 newDepth)` — selector `0x47aab79b` — is **owner-only** (`NotBatchOwner` unless `msg.sender == batch.owner`). Transfers **no** tokens. No meta-tx support. Reverts: `NotBatchOwner`, `DepthNotIncreasing`, `BatchExpired`, `InsufficientBalance`, paused.                                                                                                 | The derived owner key MUST be `msg.sender`; it needs xDAI for gas. Nothing else can ever dilute.                                                                                |
| `increaseDepth` requires `remainingBalance(batchId) / 2^Δdepth >= minimumInitialBalancePerChunk()` and checks it **before** any compensation. `minimumInitialBalancePerChunk = minimumValidityBlocks() × lastPrice()` (~24h of storage; mainnet 2026-07-31: `17280 × 68891 = 1,190,436,480` PLUR — read live, never hardcode).                                                                 | **The compensating top-up must run FIRST, then `increaseDepth`.** The existing dilute-then-top-up order in `purchase.ts` reverts on-chain in the common keep-lifespan case.     |
| `remainingBalance` = `batch.normalisedBalance − currentTotalOutPayment()` (live, ages every block).                                                                                                                                                                                                                                                                                            | All planning math MUST use the **live** remaining balance from chain, never the stored `stamp.amount` snapshot.                                                                 |
| `topUp` on an expired batch reverts `BatchExpired`; expired batches are deleted permanently by `expireLimited`.                                                                                                                                                                                                                                                                                | Preflight expiry from chain before requesting any payment.                                                                                                                      |
| `immutableFlag` is **not enforced** by the contract on either op. Widget-created product batches are mutable (`immutable: false`).                                                                                                                                                                                                                                                             | Chain-side no constraint. UI policy: extend allowed regardless; resize UI-blocked when `stamp.immutableFlag` (Bee-node semantics of diluting an immutable batch are undefined). |
| BZZ on Gnosis: `0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da`, **16 decimals** (1 BZZ = 1e16 PLUR). Proxy to PermittableToken (EIP-2612 permit exists — not used here).                                                                                                                                                                                                                          | Standard ERC-20 `approve` + `balanceOf` + `allowance` fragments needed.                                                                                                         |
| Gas: topUp ~340–580k, increaseDepth ~590k (single sample; varies with its internal `expireLimited(max)` sweep). Gnosis gas 0.07–1.25 gwei → each op well under $0.001.                                                                                                                                                                                                                         | Budget `gasLimit: 1_200_000` per tx (mirrors the multichain widget's proven setting); fee data from the provider.                                                               |
| Contract is Pausable (`whenNotPaused` on both ops); `paused()` selector `0x5c975abb` (verify in a unit test).                                                                                                                                                                                                                                                                                  | Preflight `paused()`; friendly error.                                                                                                                                           |
| Batch IDs are `keccak256(msg.sender, nonce)` of the _creator_ (the widget's temp wallet), not the owner.                                                                                                                                                                                                                                                                                       | Never derive a batchId; always carry `stamp.batchID`.                                                                                                                           |

Local dev — **superseded**. This spec was written against the old DEX-less anvil chain (id `4020`,
its own PostageStamp and a BZZ TestToken), which has since been retired. There is now **one** local
chain: the hybrid snapshot baked into `vendor/bee-compose` — mainnet's BZZ token and SushiSwap
pools with the Swarm contracts deployed on top **at their mainnet addresses**, answering as chain
`100`. So every address in the table above is the address used locally too, which is what makes the
local runs worth anything. It is reached at `http://localhost:9545` (the Bee cluster's chain) or
`http://localhost:8545` (the same snapshot standalone), and funded from a baked dev faucet rather
than a queen EOA. See `vendor/bee-compose/blockchain/HYBRID-CHAIN.md` and the README's
"Paying for storage locally".

## 3. Architecture

The on-chain machinery lives in the in-repo **`@swarm-id/multichain`** package (`multichain/`),
vendored and extended from `@upcoming/multichain-library` per the conclusion on #309 — see
`multichain/README.md` for provenance and the changes made. It already provides: `topUpBatch`,
`increaseDepth`, `createBatch`, `approveBzz`/`getBzzAllowance`, BZZ/native balances and transfers,
batch reads (`getPostageBatch`, `getRemainingBalance`, `getPostageWriteConstraints`), receipt and
balance waiters, the SushiSwap V3 leg, and chain-injectable settings — now a single preset,
`gnosisMainnetSettings()`, since the local chain carries the mainnet deployments (the
`localAnvilSettings()` this spec first proposed went with the 4020 chain). Plus local dev helpers
(`src/dev.ts`) and the local solver (`src/local-solver.ts`, companion spec §7). Selector-pinning
unit tests and a fork suite (`pnpm test:fork`: fund → swap → create → topUp → increaseDepth →
non-owner revert) exist in the package.

`lib/` stays as-is (its raw `eth_call` reads remain the UI's display path). `ui/`'s job is
orchestration only. The owner key bridges from bee-js via `prefix0x(signerKey.toHex())` →
the package's `originPrivateKey` inputs (bee-js `PrivateKey.sign()` is hardcoded EIP-191 and
cannot sign transactions, but `toHex()` exports the raw 32 bytes).

### 3.1 `ui/src/lib/payment/postage-onchain.ts` — orchestration over `@swarm-id/multichain` (new)

Constructs a `MultichainClient` from the network settings. One preset (`gnosisMainnetSettings()`)
now serves both mainnet and the local hybrid chain, because the local chain carries the mainnet
deployments; what differs is the RPC list. As implemented:

```ts
export function chainIdentity(rpcUrl?): Promise<ChainIdentity> // { chainId, isMainnet }
export function postageChain(rpcUrl?): Promise<MultichainClient>
export function ownerFunds(address, client?): Promise<OwnerFunds> // { xdai, bzz }
export function fundingShortfall(address, bzzPlur, client?): Promise<OwnerFunds>
export function ensureBzzAllowance(signerKey, totalPlur, client?): Promise<void>
// skip when getBzzAllowance >= totalPlur; else approveBzz EXACTLY totalPlur + wait
export function topUpOnChain(signerKey, stamp, amountPerChunk, client?): Promise<void>
export function increaseDepthOnChain(signerKey, stamp, newDepth, client?): Promise<void>
export function preflightExtend(stamp, client?): Promise<PostagePreflight>
export function preflightResize(
  stamp,
  signerKey,
  newDepth,
  client?,
): Promise<PostagePreflight & { alreadyResized: boolean }>
export function reconcileStampFromChain(account, stamp, client?): Promise<boolean>
// read chain state; patch {depth, amount, batchTTL} via account.updateStamp.
// Returns false when the chain could not answer — the record is left untouched.
```

Rules:

- Before ANY signature, assert the chain id is `100`; `settingsFor` throws otherwise. **Chain id is
  not enough to tell the local chain from mainnet** — it reports `100` on purpose so that an app
  resolving addresses by chain id finds what it expects. `chainIdentity()` distinguishes them by
  **genesis hash**, and an endpoint that is not mainnet never falls back to the public RPCs, so a
  failed call cannot silently read or write real mainnet.
- Every wait wraps in `withTimeout` (`lib/src/utils/promise.ts`) — surface a "still pending"
  state on timeout; `reconcileStampFromChain` on next dialog open resolves it. Never
  `Promise.race`.
- Preflights assemble from `getPostageBatch` + `getPostageWriteConstraints` and map every possible
  revert to a typed error BEFORE spending gas: batch not found / expired / paused / not owner /
  floor not cleared / insufficient funds at owner address.
- Transactions run sequentially from the owner key (the package resolves pending-block nonces).

### 3.2 `ui/src/lib/payment/purchase.ts` — planner changes

Replace `dilutedStamp()` (for the product path) with an **inverted-order** planner. Done —
`dilutedStamp()` is deleted; nothing referenced it once the dialogs moved over.

```ts
export interface ResizePlan {
  /** Per-chunk PLUR to top up at the OLD depth, BEFORE increaseDepth. */
  topUpAmount: bigint
  /** Record patch once the top-up lands (depth unchanged; amount/TTL grown). */
  afterTopUp: StampUpdate
  /** Final record patch once increaseDepth lands. */
  afterDilute: StampUpdate
}
export function resizePlan(
  liveRemainingPerChunk: bigint, // from chain, NOT stamp.amount
  currentDepth: number,
  newDepth: number,
  keepLifespan: boolean,
  minimumInitialBalancePerChunk: bigint,
  lastPrice: bigint,
): ResizePlan
```

Math (`Δ = newDepth − currentDepth`, `factor = 2^Δ`, `R = liveRemainingPerChunk`):

- keepLifespan: `topUpAmount = R × (factor − 1)`, so the post-dilution per-chunk balance returns to
  `R` and the TTL is preserved. Total BZZ = `topUpAmount << currentDepth`
  (= `R × (2^newDepth − 2^currentDepth)` PLUR) — identical total cost to the old ordering, so
  existing cost-estimate maths carry over.
- not keepLifespan: `topUpAmount = 0`; TTL divides by `factor`.
- **Floor clamp**: `increaseDepth` requires `(R + topUpAmount) / factor >= minimum`. If the
  projection misses it, raise `topUpAmount` to the shortfall and mark the plan so the dialog can
  say "resizing requires topping up to at least ~1 day of lifespan". If the user declines the
  clamped amount, the resize is impossible — say so, never send a known revert.

Unit-test targets: cost parity with the old plan, floor clamps, keepLifespan on/off, and
integer-dust rounding. (Calldata selector pinning — `b67644b9` / `47aab79b` — already exists in
`@swarm-id/multichain`'s `abi.test.ts`.)

## 4. Flows

Fund delivery (how BZZ/xDAI arrive at the owner address) is the companion spec's job. This spec's
flows begin with a funds check and end with a recorded stamp.

### 4.1 Extend = approve + topUp

1. Form math unchanged: `topUpAmount = stampAmountForSeconds(price, addedSeconds)`. Price now comes
   from the contract's `lastPrice` (via `fetchPostageWriteConstraints`) instead of the Bee
   `/chainstate`; keep the 60s cache pattern of `chain-price.ts`.
2. `preflightExtend`: batch exists, not expired, not paused. (Ownership is irrelevant — topUp is
   permissionless — but we sign with the owner key anyway.)
3. Funds check: need `topUpAmount << depth` PLUR of BZZ + gas at the owner address. Short → hand
   off to the payment flow (companion spec), then re-check.
4. Execute (deliberately OUTSIDE the attempt guard, same rationale as today — an on-chain spend's
   record must land even if the dialog closes): `ensureBzzAllowance` → `topUpOnChain` →
   `reconcileStampFromChain` (fallback: the existing projected `extendedStamp` patch if the read
   fails).

### 4.2 Resize = approve + topUp FIRST, then increaseDepth

1. `preflightResize`: chain state read; `batch.owner === ownerAddress` (hard requirement — clear
   "this drive is owned by a different key" error for imported foreign batches); not expired; not
   paused; `newDepth > depth`; floor cleared by the plan; `stamp.immutableFlag === false`.
2. Funds check as above (BZZ only needed when `topUpAmount > 0`).
3. Execute (unguarded spend section):
   a. If the top-up hasn't landed yet: `ensureBzzAllowance` → `topUpOnChain(topUpAmount)` →
   `account.updateStamp(batchID, plan.afterTopUp)`. The money is now on-chain; the record must
   reflect it even if step b fails.
   b. `increaseDepthOnChain(newDepth)` → `reconcileStampFromChain` (fallback `plan.afterDilute`).
4. **Resume is chain-truth, not component state** (this closes #392's stuck-state class): on dialog
   open and before every retry, read the chain. If on-chain `depth` already equals the target, the
   increase landed in a lost session — record it and finish. If the live remaining balance already
   covers the plan (top-up landed, increase didn't), skip to step b. Never trust a component-local
   `committedPlan` alone.

**Partial-failure semantics under the new ordering (feed back to #392 / design):** the failure
state "size grew but lifespan silently dropped" (Figma "Lifespan decreased", nodes `481:14324` /
`481:14846`) **cannot occur** — the order is inverted precisely because the contract checks the
floor before compensation. The reachable partial state is the benign inverse: _payment succeeded
and the lifespan got longer; only the (free, gas-dust) depth increase is pending._ The retry dialog
copy must say that: "Your payment went through and extended the drive's lifespan. The size increase
is still pending — retry to finish it (no additional payment)." Update the Figma copy accordingly.

### 4.3 Error taxonomy → user wording

| Condition                     | Wording direction                                                  |
| ----------------------------- | ------------------------------------------------------------------ |
| `BatchExpired` / not found    | "This drive has expired and can no longer be extended."            |
| Floor (`InsufficientBalance`) | Explain the ~1-day minimum; show the clamped amount.               |
| `NotBatchOwner`               | "This drive is owned by a different key" (imported foreign batch). |
| `paused()`                    | "Swarm's payment contract is temporarily paused. Try again later." |
| Confirmation timeout          | "Still pending" — resolved by reconciliation on next open.         |
| Insufficient owner funds      | Hand off to payment flow (companion spec).                         |

## 5. Recording & sync

Every record patch flows through `account.updateStamp` (LWW `updatedAt` clock; re-anchors the TTL
measurement instant). Prefer chain truth (`reconcileStampFromChain`) after each confirmation;
projected plan patches are the fallback so an RPC blip after a confirmed tx still lands a record.

The runtime `Stamper` needs no explicit rebuild: `postage-stamps.svelte.ts`'s `getStamper()`
constructs one per call from the stored `stamp.depth`, so there is no cached instance to go stale.
**Still open:** a regression test pinning that, so a future cache cannot reintroduce the bug
silently.

## 6. Security

- No new key-exposure class: the owner key already lives client-side and signs stamps. The hex key
  is passed function-scoped into `@swarm-id/multichain` calls; it is never persisted anywhere new
  and never leaves the origin.
- Exact-amount approvals to the fixed PostageStamp address only. No unlimited allowances.
- Assert the chain id is 100 before any signature. Addresses are the mainnet ones on both chains,
  so the safety property is not "which addresses" but "which endpoint": a non-mainnet chain never
  falls back to the public RPC list, so a failed local call cannot silently reach real mainnet.
- A hostile user-configured `gnosisRpcUrl` can lie about state and censor txs but cannot alter
  calldata, redirect approvals, or extract the key. Same trust level as today's TTL reads.

## 7. Dev tooling & tests

Chain-level helpers live in `@swarm-id/multichain`'s `src/dev.ts` — `fundLocalAccount` (transfers
xDAI/BZZ from the chain's baked faucet) and `simulateWidgetPurchase` (a throwaway payer swaps,
approves and creates the batch owned by the derived signer, mirroring production's role split).
`ui/src/lib/dev/chain-funding.ts` wraps them; the actions are on the /dev **Chain** tab (the Stamps
tab this spec named no longer exists — the node-stamp workflow was dropped):

- **Fund postage signer** → `fundPostageSigner`, and a faucet panel showing what is left to give.
- **Create owned batch** → `createOwnedBatchOnChain`.
- Funding during a real dialog flow no longer needs a toggle. It follows the chain and the
  environment: see the companion spec §7 for the rail seam that decides between paying through the
  local solver and a silent faucet transfer.

Tests:

- Vitest units: `resizePlan` (parity, clamps, dust) in `purchase.test.ts`; funding maths in
  `funding.test.ts`. The package's own unit + fork suites cover the chain calls
  (`pnpm --filter @swarm-id/multichain test`, `pnpm test:fork`).
- Playwright e2e, `ui/tests/drive-onchain.test.ts`, skipped automatically when no chain answers —
  three tests: extend grows the on-chain balance and the recorded TTL; resize keeps the lifespan by
  topping up before increasing depth; an interrupted resize resumes from chain truth without paying
  twice.

## 8. Existing code disposition

- `ui/src/lib/payment/bee.ts` `topUpStamp`/`diluteStamp`: **deleted**, not kept. Once the product
  dialogs stopped importing them nothing else did — the /dev node-stamp workflow they were retained
  for was dropped in the same period. `bee.ts` now only validates a batch by uploading a probe SOC.
- `ui/src/lib/payment/chain-price.ts`: **done** — reads the contract's `lastPrice` via
  `getPostageWriteConstraints`, with the 60s cache kept.
- `bee.ts`'s `Promise.race` + deprecated `rejectAfter`: **done** — migrated to `withTimeout`.

## 9. Out of scope

- Fund delivery UX (companion spec [Drive-Payment-Flow.md](Drive-Payment-Flow.md)).
- Partition/utilization reaction to depth changes — capacity accounting, the depth-31→32 counter
  codec crossing, IndexedDB invalidation, multi-device skew: tracked in
  [#463](https://github.com/snaha/swarm-id/issues/463). This spec only rebuilds the stamper.
- Batch purchase (add drive) migration off the widget popup.
- Relayed/gasless variants (EIP-2612 permit, EIP-7702, 4337) — unnecessary at <$0.001/op.

## 10. Acceptance criteria

- [x] Extend and resize complete end-to-end on the local chain with NO Bee node involvement —
      `drive-onchain.test.ts`, three passing tests against the hybrid chain.
- [x] Resize executes top-up **before** `increaseDepth`; the planner computes from live
      `remainingBalance` (`preflightExtend` reads `getRemainingBalance`, never `stamp.amount`);
      floor clamp and known-revert refusals in `resizePlan` / `preflightResize`.
- [x] Interrupted resize resumes from chain truth after a full page reload — `alreadyResized` off
      `preflightResize`, covered by the third e2e test.
- [x] All record updates flow through `account.updateStamp`; `reconcileStampFromChain` runs after
      each confirmation and leaves the record untouched when the chain cannot answer.
- [x] Immutable batches: extend allowed, resize blocked (`preflightResize` throws on
      `immutableFlag`).
- [x] Unit + e2e suites pass; `pnpm check:all` clean.

Open, and deliberately not closed by this spec:

- No regression test pinning that the runtime `Stamper` follows a depth change (§5).
- The #392 partial-failure **copy** is unwritten — the resize dialog surfaces the raw error and a
  generic retry rather than the "size increase pending, no additional payment needed" wording §4.2
  calls for. The underlying behaviour is correct and retry is free; only the words are missing.
  Tracked as the companion spec's §6.
