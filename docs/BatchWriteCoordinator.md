# `BatchWriteCoordinator` — the shared write path for a partitioned postage batch

Status: **implemented** (GitHub issue [#336](https://github.com/snaha/swarm-id/issues/336)).
The partitioning scheme itself — and the chunks, lock SOCs, and feeds written to Swarm, which are
part of the public API — is specified in
[Multi-Device Postage Batches](https://swarm.snaha.net/docs/multi-device-postage-batches/) on the
docs site (source: `docs-site/src/content/docs/multi-device-postage-batches.mdx`). This document
describes the internal component that coordinates writes against that scheme.

## What it is

`BatchWriteCoordinator` (`lib/src/sync/batch-write-coordinator.ts`) is the write path for one
account+batch. It owns everything needed to **write to a shared postage batch as a partition
holder**, and nothing about client communication:

- the cross-tab Web Lock (`withBatchWriteLock`, `lib/src/utils/batch-write-lock.ts`) that
  serializes all writers on a batch within a browser,
- the partition-lease lifecycle — acquire, refresh, idle-yield, demote-on-displacement, teardown,
- stamper-state flush after every write, under the lock.

It deliberately does **not** own auth/identity, the postMessage protocol, ConnectionInfo emission,
or subsidised-gateway mode — those stay in the proxy. The coordinator is the single shared
write-path implementation: every writer of a batch goes through it.

## Position in the stack

```
SwarmIdProxy (iframe)            sync-account (SwarmID UI)
        │ persistent mode                │ oneshot mode
        └────────────┬───────────────────┘
            BatchWriteCoordinator      ← write lock + lease lifecycle + stamper flush
                     │
              PartitionLease           ← one device's claim on one partition
                     │
              partition-lock.ts        ← lock SOCs on Swarm: the cross-device authority
```

The lock SOC on Swarm stays the source of truth for who holds a partition; the local lease cache
(localStorage, persistent mode only) is just a hint. The coordinator is the lifecycle layer above
`PartitionLease`.

## API

```ts
new BatchWriteCoordinator(deps: BatchWriteCoordinatorDeps)
```

Dependencies are injected — no global storage-manager reach-in:

| Dep                                  | Role                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `bee`, `batchId`                     | Bee client; the batch id (hex) is also the `withBatchWriteLock` key                                                                   |
| `stamper`                            | `UtilizationAwareStamper`, already created + account-bound by the caller; the coordinator only binds/unbinds the held partition on it |
| `deviceId`, `accountId`              | This device's identity (one `getOrCreateDeviceId` per browser) and the account                                                        |
| `backupSigner`, `swarmEncryptionKey` | Own/read the per-partition lock SOCs                                                                                                  |
| `partitionCount`                     | `<= 1` (legacy single-device accounts) means: never lease, lock-only coordination                                                     |
| `mode`                               | `"persistent"` (proxy) or `"oneshot"` (sync-account) — see below                                                                      |
| `readLeaseCache` / `writeLeaseCache` | Optional local lease-cache hint (persistent mode)                                                                                     |
| `flushStamperState`                  | Flush stamper bucket state after a write (proxy: `saveStamperStateIfNeeded`)                                                          |
| `getWorkerPool`                      | Build/reuse a parallel-signing worker pool for `useWorkers` uploads                                                                   |
| `onLeaseChange`                      | Fired on every partition / read-only transition (proxy → `emitConnectionInfoIfChanged`)                                               |
| `onLeaseAcquired`                    | Fired when a partition is (re)acquired (proxy → schedule an account-state publish)                                                    |

Methods and getters:

- **`withWrite(op, opts?)`** — the single write entry point. Takes the cross-tab Web Lock, ensures
  a held partition (acquire / slot-wait, or skip-with-throw), builds a stamper `UploadTarget`
  (optionally with a worker pool), brackets the in-flight upload count so the refresh tick's
  idle-yield can't release the partition underneath it, runs `op(target)`, and flushes stamper
  state in the lock's `finally`. `opts`: `useWorkers` / `workerCount` / `wait: "block" | "skip"`
  (default follows the mode).
- **`startLease()`** — persistent mode only: eagerly acquire a partition + start the refresh timer
  in the background so the first upload doesn't pay the acquire latency. No-op in oneshot mode.
- **`teardown()`** — stop all background work, best-effort release of the held partition so peers
  see this device vacate promptly, invalidate-then-unbind the stamper, clear the cache. Never
  throws. Sets a `disposed` flag (see below).
- **`currentPartition`** / **`isReadOnly`** / **`stamperRef`** — read by the proxy's
  `buildConnectionInfo` (partition, read-only state, appKey/uploadMode).
- **`PartitionContendedError`** — thrown when there is genuinely no slot to claim (every partition
  held by a live foreign device). Distinct from operational errors (missing stamper, a lock-SOC
  write that threw), which propagate as-is so callers can log them differently.
- **`isDisplaced(payload, now, selfDeviceId)`** — pure helper: a lock-SOC payload means
  displacement only if it names a _different_, _live_ device. Missing/unreadable payloads (e.g. a
  Bee 500), our own id, the release sentinel, and expired foreign holders are all NOT displacement.

## The two modes

|                          | `persistent` (proxy)                                                                                                     | `oneshot` (sync-account)                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Lease warm-up            | `startLease()` acquires eagerly in the background                                                                        | none                                                               |
| Refresh timer            | yes (`LEASE_REFRESH_MS`)                                                                                                 | never armed                                                        |
| `withWrite` default wait | `"block"`                                                                                                                | `"skip"`                                                           |
| No slot available        | poll for a freed slot every `LEASE_REFRESH_MS` up to 30 s, inside a 45 s overall acquire timeout; then the upload errors | single claim attempt; throws `PartitionContendedError` immediately |
| Lease end-of-life        | released on `teardown()` (sign-out / disconnect), or idle-yielded                                                        | lapses by TTL                                                      |

## Lease lifecycle

- **Acquire.** `PartitionLease.acquire` always re-reads and reconciles against the lock SOCs
  before binding — the cache is only a `hydrate` hint. A still-valid cached lease (e.g. a page
  reload within the TTL) is **re-adopted from local state alone** (`adoptIfLive`) with no lock-SOC
  scan/write, so it survives transient Bee 500s; the refresh tick then reconciles with Swarm and
  demotes only on a confirmed foreign holder. On success the stamper gets `bindPartition` and
  `onLeaseAcquired` fires.
- **Freshness check.** A held lease is re-validated against its lock SOC at most once per
  `LEASE_REFRESH_MS`, under the write lock, before a write proceeds. A read failure is
  inconclusive — keep the lease and retry later.
- **Refresh tick.** Persistent mode re-runs the lock protocol on a bare `setInterval`,
  deliberately **not** under the write lock, so it can detect displacement while an upload is
  mid-flight (see the race fix below). A failed refresh write is confirmed with one read before
  demoting; transient errors keep the lease.
- **Idle yield.** If no upload touched the lease for `IDLE_YIELD_MS` and none is in flight, the
  tick voluntarily releases the partition so a waiting peer takes the slot without waiting out
  the TTL; the next write re-acquires. The off-lock tick only _decides_ to yield — the yield
  itself runs **under the write lock**, with re-checks inside (disposed / lease identity /
  `activeUploadCount` / idle window), because releasing the slot and unbinding the stamper
  off-lock underneath an upload that just entered `withWrite` would be the same corruption class
  as the displacement race below.
- **Disposed guard.** `teardown()` sets `disposed`; from then on the coordinator never re-acquires
  a partition or arms a timer. This matters because an in-flight `withWrite` (a deferred publish,
  or a normal upload) can outlive a disconnect/sign-out — without the guard its `ensureLease`
  would re-lease the slot and start a detached refresh interval: a ghost lease the proxy could no
  longer tear down.
- **Lease-epoch guard.** The block-mode acquire races a 45 s timeout that cannot cancel the
  losing acquire. Every lease reset (`pauseLeaseBackgroundWork`, `finalizeDemote`, idle yield,
  `teardown`) bumps an epoch counter; an acquire that began under an older epoch discards its
  result — on success _and_ on failure — instead of resurrecting or clobbering a lease the
  coordinator re-established meanwhile. The slot-wait loop checks the epoch between its poll
  sleep and the next claim so a detached loop never claims the lock SOC again after the timeout
  already gave up. A claim discarded this way self-heals on Swarm via the lease TTL.
- **Stale-tick guards.** Clearing the refresh interval cannot stop a `refreshTick` already in
  flight (and a slow tick can overlap the next one). Every tick therefore re-checks
  `disposed` / `partitionLease !== lease` at entry, before arming the displacement breaker,
  inside the locked demote (mirroring the idle-yield guards), and before the tail heartbeat +
  cache write — a stale tick must not re-claim a released partition, demote a re-acquired
  lease, or resurrect a cleared lease cache that a later acquire would `adoptIfLive`.
- **Failure unwind.** `acquire()`'s cleanup undoes a partial commit: if a consumer callback
  (`writeLeaseCache`, `onLeaseAcquired`) throws after `bindPartition`/`startRefreshTimer`, the
  catch clears the timer and invalidates + unbinds the stamper so neither outlives the dropped
  lease record.
- **Error classification.** `acquire()` propagates operational failures (a lock-SOC scan/claim
  that threw) after clearing state. Skip mode therefore throws `PartitionContendedError` only
  when the acquire _completed_ read-only — a Bee outage surfaces from `sync-account` as
  `status: "error"`, never as a quiet "all partitions held" skip.

## The displacement-during-upload race fix

`refreshTick` runs off-lock, so it can detect that a peer took our partition while an upload is
mid-`stamp()`. Demotion is therefore **two-phase**:

1. **Immediately on confirmed displacement** (before taking any lock): `stamper.invalidateLease()`
   only. The partition stays bound with `leaseStale = true`, so the `stamp()` circuit breaker
   fires — the in-flight upload aborts with `PartitionLeaseLostError` instead of writing into a
   slot a peer now owns.
2. **Then unbind/clear under the write lock**: `unbindPartition()`, stop the timer, drop the lease
   and cache, enter read-only, re-arm `pendingAcquire`. The lock serializes the unbind after the
   in-flight upload's locked section completes or aborts, so no `stamp()` runs in the window
   between invalidate and unbind.

Lock-synchronizing the demote _alone_ would be insufficient — it would merely order the demote
after an upload that had already corrupted the peer's slot space. The same invalidate-before-unbind
ordering is used in `teardown()`, which also runs off-lock and can land between two awaits of an
in-flight `stamp()` (`unbindPartition` alone resets `leaseStale = false`, silently re-enabling
legacy "any"-slot picking).

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
- **`"change"`** — `handleAuxiliaryStorageChange` while a partition is held: a new identity /
  stamp / rename should propagate to peers. A `"change"` carries a real delta and is never gated;
  within a debounce window `"change"` dominates a coalesced `"acquired"`.

The publisher (`runAccountStatePublish`) re-arms itself if a publish is already in flight, and bails if
the coordinator was torn down or replaced while the (async) snapshot assembly ran.

### `sync-account` (`lib/src/sync/sync-account.ts`) — oneshot

The SwarmID UI's sync builds a oneshot coordinator per sync (stamper from
`postageStampsStore.getStamper`; for a shared, partitioned batch this is always a
`UtilizationAwareStamper`) and publishes via
`coordinator.withWrite(target => publishDeviceState(...), { wait: "skip" })` — the **same** Web
Lock and the same partition acquire the proxy uses, so a UI-driven change is published under the
identical safety guarantees. Outcomes are split:

- **Genuine contention** → `PartitionContendedError` → a "Skipping sync …: all partitions are held
  by other devices." warn and `undefined` (a peer — or the proxy — publishes instead).
- **Operational failure** (stamper missing, lock-SOC error, …) → a distinct error log and an
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
partition lease, so two devices' feeds are slot-disjoint on the shared batch, and stamper state is flushed
in the lock's `finally`.

## Counter coherence across instances

Two coordinator instances can write the same batch concurrently-ish (the proxy iframe and the
SwarmID UI tab). Correctness relies on the **reload-before-write / flush-after-write under the Web
Lock** discipline: `withWrite` flushes stamper state in the lock's `finally` (`flushStamperState`),
and the stamper reads the latest counters from the shared IndexedDB utilisation cache. The proxy
and SwarmUI share one `deviceId`, so a lock SOC written by either is recognised as self-held by
the other — they cooperate on the same partition rather than contend.

## Files and tests

| File                                                   | Role                                                            |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| `lib/src/sync/batch-write-coordinator.ts`              | The coordinator                                                 |
| `lib/src/sync/device-state.ts`                         | `publishDeviceState` — the per-device write the coordinator brackets (see `Account-State.md`) |
| `lib/src/sync/partition-lease.ts`, `partition-lock.ts` | The layers below (claim + lock SOCs)                            |
| `lib/src/utils/batch-write-lock.ts`                    | `withBatchWriteLock` (Web Lock + no-`navigator.locks` fallback) |
| `lib/src/swarm-id-proxy.ts`                            | Persistent consumer + publish triggers                          |
| `lib/src/sync/sync-account.ts`                         | Oneshot consumer                                                |

The living spec is the test suite: `batch-write-coordinator.test.ts` (block-vs-skip, contention,
lifecycle, the displacement race), `sync-account.test.ts` (use of the coordinator: publish,
skip-on-contention, error split), `device-state.test.ts` / `merge-snapshot.test.ts` (the published
per-device view + the fold/merge), `partition-lock.test.ts`, and `partition-lease.integration.test.ts`.
