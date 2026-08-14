# Postage on-chain engine — extending and resizing a drive without a Bee node

Status: **design of record**; the implementation lands in
[#533](https://github.com/snaha/swarm-id/pull/533). How the BZZ and xDAI this engine spends reach the
owner address is a separate document, [`Drive-Payment-Flow.md`](./Drive-Payment-Flow.md).

## What it is

Drive **extend** (lifespan top-up) and **resize** (depth increase plus a compensating top-up) are
executed as Gnosis Chain transactions built, signed and submitted from `ui/`, using the derived
batch-owner key the UI already holds. No Bee node is involved.

The alternative does not work in production. A Bee node's `topUpBatch`/`diluteBatch` only act on
batches the _node_ owns, and product batches are owned by the account's derived postage signer
(`derivePostageSigner`, `ui/src/lib/payment/purchase.ts`).

## Position in the stack

```
  ui/src/lib/payment/drive-operation.ts    runPurchase / runExtend / runResize
        │                                  (raises FundingNeed → Drive-Payment-Flow.md)
        ├── purchase.ts        resizePlan — how much to top up, at which depth
        ├── chain.ts           chain identity, MultichainClient construction, owner balances
        ├── postage-onchain.ts preflights, allowance, topUp / increaseDepth, bundles, reconcile
        │        │
        │        └──▶ @swarm-id/multichain   ABI, signing, waiters, EIP-7702 bundling, SushiSwap
        │                                    (multichain/, vendored from @upcoming/multichain-library)
        └── account.updateStamp              the recorded drive state (LWW, see Account-State.md)
```

`lib/` is untouched: its raw `eth_call` reads remain the UI's display path.

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

```ts
export function resizePlan(
  liveRemainingPerChunk: bigint, // from chain, NOT stamp.amount
  currentDepth: number,
  newDepth: number,
  keepLifespan: boolean,
  minimumInitialBalancePerChunk: bigint,
  lastPrice: bigint,
): ResizePlan // { topUpAmount, afterTopUp, afterDilute }
```

With `Δ = newDepth − currentDepth`, `factor = 2^Δ` and `R = liveRemainingPerChunk`:

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

`chain.ts` resolves the chain and constructs the client:

```ts
export function probeChainId(rpcUrl): Promise<number> // one call, before any client exists
export function chainIdentity(rpcUrl?): Promise<ChainIdentity> // { chainId, isMainnet }
export function postageChain(rpcUrl?): Promise<MultichainClient>
export function ownerFunds(address, client?): Promise<OwnerFunds> // { xdai, bzz }
```

`postage-onchain.ts` orchestrates over `@swarm-id/multichain`:

```ts
export function fundingShortfall(address, bzzPlur, client?): Promise<OwnerFunds>
export function ensureBzzAllowance(signerKey, totalPlur, client?): Promise<void>
export function topUpOnChain(signerKey, stamp, amountPerChunk, client?): Promise<void>
export function increaseDepthOnChain(signerKey, stamp, newDepth, client?): Promise<void>
export function createOnChain(signerKey, amountPerChunk, depth, client?): Promise<string>
export function bundledCreate(signerKey, amountPerChunk, depth, totalPlur, client?)
export function bundledExtend(signerKey, stamp, amountPerChunk, totalPlur, client?)
export function bundledResize(signerKey, stamp, amountPerChunk, totalPlur, newDepth, client?)
export function preflightExtend(stamp, client?): Promise<PostagePreflight>
export function preflightResize(stamp, signerKey, newDepth, client?)
export function reconcileStampFromChain(account, stamp, client?): Promise<boolean>
```

`ensureBzzAllowance` skips when the existing allowance suffices and otherwise approves **exactly**
the amount needed. The `bundled*` functions return false (or undefined) when the chain has no
EIP-7702 delegate, which is the caller's signal to send the calls separately.
`reconcileStampFromChain` patches `{depth, amount, batchTTL}` through `account.updateStamp` and
returns false — leaving the record untouched — when the chain cannot answer.

Rules that hold across all of it:

- **Assert chain 100 before any signature** (`settingsFor` throws otherwise). Chain id alone cannot
  tell the local chain from mainnet — it reports `100` deliberately, so that an app resolving
  addresses by chain id finds what it expects. `chainIdentity()` separates them by **genesis hash**,
  and an endpoint that is not mainnet never falls back to the public RPCs, so a failed local call
  cannot silently read or write real mainnet.
- Every wait wraps in `withTimeout` (`lib/src/utils/promise.ts`), never `Promise.race`. A timeout
  surfaces as "still pending" and is resolved by reconciliation on the next dialog open.
- Preflights assemble from `getPostageBatch` + `getPostageWriteConstraints` and map every reachable
  revert to a typed error before spending gas: batch missing, expired, paused, not owner, floor not
  cleared, insufficient funds at the owner address.
- Transactions run sequentially from the owner key; the package resolves pending-block nonces.

## Flows

Both flows begin with a funds check and end with a recorded stamp. Where the chain has the EIP-7702
delegate — which includes Gnosis mainnet — the steps run as a single atomic transaction; elsewhere
they run one at a time. The steps, their order and their preconditions are identical either way.

**Extend** — `approve → topUp`:

1. `topUpAmount = stampAmountForSeconds(price, addedSeconds)`, with the price read from the
   contract's `lastPrice` via `fetchPostageWriteConstraints` (`chain-price.ts`, 60s cache) rather
   than the Bee `/chainstate`.
2. `preflightExtend`: batch exists, not expired, not paused. Ownership is irrelevant here — `topUp`
   is permissionless — but the owner key signs anyway.
3. Funds check: `topUpAmount << depth` PLUR of BZZ plus gas at the owner address. A shortfall hands
   off to the payment flow, then re-checks.
4. `ensureBzzAllowance` → `topUpOnChain` → `reconcileStampFromChain`, falling back to the projected
   `extendedStamp` patch if the read fails.

**Resize** — `approve → topUp → increaseDepth`:

1. `preflightResize`: `batch.owner === ownerAddress` (a hard requirement — imported foreign batches
   get a clear "owned by a different key" error), not expired, not paused, `newDepth > depth`, floor
   cleared by the plan, `stamp.immutableFlag === false`.
2. Funds check as above; BZZ is only needed when `topUpAmount > 0`.
3. `ensureBzzAllowance` → `topUpOnChain(topUpAmount)` → `account.updateStamp(batchID, afterTopUp)`,
   then `increaseDepthOnChain(newDepth)` → `reconcileStampFromChain` (falling back to `afterDilute`).
   The record must reflect the top-up even if the depth increase then fails.
4. **Resume is chain truth, not component state.** On dialog open and before every retry the chain is
   read; if on-chain `depth` already equals the target, the increase landed in a lost session, so the
   record is patched and the operation finishes. This is `alreadyResized` off `preflightResize`, and
   it closes the stuck-state class in [#392](https://github.com/snaha/swarm-id/issues/392).

Steps 3–4 run deliberately **outside** the attempt guard: an on-chain spend's record must land even
if the dialog closes.

### Atomic execution (EIP-7702)

The owner EOA authorises **`Simple7702Account`** — eth-infinitism's audited minimal 7702 account,
verified on Gnosis at `0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9` — and sends the transaction from
the EOA to itself, so `msg.sender` stays the owner throughout. Both `topUp` (which pulls from the
sender) and `increaseDepth` (owner-only) require that. `supportsBundling()` gates it on the delegate
having code, so an endpoint without one degrades to the sequential path. EIP-7702 has been live on
Gnosis since the Pectra fork, 30 April 2025.

A replacement delegate must preserve two properties: **execution restricted to the account itself**,
so only a self-call from the EOA can drive it, and an `executeBatch` that reverts the whole batch on
any inner failure. `Simple7702Account` was chosen over MetaMask's `EIP7702StatelessDeleGator` (also
deployed on Gnosis, but a far larger surface than a three-call batch needs) and over writing our own,
which would add Solidity and an audit burden to a TypeScript repo.

Bundling makes the resize partial-failure state unreachable and removes the window in which an
allowance sits unspent. `SizeIncreasePendingError` and its dialog copy remain for the unbundled path;
see [`Drive-Payment-Flow.md`](./Drive-Payment-Flow.md) §5.

## Errors and wording

| Condition                     | Wording direction                                                  |
| ----------------------------- | ------------------------------------------------------------------ |
| `BatchExpired` / not found    | "This drive has expired and can no longer be extended."            |
| Floor (`InsufficientBalance`) | Explain the ~1-day minimum; show the clamped amount.               |
| `NotBatchOwner`               | "This drive is owned by a different key" (imported foreign batch). |
| `paused()`                    | "Swarm's payment contract is temporarily paused. Try again later." |
| Confirmation timeout          | "Still pending" — resolved by reconciliation on next open.         |
| Insufficient owner funds      | Hand off to the payment flow.                                      |

## Recording and sync

Every record patch flows through `account.updateStamp` (LWW `updatedAt` clock, which re-anchors the
TTL measurement instant). Chain truth via `reconcileStampFromChain` is preferred after each
confirmation; the projected plan patches are the fallback, so an RPC blip after a confirmed
transaction still lands a record.

The runtime `Stamper` needs no explicit rebuild: `postage-stamps.svelte.ts`'s `getStamper()`
constructs one per call from the stored `stamp.depth`, so there is no cached instance to go stale.

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

## Known gaps

- No regression test pins that the runtime `Stamper` follows a depth change.
- The unbundled path cannot resume a resize whose top-up landed but whose depth increase did not; see
  [`Drive-Payment-Flow.md`](./Drive-Payment-Flow.md) §5.

## Files and tests

| Path                                    | Role                                                      |
| --------------------------------------- | --------------------------------------------------------- |
| `ui/src/lib/payment/chain.ts`           | chain identity, client construction, owner balances       |
| `ui/src/lib/payment/postage-onchain.ts` | preflights, allowance, writes, bundles, reconcile         |
| `ui/src/lib/payment/purchase.ts`        | `derivePostageSigner`, `resizePlan`, TTL and cost maths   |
| `ui/src/lib/payment/drive-operation.ts` | `runPurchase` / `runExtend` / `runResize`                 |
| `ui/src/lib/payment/chain-price.ts`     | `lastPrice` from the contract, 60s cache                  |
| `multichain/`                           | ABI, signing, waiters, bundling, SushiSwap leg, dev tools |

- `purchase.test.ts` covers `resizePlan` (cost parity with the old ordering, floor clamps,
  keepLifespan on and off, integer dust); `funding.test.ts` covers the funding maths.
- `@swarm-id/multichain` pins the `b67644b9` / `47aab79b` selectors in `abi.test.ts` and runs a fork
  suite (`pnpm test:fork`): fund → swap → create → topUp → increaseDepth → non-owner revert.
- `ui/tests/drive-onchain.test.ts` runs four Playwright tests against the local chain, skipped when
  no chain answers: extend grows the on-chain balance and the recorded TTL; extend again with the
  delegate cleared, covering the sequential fallback; resize keeps the lifespan by topping up before
  increasing depth; an interrupted resize resumes from chain truth without paying twice.
- Chain-level dev helpers live in `@swarm-id/multichain`'s `src/dev.ts` (`fundLocalAccount`,
  `simulateWidgetPurchase`), wrapped by `ui/src/lib/dev/chain-funding.ts` and driven from the /dev
  **Chain** tab. Creating a batch there also calls `ensureBundlingDelegate`: a baked snapshot cannot
  carry the delegate, so its mainnet runtime bytecode is committed (`src/delegate-bytecode.ts`) and
  spliced in.
