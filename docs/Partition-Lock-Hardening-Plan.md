# Partition Lock Hardening — Verify-Own-Write Plan & Contest-SOC Direction

Status: Phase 1 fully specified. The disjoint-gateway hole has two shipped mitigations:

1. **Deterministic home partition** (`deviceHomePartition`, `partition-lock.ts`): selection
   scans from `keccak256(deviceId) mod partitionCount` instead of always 0, so devices that
   cannot see each other's locks still spread across slots rather than all binding partition
   0. Probabilistic — colliding home partitions still race.
2. **Per-device intent SOCs** (`partition-intent.ts`, the symmetric-free-partition extension
   below): a fresh claim of a free partition first runs an intent round at a per-epoch
   address that forces a network retrieval (bypassing the frozen gateway cache), so
   contenders agree on one winner before binding. This is the real fix for the symmetric
   free-partition race; the holder-vs-challenger displacement-detection direction remains
   exploration.

## Problem

The 2 s guard window in `acquirePartitionLock` (`lib/src/sync/partition-lock.ts`) provides
probabilistic mutual exclusion only. After writing its claim, a device does ONE verify-read
and treats *absence of a rival* as success:

- a failed verify-read returns `"acquired"` optimistically;
- a verify-read showing a **lower** generation (stale view, or a rival's chunk that
  physically replaced ours via LWW) also returns `"acquired"`.

A device therefore never confirms its claim is actually readable on the network before
binding the partition and stamping. Dual-hold is possible until the 10 s refresh /
confirmed-displacement backstop catches it; chunks stamped by both sides in that window are
silently overwritten and never reconciled.

## Phase 1 — verify-own-write sampling (specified, ready to implement)

An **initial** claim must observe its own write (generation equality on a verify-read)
before returning `"acquired"`. Refresh of an already-live own lease keeps today's optimism —
safe because `BatchWriteCoordinator.refreshTick` demotes only on a *confirmed* foreign
holder (`isDisplaced` with a failed read keeps the lease; verified in code).

### Protocol change (`lib/src/sync/partition-lock.ts`)

- New constants: `PARTITION_LOCK_VERIFY_SAMPLES = 3`,
  `PARTITION_LOCK_VERIFY_SAMPLE_INTERVAL_MS = 1000` (exported, next to `TIEBREAKER_BYTES`).
- New outcome `"unconfirmed"` in `AcquirePartitionLockResult`: nobody contradicted us, but
  our own write never became readable; payload = our claim (peers may still see it live).
- `isRefresh = current !== undefined && current.holderDeviceId === opts.deviceId &&
  current.leasedUntil > t`, computed from the pre-write read. Liveness is required: an
  expired own claim is contestable and gets initial-claim strictness.
- After `writePartitionLock` + `wait(guardMs)`: loop up to `1 + SAMPLES` reads (interval
  wait between extras):
  - read fails → next sample
  - **equal** generation → `acquired` (own write confirmed; return `verified`)
  - **higher** generation → `lost-race`
  - foreign payload that is **live** → `lost-race` — back off, NEVER re-assert (see below)
  - stale own lower generation / expired or released foreign → next sample
  - exhausted → `isRefresh ? acquired (ourPayload) : unconfirmed (ourPayload)`
- Fixes a latent wart: only an equal-generation read returns `verified`; exhausted paths
  return `ourPayload`, so a stale self-read can no longer regress `leasedUntil` downstream.
- Do NOT write a release sentinel on `unconfirmed`: a fresh now-timestamped generation
  would out-fence a real winner we simply couldn't see. The ghost claim self-heals within
  `LEASE_TTL_MS`.

**Why back-off instead of re-assert on LWW inversion** (a rival's lower-generation chunk
physically survived over our logically-winning one): re-asserting makes *both* contenders
confirm themselves in the crossed-reads interleaving — a guaranteed dual-hold. Backing off
on any live foreign claim yields exactly one winner regardless of which chunk physically
survived. In the rare both-back-off cross, the slot heals via the 30 s TTL (correctness
over availability).

### Supporting changes

- `partition-lease.ts`: thread an optional `wait` override into both `acquirePartitionLock`
  call sites (mirrors `now`/`guardMs`); doc-comment `unconfirmed`. No logic change — both
  consumers already gate on `outcome !== "acquired"`.
- `batch-write-coordinator.ts`: comment that `refresh() === false` now includes
  `unconfirmed` and that the confirmatory `isDisplaced` read is the healthy-holder
  protection.
- Tests (`partition-lock.test.ts`, existing MockBee/MockChunkStore harness):
  - changed: "acquires optimistically when the verify-read can't confirm" → expects
    `unconfirmed` for initial claims;
  - unchanged: stale-verify split-brain and `guardMs = 0` TOCTOU known-failure tests (the
    first sample confirms equal generation — sampling deliberately does not fix those);
  - new: transient verify failure recovers by sample 2 → `acquired`; all-samples-fail with
    live own pre-read → `acquired` (refresh optimism); with expired own pre-read →
    `unconfirmed`; higher generation at sample 2 → `lost-race`; live foreign
    lower-generation during guard → `lost-race` with no rewrite; stale-own-then-current →
    `acquired` with current payload; first-read confirmation does exactly one wait.
  - `partition-lease.integration.test.ts`: `unconfirmed` → `isReadOnly: true`; refresh
    stays held when sampling can't confirm but the pre-read showed us live.
- Docs (`docs-site/.../multi-device-postage-batches.mdx`): Acquire/refresh protocol steps
  4–6 (sampled verify, equal-generation confirmation, live-foreign back-off,
  `unconfirmed`), constants table, Design assumptions → Network bullet, porting checklist
  item 3.

### What Phase 1 wins / does not win

Wins: failed-read optimism eliminated for initial claims (fail-safe to read-only); broken
read-your-writes environments (misrouted gateway, flaky node) become a *liveness* problem
instead of a *safety* problem; LWW inversion resolved at acquire time with exactly one
winner; stale-payload `leasedUntil` regression fixed. Healthy-path latency unchanged
(~2 s); degraded paths add ≤ 3 s before failing safe.

Does NOT win: the disjoint-gateway race below.

## The remaining hole: disjoint-gateway dual-acquire

Device A writes its claim through gateway/node X; device B through node Y. Each verify-read
is served from the device's own node, which holds (and keeps serving) the device's own
version of the lock SOC. Both confirm their own writes; neither sees the rival within the
guard. Both acquire. Phase 1 cannot help: *reading back your own write through your own
node proves nothing about what the rest of the network sees.*

Root cause: a single mutable address whose value can diverge across nodes. A Bee node
serves a SOC from its local store when it has one — a node that stored your write has no
reason to re-fetch the address from the network, so it may never show you the rival's
version. The read path's freshness depends on cache coherence Swarm does not promise.

**It is worse than the own-write case (verified in Bee source, see "Key Bee facts"
below):** a node also caches chunks it *retrieved* (LRU, no TTL, no invalidation), and
non-neighborhood nodes never participate in pull-sync for the address. So ANY reader
behind a gateway gets a frozen view of the lock SOC after its first read — not just the
writer. Displacement detection and Case C polling through a caching gateway degrade the
same way.

## Phase 2 direction — contest SOCs (exploration)

Intuition (AG): alongside the lock SOC, a second SOC whose address is **deterministically
derived from the lock SOC**, used to *contest* the existing holder.

### The kernel that makes this work

The disjoint-gateway failure is a *local short-circuit*: your node serves its local copy
of an address it has — because you wrote it, **or because it retrieved it once before**
(retrieved chunks are cached with no TTL and no invalidation; see Key Bee facts). But a
read of an address your node has **never seen** must trigger a network retrieval (routed
to the address's storage neighborhood, where the rival's receipt-backed push-sync placed
~3 replicas) or fail. So the fix direction is:

> Make race/displacement detection depend on reading addresses that **only the rival
> writes** and that are **fresh per contention round** (never previously retrieved by
> your node either).

That converts the problem from "mutable-SOC cache coherence" (which Swarm doesn't
guarantee) to "push-sync receipt + retrieval routing" (which is Swarm's core mechanism).

### Where the idea works directly: challenger vs holder

Derive the contest address from the holder's **device id plus a time bucket** — NOT from
the holder's generation, and not from the static lock-SOC address:

```
contestId = keccak256("swarm-id-partition-contest-v1" ‖ partition ‖ holderDeviceId ‖ epochBucket)
```

- Generation is the wrong key (research finding): every 10 s refresh tick re-runs the lock
  protocol and mints a **fresh generation**, so a generation-derived contest address would
  rotate out from under the challenger before its contest is seen. `holderDeviceId` is
  stable for the whole holdership and the challenger learns it from its (possibly stale)
  lock-SOC read; the epoch bucket provides the freshness rotation instead.
- A static address is also wrong: after the first retrieval, both nodes hold cached copies
  and re-reads are served locally forever.
- A challenger that wants partition `p` held by device `H` writes a contest SOC at
  `f(p, H, bucket(now))` (non-deferred, receipt-backed).
- The holder, on each refresh tick, polls `f(p, ownDeviceId, bucket(now))` — one address,
  which its node has never written; the first poll of each bucket is a genuine network
  retrieval. (After a contest is retrieved once it is cached — harmless, it was already
  seen.)
- Staleness edge: if the challenger's frozen lock-SOC view names an OLD holder, its
  contest goes to an address nobody polls — the challenger falls back to today's TTL /
  turn-taking wait. Liveness degradation only, never a safety problem.

This fixes the displacement-detection direction of the disjoint-gateway problem: today a
holder can also miss a rival's lock-SOC overwrite for the same stale-read reason.

**Negative-poll cost (research finding):** Bee has no fast authoritative "not found" — a
retrieval of an absent chunk fails only after exhausting peers (30 s per-peer timeout, up
to 32 origin attempts), and the error is indistinguishable from a transient network
failure. The holder's per-tick poll must therefore use a short client-side timeout
(~2–3 s): a chunk that exists in its neighborhood typically retrieves in well under that;
a timed-out poll is treated as "no contest" and simply repeats next tick. Cost: one
bounded outstanding request per 10 s tick, only while holding.

### Where it does not work directly: the symmetric free-partition race

Two contenders claiming a *free* partition cannot derive each other's contest address: the
derivation needs the rival's generation, which is exactly what neither can read (that's the
premise of the failure). A shared per-round address (e.g. derived from a time epoch) puts
both writers back on one mutable address — same divergence problem.

### Holder presence beacons — covers the join-against-an-existing-holder case (SHIPPED)

> **Shipped.** The intent SOC now doubles as a **holder presence beacon**: a holder re-publishes
> it every refresh tick at the current epoch with `leasedUntil` set (`PartitionLease.refresh` /
> `publishPresenceBeacon`, payload field `PartitionIntentPayloadSchemaV1.leasedUntil`).
> `PartitionLease.refreshHoldersFromPresence` (run in `acquire()`, unioned with the static
> lock-SOC `refreshFromSwarm`) reads every known rival's beacon for the current+previous epoch
> bucket — fresh per-epoch addresses that retrieve on the gateway where the static lock SOC 404s —
> and marks a partition **held** iff a beacon has `leasedUntil > now`. This closes the original
> symmetric/displacement gap's *mirror*: a device joining while a peer already holds a partition
> now detects that holder and picks another partition (or read-only) instead of colliding. A bare
> intent (no `leasedUntil`) is a contender, not a holder, and is still resolved by the intent
> round; an expired beacon is ignored so a lapsed partition can be taken over. `knownDeviceIds` is
> threaded into the background-sync coordinator (`sync-account.ts`) too, so it isn't a collision
> source. Residuals unchanged: registry-lag enumeration gap, absence-unprovable (timeout = no
> beacon), and the ~1/65536 reserved-slot collision — all fail to read-only / self-heal, never
> silent overwrite.

### Extension that covers the symmetric case: per-device intent SOCs

> **Shipped** in `lib/src/sync/partition-intent.ts` + wired through
> `PartitionLease.claimPartition` (gated on a fresh claim with ≥1 known rival) and the
> `knownDeviceIds` getter threaded from the proxy's account device registry. Constants:
> `INTENT_EPOCH_MS = 30_000`, `INTENT_READ_TIMEOUT_MS = 2500`. The winner = strictly-minimum
> generation; losers fall back to read-only. Description below is the original design.
>
> **Slot placement:** the intent SOC is stamped into the **contended partition's existing
> reserved slot** (`= partition index`, `< DATA_COUNTER_START`), via
> `UtilizationAwareStamper.reserveIntentSocSlot` — NOT a data slot and NOT a new reserved
> index. So it can never share a postage `(bucket, slot)` with user data (deterministic).
> Residuals, both ~1/65536 per contending pair per round and NOT closed: (1) two contenders'
> intents hashing into the same bucket → one's stamp evicted → possible rare dual-acquire on
> disjoint gateways (a verify-own-intent back-off would close it); (2) an intent overstamping
> the contended partition's own stale lock SOC (harmless) or a published state chunk (→
> read-only fallback, liveness-only). A dedicated reserved index was rejected: it does not
> remove residual (1) and costs `1/2^(depth-16)` of the batch.

The account already maintains a synced **device registry** (account-state sync, device
announce). Use it for enumeration:

```
intentId = keccak256("swarm-id-partition-intent-v1" ‖ partition ‖ deviceId ‖ epochBucket)
```

- Before (or while guarding) a claim on a free partition, a contender writes its intent at
  its own address and reads every *other known device's* intent address for the current
  (and previous) epoch bucket — all addresses it never wrote → network retrievals.
- Intents carry the generation; the existing fence decides; the loser backs off before
  binding.
- `epochBucket = floor(now / EPOCH_MS)` (TTL-sized, e.g. 30 s) makes every contention round
  use **fresh addresses**, so no node ever has a stale cached copy of a rival's intent.
- A brand-new device not yet in the registry falls back to today's behavior (guard + TTL +
  turn-taking) until its announce propagates — the common contention case is between
  registered devices.

Cost per acquire: one extra small write + (N−1) retrieval attempts (N = known devices,
small), each with a short client-side timeout (~2–3 s, run in parallel) since a no-rival
check usually targets an absent address and Bee has no fast authoritative not-found. Only
on the initial-claim path; refresh unaffected.

### The irreducible limit

Absence is unprovable on Swarm: a retrieval timeout cannot distinguish "no rival intent
exists" from "the network failed to find it" (verified — Bee collapses all peer errors
into one `storage.ErrNotFound` after exhaustion). Treating timeout as "rival may exist"
would read-only every flaky single device (unacceptable); treating it as "no rival" keeps
liveness but means the guarantee is "when the network works, rivals are seen". The honest
claim for Phase 2 is therefore: it removes *gateway cache staleness* — the systematic,
silent failure mode — leaving only genuine network partition/timeout, which the existing
TTL + refresh backstop already bounds.

## Open questions — researched answers (2026-06-12)

Researched against the Bee source checkout (`./bee`, 2.x) and bee-js. Key supporting
facts with file references are collected in the appendix below.

### 1. Holder reaction protocol on observing a contest

**Answer: yield-if-idle, ignore-if-busy. No generation bump. `IDLE_YIELD_MS` stays as the
fallback.**

- **Idle** (`activeUploadCount === 0`): run the existing `yieldIdleLease` path
  (`batch-write-coordinator.ts:710` — publish counter via `lease.release`, write the
  release sentinel, unbind under the write lock), *skipping* the `IDLE_YIELD_MS` wait. The
  contest is precisely an explicit version of the signal idle-yield currently infers from
  a 30 s silence, so it reuses the machinery and just accelerates it (worst-case handoff
  drops from ~30 s idle + TTL discovery to ~one refresh tick).
- **Busy** (upload in flight): ignore the contest. The challenger keeps waiting exactly as
  in today's Case C. No "busy ack" chunk is needed: the holder's 10 s refresh keeps
  overstamping the lock SOC with fresh stamp timestamps, and Bee's conflict rule is
  *deterministic by stamp timestamp* (newer wins, `reserve.go:141-145`), so within the
  neighborhood the live holder keeps winning over any challenger write automatically.
- **No generation bump as a denial signal**: refresh already mints a fresh generation
  every tick (`acquirePartitionLock` writes `timestampMs: now()` on each re-acquire), so
  "the holder is alive" is already continuously signalled; an extra bump channel adds
  nothing.
- `IDLE_YIELD_MS` remains the fallback for lost/unseen contests (frozen-gateway challenger
  writing to a stale holder's address, dropped chunk, etc.) — contests improve latency,
  never replace the TTL/turn-taking safety net.

### 2. Epoch bucket size vs clock skew

**Answer: `EPOCH_MS = LEASE_TTL_MS = 30 s`, unix-time aligned; writers write the current
bucket; readers poll the current AND previous bucket.**

- Lower bound: a bucket must comfortably contain one receipt-backed write (~1–2 s) plus a
  short-timeout retrieval (~2–3 s) plus the assumed ≤ ~1 s clock skew — 30 s is ~5× that.
- Upper bound: bucket length is the address-rotation period; rotation is what defeats the
  no-TTL retrieval cache, and it also bounds how long a contest written "into the past"
  stays visible. TTL-sized alignment means one contest round and one lease lifetime have
  the same horizon — easy to reason about.
- Two-bucket reads make boundary skew a non-issue: with ≤ 1 s skew against a 30 s bucket,
  a writer and reader can disagree on the bucket only within ~1 s of a boundary, and the
  previous-bucket poll covers exactly that case (plus write-to-read latency).
- One write per (device, partition, bucket) also sidesteps Bee's same-address rule —
  re-writing the same SOC address requires a *strictly newer* stamp timestamp (equal is
  rejected, `reserve.go:143-144`); fresh per-bucket addresses never hit that path.

### 3. Intents: replace or augment the lock-SOC guard?

**Answer: augment, never replace.**

- The lock SOC + generation fence + TTL is the only layer with no enumeration gap: a
  brand-new device (not yet in the synced device registry) is invisible to per-device
  intent reads but still participates correctly in the lock protocol.
- Negative intent checks are inherently ambiguous (timeout ≠ absence), so intents can only
  ever be an *additional* detection channel, not a correctness foundation.
- The guard verify also covers the same-node case for free — where it is already reliable
  (deterministic stamp-timestamp replacement on one node) and costs nothing extra.
- Layering: lock SOC for correctness, Phase 1 sampling for own-path integrity, intents for
  cross-node visibility. Each layer fails toward read-only (safety), never toward
  dual-hold.

### 4. Storage hygiene: routing and eviction collisions

**Answer: route intent/contest chunks to the partition's reserved slot in their own bucket
(the counter-chunk mechanism), nonce-avoid the lock-SOC buckets, accept the residual
2⁻¹⁶-class collisions.**

- Overstamping eviction is real and deterministic: two chunks stamped by the same batch at
  the same `(bucket, slot)` → the newer stamp timestamp **evicts the older chunk's data
  entirely** (`reserve.go:221-237`, old chunk removed from the chunkstore). So an
  intent/contest chunk routed to a reserved slot evicts whatever lived there.
- Therefore: register each intent address with the stamper before upload (the existing
  `markReservedUtilizationChunk` routing — `batch-utilization.ts`), so it overstamps
  `reserved slot = partition` in its own bucket and never consumes data-lane slots or
  bumps counters.
- Lock-SOC bucket collision must be avoided deterministically: derivation appends a uint8
  nonce, incremented until `bucket(address) ∉ lockSocBuckets`. Both writers and readers
  compute the same nonce (lock-SOC addresses are deterministic per account); expected
  iterations ≈ 1 (collision chance `K/65536` per try).
- Residual collisions are accepted and documented: two intents in the same bucket's
  reserved slot (≈ 2⁻¹⁶ per pair per round) — newer evicts older, which can hide a rival's
  intent for one round (the guard + TTL layer still applies); an intent landing on a
  counter chunk's bucket evicts that counter chunk from the reserve — transient, since
  counter chunks are re-uploaded on every save and resumable from the local cache.

### 5. Liveness canary (holder reads its own next-epoch intent address)

**Answer: drop it — it is either meaningless or already covered by receipts.**

- A self-read through your own node proves nothing: if your node stored the write, the
  read short-circuits locally (`netstore.go:96-100`) and never touches the network path
  the canary was meant to test.
- A poll of an address that usually does not exist has the negative-check cost problem
  (hangs until client timeout, every tick).
- The push-sync **receipt already is the network-path proof**: it is issued only after the
  chunk is stored in the reserve of a proximity-verified peer in the address's
  neighborhood, with ~3 replicas via multiplexed forwarding (`pushsync.go:268-287`, `:55`).
  A receipt-backed intent/lock write therefore proves durable network placement strictly
  better than any read-back canary could.

## Consequences of overstamping eviction for the CURRENT implementation (2026-06-12)

The eviction rule behind answer 4 (same batch, same `(bucket, slot)` → newer stamp
timestamp **deletes** the older chunk from the reserve) is not only a constraint on the
future intent design — it exposes two real gaps in the shipped protocol. The codebase
clearly knows about the hazard (utilization saves avoid lock-SOC buckets; the
partition-state publish avoids its own lock bucket and self-collisions,
`partition-state.ts:215`; data slots and reserved slots are disjoint by the slot formula),
but two paths slipped through:

### Gap 1 — the release-path feed SOC consumes an unrecorded data slot

`writePartitionState` (partition-state.ts:185-252) extracts and uploads the counter
snapshot (steps 1–2), **then** writes the epoch-feed SOC (step 3,
`BasicEpochUpdater.update` → `uploadSOC`) — and `clearReservedUtilizationChunks()` runs
*before* the feed write (line 238), so the feed SOC takes the **data-slot path** in
`UtilizationAwareStamper.stamp()`: it occupies `slot(j)` in its bucket and bumps the live
counter to `j+1` — *after* the snapshot was already extracted with `j`.

Consequence: the next holder seeds the published counter and its **first data chunk in
that bucket lands on the feed chunk's exact slot** → newer stamp evicts the feed-update
chunk from the reserve. A later takeover walking the feed then misses the newest entry
and resumes from an **older** (or no) counter → bulk slot reuse → silent overwrite of the
partition's data. Probability per handoff ≈ `n/65536` (n = chunks the next holder stamps)
— small per cycle, but systematic, accumulating, and the failure is severe and silent.
This also falsifies the docs-site claim that "an orderly hand-off never re-uses a slot."

Fix sketch: the feed SOC's address is computable *before* upload (identifier =
f(topic, epoch), owner = backup signer; payload-independent). Snapshot the counter from a
copy with the feed chunk's bucket pre-incremented (`snapshot[b] = live[b] + 1`), extract
and upload state chunks from the copy, then let the feed stamp consume `slot(live[b])` —
snapshot and post-release live state then agree. (Routing the feed SOC to the reserved
slot is the alternative, but needs its bucket added to the publish's `claimedBuckets`
before the state chunks are placed.)

### Gap 2 — utilization saves can evict published partition-state chunks, and the
### zero-counter fallback amplifies a 1-chunk loss into a full-partition overwrite

Published state chunks (counter chunks + reference chunk) sit at
`(random bucket, reserved slot p)`. Subsequent utilization saves by the next holder
(`saveUtilizationState` / `flush`) overstamp reserved slot `p` in *their* buckets,
nonce-avoiding clean utilization chunks and lock-SOC buckets — **but not the published
state chunks' buckets** (unknown to that code). A collision evicts a published state
chunk (~`33 × 32 / 65536` ≈ 1.6 % per full save, accumulating over a holdership).

The amplification: on the next takeover that actually needs that publish (typically
Case D — the interim holder crashed without publishing), `readPartitionState` hits the
missing chunk and its catch block **seeds a fresh zero counter**
(partition-state.ts:161-168, deliberately, as "resilience") → the taker resumes every
bucket at `j = 0` → re-issues every used slot → each new chunk evicts the partition's
existing data chunks network-wide. A one-chunk eviction becomes a whole-partition data
loss.

Fix sketch, two independent layers:
1. **Fail safe instead of zero-seeding**: when the feed HAS an entry but its chunks can't
   be read, abort the acquisition (read-only this round, retry later) instead of seeding
   zero. Zero-seed only when the feed provably has no entry. This alone downgrades the
   failure from "overwrite everything" to "delayed takeover".
2. **Bucket avoidance**: persist the published state-chunk buckets (the publisher knows
   them; a taker learns them from the reference chunk — ≤ 65 buckets) and include them in
   `claimedBuckets` for `flush()` and `saveUtilizationState`.

### Gap 3 (minor, verify) — publish chunks can evict the holder's own on-Swarm
### utilization chunks

The publish's `claimedBuckets` starts from only the lock bucket, so a state chunk can land
in a bucket occupied by a current on-Swarm utilization chunk (same reserved slot p) and
evict it. Likely benign — cross-device counter resume goes through the partition-state
feed, and `loadUtilizationState` reads only the local IndexedDB cache — but worth
verifying that no path ever re-downloads utilization chunks by their `contentHash` from
Swarm before relying on it.

## Fix plan — partition-state eviction gaps (2026-06-12)

One branch (`fix/partition-state-eviction`), three commits in this order — each
independently shippable, ordered by value/risk. No wire-format changes anywhere: fix B is
reader-local arithmetic and fix C is writer-local placement, so old and new clients
interoperate (an old client simply keeps the old bugs).

Verified call graph: `readPartitionState`/`writePartitionState` are consumed only by
`PartitionLease.claimPartition`/`release` (plus the public lib export — no UI/demo
usage). The epoch SOC identifier derivation is inline in
`proxy/feeds/epochs/updater.ts:161-163` (`keccak(topic ‖ keccak(start ‖ level))`).
`AsyncEpochFinder.findAtWithMetadata` already returns the winning entry's `epoch`.

### Commit A — fail-safe counter reads (kills the amplifier)

`lib/src/sync/partition-state.ts`:

- `readPartitionState` return type gains a discriminated failure:
  `{ readFailed: true }` (no `localCounter`, no `referenceHex`). Emitted from the
  current catch block (lines 161-168) — i.e. the feed HAS an entry but the reference
  chunk or any counter chunk is unreadable. The no-entry path (`!refBytes`) keeps
  returning a zero counter (legitimate Case A/B fresh seed).
- `PartitionLease.claimPartition` (`partition-lease.ts:283`): on `readFailed`, return the
  read-only `AcquireResult` WITHOUT running the lock protocol (do not write a claim over
  a partition whose resume point is unknown). The coordinator's existing
  `acquireWithSlotWait` retry cadence (~10 s) provides the retry loop.
- Tests: flip `partition-lease.integration.test.ts:184` ("returns a fresh zero counter
  when the feed entry is unreadable" → "fails the read; claimPartition degrades to
  read-only without writing the lock"). Add: missing ONE counter chunk (not just the
  reference chunk) → same; feed genuinely empty → still zero-seeds and proceeds.

### Commit B — account for the release-path feed SOC slot (reader-side bump)

Insight that makes this trivial and backward compatible: the reader can reconstruct
exactly which slot the feed SOC consumed — it sits at `slot(snapshot[bucket])` of the
bucket of the feed entry's own SOC address. So instead of changing the publish (which
would need format versioning), the READER compensates:

- Extract the identifier derivation from `updater.ts:161-163` into an exported helper
  (`makeEpochIdentifier(topic, epoch)`) and add a small
  `epochSocAddress(topic, epoch, owner)` (keccak(identifier ‖ owner), same formula as
  `lockSocAddress`).
- `readPartitionState`: use `finder.findAtWithMetadata(now)` instead of `findAt`; after a
  successful counter reconstruction, compute the entry's SOC address from the returned
  `epoch`, and `localCounter[toBucket(addr)] += 1`.
- Correctness notes (encode as comments + tests):
  - the `unchanged: true` short-circuit must NOT bump — the local live counter already
    includes the bump (the stamper incremented it when the feed SOC was stamped);
  - only the latest entry needs compensation: any earlier entry was compensated by the
    reader that consumed it, and a same-device re-acquire uses the live counter;
  - for pre-fix publishes this exactly fixes the collision; for hypothetical future
    writer-side accounting it would waste one slot in one bucket — harmless, so the rule
    is unconditional (no format detection).
- Tests (`partition-lease.integration.test.ts` round-trip): after
  `writePartitionState`, assert `readPartitionState` returns a counter where the feed
  entry's bucket equals the publisher's LIVE post-release counter (not the snapshot);
  assert a next-holder stamp into that bucket gets a fresh slot (no collision with the
  feed SOC's `(bucket, slot)`).

### Commit C — bucket avoidance for reserved-slot writers

Three placement rules, all same-partition (`slot p`) since cross-partition slots are
disjoint:

1. **Saves must avoid the published state chunks.** Persist the protected bucket set per
   `(batchId, partition)`:
   - `writePartitionState` already knows every bucket it used (`claimedBuckets`) — return
     it; `PartitionLease.release` hands it to the stamper.
   - `readPartitionState` derives the same set from the reference chunk (counter-chunk
     addresses = first 32 bytes of each 64-byte ref) plus the reference chunk's own
     bucket — return it; `claimPartition` hands it to the stamper.
   - Stamper (`UtilizationAwareStamper`): hold it in memory
     (`setProtectedStateBuckets`), persist alongside `syncedReferences` in the
     utilization-store metadata (additive schema field `stateChunkBuckets` keyed by
     partition; `storage/utilization-store.ts`), restore on create.
   - Consume it: `flush()` adds it to `claimedBuckets` (next to the lock-SOC buckets),
     and expose `getProtectedBuckets()` (= lock buckets ∪ state buckets) so the
     `saveUtilizationState` call sites pass the union as `reservedBuckets`.
2. **The publish must avoid the live clean utilization chunks** (Gap 3 hardening, even
   though nothing downloads them today — verified: no Swarm read path for utilization
   chunks exists, `contentHash` is dedup bookkeeping only): seed `writePartitionState`'s
   `claimedBuckets` from the stamper's clean-chunk buckets when available (pass through
   from `release`, which has the `UtilizationAwareStamper`).
3. Comment the residual accepted risks at the derivation sites (intent-vs-intent class
   collisions, ≈ 2⁻¹⁶ per pair per round).

Tests: plumbing-level — after a publish + reload, `flush()`'s claimed-bucket set includes
the persisted state buckets (assert via `getProtectedBuckets()`); `writePartitionState`
skips a bucket occupied by a clean utilization chunk (craft via the random-key re-roll
loop with a stubbed RNG or by asserting `claimedBuckets` input).

### Docs (same branch)

`docs-site/.../multi-device-postage-batches.mdx`:

- Partition-state feed section: replace "A failed counter read falls back to a fresh zero
  counter rather than aborting" with the fail-safe semantics; document the reader-side
  feed-bucket bump as part of the read algorithm (porting-relevant: a port that skips the
  bump re-introduces the feed-chunk collision — reader-local, so no interop break, but
  spec it).
- Lease lifecycle / Case D: "resume from the last published counter, +1 in the feed
  entry's bucket".
- The "orderly hand-off never re-uses a slot" claim becomes true; keep it, with the bump
  as the reason.

### Verification

1. `pnpm --filter @snaha/swarm-id test` — flipped + new integration tests green.
2. `pnpm check:all`; prettier on touched files.
3. Manual, local bee cluster: two browser profiles (agent accounts) on one batch; device A
   uploads + releases (idle yield), device B takes over and uploads into the same buckets;
   then kill B mid-hold and let A reclaim (Case D) — assert A's resume counter ≥ B's
   published counter and that previously uploaded content stays retrievable (the
   regression that Gap 1/2 would corrupt).
4. Negative: with one published counter chunk manually deleted from the queen's store,
   the taker goes read-only and retries instead of zero-seeding (commit A behavior).

## Appendix — key Bee facts (verified in source, bee 2.x)

| Fact | Evidence |
| --- | --- |
| Same-address SOC conflict: replace iff strictly newer **postage stamp timestamp**, else `ErrOverwriteNewerChunk`. Deterministic, not arrival order. | `pkg/storer/internal/reserve/reserve.go:139-219` |
| Stamp-index (overstamp) collision, different addresses: newer stamp timestamp evicts the older chunk's data entirely. | `reserve.go:221-237`, `chunkstore.go:97-119` |
| Stamp timestamps are minted by the client at stamping time (`Date.now()`), so the network's LWW aligns with the generation fence under the clock-sync assumption. | bee-js `src/stamper/stamper.ts:48` |
| Reads short-circuit on local store; network retrieval only on local miss. | `pkg/storer/netstore.go:96-105` |
| Successfully retrieved chunks are cached locally (LRU on access time, **no TTL, no invalidation**) — a gateway's view of a mutable SOC freezes after first contact. | `netstore.go:106-124`, `pkg/storer/internal/cache/cache.go:128-182` |
| Pull-sync converges replicas on the highest stamp timestamp **within the storage neighborhood only**; non-neighborhood nodes never update their copies. | `pkg/pullsync/pullsync.go:379-390`, `pkg/storer/reserve.go:295` |
| Push-sync receipt = chunk stored in the reserve of a proximity-verified neighborhood peer; ~3 replicas via multiplexing (`maxMultiplexForwards = 2`). | `pkg/pushsync/pushsync.go:268-287, :456-463, :55, :567-603` |
| Retrieval of an absent chunk: per-peer timeout 30 s, up to 32 origin attempts, all errors collapse into `storage.ErrNotFound` — absence is indistinguishable from failure. | `pkg/retrieval/retrieval.go:125-130, :269-287` |
| Bee notifies GSOC subscribers when a SOC push passes through a node responsible for the address — a possible future *notification* channel if contest addresses were mined into the holder's node's neighborhood (requires knowing the holder node's overlay + a gateway exposing the GSOC API; out of scope here, needs its own research). | `pkg/pushsync/pushsync.go:242-248`, `pkg/gsoc` |
