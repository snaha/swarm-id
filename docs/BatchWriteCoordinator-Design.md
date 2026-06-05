# Design: extract a `BatchWriteCoordinator` from the proxy

Status: **design only** (not yet implemented). Companion to
`Postage-Batch-Partitioning.md` and `Postage-Batch-Partitioning-Refactor-Plan.md`.

## Motivation

`lib/src/swarm-id-proxy.ts` is ~4,350 lines and mixes three unrelated concerns:

1. **Client communication** (its actual job): the `postMessage` protocol — `setupMessageListener`,
   `handleParentMessage`, ~30 `handleX` handlers, `sendToParent` / `postMessage`,
   `buildConnectionInfo` / `emitConnectionInfoIfChanged`.
2. **Auth / identity / storage / button UI**: storage listeners, `authenticateFromStorage`,
   `loadAuthData`, popup + button handling, `clearAuthData`.
3. **Write path / lease / lock / stamp**: stamp management, the cross-tab Web Lock, the partition
   lease lifecycle, upload guards, lease-cache I/O.

Concern 3 is cohesive and self-contained, yet it's trapped inside the proxy, so it can't be reused.
The concrete driver: the **SwarmUI must publish account-state changes** (account creation, stamp add,
rename, connected apps) under the **same** cross-tab write lock and partition lease the proxy uses —
but that logic only exists in the proxy. Today `sync-account` takes no write lock and can't acquire a
partition, so a SwarmUI-driven change to a multi-device account is skipped (`[SyncCoordinator]
Skipping sync …: device … holds no partition (per lock SOC)`) and never reaches Swarm, so a second
device can't restore it. Extracting concern 3 into a shared coordinator both shrinks the proxy and
gives `sync-account` (and the SwarmUI) a first-class, safe way to write.

## Proposed boundary — `BatchWriteCoordinator`

A class that owns everything needed to **write to a shared postage batch as a partition holder**, and
nothing about client communication.

**Moves out of the proxy (concern 3):**

- Stamp management: `initializeStamper`, `getOrCreateWorkerPool`, `saveStamperState`,
  `saveStamperStateIfNeeded`, `getUploadTarget`; fields `stamper`, `stamperDepth`, `stampWorkerPool`,
  `stamperAccountFingerprint`, `utilizationStore`.
- Locking: `withWriteLock` (the `swarm-write-<batchIdHex>` Web Lock) and `withModeAwareWriteLock`.
- Lease lifecycle: `acquirePartitionLease`, `ensurePartitionLease`,
  `acquirePartitionLeaseWithSlotWait`, `ensureLeaseStillValid`, `isDisplaced`,
  `scheduleLeaseRefresh` / `refreshTick`, `yieldIdleLease`, `demoteSilently`,
  `pauseLeaseBackgroundWork`, `tearDownPartitionLease`, `captureLeaseContext`,
  `read/writeLeaseCache`; fields `partitionLease`, `partitionRefreshTimer`, `isReadOnly`,
  `leaseAccountId`, `leaseContext`, `pendingLeaseAccountInfo`, `lastLeaseValidatedAt`,
  `lastLeaseActivityAt`, `activeUploadCount`, `deviceId`.
- Upload guards: the batch/partition parts of `ensureCanUpload`, `ensurePartitionHeldForUpload`,
  `isSubsidisedModeActive`.

**Stays in the proxy:** the message protocol, auth/storage/identity, button UI, and the thin
`handleX` handlers (which now delegate writes to the coordinator).

## Interface (sketch)

```ts
interface BatchWriteCoordinatorOpts {
  bee: Bee
  batchId: BatchId
  batchDepth: number
  signerKey: string
  account: {
    owner: EthAddress
    encryptionKey: Uint8Array
    accountId: string
    partitionCount: number
  }
  deviceId: string
  utilizationStore: UtilizationStoreDB
  subsidisedGatewayUrl?: string
  onLeaseChange?: (partition: number | undefined) => void // coordinator → consumer
}

class BatchWriteCoordinator {
  // Builds the stamper and binds the lock SOCs.
  static async create(opts: BatchWriteCoordinatorOpts): Promise<BatchWriteCoordinator>

  // The single write entry point: take the Web Lock, ensure a held partition (acquire / slot-wait),
  // bind the stamper, run `op`, flush stamper state. Throws "fully leased" when no slot is obtainable
  // for a multi-device account.
  withWrite<T>(
    op: (target: UploadTarget) => Promise<T>,
    opts?: { useWorkers?: boolean; workerCount?: number },
  ): Promise<T>

  startLease(): void // eager acquire + refresh timer (long-lived holder = the proxy)
  release(): Promise<void>
  teardown(): void // stop timers, release, clear

  get currentPartition(): number | undefined
  get isReadOnly(): boolean
  get stamper(): UtilizationAwareStamper | undefined // for appKey / uploadMode in buildConnectionInfo
}
```

`onLeaseChange` replaces the proxy's inline `emitConnectionInfoIfChanged()` calls inside the lease
code: the coordinator fires it on every transition (acquire / adopt / read-only / yield / demote), and
the consumer decides what to do (proxy → push `connectionInfoChanged`; SwarmUI → update its store).

## How each consumer uses it

- **Proxy**: after auth + the stamp context is known, construct one coordinator and `startLease()`.
  Every upload handler becomes `coordinator.withWrite(target => uploadData(target, …))`.
  `buildConnectionInfo` reads `coordinator.currentPartition` / `isReadOnly`.
  `clearAuthData` / disconnect → `coordinator.teardown()`. `onLeaseChange` → `emitConnectionInfoIfChanged`.
- **`sync-account` (SwarmUI)**: construct a coordinator for the account's default batch and publish via
  `coordinator.withWrite(target => uploadSnapshot(target, …))` — **same Web Lock + same acquire**,
  which fixes the publish bug. Uses the one-off path (no `startLease` / refresh timer): `withWrite`
  acquires a free/expired partition under the lock if none is held; the lease then lapses by TTL. Skips
  only when genuinely contended (every partition held by a live foreign holder).
- **SwarmUI devices page**: unchanged — still a read-only `PartitionLease` for display.

## Shared lock + lease

- The `swarm-write-<batchIdHex>` Web Lock name convention lives in **one** place (the coordinator, or a
  tiny `withBatchWriteLock` it wraps), with a no-`navigator.locks` fallback for node/tests. All writers
  on a batch — every proxy tab and the SwarmUI — serialize on it.
- The proxy and SwarmUI share one `deviceId` (`getOrCreateDeviceId`), so a lock SOC written by either is
  recognised as self-held by the other; they cooperate on the same partition rather than contend.

## Counter coherence (the area to watch)

Two coordinator instances (the proxy iframe and the SwarmUI tab) share the IndexedDB utilisation cache
and the `swarm-id-utilization` BroadcastChannel. Correctness relies on each instance reading the latest
counter from the cache and flushing under the Web Lock (the proxy already flushes in
`withWriteLock`'s `finally`). The coordinator should make "reload-before-write / flush-after-write under
the lock" explicit. The dominant case — bootstrap (first device, no concurrent writer) — has no
contention.

## Migration phases (when implemented — each keeps `pnpm check:all` green)

1. `withBatchWriteLock(batchIdHex, op)` shared helper; the proxy's `withWriteLock` delegates to it. No
   behaviour change.
2. Extract a `PartitionLeaseManager` (the lease cluster + cache + timer); the proxy delegates;
   behaviour-preserving.
3. Extract stamp management (stamper + worker pool + `getUploadTarget` + `saveStamperState`).
4. Compose into `BatchWriteCoordinator` with `withWrite` + `onLeaseChange`; proxy handlers call it.
5. Wire `sync-account` to the coordinator (read-or-claim publish) + make `readPartitionState` resilient
   (ignore unreadable/old entries → fresh skewed counter) — closes the original SwarmUI-publish bug.

## Risks / open questions

- The handlers are tightly coupled to the inline lock+lease; the coordinator must expose enough state
  for `buildConnectionInfo` (partition, read-only, and appKey/uploadMode via the stamper).
- Long-lived (proxy) vs one-off (sync-account) lease modes — keep the refresh timer optional.
- Cross-tab counter coherence (above) is the main correctness risk; the lock + cache-reload/flush
  discipline must be explicit in the coordinator.
- Large mechanical surface; do it phased, not big-bang.

## Files (when implemented)

- New: `lib/src/sync/batch-write-coordinator.ts` (+ optionally `partition-lease-manager.ts`,
  `batch-write-lock.ts`).
- `lib/src/swarm-id-proxy.ts` — delegate write/lease/lock/stamp to the coordinator; keep
  communication / auth / UI.
- `lib/src/sync/sync-account.ts` — publish via the coordinator.

## Related / out of scope

- The original SwarmUI-publish bug and `readPartitionState` resilience are folded into phase 5 above
  (they can also be done independently first — a separate decision).
- The `bee-compose` docker pull failure blocking `pnpm dev:bee:fresh` is a registry-auth/environment
  issue, unrelated to this design.
