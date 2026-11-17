# Postage-Batch Partitioning — model, lanes, and cross-device handoff

How a single Swarm postage batch is shared across a user's devices without chunk
collisions: the slot-partitioning model, the per-partition utilisation counter and its
persistence, who may write a partition at a given moment, and the commit-ordered
cross-device handoff. This is the current-state reference for the multi-device write path.

> **Status.** Implemented. The per-partition counter is the single counter of record;
> counter/utilisation persistence routes to reserved slots; the cross-device handoff is
> commit-ordered (ack-after-publish) and resumes at the exact published counter via a
> numbered, write-once state-pointer entry. Who holds a partition is agreed between live
> contexts over the account bus and stored nowhere: a context with no confirmed connection
> to the bus cannot write a partitioned batch. The user-facing overview lives in
> `docs-site/src/content/docs/multi-device-postage-batches.mdx`; the write-path lifecycle
> layer is documented in [`BatchWriteCoordinator.md`](./BatchWriteCoordinator.md); the bus
> itself in [`Account-Bus.md`](./Account-Bus.md).

Source of truth in code:
`lib/src/utils/batch-utilization.ts` (the stamper + slot routing),
`lib/src/sync/partition-state.ts` (counter publish + state pointer),
`lib/src/sync/lane-state.ts` (a holder's resume and publish),
`lib/src/sync/bus-lease.ts` (who holds a partition; the protocol of `models/bus-lease`),
`lib/src/sync/batch-write-coordinator.ts` (the write entry point).

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

| Slot index      | Owner       | Holds                                                 |
| --------------- | ----------- | ----------------------------------------------------- |
| `0`             | partition 0 | **reserved**: partition 0's counter and state pointer |
| `1`             | partition 1 | **reserved**: partition 1's counter and state pointer |
| `2, 4, 6, … 14` | partition 0 | application data (`j = 0,1,2,…`)                      |
| `3, 5, 7, … 15` | partition 1 | application data                                      |

- Reserved slots are `[0, K)` — **one per partition**, at index = partition. They are
  mutable and overwritten freely; they do **not** count toward utilisation.
- Data slot formula: `slot = DATA_COUNTER_START + p + K·j`, with **`DATA_COUNTER_START = K`**.
- **Per-partition data capacity** = `floor(slotsPerBucket / K) − 1` (the `−1` is the
  partition's reserved slot). For `depth = 20, K = 2`: `16/2 − 1 = 7` data values per
  partition per bucket.
- **Minimum worth buying.** The same formula sets the purchase floor. A partition's bucket
  lane must hold at least `MIN_USABLE_PARTITION_CAPACITY = 4` data chunks, and
  `MIN_USABLE_BATCH_DEPTH` is the smallest depth that reaches it — **20** for
  `BUCKET_DEPTH = 16, K = 2` (depth 17 has no data slot at all, 18 exactly one, 19 three;
  20 gives 7, ~66 MB). It is searched from `partitionCapacity` rather than written out, so
  it follows `BUCKET_DEPTH`, `PARTITION_COUNT` and the reserved-slot term. The floor is 4
  because at capacity 1 the first chunk written to a bucket already fills that lane and the
  batch reports 100% used while effectively empty (#538), and at 3 some bucket fills after
  ~1 MB of uniformly placed chunks — a drive too small to be worth its purchase (#566).

Because reserved slots are partition-indexed, partition 0 and partition 1 can both place a
reserved chunk in the _same_ bucket without colliding (slots 0 and 1).

**Why K = 2 and not per-device lanes.** More partitions shrink each partition's per-bucket
slot budget, so a partition hits the birthday-paradox "bucket full" while other buckets
still have room. Two partitions let two of a user's devices write in quasi-real-time
without per-device lane fragmentation. The design optimises the 2-partition model.

## 3. What lives in the reserved slots

Everything below is a small chunk kept out of the data slots and stamped to
**`slot = partition`** of its bucket. The stamper has a short-circuit per kind (see
`UtilizationAwareStamper.assignSlot`):

- **Counter chunks** — the partition's per-bucket counter, chunked (§5–6). Address is
  **content-derived** and changes whenever the counter changes, so the stamper is told
  explicitly to route it to slot `p` (`markReservedUtilizationChunk`).
- **State-pointer entry** — the numbered, write-once pointer to the latest counter
  reference-chunk (§8). Routed to slot `p` via the stamper's single SOC reservation
  (`withIntentSocSlot`).

> Because these **all** land at `slot = p`, two of them in the **same bucket** would
> overwrite each other under the mutable batch. The publish actively avoids that — see §10.

Nothing in the reserved slots says who holds a partition (§7).

## 4. The per-partition counter

Each partition tracks, per bucket, how many data chunks it has written — the `j` in
`slot = K + p + K·j`. `stamp()` reads this counter to pick the next slot, then increments
it. This per-partition counter is the **counter of record**. Utilisation for the batch is
an aggregate (union/max of fill) across the `K` partitions.

Capacity is enforced per partition: a write is rejected when `j` would reach
`floor(slotsPerBucket / K) − 1`.

## 5. Persistence of the counter

The counter is a `Uint32Array(65536)` (one entry per bucket). On the wire it is packed
with the SBU1 leaf encoding (`sync/counter-codec.ts`, #463): a per-publish frame (base + bit
width chosen from the counters' spread), deltas packed to that width, outliers listed as
exceptions in the reference chunk — typically 7–23 leaves instead of the fixed 32 or 64 the
uint16/uint32 layout before it took, and independent of the batch depth, so a dilute changes
nothing published. Topic domain `swarm-id-partition-state-v2`.

The stamper's local cache rows and its own utilisation backup keep the depth-dependent
layout (`getChunkLayout(depth)`: uint16 up to depth 31, uint32 above).

Persistence rules:

- **Each leaf is routed to its bucket's reserved slot `p`** (mutable overwrite),
  so persisting the counter never consumes data capacity. Per-chunk keys are varied so a
  partition's chunks land in **distinct buckets**; each then occupies slot `p` of its
  bucket.
- Because the chunk address is content-derived, the stamper needs an explicit "reserved,
  partition `p`" instruction for these chunks.

This is why the naïve approach failed: serialising the whole counter as one ~256 KB blob
and uploading it through the ordinary data path stamped ~64 chunks into **data** slots,
consuming capacity and eventually throwing "Bucket is full" — even on a fresh stamp.

## 6. The publish format (reference chunk + incremental upload)

`writePartitionState` (`partition-state.ts`) turns the live counter into durable Swarm
state:

1. Each non-zero leaf is uploaded with a random encryption key to a reserved slot,
   yielding a 64-byte **encrypted reference** (`address ‖ key`).
2. A single **reference chunk** carries the frame, the exceptions and those references
   (within one chunk at the width cap) and is itself uploaded the same way. A leaf that is
   entirely zero (never written) is not uploaded — the reference chunk carries an
   **all-zero sentinel** at that index and the reader defaults it to a zero leaf (a sparse
   first publish).
3. The reference chunk's reference is published as the next state-pointer entry (§8).

**Incremental.** Given the previous publish's references, the counter it published and
the frame it packed with — kept while it still fits, so leaf boundaries hold — only the
leaves whose bytes changed are re-uploaded; unchanged leaves reuse the retained reference.
A small upload changes a leaf or two → a few writes in one `Promise.all`, not every leaf.
A context that takes a lane seeds this baseline from the state it read, so even its
**first** publish is incremental.

**The baseline must be exact.** A kept leaf goes out under an exception list computed
from the new counter, so the publish must be diffed against exactly the counter the kept
leaves encode. `LaneState` keeps that counter from its own last read or publish, apart
from the stamper's live counter, which can run ahead of it (stamps of an upload that was
never acknowledged). A lane with nothing published since keeps the baseline as it is.

## 7. Who holds a partition: lanes on the account bus

A **lane** is one partition of one batch. Who may write on it is agreed between the live
contexts of the account over the account bus (`bus-lease.ts`), by the protocol modelled
and checked in `models/bus-lease`. Nothing is written to Swarm for it.

- **The participants are contexts.** Every tab and iframe takes part for itself, under
  the name the signaling server gave its current connection. Two tabs of one browser are
  two participants, and a context that reconnects is a new one that holds nothing.
- **Holding.** A context may stamp only while it holds the lane **and** its own connection
  was confirmed by a round trip with the server within `LEASE_STOP_MS` (6 s). The server
  asks every member to ping every 2 s. The stamper carries the deadline, so an upload in
  flight stops by itself (§12). A late confirmation of the same connection ends nothing:
  the context was in the room throughout and freed no claim, so it carries on. A claim that
  reaches it while it is overdue is answered "free", and that does end the hold.
- **Taking a lane.** A context asks everyone in the room (`lane-claim`). It holds the
  lane once every other context has either answered "free" for that claim (`lane-free`)
  or has been absent from the room for `LEASE_WAIT_MS` (8 s). A context that has just
  joined cannot know who left a moment before, so it waits until it has been in the room
  that long. Two contexts claiming at once: the lower name wins.
- **Answering.** A context that does not hold the lane answers "free" at once, also for
  lanes of batches it never writes (`BusLanes`): a claimant waits for everyone present, so
  a context that answered nothing would keep every lane taken for as long as it stayed.
  The server drops a member that stops answering its ticks (a frozen tab).
- **Handover.** A holder that is not writing hands the lane over when asked: it stops
  stamping, then answers "free". A holder with an upload in flight, or one that wrote
  within `PEER_YIELD_MIN_IDLE_MS` (3 s), keeps the lane and answers "held"
  (`lane-held`); the claim is sent again with every tick. Nothing is published at a handover: every acknowledged upload already
  published the counter (§8).
- **Which lane.** A context first asks for every lane **gently**: one nobody holds is
  taken, and a holder keeps its lane and answers "held". Only when every lane has
  answered "held" does the context insist, on its device's home lane first
  (`deviceHomePartition`) and after each `NEXT_LANE_AFTER_MS` (1.5 s) on the next one.
  While any lane may still come by itself (nobody holds it, its holder has just gone, or
  a context that has just joined has not answered for it) nobody is asked to move.
- **No timers.** A holder keeps its lane for as long as its tab is open and connected. A
  tab that closes, crashes or loses its connection is seen leaving by the room, and its
  lane is free once it has been gone for the wait.
- **Disconnect and sign-out.** The context gives its lanes up and stays in the room,
  answering "free" to whoever asks.

The signaling server holds no lane state and grants nothing; it is the one authority for
who is in the room. It must be a single instance per account
([`decisions.md`](./decisions.md), 2026-11-16).

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

**State-pointer transport.** Each publish writes the pointer to the latest reference chunk
as the next **state-pointer entry**: entry 1, 2, 3, …, each an encrypted SOC at
`identifier = keccak256(topic ‖ uint64(seq) ‖ uint8(salt))`, written once and never
rewritten. A reader **searches** for the highest entry (`state-pointer-search.ts`): it
reads the powers of 8 to bracket the answer, then splits the bracket 8 ways until it is
one entry wide, each round a handful of concurrent reads. A device that knows an entry
(its own last publish, kept as the stamper's synced pointer) starts from it, and when
nothing newer exists the lookup is one round. The lookup uses no clock, so it finds a
state however long ago it was written, and an idle holder writes nothing.

Entries share the partition's reserved slot, so a later reserved-slot write in the same
bucket replaces an earlier entry. Which entries a search reads depends only on the
answer, which gives a small set (at most 60) that any later search depends on. The
publish keeps its chunks out of their buckets (§10), and `salt` (one of 8 candidate
addresses, the same choice for reader and writer) keeps those entries out of each
other's.

A search whose read of a possibly newer entry timed out is **inconclusive**: fail safe
(read-only + retry), never resume from what was found and never zero-seed. An entry is
never written twice: a holder that does not know the newest entry for sure (a publish
that failed part-way) searches before it publishes.

**Hold check before the ack.** After the upload's chunks are written and before the
counter is published, the context checks that it still holds the lane, waiting for the
next confirmation if that one is overdue. If the lane went meanwhile (a claim was answered
"free", or the connection was replaced), the publish and the ack are refused: an upload
that outlived the hold must not publish slots someone else may be using. Chunks are content-addressed,
so the failed upload is a safe retry.

A context that takes a lane it held before, with nothing published in between, reuses its
own counter and reads only the pointer (one round). The first time a context takes a lane
it reads the published counter in full, whatever the stamper's shared storage says:
another tab of the same browser may have published since.

## 9. Giving a lane up

`teardown()` (sign-out, disconnect, a drive leaving the grant) closes the context's lanes
and unbinds the stamper. Nothing is written: the counter was published with the last
acknowledged upload. An upload in flight at that moment fails at its next stamp.

## 10. Reserved-slot bucket-collision avoidance

All reserved-slot writers for partition `p` stamp `slot = p` (§3), so two of them in the
same bucket evict one another. Within a publish, `writePartitionState` picks each
counter/reference chunk in a bucket distinct from the live utilisation chunks, the
retained real chunks (incremental), and the **state-pointer entries** a search depends on
(§8), its own new entry included. A retained chunk that stands where that new entry goes
is uploaded again elsewhere first.

## 11. Utilisation reporting over the account bus

- **Reporting**: utilisation % is the fill of the fullest bucket, computed by aggregating
  the partitions' per-bucket usage.
- **Counter updates between contexts**: `utilization-updated` messages on the account bus
  ([`Account-Bus.md`](./Account-Bus.md)) — carried by its `BroadcastChannel` transport, and
  deliberately not by the signaling one, since every remote peer is another device on another
  lane. Receivers merge them **monotonically (max)** so concurrent tabs converge. Updates are
  keyed per partition and folded only by a receiver bound to that partition of that batch, so
  one partition's progress never clobbers another's.

The **presence heartbeat** of the account bus (a 20 s message naming the device) feeds
the device list's "Online" badge only. It plays no part in who holds a lane: that is
decided on the room's membership and the server round trip.

## 12. Remaining issues / accepted residuals

- **No bus, no writes.** A context that cannot reach the signaling server, or runs where
  none is configured, cannot write a partitioned batch. It stays read-only until its
  connection is confirmed.
- **A wait before the first write.** A context that has just joined the room waits until
  it has been there for `LEASE_WAIT_MS` (8 s). This applies to every page load, reload and
  new tab; the proxy starts asking as soon as it is connected, so the wait usually passes
  before the first upload.
- **Tabs of one browser do not share a lane.** Each takes its own or is handed one. Two
  tabs writing alternately on a full account hand a lane back and forth, at about one
  server round trip and one pointer read each time
  ([`decisions.md`](./decisions.md), 2026-11-17).
- **A context that is present but answers nothing blocks every lane.** A frozen tab is
  dropped by the server after a few missed ticks. A context running a build from before
  the bus lease has no answer to give and is dropped the same way, then reconnects and is
  dropped again; while it is in the room, claims wait.
- **A holder that stops mid-upload.** `stamp()` throws `PartitionLeaseLostError` once the
  stamper's deadline passes (`LEASE_STOP_MS` after the last confirmation) or the
  coordinator stopped holding the lane. A long multi-chunk upload aborts mid-stream; the
  chunks are content-addressed, so the upload fails cleanly and can be retried. A chunk
  whose request was already on the wire when the deadline passed is not modelled.
- **Clocks that run at different rates.** The margin between `LEASE_STOP_MS` (6 s) and
  `LEASE_WAIT_MS` (8 s) covers two machines whose clocks tick at slightly different
  rates over those seconds. No wall clock is compared between devices.
- **The server is trusted for membership.** Messages are end-to-end encrypted, but a
  server that hid a present context from another, or kept answering for a dead one, could
  make two contexts hold one lane or keep a lane taken.
- **`readFailed` degradation.** When the resume point exists but can't be read (transient
  network error, or a published chunk evicted from the reserve), acquire degrades to
  read-only and retries rather than resuming from zero — never re-issuing used slots.
- **No cross-version migration (stale-tab window).** The state lives under topic domain
  `swarm-id-partition-state-v2`; a build from before it neither writes nor reads it, and
  current code never touches the `v1` addresses, so a device running an earlier build
  against an account written by current code (or vice versa) resumes from stale/absent
  state. Accepted because the lib is bundled into the centrally-deployed UI apps — every
  device loads the current build fresh, so the exposure is one already-open tab spanning a
  deploy, and the data at risk overlaps the unclean-crash slots already accepted above. A
  wire-format change bumps the topic domain.

## Key constants (in `lib/src/utils/batch-utilization.ts` unless noted)

| Constant                          | Value     | Meaning                                                                                                    |
| --------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| `BUCKET_DEPTH`                    | 16        | → 65,536 buckets                                                                                           |
| `PARTITION_COUNT` (`K`)           | 2         | partitions sharing each bucket's slots                                                                     |
| `DATA_COUNTER_START`              | `= K` (2) | first data slot; reserved slots are `[0, K)`                                                               |
| `UTILIZATION_SLOTS_PER_BUCKET`    | 2         | reserved slots per bucket (one per partition)                                                              |
| `LEASE_STOP_MS` / `LEASE_WAIT_MS` | 6 s / 8 s | how long a holder may go unconfirmed / how long everyone else must be absent — `lib/src/sync/bus-lease.ts` |
| `PEER_YIELD_MIN_IDLE_MS`          | 3 s       | a holder that wrote within this does not hand over — `lib/src/sync/batch-write-coordinator.ts`             |
| `NEXT_LANE_AFTER_MS`              | 1.5 s     | once every lane is known held, one more lane insisted on per step — same file                              |
| `FANOUT` / `SALTS`                | 8 / 8     | state-pointer search width / candidate addresses per entry — `lib/src/sync/state-pointer-search.ts`        |

## 13. History (so future readers aren't misled)

- An earlier **pre-calculation** path (`calculateUtilizationUpdate`, `prepareBucketState`)
  assigned utilisation chunks to reserved slots but was dead code; the live upload path
  never used it.
- An earlier multi-device **`partition-state` feed** published the full counter as a single
  ~256 KB blob through the data path; replaced by the per-partition reserved-slot chunk
  persistence (§5–6).
- The **walked epoch-feed** that pointed at the latest counter reference-chunk (a ~32-level
  tree walk = ~27 slow gateway 404 probes on cold acquire) was replaced by the
  **state-pointer entries** (§8).
- The **resume-skew** handoff (`computeResumeCounterSkew`, a probabilistic margin against the
  previous holder's un-published in-flight writes) was specified but never implemented; it is
  superseded by the commit-ordered ack-after-publish handoff (§8), which resumes at the exact
  published counter and needs no margin.
- A per-partition **lock SOC** on Swarm named the holder and a 30 s lease, with intent
  and occupancy **beacons** beside it for gateways that served the lock from a stale
  cache, a refresh timer, an idle-yield timer and a local lease cache. Rewriting one
  address proved unreliable (#1017). All of it was replaced by lanes on the account bus
  (§7); nothing on Swarm says who holds a partition.
- The **fixed-width counter chunks** (uint16 or uint32 by batch depth, 32 or 64 chunks per
  publish, topic domain `v1`) were replaced by SBU1 leaves under `v2` (§5–6). State under
  `v1` is not read: a lane's first take under `v2` starts from zero.
