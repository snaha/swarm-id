# Postage-Batch Partitioning (design / model reference)

This document explains how a single Swarm postage batch is shared across multiple devices without
chunk collisions, and how per-partition utilisation counters are stored. It is the **model spec**;
the staged work to make the code match it is in **`Postage-Batch-Partitioning-Refactor-Plan.md`**.

> **Status.** Implemented on `feat/postage-batch-partitioning` (refactor phases A–E). The per-partition
> counter is the single counter of record, counter/utilisation persistence routes to reserved slots,
> and the cross-device handoff uses the reference-chunk scheme below. The _(target)_ tags throughout
> mark behaviour that this branch now realises (they predate the implementation and can be read as
> "current").

---

## 1. The two dimensions of a postage batch

A postage batch is a 2-D grid:

- **Buckets** — there are `2^BUCKET_DEPTH` of them. `BUCKET_DEPTH = 16`, so **65,536 buckets**. A chunk
  is assigned to a bucket by the **first 16 bits of its chunk address** (`toBucket(addr) =
(addr[0] << 8) | addr[1]`). You don't choose a chunk's bucket — its content (address) does.
- **Slots per bucket** ("bucketIndex") — `2^(depth − BUCKET_DEPTH)`, where `depth` is the batch's
  parameter. Example: `depth = 20` → `2^(20−16) = 16` slots per bucket.

A stamp commits a chunk to a specific `(bucket, slot)`. On a **mutable** batch, re-stamping the same
`(bucket, slot)` **overwrites** whatever was there — this is the lever the whole partitioning scheme
relies on. "Utilisation" is how full the fullest bucket is; once every slot of a bucket is used, that
bucket is full and further chunks mapping to it are rejected ("Bucket is full").

## 2. Sharing one batch across devices: slot partitioning

`K = PARTITION_COUNT` (currently **2**). Each bucket's slots are split into `K` partitions so two
devices writing into the same bucket never target the same slot.

Per-bucket slot layout (`K = 2`, `slotsPerBucket = 16` shown):

| Slot index      | Owner       | Holds                                                 |
| --------------- | ----------- | ----------------------------------------------------- |
| `0`             | partition 0 | **reserved**: partition 0's lock SOC or counter chunk |
| `1`             | partition 1 | **reserved**: partition 1's lock SOC or counter chunk |
| `2, 4, 6, … 14` | partition 0 | application data (`j = 0,1,2,…`)                      |
| `3, 5, 7, … 15` | partition 1 | application data                                      |

- Reserved slots are `[0, K)` — **one per partition**, at index = partition. They are mutable and are
  overwritten freely; they do **not** count toward utilisation.
- Data slot formula: `slot = DATA_COUNTER_START + p + K·j`, with **`DATA_COUNTER_START = K`**.
- **Per-partition data capacity** = `floor(slotsPerBucket / K) − 1` (the `−1` is the partition's
  reserved slot). For `depth = 20, K = 2`: `16/2 − 1 = 7` data values per partition per bucket.

Because reserved slots are partition-indexed, partition 0 and partition 1 can both place a reserved
chunk in the _same_ bucket without colliding (slots 0 and 1).

## 3. What lives in the reserved slots

Two kinds of small, frequently-rewritten chunks, both mutable-overwritten and both kept out of the
data slots:

- **Partition lock SOC** — the per-partition lease record (who holds partition `p`, until when). It has
  a **constant address** for a given `(partition, owner)`, so it overstamps the _same_ `(bucket,
slot = p)` on every heartbeat. (See the lock-SOC short-circuit in the stamper.)
- **Counter chunks** _(target)_ — the partition's per-bucket counter, chunked and stored in reserved
  slot `p`. Unlike the lock SOC, a counter chunk's address is **content-derived** and changes whenever
  the counter changes, so it cannot rely on a constant address; the stamper must be told explicitly to
  route it to slot `p`.

## 4. The per-partition counter

Each partition tracks, per bucket, how many data chunks it has written — the `j` in
`slot = K + p + K·j`. `stamp()` reads this counter to pick the next slot, then increments it.

_(target)_ This per-partition counter is the **counter of record**; it replaces the older batch-wide
`dataCounters`. Utilisation for the batch is then an aggregate (union/max of fill) across the `K`
partitions.

Capacity is enforced per partition: a write is rejected when `j` would reach
`floor(slotsPerBucket / K) − 1`.

## 5. Persistence of the counter

The counter is a `Uint32Array(65536)` (one entry per bucket). It is serialised and split into chunks
by `getChunkLayout(depth)`:

- counter codec is uint16 for `depth ≤ UINT16_COUNTER_MAX_DEPTH`, else uint32;
- `bucketsPerChunk = CHUNK_SIZE / counterByteSize`; `numUtilizationChunks = 65536 / bucketsPerChunk`
  (uint16 → 2,048 buckets/chunk → **32 chunks**).

Persistence rules _(target)_:

- **Only changed chunks are uploaded.** A `DirtyChunkTracker` marks the chunks whose buckets changed
  since the last save; unchanged chunks are skipped (their content — and therefore address — is
  unchanged).
- **Each counter chunk is routed to its bucket's reserved slot `p`** (mutable overwrite), so persisting
  the counter never consumes data capacity. `chooseUtilizationChunkKey` varies a per-chunk key nonce so
  a partition's ~32 chunks land in **distinct buckets**; each then occupies slot `p` of its bucket.
- Because the chunk address is content-derived, the stamper needs an explicit "reserved, partition `p`"
  instruction for these chunks (contrast §3's constant-address lock SOC).

This is why the old approach failed: serialising the whole counter as one ~256 KB blob and uploading it
through the ordinary data path stamped ~64 chunks into **data** slots, consuming capacity and
eventually throwing "Bucket is full" — even on a fresh stamp.

## 6. Cross-device handoff

The slot partitioning alone guarantees two devices on **different** partitions never collide. The
counter matters only when a device **takes over a partition another device held** (turn-taking): it
must continue past where the previous holder stopped, or it would re-stamp slots the previous holder
already used and **overwrite their chunks**.

Handoff _(target)_:

1. On yield/release, the holder persists its per-partition counter (reserved-slot chunks, §5) and
   publishes a small manifest (a feed) of the current chunk references for partition `p`.
2. A device acquiring partition `p` reads the manifest, fetches the chunks, and reconstructs the
   counter.
3. It then applies a **resume skew** (`computeResumeCounterSkew(depth) =
ceil(slotsPerBucket / K / RESUME_COUNTER_SKEW_DIVISOR)`) on top of the reconstructed counter, so even
   if the previous holder had a few un-published in-flight writes, the new holder starts comfortably
   beyond them and cannot collide.

A device that reloads within its own lease TTL skips the read entirely and re-derives its counter from
local state (the proxy's re-adopt fast path).

## 7. Utilisation reporting and cross-tab broadcast

- **Reporting**: utilisation % is the fill of the fullest bucket. _(target)_ With per-partition
  counters it is computed by aggregating the partitions' per-bucket usage.
- **Cross-tab broadcast**: same-origin tabs share counter updates over a `BroadcastChannel` and merge
  them **monotonically (max)** so concurrent tabs converge. _(target)_ Updates are keyed per partition;
  the monotonic-max merge applies **within** a partition (so one partition's progress never clobbers
  another's).

## 8. History (so future readers aren't misled)

- An earlier **pre-calculation** path (`calculateUtilizationUpdate`, `prepareBucketState`) assigned
  utilisation chunks to reserved slots starting at 0, but it is **dead code** — the live upload path
  never used it, so reserved-slot routing was never actually in effect.
- An earlier multi-device **`partition-state` feed** published the full counter as a single ~256 KB
  blob through the data path. It is replaced by the per-partition reserved-slot chunk persistence in §5.
- Net: there should be **one** counter mechanism — per-partition, reserved-slot, incremental — used for
  both local utilisation tracking and cross-device handoff. The refactor plan
  (`Postage-Batch-Partitioning-Refactor-Plan.md`) consolidates the code to that single mechanism.

## Key constants (in `lib/src/utils/batch-utilization.ts`)

| Constant                            | Value       | Meaning                                       |
| ----------------------------------- | ----------- | --------------------------------------------- |
| `BUCKET_DEPTH`                      | 16          | → 65,536 buckets                              |
| `PARTITION_COUNT` (`K`)             | 2           | partitions sharing each bucket's slots        |
| `DATA_COUNTER_START`                | `= K` (2)   | first data slot; reserved slots are `[0, K)`  |
| `UTILIZATION_SLOTS_PER_BUCKET`      | 2           | reserved slots per bucket (one per partition) |
| `LEASE_TTL_MS` / `LEASE_REFRESH_MS` | 30 s / 10 s | lock-SOC lease lifetime / heartbeat           |
| `IDLE_YIELD_MS`                     | 30 s        | idle-before-yield, so peers can take a slot   |
