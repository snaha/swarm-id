# Postage on-chain engine — buying, extending and resizing a drive without a Bee node

Status: **implemented.** How the BZZ and xDAI this engine spends reach the owner address is a
separate document, [`Drive-Payment-Flow.md`](./Drive-Payment-Flow.md).

## What it is

Drive **buy** (create a batch), **extend** (lifespan top-up) and **resize** (depth increase plus a
compensating top-up) are executed as Gnosis Chain transactions built, signed and submitted from
`ui/`, using the derived batch-owner key the UI already holds. No Bee node is involved — and none
could be: a node's `topUpBatch`/`diluteBatch` act only on batches the _node_ owns, while product
batches are owned by the account's derived postage signer (`derivePostageSigner`,
`ui/src/lib/payment/purchase.ts`).

## Position in the stack

```
  ui/src/lib/payment/drive-operation.ts    runPurchase / runExtend / runResize / resumePending
        │                                  (raises FundingNeed → Drive-Payment-Flow.md)
        ├── purchase.ts        resizePlan — how much to top up, at which depth
        ├── chain.ts           chain identity, MultichainClient construction, owner balances
        ├── postage-onchain.ts preflights, funds, bundled writes, batch-id planning, reconcile
        │        │
        │        └──▶ @swarm-id/multichain   ABI, signing, waiters, EIP-7702 bundling, SushiSwap
        │                                    (multichain/, vendored from @upcoming/multichain-library)
        ├── operation-journal.svelte.ts      what this device is part-way through paying for
        └── account.updateStamp              the recorded drive state (LWW, see Account-State.md)
```

`lib/` gained one thing: `withTimeout`/`TimeoutError` are re-exported from its index, since every
bounded wait in this engine goes through them. Its raw `eth_call` reads remain the UI's display path.

The owner key crosses from bee-js into the multichain package as raw hex —
`prefix0x(signerKey.toHex())` into `originPrivateKey`. bee-js's `PrivateKey.sign()` is hardcoded to
EIP-191 and cannot sign transactions, but `toHex()` exports the 32 bytes.

## On-chain ground truth

Verified 2026-07-31 against PostageStamp `0x45a1502382541Cd610CC9068e88727426b696293` on Gnosis
(Sourcify-verified, byte-identical to `ethersphere/storage-incentives` master `src/PostageStamp.sol`).

| Fact                                                                                                                            | Consequence                                                         |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `topUp(bytes32,uint256)` — `0xb67644b9` — is permissionless; pulls `amountPerChunk << depth` BZZ via `transferFrom(msg.sender)` | Caller needs BZZ, a prior `approve`, and xDAI gas                   |
| `increaseDepth(bytes32,uint8)` — `0x47aab79b` — is owner-only, transfers no tokens, has no meta-tx support                      | The derived owner key MUST be `msg.sender`; nothing else can dilute |
| `remainingBalance = batch.normalisedBalance − currentTotalOutPayment()`, ages every block                                       | Planning math uses the live chain figure, never `stamp.amount`      |
| `topUp` on an expired batch reverts `BatchExpired`; expired batches are deleted by `expireLimited`                              | Preflight expiry before requesting payment                          |
| `immutableFlag` is not enforced by the contract on either op                                                                    | Chain imposes nothing; the UI blocks resize on immutable batches    |
| Both ops are `whenNotPaused`; `paused()` is `0x5c975abb`                                                                        | Preflight `paused()` and report it in words                         |
| Batch IDs are `keccak256(creator, nonce)` — the creator, not the owner                                                          | Never derive a batchId; carry `stamp.batchID`                       |
| BZZ is `0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da`, **16 decimals** (1 BZZ = 1e16 PLUR)                                        | Standard ERC-20 fragments; watch the decimals                       |

Gas is negligible: at Gnosis's 0.07–1.25 gwei each operation costs well under $0.001, and a full
bundled resize is ~420k.

The same addresses are used locally. `@snaha/bee-compose` ships a hybrid snapshot — mainnet's BZZ
token and SushiSwap pools with the Swarm contracts deployed on top at their mainnet addresses,
answering as chain `100` on `http://localhost:9545`. See
[HYBRID-CHAIN.md](https://github.com/snaha/bee-compose/blob/main/blockchain/HYBRID-CHAIN.md).

### The ordering rule

`increaseDepth` requires `remainingBalance(batchId) / 2^Δdepth >= minimumInitialBalancePerChunk()`
and checks it **before** any compensation, where
`minimumInitialBalancePerChunk = minimumValidityBlocks() × lastPrice()` — about 24h of storage
(mainnet 2026-07-31: `17280 × 68891 = 1,190,436,480` PLUR; read live, never hardcode).

**So the compensating top-up runs first, then `increaseDepth`.** Diluting first reverts on-chain in
the common keep-lifespan case. This holds for the bundled path too — atomicity does not relax the
contract's check, so a bundle that dilutes first reverts exactly as the sequential version does.

## `resizePlan` — `ui/src/lib/payment/purchase.ts`

A pure function of the depths, the keep-lifespan choice, and three figures read from the chain — the
live remaining per-chunk balance (**never** `stamp.amount`, a snapshot that would over- or
under-top), the contract's minimum per-chunk balance, and its last price. It returns the per-chunk
`topUpAmount`, whether the floor forced it up, and the record patch to apply once the resize lands.

With `Δ = newDepth − currentDepth`, `factor = 2^Δ` and `R` the live remaining per chunk:

- **keepLifespan**: `topUpAmount = R × (factor − 1)`, so the post-dilution per-chunk balance returns
  to `R` and the TTL is preserved. Total BZZ = `topUpAmount << currentDepth`, which is
  `R × (2^newDepth − 2^currentDepth)` PLUR — the same total as the old dilute-first ordering, so
  existing cost estimates carry over unchanged.
- **not keepLifespan**: `topUpAmount = 0`; the TTL divides by `factor`.
- **Floor clamp**: if `(R + topUpAmount) / factor` still misses the minimum, `topUpAmount` is raised
  to the shortfall and the plan is marked, so the dialog can say that resizing requires topping up
  to at least ~1 day of lifespan. A user who declines the clamped amount cannot resize; the engine
  says so rather than sending a known revert.

## Chain access — `chain.ts` and `postage-onchain.ts`

`chain.ts` answers two questions and nothing else: **which chain is this** (`chainIdentity` →
`{ chainId, kind }`, where `kind` is `mainnet | dev | unsupported` — three answers, not a boolean,
because "dev" is what tells a page that spending is free and so has to be proven rather than
inferred), and **what does the owner address hold** (`ownerFunds`, which takes the client rather than
resolving one: a balance means nothing without the chain it was read from). `postageChain` builds and
caches the `MultichainClient` per endpoint.

`postage-onchain.ts` is the only module that spends. It offers, over `@swarm-id/multichain`:

- **A preflight before each operation**, assembling `getPostageBatch` + `getPostageWriteConstraints`
  and mapping every reachable revert to a user-worded error _before_ gas is spent: chain cannot
  bundle, batch missing, expired, paused, not owner, immutable, floor not cleared. Constraints are
  read here, uncached — a plan priced off a stale minimum is a planned revert.
- **A funding shortfall**, which nets what the owner address already holds against what the operation
  needs (BZZ, plus a gas budget sized from the live gas price), so residual balances left by an
  earlier interrupted attempt are consumed before anyone is asked to pay again.
- **One bundled write per operation** — `bundledCreate`, `bundledExtend`, `bundledResize` — each an
  atomic EIP-7702 transaction that approves **exactly** the BZZ it will pull and then spends it.
  There is no separate-transactions path: `assertBundlingSupported` throws in preflight when the
  chain has no delegate, so the operation is refused before anything is charged.
- **A precomputed batch id** for a purchase (`planBatchCreation` / `deriveBatchId`), which is what
  makes journalling before the send possible — see [Buying is journalled first](#buying-is-journalled-first).
- **`reconcileStampFromChain`**, which patches `{depth, amount, batchTTL}` through
  `account.updateStamp` and returns false — leaving the record untouched — when the chain cannot
  answer, so the caller can fall back to its projection.

Rules that hold across all of it:

- **Assert chain 100 before any signature** (`settingsFor` throws otherwise). Chain id alone cannot
  tell the local chain from mainnet — it reports `100` deliberately, so that an app resolving
  addresses by chain id finds what it expects. `chainIdentity()` separates them by **genesis hash**,
  and an endpoint that is not mainnet never falls back to the public RPCs, so a failed local call
  cannot silently read or write real mainnet.
- Every wait wraps in `withTimeout` (`lib/src/utils/promise.ts`), never `Promise.race`. A timeout
  surfaces as "still pending"; the chain read on the next Proceed is what resolves it.
- Transactions are sent from the owner key against the **pending** nonce, so a second operation
  started before the first is mined does not collide with it.

## Flows

Every flow begins with a funds check and ends with a recorded stamp, and every one of them spends in
a **single atomic transaction**. A chain without the EIP-7702 delegate is refused in preflight, not
served more slowly: there is no one-at-a-time path to fall back to.

**Buy** — `approve → createBatch`:

1. An unfinished purchase this device already paid for is adopted instead — see
   [Buying is journalled first](#buying-is-journalled-first). Otherwise: the chain must bundle and
   the contract must not be paused.
2. Price the requested lifespan at `constraints.lastPrice`, raised to
   `minimumInitialBalancePerChunk` when it falls under the contract's ~24h floor — a shorter one is a
   certain revert, not a cheaper drive.
3. Funds check, then journal the precomputed id, then `bundledCreate`. The buyer is creator _and_
   owner, so nothing has to be handed across afterwards and no dust is left behind — the difference
   from the fund.bzz.limo widget, which has no persistent key and must create from a throwaway one.
4. Read the batch back from chain truth and record it; the journal entry is cleared only then.

**Extend** — `approve → topUp`:

1. `preflightExtend`: batch exists, not expired, not paused, and the chain can bundle. Ownership is
   irrelevant here — `topUp` is permissionless — but the owner key signs anyway. It returns the write
   constraints it read, uncached, and `constraints.lastPrice` is what prices the top-up
   (`stampAmountForSeconds`) — not the Bee `/chainstate`, and not the 60s-cached
   `currentChainPrice`, which exists only so the dialogs can show an estimate before committing.
2. Funds check: `topUpAmount << depth` PLUR of BZZ plus gas at the owner address. A shortfall hands
   off to the payment flow, then re-checks.
3. `bundledExtend` — approve and top up in one transaction — then `reconcileStampFromChain`, falling
   back to the projected `extendedStamp` patch if the read fails.

**Resize** — `approve → topUp → increaseDepth`:

1. `preflightResize`: `batch.owner === ownerAddress` (a hard requirement — imported foreign batches
   get a clear "owned by a different key" error), not expired, not paused, `newDepth > depth`, floor
   cleared by the plan, `stamp.immutableFlag === false`.
2. Funds check as above. BZZ is only needed when `topUpAmount > 0`, but gas always is — a resize that
   drops the lifespan still sends a transaction the owner address has to pay for.
3. `bundledResize` — approve, top up and increase the depth in one transaction, in that order — then
   `reconcileStampFromChain`, falling back to `afterDilute`. There is no intermediate record to
   write, because there is no intermediate state: the top-up and the increase land together or
   neither does.
4. **Resume is chain truth, not component state.** `preflightResize` re-reads the batch on every
   Proceed; if on-chain `depth` already equals the target, the increase landed in a session that was
   lost, so the record is patched and the operation finishes without spending again. This is
   `alreadyResized`, and it closes the stuck-state class in
   [#392](https://github.com/snaha/swarm-id/issues/392).

The funds check onward runs deliberately **outside** the attempt guard: an on-chain spend's record
must land even if the dialog closes. What can still stop a run is the caller's `cancelled` seam, read
at the two moments money is about to move — before asking for funds, and before the transaction that
spends them.

### Buying is journalled first

A purchase is the one operation chain truth cannot resume on its own. Extend and resize act on a
batch the account already holds, so an interrupted attempt is found again by reading that batch back.
A purchase's batch is _new_: if the read-back that records it fails, the batch exists on chain, owned
by the account's signer, and **nothing looks batches up by owner**. An id nobody wrote down is money
spent on a drive that cannot be found again.

So `runPurchase` writes the id down **before** it sends anything. The id is `keccak256(creator,
nonce)` and the buyer chooses the nonce, so `planBatchCreation` knows it in advance rather than
reading it out of a receipt. The entry goes into a device-local journal
(`operation-journal.svelte.ts`, `localStorage`) and is cleared only once the drive is recorded. That
window is exactly the one where money is at risk.

Three consequences follow:

- **A purchase that finds an entry adopts it** instead of buying again — `runPurchase` reports
  `resumedUnfinished`, and the dialog says an earlier drive was finished rather than claiming the one
  on the form was bought.
- **The Storage tab offers to finish it** (`drive-unfinished-banner.svelte` → `resumePending`), which
  costs nothing: the batch is already paid for and owned, so all that is left is the read-back.
  Dismissing abandons the record, not the money.
- **The entry can outlive a purchase that never got mined.** Writing first is worth that: an
  unfinished drive the user can resume or dismiss is a far smaller problem than a paid-for batch
  nobody can name. The banner's copy says so and never asserts that payment went through.

The journal is deliberately **not synced**. It records what _this_ browser started; an entry that
outlived its device would invite resuming something another device already finished.

The two points where a real failure costs money are the two the tests can inject at:
`fault-injection.ts` arms `after-funding` or `after-create` (DEV only, single-shot, from /dev → Chain
→ Simulate failure), which is what makes the resume path exercisable rather than hypothetical.

### Atomic execution (EIP-7702)

The owner EOA authorises **`Simple7702Account`** — eth-infinitism's audited minimal 7702 account,
verified on Gnosis at `0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9` — and sends the transaction from
the EOA to itself, so `msg.sender` stays the owner throughout. Both `topUp` (which pulls from the
sender) and `increaseDepth` (owner-only) require that. `supportsBundling()` gates it on the delegate
having code, and an endpoint without one is REFUSED in preflight — there is no second path. It
throws rather than reporting absence when the endpoint cannot answer, so an RPC blip cannot read as
"this chain cannot pay atomically". EIP-7702 has been live on
Gnosis since the Pectra fork, 30 April 2025.

A replacement delegate must preserve two properties: **execution restricted to the account itself**,
so only a self-call from the EOA can drive it, and an `executeBatch` that reverts the whole batch on
any inner failure. MetaMask's `EIP7702StatelessDeleGator` is also deployed on Gnosis but is a far
larger surface than a three-call batch needs, and a bespoke delegate would add Solidity and an audit
burden to a TypeScript repo.

Bundling makes the resize partial-failure state unreachable and removes the window in which an
allowance sits unspent. Since it is the only path, that state cannot arise at all — see
[Resize cannot half-finish](./Drive-Payment-Flow.md#resize-cannot-half-finish).

## Errors and wording

| Condition                     | Wording direction                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `BatchExpired` / not found    | "This drive has expired and can no longer be extended."                                         |
| Floor (`InsufficientBalance`) | Explain the ~1-day minimum; show the clamped amount.                                            |
| `NotBatchOwner`               | "This drive is owned by a different key" (imported foreign batch).                              |
| `paused()`                    | "Swarm's payment contract is temporarily paused. Try again later."                              |
| No 7702 delegate on the chain | Refused before anything is charged, and says so.                                                |
| Confirmation timeout          | "Nothing is lost": a purchase keeps its journal entry, and the next Proceed re-reads the chain. |
| Insufficient owner funds      | Hand off to the payment flow.                                                                   |

## Recording and sync

Every record patch flows through `account.updateStamp` (LWW `updatedAt` clock, which re-anchors the
TTL measurement instant). Chain truth via `reconcileStampFromChain` is preferred after each
confirmation; the projected plan patches are the fallback, so an RPC blip after a confirmed
transaction still lands a record.

The runtime `Stamper` needs no explicit rebuild: `postage-stamps.svelte.ts`'s `getStamper()`
constructs one per call from the stored `stamp.depth`, so there is no cached instance to go stale.
Nothing pins that, so a future cache could reintroduce the bug silently —
[#544](https://github.com/snaha/swarm-id/issues/544).

## Security

- No new key-exposure class. The owner key already lives client-side and signs stamps; the hex key is
  passed function-scoped into `@swarm-id/multichain` calls, is never persisted anywhere new, and
  never leaves the origin.
- Exact-amount approvals to the fixed PostageStamp address only. No unlimited allowances.
- Because the addresses are the mainnet ones on both chains, the safety property is not _which
  addresses_ but _which endpoint_ — see the genesis-hash rule above.
- A hostile user-configured `gnosisRpcUrl` can lie about state and censor transactions, but cannot
  alter calldata, redirect approvals or extract the key. Same trust level as today's TTL reads.
- **The EIP-7702 delegation is permanent.** The authorization writes `0xef0100 || delegate` into the
  owner EOA's code field, where it stays until overwritten or cleared by authorising the zero
  address; it is not scoped to one transaction. So every account's derived postage signer reads as a
  contract (`EXTCODESIZE > 0`) after its first bundled operation. Nothing on the postage path checks
  that, but a future counterparty requiring `sender.code.length == 0` would reject it, and the
  delegate holds standing authority over that EOA — which is why the choice is a minimal account and
  not a general-purpose executor. No flow clears the delegation.

## Out of scope

- Fund delivery, quoting and the payment UI — [`Drive-Payment-Flow.md`](./Drive-Payment-Flow.md).
- Partition and utilization reaction to depth changes (capacity accounting, the depth-31→32 counter
  codec crossing, IndexedDB invalidation, multi-device skew) —
  [#463](https://github.com/snaha/swarm-id/issues/463). This engine only rebuilds the stamper.
- Relayed and gasless variants (EIP-2612 permit, ERC-4337) — unnecessary at <$0.001 per operation.

## Files and tests

| Path                                             | Role                                                        |
| ------------------------------------------------ | ----------------------------------------------------------- |
| `ui/src/lib/payment/chain.ts`                    | chain identity, client construction, owner balances         |
| `ui/src/lib/payment/postage-onchain.ts`          | preflights, funds, bundled writes, reconcile                |
| `ui/src/lib/payment/purchase.ts`                 | `derivePostageSigner`, `resizePlan`, TTL and cost maths     |
| `ui/src/lib/payment/drive-operation.ts`          | `runPurchase` / `runExtend` / `runResize` / `resumePending` |
| `ui/src/lib/payment/operation-journal.svelte.ts` | the write-before-you-spend journal                          |
| `ui/src/lib/payment/fault-injection.ts`          | DEV-only failures at the two points that cost money         |
| `ui/src/lib/payment/chain-price.ts`              | `lastPrice` for the dialogs' estimates, 60s cache           |
| `multichain/`                                    | ABI, signing, waiters, bundling, SushiSwap leg, dev tools   |

- `purchase.test.ts` covers `resizePlan` (cost parity with the old dilute-first ordering, floor
  clamps, keepLifespan on and off, unpriceable TTLs) plus the TTL and cost maths;
  `funding.test.ts` covers the funding maths; `operation-journal.test.ts` covers the journal.
- `@swarm-id/multichain` pins the write selectors in `abi.test.ts`, pins the resize call ORDER in
  `postage-bundle.test.ts`, and runs a fork suite (`pnpm test:fork`): fund → swap → create → topUp →
  increaseDepth → non-owner revert.
- Against the local chain, skipped when none answers: `ui/tests/drive-onchain.test.ts` (extend grows
  the on-chain balance and the recorded TTL; a chain with the delegate cleared is refused without
  charging; resize keeps the lifespan by topping up before increasing depth; an interrupted resize
  resumes from chain truth without paying twice), `ui/tests/drive-purchase.test.ts` (a bought batch
  exists on chain and is owned by the account's signer), and `ui/tests/drive-resume.test.ts` (an
  injected failure after the batch is created, or after the funds land, costs one drive and one
  payment — not two).
- Chain-level dev helpers live in `@swarm-id/multichain`'s `src/dev.ts` (`fundLocalAccount`,
  `simulateWidgetPurchase`), wrapped by `ui/src/lib/dev/chain-funding.ts` and driven from the /dev
  **Chain** tab. Creating a batch there also calls `ensureBundlingDelegate`: a baked snapshot cannot
  carry the delegate, so its mainnet runtime bytecode is committed (`src/delegate-bytecode.ts`) and
  spliced in.
