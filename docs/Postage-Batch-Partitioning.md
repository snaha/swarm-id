# Postage-Batch Partitioning — model, leasing, and cross-device handoff

How a single Swarm postage batch is shared across a user's devices without chunk
collisions: the slot-partitioning model, the per-partition utilisation counter and its
persistence, the partition-lease lifecycle, the commit-ordered cross-device handoff, and
the release fencing. This is the current-state reference for the multi-device write path.

> **Status.** Implemented. The per-partition counter is the single counter of record;
> counter/utilisation persistence routes to reserved slots; the cross-device handoff is
> commit-ordered (ack-after-publish) and resumes at the exact published counter via a
> rotating state-pointer SOC. The user-facing overview lives in
> `docs-site/src/content/docs/multi-device-postage-batches.mdx`; the write-path lifecycle
> layer is documented in [`BatchWriteCoordinator.md`](./BatchWriteCoordinator.md).

Source of truth in code:
`lib/src/utils/batch-utilization.ts` (the stamper + slot routing),
`lib/src/sync/partition-state.ts` (counter publish + state pointer),
`lib/src/sync/partition-lease.ts` (lease state machine),
`lib/src/sync/partition-lock.ts` (the cross-device lock SOC + fencing),
`lib/src/sync/partition-intent.ts` (intent round + occupancy beacon),
`lib/src/sync/batch-write-coordinator.ts` (the write entry point + refresh tick).

---

## 1. The two dimensions of a postage batch

A postage batch is a 2-D grid:

- **Buckets** — there are `2^BUCKET_DEPTH` of them. `BUCKET_DEPTH = 16`, so **65,536
  buckets**. A chunk is assigned to a bucket by the **first 16 bits of its chunk address**
  (`toBucket(addr) = (addr[0] << 8) | addr[1]`). You don't choose a chunk's bucket — its
  content (address) does.
- **Slots per bucket** ("bucketIndex") — `2^(depth − BUCKET_DEPTH)`, where `depth` is the
  batch's parameter. Example: `depth = 20` → `2^(20−16) = 16` slots per bucket.

A stamp commits a chunk to a specific `(bucket, slot)`. On a **mutable** batch, re-stamping
the same `(bucket, slot)` **overwrites** whatever was there — this is the lever the whole
partitioning scheme relies on. "Utilisation" is how full the fullest bucket is; once every
slot of a bucket is used, that bucket is full and further chunks mapping to it are rejected
("Bucket is full").

## 2. Sharing one batch across devices: slot partitioning

`K = PARTITION_COUNT` (currently **2**). Each bucket's slots are split into `K` partitions
so two devices writing into the same bucket never target the same slot.

Per-bucket slot layout (`K = 2`, `slotsPerBucket = 16` shown):

| Slot index      | Owner       | Holds                                                   |
| --------------- | ----------- | ------------------------------------------------------- |
| `0`             | partition 0 | **reserved**: partition 0's lock SOC / counter / beacon |
| `1`             | partition 1 | **reserved**: partition 1's lock SOC / counter / beacon |
| `2, 4, 6, … 14` | partition 0 | application data (`j = 0,1,2,…`)                        |
| `3, 5, 7, … 15` | partition 1 | application data                                        |

- Reserved slots are `[0, K)` — **one per partition**, at index = partition. They are
  mutable and overwritten freely; they do **not** count toward utilisation.
- Data slot formula: `slot = DATA_COUNTER_START + p + K·j`, with **`DATA_COUNTER_START = K`**.
- **Per-partition data capacity** = `floor(slotsPerBucket / K) − 1` (the `−1` is the
  partition's reserved slot). For `depth = 20, K = 2`: `16/2 − 1 = 7` data values per
  partition per bucket.

Because reserved slots are partition-indexed, partition 0 and partition 1 can both place a
reserved chunk in the _same_ bucket without colliding (slots 0 and 1).

**Why K = 2 and not per-device lanes.** More partitions shrink each partition's per-bucket
slot budget, so a partition hits the birthday-paradox "bucket full" while other buckets
still have room. Two partitions let two of a user's devices write in quasi-real-time
without per-device lane fragmentation. The design optimises the 2-partition model.

## 3. What lives in the reserved slots

Everything below is a small, frequently-rewritten chunk, mutable-overwritten, kept out of
the data slots, and stamped to **`slot = partition`** of its bucket. The stamper has a
short-circuit per kind (see `UtilizationAwareStamper.stamp`):

- **Partition lock SOC** — the per-partition lease record (who holds partition `p`, until
  when). **Constant address** for a given `(partition, owner)`, so it overstamps the _same_
  `(bucket, slot = p)` on every heartbeat.
- **Counter chunks** — the partition's per-bucket counter, chunked (§5–6). Address is
  **content-derived** and changes whenever the counter changes, so the stamper is told
  explicitly to route it to slot `p` (`markReservedUtilizationChunk`).
- **State-pointer SOC** — the rotating per-epoch pointer to the latest counter
  reference-chunk (§8). Routed to slot `p` via the stamper's single intent-SOC reservation.
- **Intent + occupancy beacons** — the per-device intent SOC and the deviceId-independent
  occupancy SOC (§7). Also routed to slot `p` via the same intent-SOC reservation.

> Because the lock SOC, counter chunks, state pointer, and beacons **all** land at
> `slot = p`, two of them in the **same bucket** would overwrite each other under the
> mutable batch. The publish actively avoids that — see §10.

The intent / occupancy / state-pointer writes share the stamper's _single_ intent-SOC
reservation; concurrent writers (the off-lock refresh-tick beacons vs. an under-lock
publish) are serialised by `UtilizationAwareStamper.withIntentSocSlot` so one can't clobber
the other's reservation and fall through to a data slot.

## 4. The per-partition counter

Each partition tracks, per bucket, how many data chunks it has written — the `j` in
`slot = K + p + K·j`. `stamp()` reads this counter to pick the next slot, then increments
it. This per-partition counter is the **counter of record**. Utilisation for the batch is
an aggregate (union/max of fill) across the `K` partitions.

Capacity is enforced per partition: a write is rejected when `j` would reach
`floor(slotsPerBucket / K) − 1`.

## 5. Persistence of the counter

The counter is a `Uint32Array(65536)` (one entry per bucket), serialised and split into
chunks by `getChunkLayout(depth)`:

- counter codec is uint16 for `depth ≤ UINT16_COUNTER_MAX_DEPTH`, else uint32;
- `bucketsPerChunk = CHUNK_SIZE / counterByteSize`; `numUtilizationChunks = 65536 /
bucketsPerChunk` (uint16 → 2,048 buckets/chunk → **32 chunks**).

Persistence rules:

- **Each counter chunk is routed to its bucket's reserved slot `p`** (mutable overwrite),
  so persisting the counter never consumes data capacity. Per-chunk keys are varied so a
  partition's chunks land in **distinct buckets**; each then occupies slot `p` of its
  bucket.
- Because the chunk address is content-derived, the stamper needs an explicit "reserved,
  partition `p`" instruction for these chunks (contrast §3's constant-address lock SOC).

This is why the naïve approach failed: serialising the whole counter as one ~256 KB blob
and uploading it through the ordinary data path stamped ~64 chunks into **data** slots,
consuming capacity and eventually throwing "Bucket is full" — even on a fresh stamp.

## 6. The publish format (reference chunk + incremental upload)

`writePartitionState` (`partition-state.ts`) turns the live counter into durable Swarm
state:

1. Each non-zero counter chunk is uploaded with a random encryption key to a reserved slot,
   yielding a 64-byte **encrypted reference** (`address ‖ key`).
2. A single **reference chunk** lists those N references (`N·64 ≤ 4096` even at `N = 64`)
   and is itself uploaded the same way. A chunk that is entirely zero (never written) is
   not uploaded — the reference chunk carries an **all-zero sentinel** at that index and the
   reader defaults it to a zero chunk (a sparse first publish).
3. The reference chunk's reference is published in the rotating state-pointer SOC (§8).

**Incremental.** Given the previous publish's references and the counter it published,
only the chunks whose serialized bytes changed are re-uploaded; unchanged chunks reuse the
retained reference. A typical upload changes the data SOC's bucket plus the previous
publish's feed bucket → ~3–4 chunk writes in one `Promise.all`, not all 32. On acquire the
lease seeds this baseline from the resumed state, so even the **first** publish of a
session is incremental, not a full re-publish. A genuinely fresh account (no recovered
refs) falls back to the sparse-full path.

## 7. The partition lock SOC and lease lifecycle

The per-partition **lock SOC** (`partition-lock.ts`) is the cross-device authority: it
names the current holder of partition `p` and its `leasedUntil`. A holder keeps a 30 s
lease (`LEASE_TTL_MS`) refreshed every 10 s (`LEASE_REFRESH_MS`). `PartitionLease`
(`partition-lease.ts`) is the in-code state machine; `BatchWriteCoordinator`
(`batch-write-coordinator.ts`) drives it from the write path.

- **Acquire.** Read every partition's lock SOC (`refreshFromSwarm`), union in holders
  detected via the per-device **intent/presence beacons** and the deviceId-independent
  **occupancy beacon** (fresh per-epoch addresses that stay retrievable on a gateway whose
  static lock-SOC cache is frozen), then claim the first free/expired partition from this
  device's deterministic home offset.
- **Intent round.** Only a _fresh_ claim of a free/expired slot _with a known rival_ runs
  the intent round (a short per-epoch announce + poll at `INTENT_GUARD_WINDOW_MS`) so two
  disjoint-gateway contenders agree on one winner before binding. A re-acquire of our own
  partition skips it.
- **Displacement backstop.** On refresh, if a foreign beacon with an earlier generation
  proves a peer holds the partition, the later-generation device yields (`"displaced"`),
  resolving a dual-acquire that slipped past the acquire-time guard.
- **TTL-optimism (the common case).** While `now < leasedUntil − skew`, the TTL contract
  guarantees no peer has taken over, so the holder writes straight from its local counter
  with no gateway reads and no guard round. A reload within the TTL re-adopts the cached
  lease from local state alone (`adoptIfLive`).
- **Cold re-entry.** If the local lease could have lapsed, the throttled freshness check
  re-reads the lock SOC once before writing; still ours → write, taken → demote+re-acquire.
- **Idle yield.** After `IDLE_YIELD_MS` (30 s) with no upload and none in flight, the holder
  voluntarily releases so a waiting peer takes the slot without waiting out the TTL.
- **Self-demote.** The refresh tick extends the local lease only on a _confirmed_ hold
  (write-verified renewal, or a read-verified lock SOC still naming us). An unconfirmable
  renewal tolerates a short blip but, once the lease lapses past skew, fences in-flight
  stamps and demotes — a holder whose renewals keep failing must stop writing.

The refresh tick runs on a bare interval **off** the write lock so it can detect
displacement mid-upload; the corrupting `stamp()` is aborted immediately via
`invalidateLease()` (breaker → `PartitionLeaseLostError`), and the unbind/demote then runs
under the write lock.

## 8. Cross-device handoff — commit-ordered (ack-after-publish)

The slot partitioning alone guarantees two devices on **different** partitions never
collide. The counter matters only when a device **takes over a partition another device
held** (turn-taking): it must continue past where the previous holder stopped, or it would
re-stamp slots the previous holder already used and overwrite their chunks.

Durability is defined by **ordering**, not a probabilistic margin:

> **A write is reported durable only after the partition-state that reserves its slots is
> published.**

So in `withWrite`: write the upload's chunk(s) → (reverse-clobber guard) → publish the
partition state covering them → _then_ resolve the upload's promise. Consequences:

- An un-published (in-flight) write is by definition **not yet acked**, so discarding it on
  takeover is safe.
- The new holder resumes at the **exact published counter** — writes beyond it were un-acked
  (safe to overwrite); writes at/below it were acked and the published counter never lets
  the new holder touch them. No skew margin needed.

**State-pointer transport.** The pointer to the latest reference chunk is published at a
deterministic, time-bucketed **state-pointer SOC**:
`identifier = keccak256(topic ‖ uint64(floor(now / STATE_POINTER_EPOCH_MS)))`. A reader
**computes** the address directly — no epoch-tree walk — and the rotating address bypasses a
gateway's frozen static cache. The holder heartbeats the pointer to the current bucket on
every refresh, so an idle-but-alive holder keeps a fresh resume point. A taking-over device
reads the current/previous bucket around `now` and, for a gone holder, scans the whole
`leasedUntil − LEASE_TTL_MS … leasedUntil` span (plus a couple buckets of slack for dropped
heartbeats), all concurrently — so the lookup costs ~one read timeout regardless of how long
ago the holder stopped. No pointer found _and_ a clean (absent) lock ⇒ genuinely no state ⇒
resume from zero; no pointer found but the lock was **unreadable** ⇒ fail safe (read-only +
retry), never zero-seed.

**Reverse-clobber guard.** Before acking, the held lease is re-validated (throttled to zero
reads on the fast path; a long upload that outran the TTL re-reads the lock SOC). If the
lease could have lapsed, the publish/ack is refused — a slept/throttled holder must not
overwrite a **new** holder's already-acked data. Chunks are content-addressed, so the failed
upload is a safe retry.

A device that reloads within its own lease TTL skips the read entirely and re-derives its
counter from local state (the re-adopt fast path).

## 9. Release fencing (#349)

`teardown()` releases the partition on sign-out/disconnect: it publishes the final counter,
then writes a **release sentinel** (`holderDeviceId = ""`) to the lock SOC so peers see an
immediate, authoritative free. Because the publish is slow and the sentinel's postage stamp
is minted at `stamp()` time (Bee resolves same-address SOC conflicts by newer stamp), a
naïve detached release could land its sentinel **after** a same-device re-acquire and
clobber the successor's claim → two writers on one partition. Four layers fence this:

- **L0 — lock-serialized teardown release.** The detached release runs under the batch write
  lock (`withBatchWriteLock`), which the successor's acquire also queues on. The release
  completes (sentinel minted) strictly before the successor reads/writes the lock SOC, so
  last-writer-wins keeps the successor's claim. (Same-origin case — which #349 is.)
- **L1 — released-claim generation.** The sentinel carries the **released claim's**
  generation (captured before the slow publish), not a fresh one, so any later claim
  (successor or peer) is logically newer. Also fixes a latent false `lost-race` in the
  acquire verify step.
- **L3 — generation-fenced sentinel write + ghost-claim guard.** `releasePartitionLock`
  re-reads the lock and skips the write when it would clobber a successor or a peer (sentinel
  already present, own newer-generation claim, or any foreign holder). `PartitionLease` sets
  a `closed` flag at the top of `release()`; `refresh()` passes `shouldAbort: () =>
this.closed` so a teardown-overlapping refresh tick can't mint a ghost claim that L3 would
  then refuse to clear.
- **L2 — sentinel re-assert at upload start (defense in depth).** If `ensureLeaseStillValid`
  reads a sentinel while we believe we hold, it re-asserts via `refresh()` (a converging
  stale sentinel / frozen-cache view); a peer that claimed after the sentinel demotes us.

A fifth fix: `markReservedUtilizationChunk(address, partition)` records the slot at marking
time, because the teardown release publishes through an **unbound** stamper whose
`partition ?? 0` fallback would otherwise route a partition-1 release's chunks onto
partition 0's reserved slots.

## 10. Reserved-slot bucket-collision avoidance

All reserved-slot writers for partition `p` stamp `slot = p` (§3), so two of them in the
same bucket evict one another. Within a publish, `writePartitionState` already picks each
counter/reference chunk in a bucket distinct from the lock-SOC bucket, the live utilisation
chunks, and (incremental) the retained real chunks. It **also** excludes, for the current
and previous epoch:

- the **state-pointer SOC** it writes in the same `Promise.all` (otherwise an intra-publish
  self-collision, possible on every publish at ~1/65536 per chunk);
- the deviceId-independent **occupancy beacon** bucket;
- this device's **intent beacon** bucket (when the holder's `deviceId` is known).

so a randomly-keyed chunk can't evict the pointer or a live beacon (or be evicted by them).
A peer's _intent_ beacon uses its own deviceId and can't be computed here — see §12.

## 11. Utilisation reporting and cross-tab broadcast

- **Reporting**: utilisation % is the fill of the fullest bucket, computed by aggregating
  the partitions' per-bucket usage.
- **Cross-tab broadcast**: same-origin tabs share counter updates over a `BroadcastChannel`
  and merge them **monotonically (max)** so concurrent tabs converge. Updates are keyed per
  partition; the monotonic-max merge applies **within** a partition, so one partition's
  progress never clobbers another's.

## 12. Remaining issues / accepted residuals

- **Write-fenced to clock skew (was: ack-safe, not write-safe).** A lease lapsing _mid-`op`_
  is fenced both for the **ack** (the reverse-clobber guard refuses to publish) and for the
  **data write**: `stamp()` throws `PartitionLeaseLostError` when either `leaseStale` is set
  (a refresh tick _confirmed_ a peer took over) **or** the lease has lapsed by this device's
  own clock — `Date.now() >= leaseValidUntil - LEASE_SKEW_MARGIN_MS`, a purely local check on
  every chunk. So an un-renewable holder (e.g. a disjoint-gateway view its refresh can't
  confirm by reading) stops writing the instant its own clock says the lease expired — before
  a peer reading the same `leasedUntil` could validly take over. A long multi-chunk `op`
  aborts mid-stream; the chunk is content-addressed, so the upload cleanly fails and retries.
  The residual is now just the irreducible clock skew below, not a full refresh interval.
  (Fence: `batch-utilization.ts` `leaseLocallyLapsed`; deadline pushed by
  `batch-write-coordinator.ts` `syncStamperLeaseDeadline` on bind + every renewal.)
- **Bounded clock skew.** A device with a slow clock can believe its lease is valid while
  peers correctly took over. Irreducible; bounded by NTP-level skew + the TTL margin, the
  same assumption the lock protocol already makes. The local-lapse fence above relies on
  `leaseValidUntil` (from the lease's `leasedUntil`) and the stamper's `Date.now()` being the
  same wall clock — true in production; a test that drives the coordinator with an injected
  lease clock must inject the stamper's clock too (see #385).
- **Peer intent-beacon reserved-slot collision.** §10 covers the pointer and the
  deviceId-independent occupancy beacon, but a **peer's** per-device intent beacon sits at an
  address keyed on the peer's deviceId, which we may not know (or can't enumerate). It can
  only collide with our publish during a transient **same-partition dual-hold** (different
  partitions write different slots), at ~1/65536 per chunk, and is fail-safe: an evicted
  beacon self-heals next tick; an evicted counter chunk → `readFailed` → read-only + retry.
- **Cross-node lease-expired race.** An expired holder's release re-read through its own
  node can miss a peer's claim (frozen local store / no non-neighborhood convergence) → the
  fenced sentinel still physically lands → a third device may claim → dual-hold bounded by
  the ≤ 10 s displacement window (refresh + `isDisplaced` + breaker).
- **`readFailed` degradation.** When the resume point exists but can't be read (transient
  network error, or a published chunk evicted from the reserve), acquire degrades to
  read-only and retries rather than resuming from zero — never re-issuing used slots.

## Key constants (in `lib/src/utils/batch-utilization.ts`)

| Constant                            | Value       | Meaning                                       |
| ----------------------------------- | ----------- | --------------------------------------------- |
| `BUCKET_DEPTH`                      | 16          | → 65,536 buckets                              |
| `PARTITION_COUNT` (`K`)             | 2           | partitions sharing each bucket's slots        |
| `DATA_COUNTER_START`                | `= K` (2)   | first data slot; reserved slots are `[0, K)`  |
| `UTILIZATION_SLOTS_PER_BUCKET`      | 2           | reserved slots per bucket (one per partition) |
| `LEASE_TTL_MS` / `LEASE_REFRESH_MS` | 30 s / 10 s | lock-SOC lease lifetime / heartbeat           |
| `IDLE_YIELD_MS`                     | 30 s        | idle-before-yield, so peers can take a slot   |
| `STATE_POINTER_EPOCH_MS`            | 30 s        | rotation period of the state-pointer SOC      |

## 13. History (so future readers aren't misled)

- An earlier **pre-calculation** path (`calculateUtilizationUpdate`, `prepareBucketState`)
  assigned utilisation chunks to reserved slots but was dead code; the live upload path
  never used it.
- An earlier multi-device **`partition-state` feed** published the full counter as a single
  ~256 KB blob through the data path; replaced by the per-partition reserved-slot chunk
  persistence (§5–6).
- The **walked epoch-feed** that pointed at the latest counter reference-chunk (a ~32-level
  tree walk = ~27 slow gateway 404 probes on cold acquire) was replaced by the rotating
  **state-pointer SOC** (§8).
- The **resume-skew** handoff (`computeResumeCounterSkew`, a probabilistic margin against the
  previous holder's un-published in-flight writes) was specified but never implemented; it is
  superseded by the commit-ordered ack-after-publish handoff (§8), which resumes at the exact
  published counter and needs no margin.
