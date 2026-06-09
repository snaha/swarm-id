# Implementation Plan: extract a `BatchWriteCoordinator` from the proxy

Status: **in progress.** Tracks GitHub issue [#336](https://github.com/snaha/swarm-id/issues/336).

**Progress: all phases complete and committed** (lib typecheck + lint clean, 658 lib tests passing).
Step A (scaffold), Steps B–C (lease cluster + `withWrite` moved into the coordinator; proxy delegates)
and the displacement-during-upload race fix landed first (the proxy is ~530 lines smaller). Step D-a
routed `sync-account` through a one-shot coordinator via the new shared
`lib/src/sync/publish-account-state.ts` (gate removed; contention/error logging split), and Step D-b
wired proxy-side publish-on-lease-acquisition (+ on account-state change) to fix the 3-device
device-announce bug. See the constraints note at the end for the two integration frictions that were
resolved.

Companion to `BatchWriteCoordinator-Design.md` (the original design), `Postage-Batch-Partitioning.md`,
and `Postage-Batch-Partitioning-Refactor-Plan.md`. This document records the **confirmed** approach and
the step-by-step execution; the design doc records the original motivation.

## Why

`lib/src/swarm-id-proxy.ts` (~4,350 lines) mixes three concerns: (1) client communication (its real job
— the postMessage protocol), (2) auth / identity / storage / button UI, and (3) the **write path** —
stamp management, the cross-tab Web Lock, the partition-lease lifecycle, upload guards. Concern 3 is
cohesive but trapped inside the proxy, so `sync-account.ts` carries a second, parallel
lease/lock/claim implementation (drift risk).

Extracting concern 3 into a shared `BatchWriteCoordinator` shrinks the proxy, removes the duplication,
and unlocks three fixes:

1. **Proxy-side publish** (motivation #3): in production the user is on the dApp, not the identity UI,
   so the only guaranteed-persistent context is the **proxy iframe** — which holds a coordinator-like
   write path but never publishes account state.
2. **Device-announce on lease acquisition** (motivation #4): observed 3-device bug — a newcomer sees all
   3 devices, but the other two only ever see 2, because the newcomer never publishes _itself_. Lease
   acquisition is the natural trigger (the device provably holds a partition then).
3. **The displacement-during-upload race** (found in the #335 review): `refreshTick` runs on a bare
   `setInterval` (not under the write lock) and calls `demoteSilently`, which does `invalidateLease()`
   then `unbindPartition()`. `unbindPartition()` resets `leaseStale = false` and clears `partition`, so
   the `stamp()` circuit breaker (`partition !== undefined && leaseStale`, `batch-utilization.ts:1481`)
   **never fires** for an in-flight upload — it silently falls back to legacy "any"-slot picking and
   corrupts the displacing peer's slot space instead of aborting.

Issue **phase 1** (the `withBatchWriteLock` helper) is already done — the proxy delegates at
`swarm-id-proxy.ts:588-596` and `sync-account.ts:739` uses it.

## Confirmed decisions

- Land the **full refactor (issue phases 2–5) plus the race fix**, phased so each step keeps
  `pnpm check:all` green.
- Proxy-side publish fires **on lease acquisition AND on account-state changes** while a lease is held.
- The shared publish core lives in a **new `lib/src/sync/publish-account-state.ts`**.
- `storagePartitioned` is **not** a blocker: proxy-side publish only runs when the proxy holds a real
  partition lease, which already requires non-partitioned storage + a stamper. No parent-postMessage
  snapshot plumbing.
- **One class** — fold the lease cluster directly into `BatchWriteCoordinator`; do **not** extract a
  separate `PartitionLeaseManager`. The lease cluster is tightly coupled to the write lock and stamper
  bind/unbind, and the race fix needs `refreshTick`'s demote to coordinate with `withWrite`'s lock. A
  separate manager would need back-references to the coordinator's `activeUploadCount` /
  `withBatchWriteLock` / `stamper` — a circular dependency. The coordinator holds a `PartitionLease`
  (the existing primitive) as its lower layer.

## The `BatchWriteCoordinator` (`lib/src/sync/batch-write-coordinator.ts`, new)

Owns the lease cluster + write-lock wrapping + stamper-state flush for one `(account, batchId)`. Owns
nothing about auth, ConnectionInfo emission, or upload handlers.

### Constructor (dependency-injected — no global storage-manager reach-in)

```ts
export interface BatchWriteCoordinatorDeps {
  bee: Bee
  batchId: string // postageBatchId hex; the withBatchWriteLock key
  stamper: UtilizationAwareStamper // already created + account-bound by the caller
  deviceId: string
  accountId: string
  backupSigner: PrivateKey // what captureLeaseContext derives today
  swarmEncryptionKey: Uint8Array
  partitionCount: number
  mode: 'persistent' | 'oneshot' // proxy = persistent; sync-account = oneshot
  readLeaseCache?: () => PartitionLeaseStateSnapshot | undefined
  writeLeaseCache?: (snap: PartitionLeaseStateSnapshot | undefined) => void
  flushStamperState?: () => Promise<void> // proxy: saveStamperStateIfNeeded
  onLeaseChange?: (info: { currentPartition: number | undefined; isReadOnly: boolean }) => void
  onLeaseAcquired?: (partition: number) => void // phase-5 publish trigger
}
export class PartitionContendedError extends Error {} // typed "no free slot" outcome
```

The `stamper` is **injected, not created** — its construction needs auth-level inputs the proxy already
resolves and `sync-account` resolves via `postageStampsStore.getStamper`. The coordinator only
binds/unbinds the partition on it.

### Methods

| Method                                                                             | Behavior                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `withWrite<T>(op, opts?: { useWorkers?; workerCount?; wait?: "block" \| "skip" })` | Single write entry point. Wraps `withBatchWriteLock(batchId, …)` with reload-before / flush-after. Inside the lock: `ensureLease(wait)` → `ensureHeldForUpload()` → bracket `activeUploadCount`/`lastLeaseActivityAt` → `op(target)`, where `target = {mode:"stamper", bee, stamper, workerPool}`. **Subsidised mode stays in the proxy.** |
| `startLease()`                                                                     | Persistent only: eager background acquire + refresh timer. Oneshot: no-op.                                                                                                                                                                                                                                                                 |
| `release()` / `teardown()`                                                         | `pauseLeaseBackgroundWork` / `tearDownPartitionLease` equivalents.                                                                                                                                                                                                                                                                         |
| `get currentPartition` / `get isReadOnly` / `get stamper`                          | For `buildConnectionInfo`.                                                                                                                                                                                                                                                                                                                 |

### The one behavioral fork — `ensureLease(wait)`

- **`wait:"block"` (proxy):** today's `ensurePartitionLease` — race the slot-wait acquire against the
  45s acquire timeout; the slot-wait polls up to 30s and **throws** if no slot frees → the upload errors.
- **`wait:"skip"` (sync-account):** claim a free/expired partition **once**; if none free, throw
  `PartitionContendedError`. Never polls. sync-account catches it → `console.warn("Skipping sync …: all
partitions held by other devices.")` + `return undefined`.

## Migration steps (each keeps `pnpm check:all` green)

- **Step A (issue phase 2 — scaffold).** New file with the class skeleton, `PartitionContendedError`,
  moved constants (`PARTITION_LEASE_ACQUIRE_TIMEOUT_MS`, `SLOT_WAIT_TIMEOUT_MS`), and the pure helper
  `isDisplaced`. Unit-tested in isolation; the proxy doesn't delegate yet.
- **Step B (issue phase 3 — move the lease cluster; proxy delegates).** Move `acquirePartitionLease`,
  `ensurePartitionLease`, `acquirePartitionLeaseWithSlotWait`, `ensureLeaseStillValid`,
  `scheduleLeaseRefresh`/`refreshTick`, `yieldIdleLease`, `demoteSilently`, `pauseLeaseBackgroundWork`,
  `tearDownPartitionLease`, `captureLeaseContext`, `readLeaseCache`/`writeLeaseCache`, plus the lease
  state fields. The proxy constructs the coordinator in `initializeStamper`, replaces the warm-up block
  with `coordinator.startLease()`, and wires `emitConnectionInfoIfChanged` via `onLeaseChange`.
  `ensureCanUpload()` (auth-level) stays in the proxy.
- **Step C (issue phase 4 — compose `withWrite`).** Move `getUploadTarget`'s stamper branch and the
  flush-after-write into `withWrite`. The proxy's `withModeAwareWriteLock` becomes `if subsidised →
op(target) unlocked; else coordinator.withWrite(op)`. The ~14 upload handlers are untouched.
  `buildConnectionInfo` reads coordinator getters.
- **Step D (issue phase 5 — route sync-account + new behavior).** See below.

## Race fix (in `refreshTick`/`demoteSilently`, inside the coordinator)

Split `demoteSilently` into two halves:

1. **Immediately on confirmed displacement** (before any lock): `stamper.invalidateLease()` **only** →
   `leaseStale=true` while `partition` stays bound → in-flight `stamp()` throws `PartitionLeaseLostError`
   and aborts the corrupting upload.
2. **Then unbind/clear under the write lock:** `withBatchWriteLock(batchId, () => {
stamper.unbindPartition(); clear timer/lease; isReadOnly=true; writeLeaseCache(undefined); re-arm
pending; onLeaseChange(...) })`. The lock serializes the unbind after the in-flight upload's locked
   section completes or aborts, so no `stamp()` runs between invalidate and unbind.

**Critical:** lock-synchronizing the demote _alone_ is insufficient — it merely orders the demote after
an upload that has **already corrupted** the peer slot. The immediate `invalidateLease()` is what aborts
the upload; the lock only protects the subsequent unbind. Both halves are required.

## Phase-5 new behavior (Step D)

- **Shared publish core — new `lib/src/sync/publish-account-state.ts`.** Extract from `sync-account.ts`
  `runSync`: `publishMerged` (fetch latest remote → merge → `uploadData` → `handleUtilizationUpdate` →
  `updater.update`), the `verifyWon` retry loop, and the root-chunk probe, into
  `publishAccountState(deps)` with injected store deps + a partition-bound stamper + `bee` + topic.
  `getAccountStateSnapshot` is reused (snapshot includes `metadata.devices`).
- **Route sync-account through the coordinator.** Build a `oneshot` coordinator after the snapshot;
  replace the inline gate with `coordinator.withWrite(() => publishAccountState(...), { wait: "skip" })`;
  remove the outer `withBatchWriteLock` wrap; the `bindPartition` moves into `ensureLease`.
- **Contention-vs-error logging split.** Genuine contention → `PartitionContendedError` → the "Skipping"
  warn. An operational failure (missing stamper, `acquirePartitionLock` threw) → a **distinct error
  log**, not the misleading contended warn.
- **Proxy-side publish.** The proxy subscribes to `onLeaseAcquired` and calls `publishAccountState(...)`,
  and also publishes when `handleAuxiliaryStorageChange` detects an account-state change **while a lease
  is held**. Both run outside the coordinator's write-lock context (the publish itself re-enters the
  lock via `coordinator.withWrite`) — guard with a debounce + an "already-publishing" flag. Publishing
  the snapshot (which already includes this device in `metadata.devices`) on first acquisition fixes the
  3-device device-announce bug.

## Files

- New: `lib/src/sync/batch-write-coordinator.ts`, `lib/src/sync/publish-account-state.ts`.
- `lib/src/swarm-id-proxy.ts` — delegate write/lease/lock/stamp to the coordinator; keep comms/auth/UI;
  add `onLeaseAcquired` / storage-change publish wiring.
- `lib/src/sync/sync-account.ts` — publish via the coordinator + the shared core; gate → `wait:"skip"`;
  logging split.
- `lib/src/utils/batch-utilization.ts` — no API change; the race fix uses existing
  `invalidateLease`/`unbindPartition`/the breaker.

## Testing

Regression guard (stay green): `sync-account.test.ts` (update for the logging split),
`partition-lock.test.ts`, `partition-lease.integration.test.ts`, `merge-snapshot.test.ts`.

New tests:

1. **`batch-write-coordinator.test.ts`** — `withWrite` block-vs-skip; `PartitionContendedError` on skip;
   getters; `onLeaseChange`/`onLeaseAcquired`; `startLease`/`teardown` lifecycle.
2. **Displacement-during-upload (the race fix).** Hold the lock mid-`stamp()`, fire a `refreshTick`
   confirming displacement; assert the in-flight `stamp()` throws `PartitionLeaseLostError`, the upload
   aborts before writing a peer slot, `unbindPartition` runs only after the lock frees. Negative control:
   lock-only would complete and corrupt.
3. **3-device device-announce.** A,B hold partitions; C joins, acquires, publishes; assert the feed
   snapshot's `metadata.devices` contains C and A/B converge to include C.
4. **Contention-vs-error split.** (i) all live-held → `PartitionContendedError` → "Skipping" warn; (ii)
   `acquirePartitionLock` throws → distinct error log.

## Verification (end-to-end)

- `pnpm check:all` green after **every** step A–D.
- `pnpm --filter @snaha/swarm-id test` for new + existing tests.
- Manual multi-device against a local cluster (`.claude/rules/bee-cluster.md` — image must be built with
  `REACHABILITY_OVERRIDE_PUBLIC=true`): 3 browser profiles on one account, confirm all device lists
  converge to 3, and an upload during a forced displacement aborts cleanly.

## Risks

- Moving the sync-account claim from outside-the-lock to inside-`ensureLease`-under-lock is a
  concurrency-path change (safe — claims are generation-fenced — isolate to Step D; covered by tests).
- Keep the subsidised short-circuit proxy-side; else subsidised uploads would wrongly try to lease.
- Avoid double-flush in the oneshot path (sync-account already flushes via `handleUtilizationUpdate`).
- Proxy publish-on-acquire must not deadlock on the write lock it re-enters via `coordinator.withWrite`
  — run it outside the acquiring lock context, debounced.

## Step D — constraints discovered while implementing A–C

Two integration frictions to resolve when implementing Step D (recorded so the work is scoped before it
starts):

1. **Stamper type.** `PostageStampsStoreInterface.getStamper` returns the narrower `FlushableStamper`
   (`stamp` + optional `flush`), not `UtilizationAwareStamper`. `sync-account` today feature-detects the
   lease methods (`stamper.bindPartition && stamper.buildLeaseLocalCounter`). The coordinator's deps
   require a `UtilizationAwareStamper` and call `bindPartition`/`buildLeaseLocalCounter`/`getLocalCounter`
   unconditionally. Step D must either narrow the coordinator's stamper contract + feature-detect, or
   have `sync-account` assert/cast the stamper to `UtilizationAwareStamper` (it is one in production for
   shared, partitioned batches) — and the test `mockStamper` must gain the lease methods.

2. **Gate tests move down a layer.** `sync-account.test.ts` mocks `./partition-lock`
   (`readPartitionLock`/`acquirePartitionLock`) and asserts on call counts (e.g. "claims a free
   partition" → `acquirePartitionLock` called once; "skips when all held" → not called). Once the gate
   is the coordinator's `PartitionLease.acquire`, those assertions belong in
   `batch-write-coordinator.test.ts`. In `sync-account.test.ts` the cleanest path is to **mock
   `BatchWriteCoordinator`**: a publish test = `withWrite` resolves; a skip test = `withWrite` rejects
   `PartitionContendedError` → assert `undefined` + the "Skipping" warn. This is the correct layering
   (sync-account tests its _use_ of the coordinator; the coordinator tests the claim/skip).

These make Step D a distinct, test-invasive phase. Steps A–C + the race fix are independently complete
and green, so they can land as a reviewable unit before Step D proceeds.
