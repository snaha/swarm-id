# Multi-drive support for apps: plan

Status: **draft** (2026-10-15). All decisions are taken; what is left to verify is at the
end. Tracked in [#862](https://github.com/snaha/swarm-id/issues/862); second attempt after
[#537](https://github.com/snaha/swarm-id/pull/537).

## Goal

An app can be granted **any combination of regular and scratch drives, or all of the
account's drives**, at connect time or at any time later, and can target any granted drive
on a write. A **scratch drive** lets an app overwrite its own earlier data instead of
filling the batch.

A drive is a postage batch. Today an app session spends exactly one: its per-app override
(`ConnectedApp.postageStampBatchID`) or else the account default
(`resolveStampForApp`, `lib/src/utils/postage-stamp-association.ts`).

Related issues: [#512](https://github.com/snaha/swarm-id/issues/512) (drive types and
usage), [#711](https://github.com/snaha/swarm-id/issues/711) (permission flow from an
app), [#502](https://github.com/snaha/swarm-id/issues/502) (create a drive while
connecting).

Out of scope: [#815](https://github.com/snaha/swarm-id/issues/815) (batch adoption through
the SDK), an app asking for a _new_ drive, and losing the default drive ([#363](https://github.com/snaha/swarm-id/issues/363#issuecomment-6190992219)).

## Why #537 did not converge

#537 made the write lease **account-scoped** and had one `BatchWriteCoordinator` "join"
additional batches (`joinBatch`, `joinedSecondaries`). Every lifecycle path — teardown,
demote, idle-yield, adopt, reload-restore, heartbeat — then had to fan out over N batches,
and each review round found another path that did not. Nearly all of its 20+ review
findings have that shape: a joined batch's counter not flushed at teardown, its state
pointer not heartbeated after a reload, a breaker reset mid-join, a streak tracked on the
wrong batch.

That design is no longer needed. Since #537 was written:

- [#683](https://github.com/snaha/swarm-id/pull/683): the lock, intent and occupancy SOCs
  hash the batch — a lane is `(batchId, partition)`.
- [#684](https://github.com/snaha/swarm-id/issues/684): the lease cache is keyed per batch.
- The bus `lease-request` / `lease-claim` / `lease-released` messages carry a `batchId`.

So two batches of one account no longer share any write state. Multi-drive is **N
independent copies of the existing single-batch stack**, and `lib/src/sync/` does not
change. #537 is to be closed.

## Design

### Per-drive write state

`SwarmIdProxy` holds its write state as single-valued fields — `postageBatchId`, `stamper`,
`coordinator`, `stampWorkerPool`, `signerKey`, `stamperAccountFingerprint`,
`stamperInitGeneration` — referenced about 59 times. These move into one per-drive object;
the proxy holds a map of them keyed by batch id.

Each entry is the stack `initializeStamper` builds today: one `UtilizationAwareStamper`, one
`BatchWriteCoordinator`, one worker pool. Entries never reference each other.

**Created lazily, on the first write to that drive** — never at connect. An entry costs a
lane acquire and a heartbeat, so an "all drives" app must not pay for drives it never
writes. The coordinator's existing idle-yield releases the lane again.

Bus handlers route by the `batchId` already on each message, to the matching entry or to
none.

A drive that leaves the grant (revoked, deleted, expired out) has its entry torn down; an
upload in flight on it is **aborted**, as a stamp change aborts one today.

### Drive kind

Every drive has a `kind`, `"regular"` or `"scratch"`, **fixed when the drive is created**
and synced with the rest of `PostageStampSchemaV1`. A regular drive never becomes scratch
or the reverse: mixing counter-allocated and recycled slots on one batch would let an app
overwrite regular data.

SwarmID works with **mutable batches only**. Every purchase path already buys with
`immutableFlag: false`; "Use existing batch" now **rejects an immutable batch** at import
(today `/dev` only warns), and lets the user pick the kind, **regular by default**.

### Account default drive

The account synchronizes to its **default drive**, and never to a scratch drive. The
default is the **first regular drive** the account gets. An account with only scratch
drives has no default and syncs as an account with no drive does today.

The drive menu's existing "Set as default" stays, offered for regular drives only.

What happens when the default drive is deleted or expires — the account's synced data is
then gone from Swarm, and the browser's local copy may be stale — is tracked separately
in [#363](https://github.com/snaha/swarm-id/issues/363#issuecomment-6190992219).

### Grant model

`ConnectedApp.postageStampBatchID` is replaced in place (pre-production, no migration) by a
drive grant: a list of batch ids, or `"all"`, with one last-writer-wins clock as today's
`postageStampBatchIDAt`.

- **`"all"` is live and includes scratch drives**: it covers drives created after the grant.
- **No stated requirement** means today's behaviour: one regular drive, the account default
  preselected. The grant is then `"default"`, a third form beside the list and `"all"`: it
  tracks the account default, so "Set as default" moves such an app's writes with it.
- **Zero drives** is an explicit opt-out. Such an app uploads through the subsidised
  gateway when one is configured (`isSubsidisedModeActive`), and cannot upload otherwise.
- **Scratch only** is allowed.

`resolveStampForApp` (what a session spends) and `stampsReachableByApp` (what a partitioned
session is handed) become one rule over the grant, so the `setSecret` handover ships signer
keys for granted drives only.

### Primary drive

A write without `batchID` goes to the app's **primary drive**: its **first granted regular
drive** — for an `"all"` or `"default"` grant, the account default drive. The primary is
derived by that rule, not stored, so when it leaves the grant the next granted regular
drive becomes primary with nothing to update. Adding a drive —
through a live `"all"` grant, or a later request — never breaks an app that writes
untargeted.

- **A scratch drive is never primary.** Every write to one names it with `batchID`.
- **No regular drive granted** (zero drives, or scratch only): an untargeted write goes to the
  subsidised gateway when one is configured, and is rejected with a typed error otherwise.
- **The user sees the primary** on the connect screen and wherever the app's drives are
  shown.

### Requesting drives

The app states how many drives of each kind it wants, or all of them (#512 option 2). The
user picks which existing drives satisfy the request on the connect screen, and may create a
new drive there (#502). The user may grant fewer than asked; the app finds out from
`getDrives()` and can ask again.

An app can request further drives **at any time**, not only when connecting (#711). That
request opens a popup **from the iframe**, as connect does, so a partitioned (Safari)
session receives the new signer keys through `window.opener`. Editing an app's grant after
connect, removing a drive included, belongs to #711 as well.

### SDK

- `getPostageBatch()` → `getDrives()`: the granted drives, each with today's
  `PostageBatch` fields plus `kind` and a primary marker, possibly extended (e.g. size).
- Every writer takes an optional `batchID`: data, file, chunk, SOC, GSOC, sequential and
  epoch feeds, feed manifest, ACT. Without it the write goes to the primary drive.
- A target outside the grant is rejected with a typed error.
- A feed's payload and its SOC always go to the same drive.

### Scratch drive: a ring in the lane

The proxy manages the slots; the app writes as normal. Today the stamper allocates
`dataSlot(partition, counter[bucket]++)` and throws `Bucket is full` at the end of the lane
(`lib/src/utils/batch-utilization.ts`). On a scratch drive the counter **wraps** instead:
the slot is `dataSlot(partition, counter mod partitionCapacity, partitionCount)`, so a full
bucket overwrites its oldest chunk in that lane.

- **Lane-relative**: the lease, the partition-state resume point and the takeover logic stay
  as they are, so two devices never write one lane at once. Each device's ring is its lane:
  1/`partitionCount` of the bucket.
- **Counters stay monotonic.** Only the slot is reduced modulo the capacity. The
  partition-state publish refuses a counter that goes backwards (its "KEYSTONE tripwire",
  `lib/src/sync/partition-state.ts`), and a monotonic counter keeps it valid unchanged.
- **Counters serialize as uint32** on a scratch drive. A uint16 counter is chosen today for
  depth ≤ 31 because the counter is bounded by the lane; a wrapping one is not.
- **The drive's own metadata is safe.** Lock SOCs, intent, partition state and utilization
  chunks stamp the reserved slots `[0, partitionCount)`, below the data lane, so the ring
  never evicts them.
- **Two apps on one scratch drive** share the counter (as two tabs on one batch do today), so
  one overwrites the other's data only once the counters wrap. Accepted.
- **Device clocks must be correct.** An overwrite has to carry a newer stamp timestamp than
  the chunk it replaces, so after a lane takeover a device whose clock is behind could fail
  to overwrite. Keeping clocks in sync is a stated requirement, not something SwarmID
  corrects for.
- The UI shows a scratch drive as never full: Bee's utilization reads near 100% once it wraps.
- **No warranties.** Data on a scratch drive can be lost to an overwrite at any time. The
  SDK does not restrict what goes on one; the docs state the risk, including for structures
  that depend on older chunks: a sequential feed whose index 0 is evicted may read as empty,
  an epoch feed's lookup relies on older nodes, ACT keeps its history as a feed, and a file's
  chunks can be evicted piecemeal.
- **Resizing is allowed.** Dilution changes `partitionCapacity`, so the ring's modulus
  changes and the next writes land on slots that are not the oldest. Accepted and documented.

## Steps

One PR each, in order.

| #   | PR                                                                                                                                                                                                           | Depends on   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| 1   | **Refactor, no behaviour change**: per-drive write state extracted from `SwarmIdProxy`; the proxy holds exactly one (`DriveWritePath`). Tests change only where they set the moved private fields.           | —            |
| 2   | **Schemas**: the drive grant, drive `kind`, their merge, the single reachability rule, the partitioned handover, the default-drive rule, the immutable-import check (#864). The kind picker moved to step 7. | —            |
| 3   | **Proxy map**: lazily created per-drive entries, bus routing by `batchId`, teardown and abort when a drive leaves the grant.                                                                                 | 1, 2         |
| 4   | **SDK**: `getDrives()`, optional `batchID` on every writer with the primary as fallback, the typed rejection. Docs-site pages and the demo's drive selector.                                                 | 3            |
| 5   | **Connect-time request**: the requirement in the client options → `connect` message → per-kind drive selection on the connect screen, including creating a drive there (#502), the primary shown.            | 4            |
| 6   | **Later request and grant editing** (#711): `requestDrives()`, a popup opened by the iframe; approval only, no re-authentication; removing a drive from an app.                                              | 5, UI design |
| 7   | **Scratch drive**: kind chosen in the Add drive flow and at import, the wrapping counter, uint32 counters, the never-full display, no "Set as default" on a scratch drive.                                   | 4            |

Step 1 carries the risk and ships no feature.

### Step 3 must bind each callback to its drive

Step 1 keeps three reads of "the current drive" at call time, because binding them changes
behaviour in a race and a refactor should not. With one drive they are harmless; with a map
they cross drives, so step 3 binds each to its own `DriveWritePath`, test first:

- the coordinator's `flushStamperState` flushes whichever drive is current, not its own;
- its `getWorkerPool` hands back the current drive's pool, signing with that drive's key;
- `saveStamperState` labels its `utilization-updated` broadcast with the batch read _after_ the
  flush, so a rebind mid-flush mislabels the buckets.

Each reaches across drives today only when a coordinator torn down mid-write is still
running.

### Testing

- Step 1: the existing suite is the test; only the helpers that set the moved private fields change.
- Steps 2–4: unit tests per `lib/AGENTS.md`, including that an account-bus delta hands a
  partitioned session only its granted drives' signer keys (a live `"all"` grant learns of
  new drives that way); an integration test against the local Bee
  cluster with one session writing two drives and a second device taking over each lane
  independently.
- Step 7: unit tests for the wrap (slot sequence, counter monotonicity across a publish); an
  integration test that fills a lane past its capacity and reads back the newest data; a
  live test that the overwrite evicts on a real network.

## Open questions

None at the moment. To verify in steps 2–3: how the account bus delivers a newly created
drive to a partitioned session today, so the delta can apply the same reachability rule as
the `setSecret` handover.
