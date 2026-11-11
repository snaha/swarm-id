# Decisions

Architecture and product decisions, newest first. One entry per decision: the
context in a line or two, the decision, and why. Append only; a reversed
decision gets a new entry that names the old one. Code comments describe the
present and may point at an issue or PR; the reasons live here.

A PR that makes or changes a decision adds the entry in the same PR.

## 2026-11-11 A context trusts the lease record only as far as its rows go

**Context.** A review of the lease stack found paths where a context acted on the lease
record without the counters behind it. A context followed the record's new reference
whatever the rows held, so a sibling that published without flushing (account sync) or
whose flushes failed left it stamping slots the sibling had used. An upload finishing after
a sibling cleared the record off-lock wrote the claim back and was acked. Adopting the
recorded lease pushed its expiry out by a full TTL with no write to Swarm, which a chain of
one-shot writers could repeat past the lock's expiry. A teardown after an upload's last
stamp let it ack on the strength of the teardown's detached release.

**Decision.**

- A reference this context did not publish is followed only when the rows name it;
  otherwise the context drops its lease and reads the lane's state from Swarm. Account sync
  flushes its stamper like the proxy.
- Under the write lock, a held lease whose record no longer names its claim is lost: the
  context demotes and the section fails before its ack.
- Adopting the recorded lease keeps the recorded expiry.
- An upload whose lease is gone when its operation returns fails with
  `PartitionLeaseLostError`.
- A teardown's release is flushed to the rows, like an idle yield's.
- A full publish is still checked against the last published counter.
- A publish keeps its new chunks out of the buckets of the state it replaces, leaves and
  reference chunk alike, until its own pointer lands.
- A cold acquire binds the larger, per bucket, of the counter it downloaded and the rows
  this device holds for the lane. The publish baseline stays the downloaded counter.

**Why.** The record says which claim and which publish; only the rows, or Swarm, say which
slots are used. Reading the state back costs a download in the failure cases and nothing
otherwise, where a context that guesses re-issues acked slots. The expiry in the record is
the lock's on Swarm, and only a renewal may move it. A failed upload is retried safely,
its chunks being content-addressed; an ack without a publish is not recoverable. A publish
that fails partway must leave the previous state readable, since the pointer still names
it. And a counter that skips slots only costs capacity, where one that goes back
overwrites a chunk, so the rows are a floor whatever the pointer says.

## 2026-11-10 One context of a storage partition renews its lease

**Context.** Every tab, iframe and the SwarmID tab of one storage partition holds the
same lease and ran its own refresh tick, so N contexts made N lock-SOC renewals, N pairs
of presence beacons and N state-pointer heartbeats per interval. Each measured idleness
from its own clock, and learned of a lost lease only from its own renewal.

**Decision.** Every context still ticks, and claims the interval's renewal in the lease
record (`renewingAt`) in one atomic update; a context that finds a claim younger than half
an interval takes the recorded expiry instead. A lease near expiry renews regardless, so a
renewer that closes or keeps failing costs one interval. A renewer that finds the lane
taken clears the record off-lock, and a sibling's tick invalidates its stamper on seeing
the claim gone. The idle yield measures from `activeAt`, written as each upload starts and
ends.

**Why.** No election and no messaging: the record is already read at every tick, and an
IndexedDB transaction is the arbiter. Half an interval tolerates tabs' timers running out
of phase while the claimant's own next tick still finds its claim lapsed. The off-lock
clear is what keeps a sibling's long upload from stamping a lost lane until it lets go of
the write lock, which the renewer's demote would otherwise wait for.

## 2026-11-10 The publish baseline is stored, apart from the cache rows

**Context.** What an incremental publish diffs against — the leaf references,
the frame and the counter as published — lived in each tab's lease object. A
reload or a sibling tab's publish lost it, so that publish went out in full,
and a cache-hit claim rebuilt it from the cache rows, which an upload whose
publish failed leaves ahead of the published leaves. Supersedes "An
incremental publish needs rows that are exactly its baseline".

**Decision.** The frame and leaf references ride on the rows' `stateReference`
and a copy of the counter as published is kept in its own object store,
written in the transaction that records the reference. A lease with no
baseline loads it, and uses it only when it belongs to the reference the lease
record names. A cache-hit claim downloads nothing. The `exact` flag is gone.
A lane with no publish on either side is adopted from the record.

**Why.** A diff against what was actually published cannot be wrong about
which leaves changed, whatever has happened to the rows since; a flag saying
the rows happen to equal it was bookkeeping that could drift. A stored copy
was preferred to a changed-bucket bitmap for the same reason, and it keeps the
publish's diff and its monotonicity tripwire as they were. It costs 256 KB per
drive and a second write of each changed row.

## 2026-11-10 A flush is one transaction, and runs before the publish

**Context.** A flush wrote its rows one by one and the metadata that describes
them in separate transactions, after the publish. A tab dying midway had to be
planned for at every step: the generation was bumped before the first row and
after the last, the lane was cleared before a full rewrite, and rows stopped
being called exact before a data row went in. Supersedes that part of "A tab
folds in the cache rows another tab wrote".

**Decision.** The rows and their metadata go in one IndexedDB transaction
(`UtilizationStoreDB.writeRows`), which also refuses to land if another tab
wrote the rows since this one last read them. The coordinator flushes before
it publishes; the flush after the publish only records its reference.

**Why.** A flush that lands whole or not at all has no intermediate state to
certify wrongly. Flushing first means the shared rows always hold every slot a
publish may have named, whichever point a tab dies at, and it costs nothing in
latency: both flushes already finished before the caller's promise resolved.

## 2026-11-10 A storage partition's lease is one record in IndexedDB

**Context.** Every tab of a storage partition has the same device id, so to the
lease protocol they hold one lease. Each tab kept its own `PartitionLease`, and
a `localStorage` cache that every tab overwrote from its own copy. An idle
tab's heartbeat re-pointed the state pointer at its older reference; its idle
timer released a lane a sibling was uploading through; two tabs torn down
together published the older counter last; and the SwarmID tab's account sync
published on the lane without telling anyone.

**Decision.** The lease a partition holds is one record per account and batch,
in the IndexedDB metadata next to the counter rows (`leaseRecordIn`), written
under the write lock at every claim, publish and re-pin. A context brings its
lease up to the record on taking the lock, drops it when the record names
another claim or none, and a refresh tick reads the record before it touches
Swarm and writes back only the expiry. Teardown releases, and clears the
record, only for the context whose lease the record describes. The
`localStorage` lease cache is removed. Plan: `docs/Lease-State-Plan.md`.

**Why.** Copies that have to be reconciled were the defect. IndexedDB rather
than `localStorage` because the counter rows are already there, the
coordinator already reads that metadata on taking the lock, and one store
cannot disagree with itself after a crash or an eviction. Nothing on the write
path needs a synchronous read.

## 2026-11-10 A tab folds in the cache rows another tab wrote, on taking the write lock

**Context.** The counter rows in IndexedDB are shared by every tab of a storage
partition, each with its own stamper and its own table in memory. A tab judged
the rows by what it remembered of them, and relied on a broadcast to learn of a
sibling's writes.

**Decision.** A flush bumps a generation on the rows before its first row and
after its last. On taking the cross-tab write lock, and again at a flush, a tab
that finds a generation it did not write folds the rows into its table by
per-bucket maximum; an unbound stamper takes the rows. (#918)

**Why.** Counters only grow, so a maximum can never lower either side, where
rewriting the rows from one tab's table erased a sibling's counters wherever
that tab had missed them. The lock is the one point a tab can read the rows
knowing nobody is writing them.

## 2026-11-10 An incremental publish needs rows that are exactly its baseline

**Context.** An upload whose publish failed still flushes its stamps, so the
cache rows can be ahead of the leaves the synced reference points to. A
cache-hit claim seeded the publish baseline from those rows.

**Decision.** The rows' certification says whether they hold exactly the
counter their reference names. A cache-hit claim seeds an incremental baseline
only then; otherwise it still resumes from the rows and its first publish goes
out in full. Rows stop being called exact before a data row is written, not
after. (#918)

**Why.** The exception list rides in the reference chunk, computed from the
live counter. A leaf retained from an older counter can hold an in-band field
for a bucket the list calls an exception, and the decoder rejects that: every
reader goes read-only on the lane until the holder re-pins, or for good if it
is gone.

## 2026-11-10 Cache rows are certified by the flush that writes them

**Context.** The rows hold a single lane's counter, and binding a lane replaced
the table without rewriting them. The synced reference was recorded at the
publish, one write ahead of the rows, and kept one per partition.

**Decision.** One reference certifies the rows, for the lane they describe, and
it is committed by the flush that writes the rows it names. A bind to a table
the rows do not hold rewrites every row. The adopt fast path requires the rows'
reference to be the one the cached lease last read or published. (#918)

**Why.** A cold start could otherwise resume from a table mixing two lanes, or
from rows one write behind the published counter, and re-issue slots an
acknowledged upload had used.

## 2026-11-10 Partition state is published as SBU1 leaves, with no depth on the wire

**Context.** The counter was serialized as fixed uint16 or uint32 chunks chosen
from the batch depth, so a dilute across depth 31 to 32 changed the published
layout and a peer on a stale record misparsed it. (#463)

**Decision.** The counters are packed with the leaf encoding of Nectar's SBU1
usage snapshot: a frame (base and bit width) chosen per publish from the
counters' spread, deltas packed to that width, outliers as exceptions. The
frame rides in the reference chunk under topic domain `v2`. The cache rows are
one fixed uint32 layout at every depth, and a drive's write path is rebuilt
when its stamp's depth changes. State under `v1` is not read. (#918)

**Why.** Nothing published or cached depends on the depth, so a dilute changes
no byte, and a takeover reads 8–24 chunks instead of 33 or 65. Not reading `v1`
means a lane's first acquire under `v2` resumes from zero; accepted while the
version is `0.x`. The widest delta is 23 bits, so that the frame, 128
exceptions and a reference per leaf fit one chunk.

## 2026-09-21 Stamper-mode uploads honour the caller's `deferred`

**Context.** Every data and chunk upload in stamper mode forced
`deferred: false`, so a caller's `true` was silently dropped.

**Decision.** Stamper mode passes the caller's `deferred` through. (#784)

**Why.** Setting the flag from `getNodeInfo()` is the documented remedy for a
node that needs it, and dropping it made the upload time out anyway.

## 2026-09-17 A per-call timeout bounds the whole round trip

**Context.** `requestOptions.timeout` reached only the Bee request inside the
iframe, while the client's own round-trip timer kept the constructor default.

**Decision.** The per-call value bounds the client's round-trip timer as well
as the Bee request. (#775)

**Why.** A per-call value above the default still rejected at the default,
with the same message the caller was trying to escape.

## 2026-09-11 Balances are read through the chain's own endpoint

**Context.** #534 read balances through the wallet wherever it was on the
selected chain, for the figures the wallet itself shows.

**Decision.** Balances are read through the chain's own endpoint, never the
wallet. Reverses #534.

**Why.** Over WalletConnect every read is a relay round trip to the user's
phone, and a session left holding responses nobody is waiting for redelivers
them for the rest of its life.

## 2026-09-11 `AlreadyKnown` from a node is a success

**Context.** `AlreadyKnown` took the write retry's rethrow branch.

**Decision.** It counts as a successful broadcast: the node has the
transaction.

**Why.** Once a send reached any mempool, every resend of those bytes failed,
the user's Try again included, because the nonce and the payload do not change
on their own.

## 2026-09-04 One saved session per dApp origin

**Context.** Storage is partitioned by iframe origin and top-level site, and a
site ignores the subdomain, so two dApps under one site share a store. The
saved session lived under one fixed key.

**Decision.** The handover is saved under
`partitionSessionStorageKey(parentOrigin)`. (#671)

**Why.** The second dApp to connect overwrote the first one's session, and
both needed the popup again on every reload.

## 2026-09-04 A refused handover ends the connect attempt

**Context.** A payload that failed the schema left the proxy's spinner running
while the popup, which cannot tell it was refused, said "Connected!". It was
also rejected further on as coming from an unauthorized origin.

**Decision.** A refused handover ends the attempt it belongs to, and the log
names the schema failure. (#587, #678)

**Why.** A refused handover is the ordinary way a version-skewed identity
deployment fails, and it must not read as an origin bug. Only closing the
popup cleared the spinner, which the user had no reason to do.

## 2026-09-04 Lease lanes are per (batch, partition)

**Context.** One partition-lock namespace was shared across all of an account's
batches.

**Decision.** Lock, intent and occupancy addresses are derived per (batch,
partition), and a `lease-request` names its batch. (#589)

**Why.** A holder on one batch and a waiter on another contend for nothing.

## 2026-09-04 A connected app's membership merges on the fields that state it

**Context.** One clock bumped by every write ranked the entry, so a drive
picked on a stale copy outranked a revoke and restored the credential it had
cleared. A dApp-initiated Disconnect wrote `lastConnectedAt: 0`.

**Decision.** Membership merges on
`max(revokedAt, disconnectedAt, lastConnectedAt)`, and a Disconnect sets
`disconnectedAt`. (#681, #682)

**Why.** A zero loses every merge, so the entry's old timestamp came back on
the next fold and the Disconnect never reached a peer.

## 2026-09-03 Only a genuine sign-in re-activates a device

**Context.** `mergeDevices` stamped our own entry on every poll, and the
announce path read a tombstoned self as "not yet announced".

**Decision.** A poll touches neither `removedAt` nor `lastSignedInAt`.
Re-activation happens at `reactivateThisDevice`, the one seam that can tell a
user unlocking their account from a timer. A tombstoned self stands down.
(#337, #611, #652)

**Why.** Clearing the tombstone undid every removal on the next round, and
republishing without it resurrected the device on every peer. Stamping the
field made every fold a byte change, which a proxy holding a partition
answered with a bus delta and a stamped feed write.

## 2026-09-03 Device names and app grants have clocks of their own

**Context.** Three dApps on one Safari are three partition devices, and a
corrected label moves neither `lastSignedInAt` nor `removedAt`.

**Decision.** A device's name merges on its own `nameUpdatedAt`, and a
connected app's grant field by field on its own clocks. (#643, #663)

**Why.** Without a clock a corrected row ties with every stale copy of itself
and loses, so every other context keeps the stale name forever.

## 2026-09-01 A partitioned session survives a reload

**Context.** The handed-over session lived only in memory, so every page load
re-ran the connect popup. On Safari, where partitioned is the ordinary mode, a
plain reload was a logout.

**Decision.** The handover is persisted in the partition's own store, under
the same 30-day deadline as the unpartitioned path. A restored session comes
up at once and checks the account's Swarm state in the background. (#635)

**Why.** The deadline cannot see a revoke made while the tab was closed, and
persisting removes the re-handshake that caught it. Trusting local storage
first and learning of a remote revoke after is what the unpartitioned path
already does.

## 2026-09-01 A session requires the account projection

**Context.** A payload with no account built a "download-only" session with no
stamps and no `derivationKey`.

**Decision.** `AuthDataSchema` requires the projection, so such a payload is
refused. (#642)

**Why.** Without a `derivationKey` a session derives no bus topic, joins no
room and can never be told it was revoked. No session beats a session nothing
can reach.

## 2026-09-01 An endpoint that cannot be identified gets no bridged rail

**Context.** A genesis probe that blipped was routed like a proven dev chain.

**Decision.** "Not proven mainnet" is not "proven dev": an unidentified
endpoint gets no bridged rail.

**Why.** A wallet pointed at real Gnosis was offered a local rail that takes a
deposit on a chain the destination has never heard of.

## 2026-08-31 The auth transport follows the storage mode

**Context.** `connect()` picked its transport by user agent, so a partitioned
Chromium was put on the storage-event path while only WebKit got the handover.

**Decision.** The iframe's storage probe decides, and `proxyReady` reports it.
(#613, #630)

**Why.** A partitioned iframe can only be reached by the popup it opened
itself, and no user agent says which mode an iframe is in.

## 2026-08-31 A handover carries only what the grant names

**Context.** The partitioned handover shipped every stamp with its signer key.

**Decision.** The handover is limited to the stamps this app's grant names.
(#578)

**Why.** The session runs in a context embedded by an arbitrary dApp page. It
can only spend the drives it was granted, so the other signer keys are pure
exposure.

## 2026-08-31 The payment method is chosen before any balance read

**Context.** The funding seam was the only place to choose, and it is raised
only when the owner address is short.

**Decision.** The chooser precedes the balance read. (#619)

**Why.** An account holding funds from an earlier attempt was committed to the
built-in engine with no way to say otherwise, and a purchase that could not
reach the chain failed before the question was put.

## 2026-08-27 The signaling room topic travels in the `join` frame

**Context.** The topic travelled as `/?topic=<hex>`.

**Decision.** It goes in the first frame, and the URL form is refused. (#577)

**Why.** The topic is the room capability, and query strings are recorded by
every ingress and proxy access log.

## 2026-08-27 A device registry merge is saved when any field moves

**Context.** The refresh persisted a merge only when the list got longer.

**Decision.** A merge that moved any field is saved, `lastSignedInAt` and
tombstones included.

**Why.** `activeDeviceIds` prunes the rival set on those fields, so a peer the
roster shows as live could age out of the stored copy, miss the intent round
and dual-acquire.

## 2026-08-26 Bus channels are per account

**Context.** The local channel was one origin-wide constant, harmless while the
only traffic was batch-scoped counters.

**Decision.** The topic comes from `deriveBusContext`, the same value the
signaling transport uses as its room.

**Why.** `account-delta` carries `postageStamps[].signerKey`, so co-resident
accounts must not share an unencrypted channel.

## 2026-08-26 A `lease-request` ranks the holders

**Context.** One waiter's `lease-request` made every idle holder yield.

**Decision.** Every holder takes a rank from the request id, and holders
further down the order stand down on a claim. The schema drops an id that does
not parse to a rank. (#576)

**Why.** An id that parses to NaN or a negative puts every holder at rank 0,
which is the same stampede, silently.

## 2026-07-13 Plain Merkle trees use 128-ref intermediate chunks

**Context.** Plain uploads built intermediate chunks with a 64-ref fanout.

**Decision.** The plain Merkle layout matches what a stock node builds, 128
refs per intermediate chunk. (#417)

**Why.** Bee could not join trees built with a 64-ref fanout.

## 2026-07-04 Sync is wired app-wide in the root layout

**Context.** Publish and fold were wired only in `/dev`.

**Decision.** The root layout owns the publish hook. (#389)

**Why.** The shipping app never synced, and a partitioned dApp iframe learns
about a revoke no other way.

## 2026-07-03 The state pointer is a reserved-slot SOC

**Context.** The partition's state pointer was an epoch feed entry in a data
slot.

**Decision.** It is a reserved-slot SOC that overstamps the partition's
reserved slot, like the counter chunks.

**Why.** It consumes no data slot, so the snapshot has nothing to compensate
for.

## 2026-06-29 One kind of account, one nested document

**Context.** Accounts had distinct types (passkey, ethereum, agent), with flat
identity, app and stamp stores joined by pointers.

**Decision.** There is one BIP-39 seed account that owns its connected apps and
postage stamps inline. Access methods live in the device-local vault. (#377)

**Why.** The types were only different ways of protecting the seed.

## 2026-06-26 Device discovery is an append-only roster

**Context.** Devices shared one mutable registry document and one snapshot.

**Decision.** An append-only roster handles discovery, and each device
publishes its own state feed, folded on read.

**Why.** On a high-latency or caching gateway, read-merge-overwrite dropped a
peer's just-written entry.

## 2026-06-16 A release sentinel is generation-fenced

**Context.** A stale release could write a sentinel over a successor's claim.

**Decision.** The sentinel carries the generation of the claim it releases.
(#349)

**Why.** A fresh-generation sentinel reads back as a higher generation, which
is a false lost race and a spurious read-only session.

## 2026-06-12 The theme key is `swarm-id-theme`

**Context.** Earlier deployments auto-persisted the OS-resolved theme under
`swarm-ui-theme` on every first visit.

**Decision.** The preference lives under `swarm-id-theme`, and everyone starts
on `auto`.

**Why.** The old key's value cannot be told apart from an explicit user choice.
