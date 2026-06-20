# Postage-Batch Partitioning — Refactoring Plan (partition-native utilisation counters)

Companion to the design doc **`Postage-Batch-Partitioning.md`** (Deliverable 1 below), which is the
model spec this refactor implements. This document is the phased execution plan.

## Why this refactor

Turn-taking across devices (wait-for-slot on upload + idle yield) is implemented and works, but the
idle-yield `release()` throws **"Bucket is full"** even on a freshly-bought stamp. Investigation
established two facts (both verified against the code):

1. **`writePartitionState` (`lib/src/sync/partition-state.ts`) uploads the entire 65,536-entry counter
   as a ~256 KB / ~64-chunk blob** via plain `uploadData`. A partition-bound `UtilizationAwareStamper`
   stamps each chunk through the **data-slot** formula (`batch-utilization.ts:1873`,
   `slot = DATA_COUNTER_START + p + K·j`), consuming real data capacity and bumping counters — which is
   what trips "Bucket is full".
2. **The reserved-slot mechanism is not wired into the live path at all.** A utilisation chunk goes
   `saveUtilizationState → uploadUtilizationChunk → uploadData → stampChunkData → stamper.stamp()`, and
   `stamp()`'s only fixed-slot short-circuit is for **lock SOCs** (matched by constant address,
   `:1848-1855`). Content-addressed counter/utilisation chunks fall into the data-slot branch. The
   reserved-slot assignment exists only in **dead code** (`calculateUtilizationUpdate:1076`, no live
   caller; `prepareBucketState:1154` also dead — only `updateAfterWrite` is live).

So the two reserved indexes per bucket are effectively unused headroom today; utilisation data and the
partition-state blob both consume data capacity. The blob is just the most extreme instance.

### Decisions (confirmed)

- **Full fix**: actually wire reserved-slot routing into the live stamper and generalize to K partitions.
- **Replace `dataCounters` fully per-partition** (rework utilisation reporting, the cross-tab broadcast
  merge, and reconstruction accordingly).
- **Document it** (this plan + the design doc), because the subsystem is intricate and has confused
  every iteration.

Blast radius is entirely within `lib/` (verified: no `swarm-ui`/`demo` reads of `dataCounters`,
partition-state, or utilisation internals). No account migration needed (dev only).

## Target model

Two dimensions of a postage batch:

- **Buckets**: `2^BUCKET_DEPTH` (= 65,536; `BUCKET_DEPTH = 16`). A chunk maps to a bucket by the first
  16 bits of its address.
- **Per-bucket slots**: `2^(depth - BUCKET_DEPTH)`. E.g. depth 20 → `2^4 = 16` slots.

Per bucket, with `K = PARTITION_COUNT`:

| Slot index    | Owner                      | Holds                                                                                                                                |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `0 … K-1`     | partition = index          | **reserved** — that partition's utilisation/counter chunk **or** its lock SOC (mutable overwrite; does not count toward utilisation) |
| `K + p + K·j` | partition `p`, `j = 0,1,…` | application data                                                                                                                     |

- `DATA_COUNTER_START = K`.
- Per-partition data capacity: `floor(slotsPerBucket / K) - 1` (depth 20, K=2 → **7**: indexes
  2,4,…,14 for p=0 and 3,5,…,15 for p=1).
- Each partition owns its per-bucket counter `j`. This **is** the counter of record — it replaces the
  batch-wide `dataCounters`. Utilisation reporting aggregates across partitions.

Reserved-slot routing is the novel piece: a counter chunk's address is content-derived (unlike a lock
SOC's constant address), so the stamper must be told "this is partition `p`'s counter chunk → overstamp
slot `p`".

---

## Deliverable 1 — Design doc: `docs/Postage-Batch-Partitioning.md`

Write FIRST; it is the spec the code must match. Sections:

1. Postage-batch dimensions (buckets × slots), chunk→bucket mapping, mutable overwrite semantics.
2. Per-bucket slot layout (reserved `[0,K)` one-per-partition; data `K + p + K·j`); capacity formula.
3. What lives in reserved slots (lock SOC + the partition's counter chunks) and why partitions can
   co-reside in one bucket (different reserved index).
4. Counter model: per-partition `j`; slot computation; capacity enforcement.
5. Persistence: counter chunked via `getChunkLayout`; only changed chunks uploaded (dirty tracking);
   each routed to its bucket's reserved slot `p` (mutable). Why content-addressed chunks need explicit
   reserved-slot routing (contrast with the constant-address lock SOC).
6. Cross-device handoff: discovery + reconstruction of the previous holder's counter; the resume skew
   (`computeResumeCounterSkew`) and its purpose.
7. Utilisation reporting + cross-tab broadcast under per-partition counters.
8. History note: supersedes the dead `calculateUtilizationUpdate` pre-calc and the `partition-state`
   blob feed.

---

## Deliverable 2 — Phased refactor (all in `lib/`)

Land in this order; keep `pnpm check:all` green between phases.

### Phase A — partition-aware slot/capacity helpers + delete dead code

- Extract the inline slot formula (`stamp():1873`) into `dataSlot(p, j, K)`; add
  `partitionCapacity(depth, K) = floor(slotsPerBucket/K) - 1`; express `DATA_COUNTER_START = PARTITION_COUNT`.
- Generalize `hasBucketCapacity` / `calculateMaxSlotsPerBucket` to be partition-aware.
- **Delete** dead `calculateUtilizationUpdate` (`:1076`), `prepareBucketState` (`:1154`), the unused
  `UtilizationUpdate` interface, their `index.ts` re-exports, and the corresponding
  `batch-utilization.test.ts` blocks.

### Phase B — eliminate `dataCounters`; unify on the per-partition local counter

**Decision (revised):** `dataCounters` is the pre-multi-device, batch-wide counter and is **no longer
needed**. The per-partition local counter (`partitionLocalCounter`, the `j` in `slot = DATA_COUNTER_START

- p + K·j`) is the **single counter of record** — it already drives slot selection and is seeded
per-partition from the handoff. Remove `dataCounters` entirely and route everything through the
  partition local counter.

* Remove the `dataCounters` field from `BatchUtilizationState` and `UtilizationAwareStamper`. The
  persisted/loaded "utilisation" chunks now serialise the **partition's local counter (`j`)**, per
  partition.
* `stamp()` counter bump: drop the `dataCounters[bucket]++`; keep only `partitionLocalCounter[bucket]++`.
* The counter is meaningful only once a partition is bound, so it is **seeded at `bindPartition`**
  (from the handoff / cache), not loaded partition-agnostically at stamper creation. Single-device
  (legacy) collapses to `K=1, partition 0`.
* Rework consumers off `dataCounters`:
  - `calculateUtilization`: fill = `j / partitionCapacity(depth, K)` over the partition's counter.
  - `buildLeaseLocalCounter` / `utilizationToBucketState`: derive from `partitionLocalCounter`
    (`utilizationToBucketState` maps `j → DATA_COUNTER_START + p + K·j`).
  - Cross-tab broadcast (`getBucketUpdatesForBroadcast` / `applyUtilizationUpdate`): broadcast the
    partition's `j` values; same-origin tabs share one device = one partition, so the monotonic-max
    merge stays correct.
  - `loadUtilizationState` / `saveUtilizationState` / `updateAfterWrite` (`sync-account.ts`): operate
    on the partition counter; storage keyed per partition via the `leaseChunkIndex`-style chunkIndex
    offset (Option 1).
* Persisting `j` (small, per-partition) is what Phases C/D then route to reserved slots / the handoff.

### Phase C — wire reserved-slot routing into `stamp()`

- Add a counter/utilisation-chunk short-circuit parallel to the lock-SOC one: when stamping partition
  `p`'s counter chunk, overstamp **slot `p`** in its bucket (mutable), bypassing the data-slot formula
  and the counter bump — so counter persistence never consumes data capacity.
- Because counter-chunk addresses are content-derived, register the current counter-chunk addresses
  for the in-flight save (like `bindLockSocs`/`lockSocs`) or pass an explicit "reserved, partition `p`"
  flag through `uploadUtilizationChunk` → `stamp()`.
- `chooseUtilizationChunkKey` already spreads a partition's chunks across distinct buckets, so each
  lands at slot `p` of its own bucket; partitions 0/1 may share a bucket at slots 0/1.

### Phase D — replace the partition-state feed handoff

- `PartitionLease.release` / `claimPartition`: stop writing/reading the blob
  (`partition-state.ts` `writePartitionState` / `readPartitionState`). Persist partition `p`'s counter
  as its reserved-slot chunks (Phase C), uploading only changed chunks, plus a small manifest (feed) of
  the current per-partition chunk references so a peer can fetch + reconstruct. Apply the resume skew
  on read (unchanged).
- Update `PartitionStateSchemaV1` (`schemas.ts`) to the manifest/sparse representation (no migration).
- This removes the data-slot blob write → eliminates "Bucket is full" at the root.

### Phase E — call sites, tests, build

- Update `sync-account.ts` (`updateAfterWrite` / `calculateUtilization` / `saveUtilizationState`, and
  the `bindPartition` / `buildLeaseLocalCounter` block at `:457`) and `swarm-id-proxy.ts`
  (`bindPartition` / `getLocalCounter` at `:812 / :840 / :891 / :928`).
- Tests: rewrite the round-trip + `release` cases in `partition-lease.integration.test.ts`; update
  `batch-utilization.test.ts` for per-partition counters, the deleted functions, and the new helpers.
  **Add the missing regression**: a partition-**bound** stamper persisting its counter on a near-full
  bucket must NOT throw "Bucket is full" (no current test exercises a bound stamper through `release`).
- `pnpm check:all` green. Rebuild only via the running `dev:lib` rollup watcher — never a manual
  `pnpm build` while `pnpm dev` is up (concurrent writers corrupt `lib/dist/swarm-id.esm.js`).

---

## End-to-end verification

1. `pnpm dev:bee:fresh`, `pnpm dev`; buy a fresh stamp.
2. Device A uploads (partition 0), B uploads (partition 1); idle both. Within ~30 s each yields:
   `release()` persists its counter via reserved slots — **no "Bucket is full"** in the proxy log.
3. Device C uploads → takes a freed slot, reconstructs the prior holder's counter (no overwrite of the
   prior holder's chunks), succeeds.
4. Demo's reported utilisation % reflects true batch fill across both partitions.
5. Repeated yield/acquire cycles on a small (depth-20) batch don't exhaust data capacity.
6. `pnpm check:all` green; the new bound-stamper-release regression test passes.

## Risks / notes

- Largest, most intricate module in the codebase; phase order + per-phase CI is the safety net.
- Phase C (reserved-slot routing for content-addressed chunks) is the novel mechanism — imitates the
  lock-SOC short-circuit but with per-save address registration.
- Phase B (`dataCounters` → per-partition) is the riskiest (reporting, tab-sync merge, IndexedDB
  schema) — chosen deliberately; the design doc + per-phase green CI de-risk it.
- `calculateUtilizationUpdate` and `prepareBucketState` are dead (no live callers) and are deleted in
  Phase A; the remaining live counter paths (`updateAfterWrite` for bookkeeping, `stamp()` for slot
  selection) do different jobs and are unified on the shared slot/capacity helpers, not collapsed into
  one function.
