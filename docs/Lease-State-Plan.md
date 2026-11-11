# One source of truth for a lane's lease state: plan

Status: **in progress** (2026-11-10). Phases 1 to 4 are built; phase 5 is not. The
decisions taken are at the end. Follows [#918](https://github.com/snaha/swarm-id/pull/918) and the
`fix/one-lease-across-tabs` branch stacked on it.

## Goal

Every browser context of one storage partition that writes to a drive — dApp proxy iframes,
tabs of one dApp, same-site dApps, the SwarmID tab's account sync — works from **one shared
record** of the lane it holds. A context's memory is a working copy, valid only inside a
locked section. No context acts on Swarm from what it remembers.

Batching the publish of several tabs (group commit) is an optimisation on top of this and
is deliberately last.

## The problem

To the lease protocol, all contexts of a storage partition are one device: the device id is
in `localStorage`. They hold one lease. The state describing it is spread over three places
and duplicated per context.

| State                                                     | On Swarm         | Shared in the partition       | Per context (memory)              |
| --------------------------------------------------------- | ---------------- | ----------------------------- | --------------------------------- |
| Which lane, claim generation, expiry                      | lock SOC         | lease cache (`localStorage`)  | `PartitionLease.self`             |
| Last published reference                                  | state pointer    | lease cache **and** IndexedDB | `PartitionLease.lastReferenceHex` |
| Counter table                                             | published leaves | IndexedDB rows                | the stamper's table               |
| Publish baseline (leaf refs, frame, counter as published) | reference chunk  | —                             | `PartitionLease.published*`       |
| What the rows are (lane, generation, exact)               | —                | IndexedDB metadata            | copies on the stamper             |
| Idle clock, refresh timer, heartbeat streak               | —                | —                             | the coordinator                   |

Each duplicate has produced a defect. All of these were reproduced with tests:

- An idle tab's heartbeat re-points the state pointer at its own older reference, so a
  takeover resumes below a sibling's acknowledged upload.
- An idle tab's tick writes its older reference back into the lease cache.
- An idle tab's timer releases the lane a sibling is uploading through.
- A tab re-claims the lane its sibling just yielded.
- Two tabs torn down together publish the older counter last.
- A tab that missed a sibling's writes lowers the shared rows, or certifies a mix of two
  tables.
- An incremental publish diffed against rows that are ahead of the published leaves
  produces state no reader can decode.

Found by reading, not yet reproduced: the SwarmID tab's account sync
(`lib/src/sync/sync-account.ts`) builds a one-shot coordinator with no lease cache, so it
publishes on the lane without the other contexts learning of it.

## What exists today

Two interim measures exist. Both reconcile copies; neither removes them. The first is on
#918; the second stays unmerged (decision 2).

- **#918 branch**: the rows carry a generation; a context folds in foreign rows by maximum
  on taking the write lock; the metadata says whether the rows are exactly the published
  counter (`exact`).
- **`fix/one-lease-across-tabs`**: a context's lease object is trusted only while it matches
  the lease cache, dropped otherwise, and re-adopted from the cache.

Known costs of the interim state: a re-adopted lease has no baseline, so tabs that
alternate publish in full each time; a lane that has never published cannot be re-adopted
at all (see "The unpublished lane" below).

## Target

One **lane record** per drive, in the IndexedDB metadata store next to the rows. It is read
at the start of every locked section and written only under the write lock.

```
lane        partition, claim generation, acquiredAt, leasedUntil   (absent: no lane held)
published   referenceHex, frame, leaf references, epoch of the last full re-pin
            rows: the counter as last published (a second set of rows)
rows        lane, generation
activity    last upload, for the idle yield
protected   buckets of the latest published state chunks
```

What this replaces:

- **The `localStorage` lease cache.** The reference then lives in one place, not two that
  have to be compared.
- **`PartitionLease`'s copies** of `self`, `lastReferenceHex` and the baseline. The object
  keeps the protocol (claim, refresh, publish, release) and takes the record as input.
- **The `exact` flag and the pending reference.** A publish diffs against the stored copy
  of the published counter, so it no longer matters whether the live rows have moved past
  it.
- **The per-context baseline.** The leaf references and frame are in the record and the
  counter as published is in its own rows; a failed publish leaves all three as they were.
- **The per-context idle clock.**

A context without IndexedDB is read-only: its stamper does not build, so it reports
`canUpload: false` and never acquires a partition (see `docs/decisions.md`, "Uploads
require IndexedDB").

## Phases

Each phase is its own PR, test-first, with its entry in `docs/decisions.md`. The two-tab
integration file (`batch-write-coordinator.two-tabs.integration.test.ts`) and the
randomised two-tab invariant test are the regression net throughout.

### 1. One record, one reader

- Define the lane record and move the lease cache's fields into it.
- The coordinator reads the record on taking the lock and at the start of a tick. Same
  claim: its lease takes the record's expiry and published reference. Another claim or
  none: it drops its lease locally. The `PartitionLease` object still exists per context;
  what it no longer has is a say over the record.
- Give `sync-account.ts`'s coordinator the same record.
- Remove `leaseCacheStorageKey` from `internal.ts` and the dev device list
  (`ui/src/routes/dev/device-list.svelte`), or point them at the record.

Done when: the two-tab tests pass with the reconciliation code deleted, and a test shows the
account-sync publish is visible to a proxy context. **Built**: 13 two-tab tests, including a
one-shot writer standing in for account sync.

### 2. A flush is one transaction

- Write the dirty rows and the record in a single IndexedDB transaction.
- Flush the live rows before the publish; after it, write the record's new reference in one
  transaction (joined in phase 3 by the published-counter rows).

Done when: the "tab dies mid-flush" tests pass without the two-bump generation and without
clearing the lane before a rewrite. **Built**: `UtilizationStoreDB.writeRows`; a failed
flush writes nothing and the next one lands whole.

### 3. Shared baseline

- Keep the leaf references and frame in the record, and the counter as published in a
  second set of rows, written in one transaction with the record's new reference.
- `writePartitionState` keeps its diff; its previous counter comes from those rows.

Done when: two tabs alternating, and a reload, both publish incrementally; the decoder
stays strict. **Built**: the baseline rides on the rows' `stateReference` and a `published`
object store; the `exact` flag is gone; a cache-hit claim downloads nothing.

### 4. One ticker, one idle clock

- Every context ticks. A tick claims the interval's Swarm renewal in the record
  (`renewingAt`, one atomic update) unless another context claimed it within half an
  interval; a context that does not renew takes the recorded expiry. A lease near expiry
  renews whatever the record says.
- The context that finds the lane taken clears the record off-lock; a sibling's next tick
  sees the claim gone and stops its in-flight upload's stamps without waiting for the lock.
- The idle yield reads `activeAt` from the record, written as an upload starts and ends.

Done when: N tabs produce one refresh per interval, and closing the ticking tab hands the
tick to another. **Built**: eight two-tab tests, each piece mutation-checked.

### 5. Group commit (optimisation)

A write that finds another request pending on the write lock skips its publish, and acks
once a publish covers its generation — its own if nobody else's does. Left for after 1–4;
the design notes and its open question (a small write waiting behind a long upload) are in
the review thread, not repeated here.

## The unpublished lane

Current behaviour, on `fix/one-lease-across-tabs`: a lane that was claimed but never
uploaded to has no published reference, so nothing certifies the cache rows for it, and a
context can only _adopt_ a lease whose rows are certified. Two tabs on such a lane therefore
cannot share it: the second tab's claim leaves the first without a lease object until the
first has something to write, when it claims again. The device holds the lane throughout;
it is the first tab that holds nothing.

Phase 1 did not change this. Phase 3 does: nothing can put an older reference back in the
record any more, and a publish is in the record before its ack, so a lane whose rows describe
it and which has no reference on either side is adopted like any other.

## Decisions taken

1. **The record lives in IndexedDB**, in the metadata store next to the rows (2026-11-10).
   Nothing on the write path needs a synchronous read: the only synchronous user is
   `teardown()`, whose clear becomes a write queued on the lock, ahead of any successor's
   acquire. The record carries the account id and device id and is ignored when either
   differs, because the store is keyed by batch alone.
2. **`fix/one-lease-across-tabs` is not merged** (2026-11-10). Phase 1 replaces its
   reconciliation; its two-tab tests carry over as phase 1's acceptance tests.
3. **A publish diffs against a stored copy of the published counter** (2026-11-10): a
   second set of rows in IndexedDB, written in the same transaction as the record's new
   reference. A diff against what was actually published cannot miss a change, where a
   changed-bucket bitmap or a per-row generation is bookkeeping that can drift; it also
   keeps `writePartitionState`'s diff and its monotonicity tripwire. Costs 256 KB per
   drive and a second write of each changed row. It makes the `exact` flag unnecessary.
4. **The rows are flushed before the publish** (2026-11-10). Both already happen before the
   caller's promise resolves, so the ack is no later. With one record there is no second
   store to disagree with after a crash between publish and local write; flushing first
   means a reload always finds rows that include the stamps that reached Swarm. A flush
   that fails stays non-fatal: publish from memory and leave the record untouched.
5. **Every context ticks, one refreshes** (2026-11-10). Each context reads the record on
   its own timer and does the Swarm refresh only when the record shows nobody renewed
   within the last interval. No election and no messaging; an uploading context still
   learns within one interval that the lease is gone. The presence and occupancy beacons a
   refresh writes are per device, not per context, so one writer per interval is the right
   count; so is one state-pointer heartbeat.

## Not verified

- Web Locks, IndexedDB transactions and `localStorage` are simulated in the tests so far.
  Phases 1, 2 and 4 each need one run in a real browser with two tabs.
- Safari private windows and other contexts where IndexedDB is refused.
- The account-sync gap is from reading the code only.
