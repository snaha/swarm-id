# `BatchWriteCoordinator` — the shared write path for a partitioned postage batch

Status: **implemented** (GitHub issue [#336](https://github.com/snaha/swarm-id/issues/336)).
The partitioning scheme itself — and the chunks and feeds written to Swarm, which are
part of the public API — is specified in
[Multi-Device Postage Batches](https://swarm.snaha.net/docs/multi-device-postage-batches/) on the
docs site (source: `docs-site/src/content/docs/multi-device-postage-batches.mdx`). This document
describes the internal component that coordinates writes against that scheme.

## What it is

`BatchWriteCoordinator` (`lib/src/sync/batch-write-coordinator.ts`) is the write path for one
account+batch. It owns everything needed to **write to a shared postage batch as the holder of
one of its lanes**, and nothing about client communication:

- taking a lane over the account bus (`lib/src/sync/bus-lease.ts`), and noticing when it is gone,
- resuming and publishing the lane's counter (`lib/src/sync/lane-state.ts`),
- the cross-tab Web Lock (`withBatchWriteLock`, `lib/src/utils/batch-write-lock.ts`) that
  serializes the stamper state of all writers on a batch within a browser, and the stamper-state
  flush after every write under it.

It deliberately does **not** own auth/identity, the postMessage protocol, ConnectionInfo emission,
or subsidised-gateway mode — those stay in the proxy. The coordinator is the single shared
write-path implementation: every writer of a batch goes through it.

## Position in the stack

```
SwarmIdProxy (iframe)            sync-account (SwarmID UI)
        │ persistent mode                │ oneshot mode
        └────────────┬───────────────────┘
            BatchWriteCoordinator      ← lane + published counter + write lock + stamper flush
               │              │
           BusLanes        LaneState   ← who holds a lane        ← what a holder resumes and publishes
               │              │
          account bus       Swarm      ← the room's membership   ← counter chunks + state pointer
```

A lane is `(batchId, partition)`, and every lane message and every state address says so. Two
coordinators on two batches (a per-app stamp override) contend for nothing
([#589](https://github.com/snaha/swarm-id/issues/589)).

Who holds a lane is agreed between the account's live contexts over the bus and stored nowhere;
the protocol is `models/bus-lease`, described in
[`Postage-Batch-Partitioning.md`](./Postage-Batch-Partitioning.md) §7. A lane is held by a
**context**: the proxy iframe and the SwarmID tab of one browser are two participants.

## API

```ts
new BatchWriteCoordinator(deps: BatchWriteCoordinatorDeps)
```

Dependencies are injected — no global storage-manager reach-in:

| Dep                                  | Role                                                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `bee`, `batchId`                     | Bee client; the batch id (hex) is also the `withBatchWriteLock` key                                                                            |
| `stamper`                            | `UtilizationAwareStamper`, already created + account-bound by the caller; the coordinator only binds/unbinds the held partition on it          |
| `deviceId`, `accountId`              | This device's identity, which picks the lane asked for first (`deviceHomePartition`), and the account                                          |
| `lanes`                              | This context's `BusLanes` on the account bus. Without it a partitioned batch cannot be written                                                 |
| `backupSigner`, `swarmEncryptionKey` | Own and read the lane's published state                                                                                                        |
| `partitionCount`                     | `<= 1` (legacy single-device accounts) means: no lanes, lock-only coordination                                                                 |
| `mode`                               | `"persistent"` (proxy) or `"oneshot"` (sync-account) — see below                                                                               |
| `flushStamperState`                  | Flush stamper bucket state after a write (proxy: `saveStamperStateIfNeeded`)                                                                   |
| `getWorkerPool`                      | Build/reuse a parallel-signing worker pool for `useWorkers` uploads. The pool only signs: every slot still comes from `stamper` (`assignSlot`) |
| `onLeaseChange`                      | Fired on every partition / read-only transition (proxy → `emitConnectionInfoIfChanged`)                                                        |
| `onLeaseAcquired`                    | Fired when a lane is taken and its counter bound (proxy → schedule an account-state publish, poll the device roster)                           |

Methods and getters:

- **`withWrite(op, opts?)`** — the single write entry point. Makes sure a lane is held (outside
  the Web Lock: that can take seconds), takes the lock, checks the hold again, builds a stamper
  `UploadTarget` (optionally with a worker pool), runs `op(target)`, checks the hold once more,
  publishes the counter, and flushes stamper state in the lock's `finally`. `opts`: `useWorkers` /
  `workerCount` / `wait: "block" | "skip"` (default follows the mode) / `signal`.
- **`startLease()`** — persistent mode only: take a lane in the background so the first upload
  doesn't wait for it. No-op in oneshot mode.
- **`teardown()`** — give every lane up and invalidate-then-unbind the stamper. Writes nothing and
  never throws. Sets a `disposed` flag (see below).
- **`currentPartition`** / **`isReadOnly`** / **`stamperRef`** — read by the proxy's
  `buildConnectionInfo` (partition, read-only state, appKey/uploadMode).
- **`PartitionContendedError`** — thrown when no lane could be taken: every lane is held by a
  context that is writing, or this context has no confirmed connection to the bus. Distinct from
  operational errors (missing stamper, an unreadable published state), which propagate as-is so
  callers can log them differently.

## The two modes

|                          | `persistent` (proxy)                                                           | `oneshot` (sync-account)                                              |
| ------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Warm-up                  | `startLease()` takes a lane in the background                                  | none                                                                  |
| `withWrite` default wait | `"block"`                                                                      | `"skip"`                                                              |
| No lane handed over      | keeps asking for 30 s, inside a 45 s overall cap; then the upload errors       | keeps asking for 10 s; then throws `PartitionContendedError`          |
| End of life              | lanes given up on `teardown()` (sign-out / disconnect), or when the tab closes | `sync-account` tears the coordinator down as soon as the sync is done |

The one-off wait is 10 s and not zero because a context that has just joined the room may not
take a lane nobody answers for until it has been there for 8 s.

## Lane lifecycle

- **Taking a lane.** `claimAny` asks for every lane gently (a lane nobody holds is taken, a
  holder keeps its lane and answers "held"). Once every lane has answered "held" it insists,
  on the device's home lane first and on one more lane every `NEXT_LANE_AFTER_MS`. The first lane held wins and the other claims are dropped. Then
  `LaneState.resume()` reads the lane's published counter, the stamper gets `bindPartition`, and
  `onLeaseAcquired` fires. While the counter is being read the context does not hand the lane
  over; if its connection lapsed meanwhile it starts again.
- **An unreadable state.** If the lane may have a published counter that could not be read, the
  lane is given back at once and the write fails: stamping from a guess would re-issue used
  slots.
- **Holding.** `mayWrite()` is a local check: the lane is held and the connection was confirmed
  within `LEASE_STOP_MS`. No network read, no timer. Each confirmation moves the stamper's
  deadline forward (`setLeaseValidUntil`).
- **Handing over.** A claim from another context is answered by `BusLane`: not while an upload
  is in flight, nor within `PEER_YIELD_MIN_IDLE_MS` of the last one, nor to a gentle claim
  (the lane then answers "held"). Otherwise the coordinator stops stamping (`invalidateLease`, unbind) and the lane answers
  "free". The upload count is raised with no `await` since the hold check, so a handover cannot
  land between the check and the upload.
- **Disposed guard.** `teardown()` sets `disposed`; from then on the coordinator never takes a
  lane. This matters because an in-flight `withWrite` (a deferred publish, or a normal upload) can
  outlive a disconnect/sign-out.
- **One acquisition at a time.** Writes that start together share one acquisition. It races a
  45 s cap that cannot cancel it; an acquisition that outlived the cap binds nothing if a later
  one has started.
- **Error classification.** Skip mode throws `PartitionContendedError` only when no lane could be
  taken — a Bee outage while reading the counter surfaces from `sync-account` as
  `status: "error"`, never as a quiet "all partitions held" skip.

## Losing the lane during an upload

An upload mid-`stamp()` can find its context's connection unconfirmed for `LEASE_STOP_MS`, and
the lane goes for good if a claim is answered meanwhile or the connection is replaced. Three things keep such an upload from doing harm:

1. **The stamper's deadline.** `stamp()` throws `PartitionLeaseLostError` once it passes, whether
   or not anything has noticed the lapse yet.
2. **Invalidate before unbind.** When the coordinator stops holding the lane it calls
   `stamper.invalidateLease()` at once. The flag outlives `unbindPartition()`, which is left to the
   upload's own `finally` when one is in flight: an unbound stamper would otherwise stamp the rest
   of that upload at legacy slots. Only the next `bindPartition()` clears the flag.
3. **The hold check before the ack.** The counter is not published, and the upload not
   acknowledged, unless the lane is still held when the upload's chunks are written.

A handover never lands mid-upload, because a holder with a write in flight does not answer.

## Consumers

### Proxy (`lib/src/swarm-id-proxy.ts`) — persistent

After auth resolves the stamp context, the proxy builds the stamper, then one coordinator per
account+batch and calls `startLease()` (multi-device accounts pre-acquire in the background;
single-partition accounts get a lock-only coordinator). Every upload handler goes through
`withModeAwareWriteLock`: subsidised mode (gateway stamping, no local stamp state) short-circuits
to an unlocked gateway target; everything else delegates to `coordinator.withWrite`.
`buildConnectionInfo` reads `currentPartition` / `stamperRef`; `onLeaseChange` →
`emitConnectionInfoIfChanged`; sign-out / disconnect / re-auth → `teardown()`.

### Proxy-side account-state publish

In production the user sits on the dApp, not the identity UI, so the proxy iframe is the only
guaranteed-persistent context that can publish account state. Two triggers, both funnelled through
a debounced scheduler (`schedulePublish`, `PUBLISH_DEBOUNCE_MS`) so the publish runs **outside**
the lease callback's write lock (the publish re-enters the lock via `coordinator.withWrite`):

- **`"acquired"`** — `onLeaseAcquired`. Announces a newly joining device by publishing this device's
  own state feed and appending it to the roster (`ensureInRoster`), which is what makes all peers'
  device lists converge on the next fold. `ensureInRoster` is itself the **announce-once** gate: it
  appends only when this device is absent from the roster or its `removedAt` state changed, so a page
  reload that merely re-acquires doesn't re-write the roster.
- **`"change"`** — `reevaluateConnection`, reached from `handleAccountStorageChange` (a storage
  event on the account document): a new identity / stamp / rename should propagate to peers. A
  `"change"` carries a real delta and is never gated; within a debounce window `"change"` dominates
  a coalesced `"acquired"`. A held partition is **not** a precondition — only the feed half of the
  publish needs one. `runAccountStatePublish` sends the bus delta unconditionally and checks
  `coordinator.currentPartition` only before the feed write, so a session with no coordinator at all
  (a stamp-less account never gets past `initializeStamper`) still relays to peers that cannot see
  storage.

The publisher (`runAccountStatePublish`) re-arms itself if a publish is already in flight, and bails if
the coordinator was torn down or replaced while the (async) snapshot assembly ran.

### `sync-account` (`lib/src/sync/sync-account.ts`) — oneshot

The SwarmID UI's sync builds a oneshot coordinator per sync (stamper from
`postageStampsStore.getStamper`; for a shared, partitioned batch this is always a
`UtilizationAwareStamper`), with the tab's `BusLanes` from its account-bus store, and publishes via
`coordinator.withWrite(target => publishDeviceState(...), { wait: "skip" })` — the **same** Web
Lock and the same lane protocol the proxy uses, so a UI-driven change is published under the
identical safety guarantees. The coordinator is torn down when the sync is done, which gives its
lane up. Outcomes are split:

- **Genuine contention** → `PartitionContendedError` → a "Skipping sync …: all partitions are held
  by other devices." warn and `undefined` (a peer — or the proxy — publishes instead).
- **Operational failure** (stamper missing, an unreadable published state, …) → a distinct error log and an
  `{ status: "error" }` result.

The whole publish races a 60 s timeout (Bee client requests have no built-in timeout).

## The published account state (`lib/src/sync/device-state.ts`)

The write the coordinator brackets is `publishDeviceState`: each device writes its **own full current
view** to its **own** epoch feed (no shared SOC address, so no read-merge-rewrite and no verify-won
retry), then `ensureInRoster`. Convergence happens later at READ time, where a fold merges every device's
latest view. That whole account-state model — the per-device feeds, the append-only roster, fold-on-read,
the LWW/tombstone merges — is documented in [`Account-State.md`](./Account-State.md). (This replaced an
earlier single shared snapshot feed with a `publishAccountState` merge-read-rewrite + verify-won loop; see
that doc's "Retired / legacy" note.)

What the coordinator guarantees for it is unchanged: the per-device write rides the cross-tab lock +
held lane, so two devices' feeds are slot-disjoint on the shared batch, and stamper state is flushed
in the lock's `finally`.

## Counter coherence across instances

Two coordinator instances of one browser can write the same batch (the proxy iframe and the
SwarmID UI tab). Each is its own participant: it takes a lane for itself, and the one that
wants the lane the other holds is handed it when the other is not writing. Whoever takes a lane
resumes from the counter **published on Swarm**, not from the stamper cache the two share in
IndexedDB: the cache says what some tab of this browser last wrote, not what this tab's stamper
has in memory. A context reuses its own in-memory counter only when the newest published state
is one it read or wrote itself.

The Web Lock still serializes the two on the shared stamper cache: `withWrite` flushes stamper
state in the lock's `finally` (`flushStamperState`). Counter updates between contexts also travel
as lane-scoped `utilization-updated` messages on the account bus, folded only by a receiver on
the same partition of the same batch ([`Account-Bus.md`](./Account-Bus.md)).

## Files and tests

| File                                         | Role                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `lib/src/sync/batch-write-coordinator.ts`    | The coordinator                                                                               |
| `lib/src/sync/device-state.ts`               | `publishDeviceState` — the per-device write the coordinator brackets (see `Account-State.md`) |
| `lib/src/sync/bus-lease.ts`, `lane-state.ts` | The layers below (who holds a lane; its published counter)                                    |
| `lib/src/utils/batch-write-lock.ts`          | `withBatchWriteLock` (Web Lock + no-`navigator.locks` fallback)                               |
| `lib/src/swarm-id-proxy.ts`                  | Persistent consumer + publish triggers                                                        |
| `lib/src/sync/sync-account.ts`               | Oneshot consumer                                                                              |

The living spec is the test suite: `batch-write-coordinator.test.ts` (block-vs-skip, contention,
lifecycle, losing the lane), `bus-lease.test.ts` (the protocol), `lane-state.integration.test.ts`
(resume and publish), `sync-account.test.ts` (use of the coordinator: publish,
skip-on-contention, error split), `device-state.test.ts` / `merge-snapshot.test.ts` (the published
per-device view + the fold/merge).
