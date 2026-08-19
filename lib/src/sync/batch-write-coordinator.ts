// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `BatchWriteCoordinator` — the write path for one ACCOUNT.
 *
 * Owns everything needed to **write to the account's postage batches as a
 * partition holder**, and nothing about client communication:
 *   - the cross-tab Web Lock (`withAccountWriteLock`),
 *   - the partition-lease lifecycle (acquire / refresh / yield / demote),
 *   - stamper-state flush under the lock.
 *
 * The partition claim (lock/intent/occupancy SOCs) is account-scoped — one
 * lease covers every batch the account owns — while each write supplies its
 * own batch context: `withWrite(stamper, …)` takes the target batch's
 * `UtilizationAwareStamper` (which carries its batch id + depth). The lease
 * itself is stamped under `deps.leaseStamper` (the resolved default batch);
 * other batches are joined lazily on their first write (`ensureBatchJoined` →
 * `PartitionLease.joinBatch`) with NO lock activity, so alternating writes
 * across batches never release/re-acquire the partition.
 *
 * Two consumers share it:
 *   - the proxy iframe — long-lived (`mode: "persistent"`): eager
 *     `startLease()` + a refresh timer; an upload that can't get a partition
 *     blocks for a slot and then throws.
 *   - `sync-account` — one-off (`mode: "oneshot"`): no refresh timer; a write
 *     claims a free/expired partition once and throws `PartitionContendedError`
 *     when every partition is held by a live foreign device, so the caller
 *     skips. The lease then lapses by TTL.
 *
 * The lock SOC on Swarm (`partition-lock.ts`) stays the cross-device authority;
 * this class is the lifecycle layer above `PartitionLease`. See
 * `docs/BatchWriteCoordinator.md`.
 *
 * ## Displacement-during-upload race (issue #336)
 *
 * `refreshTick` runs on a bare `setInterval`, NOT under the write lock, so it
 * can detect that a peer took our partition while an upload is mid-`stamp()`.
 * The fix is two-phase: on confirmed displacement we call
 * `stamper.invalidateLease()` **immediately** (partition stays bound →
 * `leaseStale=true` → the in-flight `stamp()` throws `PartitionLeaseLostError`
 * and the corrupting upload aborts), and only *then* run the
 * unbind/clear cleanup **under the write lock** so no `stamp()` runs in the
 * window between invalidate and unbind. Lock-synchronising the demote alone is
 * insufficient — it would merely order the demote after an upload that already
 * corrupted the peer's slot space.
 */

import { Bee, PrivateKey } from "@ethersphere/bee-js"
import {
  LEASE_TTL_MS,
  LEASE_REFRESH_MS,
  LEASE_SKEW_MARGIN_MS,
  IDLE_YIELD_MS,
  UtilizationAwareStamper,
  PartitionLeaseLostError,
} from "../utils/batch-utilization"
import { withAccountWriteLock } from "../utils/account-write-lock"
import { withTimeout } from "../utils/promise"
import { PartitionLease } from "./partition-lease"
import type {
  LeaseRefreshOutcome,
  PartitionLeaseStateSnapshot,
} from "./partition-lease"
import { readPartitionLock, NO_HOLDER_DEVICE_ID } from "./partition-lock"
import { STATE_POINTER_EPOCH_MS } from "./partition-state"
import type { UploadTarget } from "../proxy/upload"
import type { StampWorkerPool } from "../proxy/stamp-worker-pool"

/** Hard cap on the acquire path (including any wait-for-slot retry). */
const PARTITION_LEASE_ACQUIRE_TIMEOUT_MS = 45000
/** Max time the acquire spends polling for a slot when all are held. */
const SLOT_WAIT_TIMEOUT_MS = 30000

/**
 * Thrown by `withWrite` in `wait: "skip"` mode when every partition is held by
 * a live foreign device, i.e. there is genuinely no slot to claim. The caller
 * (`sync-account`) catches this and skips the publish — distinct from an
 * operational error (missing stamper, a lock-SOC write that threw), which
 * propagates so it can be logged as an error rather than as contention.
 */
export class PartitionContendedError extends Error {
  constructor(
    message = "All partitions are held by other devices.",
    readonly accountId?: string,
  ) {
    super(message)
    this.name = "PartitionContendedError"
  }
}

/**
 * A lock-SOC payload means this device has been displaced only if it names a
 * *different*, *live* device. A missing/unreadable payload (e.g. a Bee 500),
 * our own id, the release sentinel, or an *expired* foreign holder are all NOT
 * displacement — the holder keeps its lease and retries. Pure (no instance
 * state) so it can be unit-tested directly; mirrors the proxy's former
 * `isDisplaced`.
 */
export function isDisplaced(
  payload: { holderDeviceId: string; leasedUntil: number } | undefined,
  now: number,
  selfDeviceId: string,
): boolean {
  return (
    payload !== undefined &&
    payload.holderDeviceId !== selfDeviceId &&
    payload.holderDeviceId !== NO_HOLDER_DEVICE_ID &&
    payload.leasedUntil > now
  )
}

/** Long-lived (proxy) vs one-off (`sync-account`) lease behaviour. */
export type CoordinatorMode = "persistent" | "oneshot"

/** Per-transition lease snapshot handed to `onLeaseChange`. */
export interface LeaseChangeInfo {
  currentPartition: number | undefined
  isReadOnly: boolean
}

export interface WithWriteOptions {
  useWorkers?: boolean
  workerCount?: number
  /** Override the mode default: persistent → "block", oneshot → "skip". */
  wait?: "block" | "skip"
}

export interface BatchWriteCoordinatorDeps {
  bee: Bee
  /**
   * The resolved-default batch's stamper: stamps the lease's lock/intent/
   * occupancy SOCs and is the write context when no per-write stamper says
   * otherwise. Already created + account-bound by the caller; the coordinator
   * only binds/unbinds the held partition on it (and on any stamper joined
   * via `withWrite`). Its `batchId`/`depth` also serve as the lease batch.
   */
  leaseStamper: UtilizationAwareStamper
  /** This device's identity, captured once by the caller. */
  deviceId: string
  /**
   * Current known device IDs for this account (from the synced device
   * registry). Read fresh per acquire so it reflects late-announced devices.
   * Drives the Phase-2 intent round that lets disjoint-gateway contenders for
   * a free partition agree on one winner (see partition-intent.ts). Omit for
   * single-device / legacy callers — acquire falls back to guard+TTL only.
   */
  knownDeviceIds?: () => string[]
  /**
   * Pull the latest device registry from Swarm into local state before a fresh
   * acquire, so `knownDeviceIds` reflects a peer that signed in after this device
   * created the account (otherwise the claimer is "blind" — never reads the
   * peer's beacon — and dual-acquires). Best-effort; the provider throttles.
   * Omit for node/oneshot callers.
   */
  refreshKnownDeviceIds?: () => Promise<void>
  /**
   * Gateway-propagation tuning for the intent round (optional overrides; default
   * to the `INTENT_*` constants). Lets the proxy pass runtime-tunable values.
   */
  intentReadTimeoutMs?: number
  intentGuardWindowMs?: number
  intentGuardPollMs?: number
  accountId: string
  /** Owns the per-partition lock SOCs (derived from the account key). */
  backupSigner: PrivateKey
  swarmEncryptionKey: Uint8Array
  partitionCount: number
  mode: CoordinatorMode
  /** Persistent mode only: read/write the local lease-cache hint. */
  readLeaseCache?: () => PartitionLeaseStateSnapshot | undefined
  writeLeaseCache?: (snap: PartitionLeaseStateSnapshot | undefined) => void
  /** Flush the GIVEN stamper's bucket state after a write (proxy:
   *  `saveStamperState`). Called for the write's stamper and, when different,
   *  the lease stamper — lease SOC writes dirty the latter's buckets. */
  flushStamperState?: (stamper: UtilizationAwareStamper) => Promise<void>
  /** Build/reuse a parallel-signing worker pool for the GIVEN stamper (proxy:
   *  `getOrCreateWorkerPool`). Pools capture a stamper's batch/buckets, so
   *  they must never be shared across batches. */
  getWorkerPool?: (
    stamper: UtilizationAwareStamper,
    count?: number,
  ) => Promise<StampWorkerPool | undefined>
  /**
   * Resolve an owned batch's stamper by hex batch id (proxy: the per-batch
   * stamp-entry cache, building on a miss). Used only by the re-adopt path to
   * re-bind batches this device had joined before a reload, so their state
   * pointers keep being heartbeated. Returns `undefined` — never throws — when
   * the account no longer owns the batch. Absent for callers with no batch
   * cache (`sync-account`), which simply skip the restore.
   */
  resolveStamperForBatch?: (
    batchIdHex: string,
  ) => Promise<UtilizationAwareStamper | undefined>
  /** Fired on every partition / read-only transition. */
  onLeaseChange?: (info: LeaseChangeInfo) => void
  /** Fired when a partition is (re)acquired (phase-5 publish trigger). */
  onLeaseAcquired?: (partition: number) => void
}

export class BatchWriteCoordinator {
  private readonly deps: BatchWriteCoordinatorDeps

  /** Active partition-lease; undefined when no lease is held (read-only mode,
   *  or single-partition legacy accounts). */
  private partitionLease: PartitionLease | undefined
  private partitionRefreshTimer: ReturnType<typeof setInterval> | undefined
  private readOnly: boolean = false
  /** Set when the next write should (re)acquire a partition: cold start,
   *  after a demote, or while read-only. */
  private pendingAcquire: boolean = false
  /** Wall-clock ms of the last lock-SOC validation (acquire / refresh). */
  private lastLeaseValidatedAt: number = 0
  /** Wall-clock ms of the last upload activity; drives the idle-yield. */
  private lastLeaseActivityAt: number = 0
  /** Uploads currently executing under the write lock; the refresh tick only
   *  yields an idle lease when this is 0. */
  private activeUploadCount: number = 0
  /** Wall-clock ms the state-pointer heartbeat has been failing since
   *  (undefined = healthy). The heartbeat is best-effort per tick, but a
   *  PERSISTENT failure streak walks the last durable pointer out of the
   *  takeover lookup span while lock renewals keep extending `leasedUntil` —
   *  a takeover would then zero-seed over acked slots. Once the streak
   *  exceeds one pointer epoch, `refreshTick` demotes. Reset on a successful
   *  heartbeat and whenever the lease binding changes. */
  private pointerHeartbeatFailingSince: number | undefined = undefined
  /** Set by `teardown()`. Once disposed the coordinator must never re-acquire a
   *  partition or arm a refresh timer: an in-flight `withWrite` (e.g. a deferred
   *  publish, or a normal upload) can outlive a disconnect/sign-out, and without
   *  this guard its `ensureLease` would re-lease the slot and start a detached
   *  interval — a ghost lease the proxy can no longer tear down. */
  private disposed: boolean = false
  /** Bumped whenever held-lease state is reset (`pauseLeaseBackgroundWork`,
   *  `finalizeDemote`, `yieldIdleLease`, `teardown`). An `acquire()` that began
   *  under an older epoch must not commit (bind / start timers) when it
   *  resolves — `Promise.race` cannot cancel a losing acquire, whose
   *  continuation would otherwise resurrect a lease the coordinator already
   *  cleared. */
  private leaseEpoch: number = 0
  /**
   * Stampers of batches OTHER than the lease batch that are partition-bound to
   * the current lease session (joined via `ensureBatchJoined` on their first
   * write), keyed by batch id hex. Every lease-loss path (displacement, demote,
   * idle-yield, teardown, pause) fans invalidate/unbind out over these too, so
   * an in-flight targeted stamp aborts exactly like a lease-batch one — and
   * clears the map, because a NEW lease session may hold a different partition
   * (the next targeted write re-joins against it).
   */
  private readonly joinedSecondaries = new Map<
    string,
    UtilizationAwareStamper
  >()
  /**
   * The lease session `signalLeaseLost` last fired for. The breaker fan-out
   * only reaches stampers ALREADY in `joinedSecondaries`; a batch whose
   * `joinBatch` is in flight when the signal lands (the refresh tick signals
   * OFF the write lock, while a targeted write holds it) would miss it and
   * `bindPartition` would re-arm (`leaseStale = false`) on a lost partition.
   * `ensureBatchJoined` re-checks this marker after the join resolves and
   * aborts the write instead of binding. Cleared by `finalizeDemote` — once
   * the demote lands, `partitionLease` no longer names the lost session and
   * the identity check covers stragglers.
   */
  private lostLease: PartitionLease | undefined
  /**
   * The in-flight background restore kicked off by the re-adopt fast path.
   * Never awaited in production — the refresh tick picks the batches up once
   * they land. See {@link joinedRestoreSettled}.
   */
  private joinedRestore: Promise<void> | undefined
  /**
   * Per-SECONDARY state-pointer heartbeat failure streaks, keyed by batch id
   * hex. The lease batch's streak is `pointerHeartbeatFailingSince` (it demotes
   * the whole lease — the pointer protects every takeover); a secondary's
   * streak only evicts THAT batch from the joined set once it outlives one
   * pointer epoch. Entries are pruned lazily on each tick.
   */
  private readonly secondaryHeartbeatFailingSince = new Map<string, number>()

  constructor(deps: BatchWriteCoordinatorDeps) {
    this.deps = deps
  }

  /** Current held partition, or undefined (read-only / legacy / not yet acquired). */
  get currentPartition(): number | undefined {
    return this.partitionLease?.currentPartition
  }

  /** True when every partition is held by a live peer and this device cannot write. */
  get isReadOnly(): boolean {
    return this.readOnly
  }

  /**
   * Resolves when the re-adopt path's background joined-batch restore has
   * settled (immediately when none ran). Never rejects. Exposed so tests have
   * a deterministic sync point, mirroring `PartitionLease.beaconPublishSettled`.
   */
  get joinedRestoreSettled(): Promise<void> {
    return this.joinedRestore ?? Promise.resolve()
  }

  /** The lease (resolved-default) batch's stamper — exposed for the proxy's
   *  `buildConnectionInfo` (appKey / uploadMode) and its account-state
   *  publish. */
  get stamperRef(): UtilizationAwareStamper {
    return this.deps.leaseStamper
  }

  /** The account this coordinator (and its batch/lease) was built for —
   *  exposed so the proxy can refuse to publish a snapshot assembled for a
   *  different account through this coordinator's batch. */
  get accountId(): string {
    return this.deps.accountId
  }

  // ---- write entry point --------------------------------------------------

  /**
   * The single write entry point. Takes the cross-tab Web Lock, ensures a held
   * partition (acquire / slot-wait, or skip-with-throw), joins `stamper`'s
   * batch to the lease session when it isn't the lease batch, runs `op`
   * against a stamper upload target, and flushes stamper state. Subsidised
   * mode is NOT a coordinator concern — the proxy only calls this in stamper
   * mode.
   *
   * @param stamper the target batch's stamper — the write's batch context
   *   (its `batchId`/`depth` name the batch). Pass `stamperRef` to write the
   *   resolved default batch.
   */
  async withWrite<T>(
    stamper: UtilizationAwareStamper,
    op: (target: UploadTarget) => Promise<T>,
    opts?: WithWriteOptions,
  ): Promise<T> {
    const wait =
      opts?.wait ?? (this.deps.mode === "persistent" ? "block" : "skip")
    return this.lockAndFlush(async () => {
      await this.ensureLease(wait)
      this.ensureHeldForUpload()
      await this.ensureBatchJoined(stamper)
      const target = await this.buildStamperTarget(stamper, opts)
      // Bracket the in-flight upload so the refresh tick's idle-yield can't
      // release the partition (and unbind the stamper) underneath us.
      this.lastLeaseActivityAt = Date.now()
      this.activeUploadCount++
      try {
        // NOTE: `op` performs the chunk write(s) BEFORE the post-op guard
        // below. The cold-re-entry case (a woken/throttled holder) is fenced by
        // the pre-op `ensureLease` check (`leaseNearExpiry` forces a lock read).
        // A lease that lapses MID-`op` (a long multi-chunk upload while the
        // refresh tick can't renew for a full TTL) is NOT fenced for the data
        // write — stamps only re-check the local `leaseStale` flag — only the
        // ack is. Bounded by skew + TTL (see Postage-Batch-Partitioning.md §12).
        const result = await op(target)
        // Commit-ordered ack: only report the upload durable after the
        // partition-state that reserves its slots is published.
        //  1. Reverse-clobber guard (#rule 2): re-validate the lease before
        //     acking. For a fast upload this is throttled (no read); a long
        //     upload that outran the refresh tick / TTL re-reads the lock SOC
        //     and demotes+throws here, so we never publish slots a peer owns.
        //  2. Ack-after-publish (#rule 1): publish the partition counter, then
        //     resolve. A guard/publish throw propagates → upload reported
        //     failed, never acked (chunks are content-addressed → safe retry).
        await this.ensureLeaseStillValid()
        const localCounter = stamper.getLocalCounter()
        if (localCounter !== undefined) {
          await this.partitionLease?.publishState(localCounter, stamper)
          // The publish durably re-wrote the state pointer to the current
          // bucket (same effect as a successful heartbeat), so an idle-blip
          // failure streak is stale — clear it. Otherwise the refresh tick keeps
          // measuring drift from the old timestamp across this fresh publish and
          // could demote a healthy holder prematurely.
          this.pointerHeartbeatFailingSince = undefined
        } else if (this.currentPartition !== undefined) {
          // Held a partition lease but the stamper has no local counter: the
          // commit publish (ack-after-publish) would be silently skipped,
          // acking an upload whose slot reservation never reached Swarm. Fail
          // loudly instead — the chunks are content-addressed, so a retry is
          // safe. (Legacy single-partition mode has no counter to publish and
          // correctly falls through.)
          throw new Error(
            `[BatchWriteCoordinator] Held partition ${this.currentPartition} ` +
              "but the stamper exposed no local counter — cannot publish the " +
              "slot reservation (ack-after-publish); failing the upload.",
          )
        }
        return result
      } finally {
        this.activeUploadCount--
        this.lastLeaseActivityAt = Date.now()
      }
    }, stamper)
  }

  /**
   * Bind a targeted batch's stamper to the held partition: seed its counter
   * from that batch's published partition state (`PartitionLease.joinBatch` —
   * no lock activity, the claim is account-scoped) and register it for the
   * lease-loss fan-out. No-op for the lease stamper ITSELF (bound at acquire),
   * an already-joined instance, and single-partition legacy accounts (nothing
   * is sliced). A REPLACED stamper instance (the proxy rebuilt it) re-joins and
   * supersedes the old entry — including a rebuild of the LEASE batch, which
   * must be matched by instance and not by batch id: a fresh instance for the
   * lease batch is unbound, and letting it through would stamp it into
   * partition 0's slot lane (`stamp()` falls back to `dataSlot(0, …)` when no
   * partition is bound) before the post-op counter guard fails the upload.
   * MUST run under the write lock, after `ensureHeldForUpload`.
   */
  private async ensureBatchJoined(
    stamper: UtilizationAwareStamper,
  ): Promise<void> {
    if (this.deps.partitionCount <= 1) return
    const key = stamper.batchId.toHex()
    if (stamper === this.deps.leaseStamper) return
    if (this.joinedSecondaries.get(key) === stamper) return
    const lease = this.partitionLease
    const partition = lease?.currentPartition
    if (!lease || partition === undefined) {
      // `ensureHeldForUpload` ran before us, so this is unreachable in practice.
      throw new Error("Cannot join a batch without a held partition lease.")
    }
    const localCounter = await lease.joinBatch(stamper)
    // The join awaited off the breaker's reach (this stamper is not in
    // `joinedSecondaries` yet): a displacement signalled meanwhile must abort
    // the write here — `bindPartition` below would reset `leaseStale` and let
    // the upload stamp a partition a peer now owns.
    if (
      this.disposed ||
      this.partitionLease !== lease ||
      this.lostLease === lease
    ) {
      throw new PartitionLeaseLostError()
    }
    stamper.bindPartition({
      partition,
      partitionCount: this.deps.partitionCount,
      localCounter,
    })
    stamper.setLeaseValidUntil(lease.leasedUntil)
    this.joinedSecondaries.set(key, stamper)
    // Persist the join immediately rather than waiting for the next refresh
    // tick: a reload inside that window would lose this batch from the cached
    // snapshot, and its state pointer would stop being heartbeated.
    this.deps.writeLeaseCache?.(lease.serialize())
  }

  /**
   * Re-bind the batches a PREVIOUS session of this device had joined, after the
   * re-adopt fast path re-established the lease from the local cache.
   *
   * `joinedSecondaries` lives only in memory, so without this a reload leaves
   * every secondary batch unheartbeated: `heartbeatStatePointer` no-ops for a
   * batch whose `lastReferenceHex` is unset, the pointer ages out of
   * `readStatePointer`'s ~90s lookup span, and a later cross-device takeover
   * resumes that batch from a ZERO counter — re-issuing acked slots and
   * evicting their chunks. This device's own writes are safe either way (they
   * resume off the persisted synced reference); the exposure is to peers.
   *
   * Mirrors the adopt path's lease-batch sequence per batch, and like it seeds
   * from local state only — no Swarm read, no lock activity on the claim.
   * Best-effort per batch: a failure leaves that batch exactly as badly off as
   * before this existed.
   */
  private async restoreJoinedSecondaries(
    lease: PartitionLease,
    epoch: number,
    partition: number,
    batchIds: string[] | undefined,
    seed: "local" | "network",
  ): Promise<void> {
    const resolve = this.deps.resolveStamperForBatch
    if (!resolve || !batchIds?.length || this.deps.partitionCount <= 1) return
    const leaseBatchHex = this.deps.leaseStamper.batchId.toHex()
    let restored = 0
    for (const key of batchIds) {
      // The persisted list includes the writing session's lease batch, which
      // after a default-stamp change is a restorable secondary here — but the
      // CURRENT lease batch is already bound by the acquire/adopt itself.
      if (key === leaseBatchHex) continue
      if (this.joinedSecondaries.has(key)) continue
      try {
        // Resolved OFF the write lock: the proxy's resolver takes the batch's
        // state Web Lock internally and Web Locks are not reentrant.
        const stamper = await resolve(key)
        if (!stamper) continue
        // Where the batch's resume state comes from decides safety:
        //  - "local" (adopt fast path): `adoptIfLive` proved the lease never
        //    lapsed, so no peer can have written this partition since our last
        //    flush — this device's persisted state is the newest there is, and
        //    no network read is needed (adopt works through Bee blips).
        //  - "network" (cold acquire): the cached lease was NOT adoptable, so a
        //    peer may have held the partition meanwhile and advanced this batch
        //    past our local state; binding local here could later full-publish
        //    a LOWER counter over the peer's resume point (slot reuse).
        //    `joinBatch` reads the partition state exactly like a targeted
        //    write's join would, and throws on an inconclusive read.
        const localCounter =
          seed === "network"
            ? await lease.joinBatch(stamper)
            : stamper.buildLeaseLocalCounter()
        const referenceHex =
          seed === "network"
            ? undefined // joinBatch already seeded the lease's pointer state
            : await stamper.getSyncedReference(partition).catch(() => undefined)
        // Commit under the lock so it cannot interleave with a demote or an
        // idle-yield, with no await between the guard and the map insert.
        await this.lock(async () => {
          // `bindPartition` clears `leaseStale`, so a restore that straggles
          // past a lease loss would re-arm a stamper on a partition a peer now
          // owns. Same triple check `ensureBatchJoined` makes, plus the epoch.
          if (
            this.disposed ||
            this.leaseEpoch !== epoch ||
            this.partitionLease !== lease ||
            this.lostLease === lease
          ) {
            return
          }
          // Re-checked HERE, not only before the awaits above: a targeted
          // write can join this batch properly (network read + publish) while
          // we were resolving. Its state is fresher — committing ours would
          // regress the heartbeat pointer to our pre-publish read, and a
          // takeover following the stale pointer resumes below acked.
          if (this.joinedSecondaries.has(key)) return
          stamper.bindPartition({
            partition,
            partitionCount: this.deps.partitionCount,
            localCounter,
          })
          stamper.setLeaseValidUntil(lease.leasedUntil)
          if (seed === "local") lease.seedReferenceHex(referenceHex, stamper)
          this.joinedSecondaries.set(key, stamper)
          restored++
        })
      } catch (error) {
        console.warn(
          `[BatchWriteCoordinator] Could not restore joined batch ${key}:`,
          error,
        )
      }
    }
    // Persist the restored set: the acquire wrote its snapshot BEFORE this ran
    // (empty stateByBatch → no joinedBatchIds), so without this a SECOND reload
    // inside the next refresh tick's window (~LEASE_REFRESH_MS) would lose the
    // list again.
    if (restored > 0) {
      await this.lock(async () => {
        if (this.disposed || this.partitionLease !== lease) return
        this.deps.writeLeaseCache?.(lease.serialize())
      })
    }
  }

  /** Persistent mode: eagerly acquire a partition + start the refresh timer in
   *  the background so the first upload doesn't pay the acquire latency. */
  startLease(): void {
    if (this.disposed) return
    if (this.deps.mode !== "persistent") return
    if (this.deps.partitionCount <= 1) return
    this.pendingAcquire = true
    void this.lockAndFlush(() => this.ensureLease("block")).catch((err) =>
      console.warn(
        "[BatchWriteCoordinator] Background lease warm-up failed:",
        err,
      ),
    )
  }

  /**
   * Tear down all lease background work and release the held partition
   * (best-effort) so peers see this device vacate promptly. Used on sign-out /
   * disconnect. Never throws.
   */
  teardown(): void {
    // Disposed coordinators must never re-acquire: an in-flight `withWrite`
    // (deferred publish or upload) can outlive this call and would otherwise
    // re-lease the slot + arm a detached refresh interval.
    this.disposed = true
    this.leaseEpoch++
    if (this.partitionRefreshTimer !== undefined) {
      clearInterval(this.partitionRefreshTimer)
      this.partitionRefreshTimer = undefined
    }
    const lease = this.partitionLease
    if (lease) {
      const localCounter = this.deps.leaseStamper.getLocalCounter()
      // Stampers AND counters captured before the synchronous unbind below:
      // the deferred lock callback runs after it (Web Locks callbacks are
      // always async), when `getLocalCounter()` is already `undefined`.
      const secondaries = [...this.joinedSecondaries.values()].map((s) => ({
        stamper: s,
        counter: s.getLocalCounter(),
      }))
      if (localCounter !== undefined) {
        // Serialize the detached release under the account write lock (#349):
        // a successor coordinator's acquire (`startLease`/`withWrite` →
        // `lockAndFlush`) queues on the same account-wide Web Lock, so the
        // release's publish + sentinel fully complete BEFORE the successor
        // can read or write the lock SOC — the sentinel's postage stamp is
        // minted strictly before the successor's claim stamp, and Bee's
        // newer-stamp-wins replacement keeps the claim. The generation fence
        // in `releasePartitionLock` covers writers outside this lock. (In
        // non-browser contexts the lock no-ops; only `oneshot` mode runs
        // there and it never releases.)
        //
        // The release runs AFTER the synchronous unbind below — the publish
        // goes through an unbound stamper, which is safe because
        // `writePartitionState` marks its chunks with the explicit partition
        // slot.
        void this.lock(async () => {
          // Flush every joined batch's final counter first (best-effort,
          // per batch) — the release sentinel below frees the partition for
          // peers, whose takeover must resume each batch at its acked
          // counter, not just the lease batch's.
          for (const { stamper, counter } of secondaries) {
            if (counter === undefined) continue
            try {
              await lease.publishState(counter, stamper)
            } catch (err) {
              console.warn(
                "[BatchWriteCoordinator] Teardown state publish failed for a joined batch:",
                err,
              )
            }
          }
          await lease.release(localCounter)
        }).catch((err) =>
          console.warn(
            "[BatchWriteCoordinator] Partition lease release failed:",
            err,
          ),
        )
      }
      // Invalidate BEFORE unbinding (same ordering as the displacement race
      // fix): teardown runs synchronously, off the write lock, so it can land
      // between two awaits of an in-flight `stamp()`. `unbindPartition` alone
      // resets `leaseStale=false`, letting that stamp silently fall back to
      // legacy "any"-pool slot-picking and corrupt a peer's slots; invalidating
      // first arms the breaker so the in-flight stamp aborts with
      // `PartitionLeaseLostError` instead. Fanned out over every bound
      // stamper — a targeted in-flight stamp must abort the same way.
      this.forEachBoundStamper((s) => s.invalidateLease())
      this.forEachBoundStamper((s) => s.unbindPartition())
      this.joinedSecondaries.clear()
    }
    this.partitionLease = undefined
    this.readOnly = false
    this.lastLeaseValidatedAt = 0
    this.deps.writeLeaseCache?.(undefined)
    this.emitLeaseChange()
  }

  // ---- lease lifecycle ----------------------------------------------------

  /**
   * Ensure a partition is held for the current write. Runs under the write
   * lock (called from `withWrite`/`startLease`). Re-arms a pending acquire
   * when no lease is held or we are read-only, then either acquires (with
   * slot-wait in "block" mode, or once-then-throw in "skip" mode) or runs the
   * throttled freshness check on the held lease.
   */
  private async ensureLease(wait: "block" | "skip"): Promise<void> {
    try {
      // Single-partition (legacy) accounts never lease — nothing to do (and no
      // ghost-lease risk, so the disposed guard below doesn't apply to them).
      if (this.deps.partitionCount <= 1) return
      // Torn down while this write was in flight (disconnect / sign-out / re-
      // auth). Bail before any (re)acquire so we never resurrect a ghost lease.
      if (this.disposed) {
        throw new Error("BatchWriteCoordinator has been torn down.")
      }

      if (!this.pendingAcquire && (!this.partitionLease || this.readOnly)) {
        this.pendingAcquire = true
      }

      if (this.pendingAcquire) {
        this.pendingAcquire = false
        if (wait === "skip") {
          // One-off: a single acquire attempt. PartitionLease.acquire claims a
          // free/expired slot under the lock SOC's generation fencing. An
          // operational failure inside `acquire` (lock-SOC scan/claim threw)
          // propagates as-is so the caller reports an error; only a COMPLETED
          // acquire that found every partition held by a live peer is
          // contention.
          await this.acquire()
          if (this.readOnly || this.currentPartition === undefined) {
            throw new PartitionContendedError(undefined, this.deps.accountId)
          }
          return
        }
        try {
          await withTimeout(
            this.acquireWithSlotWait(),
            PARTITION_LEASE_ACQUIRE_TIMEOUT_MS,
            `Partition lease timed out after ${PARTITION_LEASE_ACQUIRE_TIMEOUT_MS}ms`,
          )
        } catch (error) {
          console.warn(
            "[BatchWriteCoordinator] Partition lease acquisition failed, pausing background work:",
            error,
          )
          this.pauseLeaseBackgroundWork()
          // Surface the real cause (Bee down, timeout, contention) instead of
          // letting `ensureHeldForUpload` mislabel it as "batch fully leased
          // by other devices". `startLease`'s warm-up catch absorbs this.
          throw error
        }
        return
      }
      await this.ensureLeaseStillValid()
    } finally {
      // Reflect any partition transition to the consumer. Idempotent — the
      // proxy suppresses unchanged ConnectionInfo.
      this.emitLeaseChange()
    }
  }

  /**
   * Acquire a partition via the lock SOC — the single source of truth. The
   * local cache is only a hint (`hydrate`); `acquire` always re-reads and
   * reconciles against the lock SOCs before binding.
   */
  private async acquire(): Promise<void> {
    const {
      leaseStamper: stamper,
      partitionCount,
      swarmEncryptionKey,
    } = this.deps
    if (partitionCount <= 1) {
      this.readOnly = false
      return
    }
    // Torn down before this acquire started (e.g. a later slot-wait iteration
    // after a disconnect). Don't bind a partition we can never release.
    if (this.disposed) return
    // Epoch capture: `ensureLease`'s block path races this acquire against a
    // timeout it cannot cancel. If the timeout fires, `pauseLeaseBackgroundWork`
    // resets state and bumps the epoch; a late-completing continuation here must
    // then abort instead of re-binding a partition and arming a refresh timer
    // the coordinator no longer tracks.
    const epoch = this.leaseEpoch
    // Refresh the device registry in the BACKGROUND — do NOT await it here.
    // `refreshKnownDeviceIds` folds the roster from Swarm, which on a slow/flaky
    // gateway can take tens of seconds; awaiting it under the cross-tab write
    // lock made `startLease`'s warm-up hold that lock for the whole scan (up to
    // the 45s acquire cap), stalling the user's first upload behind it. `acquire`
    // reads the rival set from local storage (`knownDeviceIds`), so a refresh
    // that lands after this acquire simply benefits the NEXT one. The only cost
    // of a momentarily-stale set is skipping the per-device intent read for a
    // brand-new peer — still caught by the deviceId-independent occupancy beacon
    // and reconciled on the next acquire.
    void this.deps
      .refreshKnownDeviceIds?.()
      .catch((error) =>
        console.warn(
          "[BatchWriteCoordinator] Background device-registry refresh failed (using current registry):",
          error,
        ),
      )
    if (this.leaseEpoch !== epoch || this.disposed) return
    try {
      const lease = await PartitionLease.fromSwarmEncryptionKey({
        bee: this.deps.bee,
        deviceId: this.deps.deviceId,
        batchId: stamper.batchId,
        batchDepth: stamper.depth,
        swarmEncryptionKey,
        stamper,
        knownDeviceIds: this.deps.knownDeviceIds,
        intentReadTimeoutMs: this.deps.intentReadTimeoutMs,
        intentGuardWindowMs: this.deps.intentGuardWindowMs,
        intentGuardPollMs: this.deps.intentGuardPollMs,
      })
      if (this.leaseEpoch !== epoch) return
      const cached = this.deps.readLeaseCache?.()
      if (cached) lease.hydrate(cached)

      // Re-adopt fast path: a still-valid cached lease (e.g. after a reload
      // within the TTL) is re-established from local state alone — no lock-SOC
      // scan/write, so it survives transient Bee 500s. The refresh tick then
      // reconciles with Swarm and demotes only on a confirmed foreign holder.
      const adopted = lease.adoptIfLive()
      if (adopted !== undefined) {
        // Seed the heartbeat's resume-pointer target from the persisted synced
        // reference. The cold `claimPartition` path seeds this from the state it
        // reads on acquire; the adopt fast path skips `claimPartition`, so
        // without this an adopted-but-idle holder never heartbeats the inherited
        // pointer forward and it ages out of the takeover lookup span
        // (resume-from-zero → re-issues a gone holder's acked slots). Read it
        // BEFORE the synchronous commit below so no await splits the bind, then
        // re-check the epoch the same way the cold path does. Best-effort
        // (undefined on a genuinely fresh partition → heartbeat stays a no-op).
        const seededReferenceHex = await stamper
          .getSyncedReference(adopted)
          .catch(() => undefined)
        if (this.leaseEpoch !== epoch || this.disposed) return
        // Diagnostic: this re-binds a CACHED lease with no Swarm scan and no
        // intent round. If two devices both adopt partition 0 from stale
        // caches, that's a dual-hold the intent round never gets to arbitrate.
        console.debug(
          `[BatchWriteCoordinator] Adopted cached lease p=${adopted} (no acquire/intent round) for device=${this.deps.deviceId}`,
        )
        this.partitionLease = lease
        this.readOnly = false
        stamper.bindPartition({
          partition: adopted,
          partitionCount,
          localCounter: stamper.buildLeaseLocalCounter(),
        })
        // Fence in-flight stamps to the lease's local expiry (bind clears it).
        this.syncStamperLeaseDeadline()
        // Seed before `onLeaseAcquired` (which may publish): a publish's
        // `flushState` then overwrites this with the fresh reference.
        lease.seedReferenceHex(seededReferenceHex)
        this.deps.writeLeaseCache?.(lease.serialize())
        this.startRefreshTimer(lease)
        this.lastLeaseValidatedAt = Date.now()
        this.lastLeaseActivityAt = Date.now()
        this.pointerHeartbeatFailingSince = undefined // fresh lease session
        this.deps.onLeaseAcquired?.(adopted)
        // Re-establish the batches this device had joined before the reload,
        // in the BACKGROUND: each one needs its stamper resolved (a lock
        // acquisition inside the proxy) and adopt must not pay for that. The
        // pointer only has to be refreshed before it ages out of the ~90s
        // takeover lookup span, and the refresh tick runs far more often.
        this.joinedRestore = this.restoreJoinedSecondaries(
          lease,
          epoch,
          adopted,
          cached?.joinedBatchIds,
          // Local seeding is sound here and only here: `adoptIfLive` proved the
          // cached lease is still unexpired, so no peer can have held this
          // partition since our last write — local state is the newest there is.
          "local",
        ).catch((error: unknown) =>
          console.warn(
            "[BatchWriteCoordinator] Joined-batch restore failed:",
            error,
          ),
        )
        return
      }

      const result = await lease.acquire({ partitionCount })
      if (this.leaseEpoch !== epoch) return
      this.partitionLease = lease
      this.readOnly = result.isReadOnly

      if (result.partition === undefined) {
        if (result.isReadOnly) {
          console.warn(
            "[BatchWriteCoordinator] All partitions held; entering read-only mode until a peer releases.",
          )
        }
        this.deps.writeLeaseCache?.(lease.serialize())
        return
      }

      stamper.bindPartition({
        partition: result.partition,
        partitionCount: result.partitionCount,
        localCounter: result.localCounter,
      })
      // Fence in-flight stamps to the lease's local expiry (bind clears it).
      this.syncStamperLeaseDeadline()
      this.deps.writeLeaseCache?.(lease.serialize())
      this.startRefreshTimer(lease)
      this.lastLeaseValidatedAt = Date.now()
      this.lastLeaseActivityAt = Date.now()
      this.pointerHeartbeatFailingSince = undefined // fresh lease session
      this.deps.onLeaseAcquired?.(result.partition)
      // Re-join the batches the previous session had written, seeding each from
      // the NETWORK (`joinBatch`): a cold acquire means the cached lease was
      // not adoptable — it lapsed, or the lease batch changed — so a peer may
      // have held this partition meanwhile and advanced those batches past our
      // local state. Local seeding here could full-publish a LOWER counter over
      // the peer's resume point (slot reuse); `joinBatch`'s read is the same
      // one a targeted write would pay.
      this.joinedRestore = this.restoreJoinedSecondaries(
        lease,
        epoch,
        result.partition,
        cached?.joinedBatchIds,
        "network",
      ).catch((error: unknown) =>
        console.warn(
          "[BatchWriteCoordinator] Joined-batch restore failed:",
          error,
        ),
      )
    } catch (error) {
      console.error(
        "[BatchWriteCoordinator] Failed to acquire partition lease:",
        error,
      )
      // Same epoch guard as the success paths above, mirrored to the failure
      // side: a newer epoch owns the coordinator state now (the racing acquire
      // timeout paused background work, and a later acquire may have re-leased).
      // A stale failure must not clobber the live lease's in-memory state or
      // wipe its cache — just propagate.
      if (this.leaseEpoch !== epoch) throw error
      // The throw may have come AFTER bindPartition/startRefreshTimer (e.g. a
      // consumer callback — writeLeaseCache/onLeaseAcquired — threw): undo the
      // partial commit so the stamper and the interval don't outlive the lease
      // record. Invalidate-before-unbind per the displacement-race ordering;
      // all three are no-ops when nothing was bound/armed.
      if (this.partitionRefreshTimer !== undefined) {
        clearInterval(this.partitionRefreshTimer)
        this.partitionRefreshTimer = undefined
      }
      stamper.invalidateLease()
      stamper.unbindPartition()
      this.partitionLease = undefined
      this.readOnly = false
      // Keep cache and in-memory state in lockstep: no lease → no live cache.
      this.deps.writeLeaseCache?.(undefined)
      // Operational failure (the lock-SOC scan/claim threw) — NOT contention.
      // Propagate so the skip path reports an error instead of "all partitions
      // held", and the block path pauses background work on the real cause.
      throw error
    }
  }

  /**
   * Wait-for-slot wrapper around `acquire`. When the initial acquire returns
   * read-only (every partition held by a live foreign holder), poll every
   * `LEASE_REFRESH_MS` up to `SLOT_WAIT_TIMEOUT_MS`.
   */
  private async acquireWithSlotWait(): Promise<void> {
    const deadline = Date.now() + SLOT_WAIT_TIMEOUT_MS
    // Epoch capture: when the `withTimeout` in `ensureLease` fires, this
    // loop keeps running detached (the race can't cancel it) and would
    // otherwise wake from its poll sleep and claim the lock SOC one more
    // time, only for `acquire()` to discard the claim — a pointless ghost
    // claim peers must wait out via the TTL.
    const epoch = this.leaseEpoch
    while (true) {
      await this.acquire()
      // Disposed mid-wait (disconnect during the slot poll): stop waiting for a
      // slot we'd never be able to use.
      if (this.disposed) return
      if (!this.readOnly) return
      if (Date.now() + LEASE_REFRESH_MS > deadline) {
        throw new PartitionContendedError(
          "No partition available — all slots are held by other devices.",
          this.deps.accountId,
        )
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, LEASE_REFRESH_MS),
      )
      // Checked between the sleep and the next acquire: a fresh `acquire()`
      // call would capture the bumped epoch as its own baseline and commit.
      if (this.leaseEpoch !== epoch) return
    }
  }

  /**
   * Push the held lease's local expiry to the stamper so an in-flight `stamp()`
   * fences itself the moment the lease lapses locally — the write-side
   * complement of the reverse-clobber ack guard (Postage-Batch-Partitioning.md
   * §12, "ack-safe, not write-safe"). Call wherever `leasedUntil` moves while we
   * hold: bind and every renewal. `undefined` (no lease) disables the fence.
   */
  private syncStamperLeaseDeadline(): void {
    this.forEachBoundStamper((s) =>
      s.setLeaseValidUntil(this.partitionLease?.leasedUntil),
    )
  }

  /** The lease stamper plus every joined secondary — the set a lease-state
   *  transition must fan out to. */
  private forEachBoundStamper(fn: (s: UtilizationAwareStamper) => void): void {
    fn(this.deps.leaseStamper)
    for (const s of this.joinedSecondaries.values()) fn(s)
  }

  /**
   * Whether the held lease is within {@link LEASE_SKEW_MARGIN_MS} of its local
   * expiry (or already lapsed). When true the freshness check must re-read the
   * lock SOC even inside the throttle window — the reverse-clobber guard.
   */
  private leaseNearExpiry(): boolean {
    const leasedUntil = this.partitionLease?.leasedUntil
    if (leasedUntil === undefined) return false
    return Date.now() >= leasedUntil - LEASE_SKEW_MARGIN_MS
  }

  /**
   * Throttled lock-SOC freshness check on the held lease. Runs under the write
   * lock (via `ensureLease`). Demotes (and throws) when a different live device
   * now holds our partition.
   */
  private async ensureLeaseStillValid(): Promise<void> {
    if (!this.partitionLease || this.readOnly) return
    const partition = this.partitionLease.currentPartition
    if (partition === undefined) return
    // Throttle gateway reads to once per refresh window — UNLESS the local
    // lease is within skew of expiry, in which case we must re-read now (the
    // refresh tick fell behind: suspended tab / clock jump / long upload).
    if (
      !this.leaseNearExpiry() &&
      Date.now() - this.lastLeaseValidatedAt < LEASE_REFRESH_MS
    )
      return

    let payload
    try {
      payload = await readPartitionLock({
        bee: this.deps.bee,
        backupSigner: this.deps.backupSigner,
        swarmEncryptionKey: this.deps.swarmEncryptionKey,
        partition,
      })
    } catch (err) {
      // Read failed (transient) — inconclusive, keep the lease and retry.
      console.warn(
        "[BatchWriteCoordinator] Lease freshness check read failed:",
        err,
      )
      return
    }

    if (isDisplaced(payload, Date.now(), this.deps.deviceId)) {
      console.warn(
        `[BatchWriteCoordinator] Lease freshness check: partition ${partition} taken by ${payload!.holderDeviceId}; demoting.`,
      )
      // Already under the write lock here, so finalize inline (no re-acquire —
      // Web Locks are not reentrant). `signalLeaseLost` first so the breaker is
      // armed before unbind, consistent with the refresh-tick path.
      this.signalLeaseLost()
      this.finalizeDemote()
      throw new Error("Partition lease was reclaimed by another device.")
    }

    // A release sentinel is visible while we believe we hold — a stale
    // (pre-fencing) sentinel converging late, or a frozen-cache view of one.
    // Re-assert the claim NOW instead of waiting for the next refresh tick,
    // so peers stop reading the partition as free before this upload runs.
    // NOTE: this is defence in depth, not the primary #349 fix — the
    // freshness throttle above usually skips this check in the seconds right
    // after a re-acquire; the teardown-release lock serialization closes
    // that window.
    if (
      payload !== undefined &&
      payload.holderDeviceId === NO_HOLDER_DEVICE_ID
    ) {
      let reasserted: LeaseRefreshOutcome
      try {
        reasserted = await this.partitionLease.refresh()
      } catch (err) {
        // Transient — keep the lease, and do NOT bump lastLeaseValidatedAt so
        // the next upload retries the check.
        console.warn(
          "[BatchWriteCoordinator] Sentinel re-assert hit a transient error; keeping lease:",
          err,
        )
        return
      }
      if (reasserted !== "held") {
        // blocked / lost-race (`"lost"`) or a beacon-confirmed peer
        // (`"displaced"`) — a peer claimed after the sentinel. Mirror the
        // displaced branch exactly (we are under the write lock).
        console.warn(
          `[BatchWriteCoordinator] Sentinel re-assert: partition ${partition} taken by a peer; demoting.`,
        )
        this.signalLeaseLost()
        this.finalizeDemote()
        throw new Error("Partition lease was reclaimed by another device.")
      }
      // Re-asserted: refresh() rewrote the claim and bumped the lease.
      this.syncStamperLeaseDeadline()
      this.lastLeaseValidatedAt = Date.now()
      this.deps.writeLeaseCache?.(this.partitionLease.serialize())
      return
    }

    // Optimistic resume: the lock read showed no live foreign holder and no
    // release sentinel, so extend the local lease and keep writing — even when
    // our OWN lock claim has lapsed on Swarm (idle past TTL, or renewals failing)
    // but no peer has taken the slot on this gateway. This is the held-lease fast
    // path (an idle-past-TTL upload re-validates its still-readable lock instead
    // of paying a fresh acquire). A same-gateway takeover IS caught above by
    // `isDisplaced`; the only unhandled case is a peer on a disjoint gateway whose
    // lock write we can't see — the documented §12 optimistic-lease residual,
    // bounded by skew and backstopped by the presence/occupancy beacons on
    // `refresh()`. (The refresh tick takes a more conservative stance and
    // self-demotes an un-renewable lease; this on-demand path favors upload
    // latency, relying on the per-upload `isDisplaced` re-read as its net.)
    this.partitionLease.bumpLocalLease(LEASE_TTL_MS)
    this.syncStamperLeaseDeadline()
    this.lastLeaseValidatedAt = Date.now()
    this.deps.writeLeaseCache?.(this.partitionLease.serialize())
  }

  /**
   * Phase 1 of demotion (the race fix): mark the bound lease stale so an
   * in-flight `stamp()` throws `PartitionLeaseLostError` and aborts before
   * writing to a slot a peer now owns. The partition stays bound (so the
   * breaker can fire); the unbind happens in `finalizeDemote` under the lock.
   */
  private signalLeaseLost(): void {
    this.lostLease = this.partitionLease
    this.forEachBoundStamper((s) => s.invalidateLease())
  }

  /**
   * Phase 2 of demotion: drop the claim on the current partition. MUST run
   * under the write lock when called outside a held lock (see `refreshTick`),
   * so no `stamp()` runs between `invalidateLease` and `unbindPartition`.
   */
  private finalizeDemote(): void {
    this.leaseEpoch++
    this.lostLease = undefined
    this.forEachBoundStamper((s) => s.unbindPartition())
    this.joinedSecondaries.clear()
    if (this.partitionRefreshTimer !== undefined) {
      clearInterval(this.partitionRefreshTimer)
      this.partitionRefreshTimer = undefined
    }
    this.partitionLease = undefined
    this.readOnly = true
    this.lastLeaseValidatedAt = 0
    this.pointerHeartbeatFailingSince = undefined
    this.deps.writeLeaseCache?.(undefined)
    // Re-arm so the next write re-acquires.
    this.pendingAcquire = true
    this.emitLeaseChange()
  }

  /**
   * Periodic refresh: re-run the lock protocol on the held partition every
   * `LEASE_REFRESH_MS`. Runs on a bare interval (NOT under the write lock) so
   * it can detect displacement mid-upload — see the race-fix note in the class
   * doc. Persistent mode only.
   */
  private startRefreshTimer(lease: PartitionLease): void {
    // A disposed coordinator must never arm an interval — closes the window
    // where a `withWrite` acquire that began before teardown finishes after it.
    if (this.disposed) return
    if (this.deps.mode !== "persistent") return
    if (this.partitionRefreshTimer !== undefined) {
      clearInterval(this.partitionRefreshTimer)
    }
    this.partitionRefreshTimer = setInterval(() => {
      void this.refreshTick(lease)
    }, LEASE_REFRESH_MS)
  }

  private async refreshTick(lease: PartitionLease): Promise<void> {
    // Stale-continuation guard: clearing the interval (teardown / demote /
    // pause) cannot stop a tick already in flight, and a slow tick can overlap
    // the next one. A tick for a lease the coordinator no longer tracks must
    // not touch Swarm, the stamper, or the cache. Re-checked after every await
    // below; a teardown landing mid-`lease.refresh()` can still produce one
    // ghost lock-SOC re-claim, which self-heals via LEASE_TTL_MS.
    if (this.disposed || this.partitionLease !== lease) return
    const partition = lease.currentPartition
    if (partition === undefined) return

    // Idle yield: if no upload touched this lease for IDLE_YIELD_MS and none is
    // in flight, voluntarily release so a waiting peer takes the slot without
    // waiting out the TTL. We re-acquire on the next upload.
    //
    // Gated on a KNOWN RIVAL: the yield only ever benefits a waiting peer, and
    // for a solo device it converts every >30s pause into a full cold acquire
    // on the next upload. With no rival in the registry the holder keeps its
    // lease (renewed below) and later uploads hit the TTL-optimism fast path.
    // A brand-new peer regains the yield as soon as the roster syncs it into
    // `knownDeviceIds` (every acquire triggers `refreshKnownDeviceIds`); until
    // then it can still take the OTHER partition, or this one via the TTL if
    // this tab closes.
    //
    // The yield itself MUST run under the write lock: this tick is off-lock, so
    // an upload can enter `withWrite` between the idle check here and the
    // unbind inside `yieldIdleLease` — releasing the partition to peers and
    // unbinding the stamper (which resets the `leaseStale` breaker) underneath
    // an in-flight `stamp()` is the same slot-corruption race as a displacement.
    // Holding the lock excludes in-flight uploads; the re-checks inside cover
    // an upload that completed (or a demote/teardown that ran) while this tick
    // waited for the lock.
    const rivalKnown = (this.deps.knownDeviceIds?.() ?? []).some(
      (id) => id !== this.deps.deviceId,
    )
    if (
      rivalKnown &&
      this.activeUploadCount === 0 &&
      Date.now() - this.lastLeaseActivityAt >= IDLE_YIELD_MS
    ) {
      await this.lock(async () => {
        if (this.disposed) return
        if (this.partitionLease !== lease) return
        if (
          this.activeUploadCount !== 0 ||
          Date.now() - this.lastLeaseActivityAt < IDLE_YIELD_MS
        ) {
          return
        }
        await this.yieldIdleLease(lease)
      })
      return
    }

    let confirmedDisplaced = false
    // Did this tick confirm we STILL hold the slot? Either write-verified
    // (`refresh()` returns "held") or read-verified (a "lost" whose lock-SOC
    // read shows us as the live holder). A transient throw or an unconfirmable
    // "lost" (lock read undefined / expired) leaves this false — we must NOT
    // extend the local lease on a hold we couldn't confirm, else a holder whose
    // writes keep failing extends itself forever and keeps writing (the
    // reverse-clobber the post-op ack guard can't cover for a long upload).
    let confirmedHeld = false
    try {
      const outcome = await lease.refresh()
      if (outcome === "held") confirmedHeld = true
      if (outcome === "displaced") {
        // The lease read a foreign presence beacon (earlier generation) at a
        // fresh per-epoch address and confirmed a peer holds this partition.
        // That beacon channel is exactly what the static lock SOC cannot show
        // on a disjoint gateway, so trust the verdict directly. Re-reading the
        // lock SOC here would be the no-op the backstop exists to avoid:
        // refresh() just rewrote our own claim to that address, so the read
        // would return SELF and never confirm the displacement.
        confirmedDisplaced = true
      } else if (outcome === "lost") {
        // Couldn't confirm via write+verify — check for ACTUAL displacement
        // with one read. A 500 here returns undefined → not displaced.
        const payload = await readPartitionLock({
          bee: this.deps.bee,
          backupSigner: this.deps.backupSigner,
          swarmEncryptionKey: this.deps.swarmEncryptionKey,
          partition,
        })
        confirmedDisplaced = isDisplaced(
          payload,
          Date.now(),
          this.deps.deviceId,
        )
        // Not displaced AND the lock SOC still names US as the live holder →
        // read-verified hold (the lock protocol's authority), so it's safe to
        // extend the lease even though the write+verify didn't land this tick.
        if (
          !confirmedDisplaced &&
          payload !== undefined &&
          payload.holderDeviceId === this.deps.deviceId &&
          payload.leasedUntil > Date.now()
        ) {
          confirmedHeld = true
        }
      }
    } catch (err) {
      console.warn(
        "[BatchWriteCoordinator] Lease refresh hit a transient error; keeping lease:",
        err,
      )
    }

    if (confirmedDisplaced) {
      // The lease may have been demoted and a NEW one re-acquired while the
      // refresh/read above was in flight; invalidating the stamper here would
      // arm the breaker on the new binding and demoting would clobber it.
      if (this.disposed || this.partitionLease !== lease) return
      console.warn(
        `[BatchWriteCoordinator] Refresh: partition ${partition} taken by a peer; demoting.`,
      )
      // Race fix: abort any in-flight upload immediately, THEN unbind under the
      // write lock (this tick is not under the lock).
      this.signalLeaseLost()
      await this.lock(async () => {
        // Re-check after winning the lock: a queued withWrite may have demoted
        // this lease and re-acquired a new live one while we waited. Same
        // guards as the idle-yield branch — this is the correctness-critical
        // check; the off-lock one above only narrows the breaker window.
        if (this.disposed || this.partitionLease !== lease) return
        this.finalizeDemote()
      })
      return
    }

    // Guard the tail too: after teardown/demote cleared the cache, a stale
    // tick must not re-write a live-looking snapshot that a future acquire
    // would hydrate + adoptIfLive without any Swarm round-trip.
    if (this.disposed || this.partitionLease !== lease) return

    if (!confirmedHeld) {
      // Couldn't confirm we still hold (transient failure, not a confirmed
      // peer). Tolerate a short blip — but once the local lease lapses past skew
      // we can no longer assert we hold the slot (rule 2: never write without a
      // valid lease). Stop writing and demote; the next upload re-acquires and
      // re-reads the lock. Until then, keep the lease as-is WITHOUT bumping, so
      // `leasedUntil` tracks the last successful renewal and genuinely counts
      // down. The UI stays Active through the blip (lease not yet lapsed).
      if (this.leaseNearExpiry()) {
        console.warn(
          `[BatchWriteCoordinator] Refresh: partition ${partition} lease lapsed without a successful renewal; demoting.`,
        )
        this.signalLeaseLost()
        await this.lock(async () => {
          if (this.disposed || this.partitionLease !== lease) return
          this.finalizeDemote()
        })
      }
      return
    }

    // Renewed on Swarm → bump the local heartbeat and persist it.
    lease.bumpLocalLease(LEASE_TTL_MS)
    this.syncStamperLeaseDeadline()
    this.lastLeaseValidatedAt = Date.now()
    this.deps.writeLeaseCache?.(lease.serialize())
    // Heartbeat the state pointer to the current rotating bucket (best-effort,
    // off the critical path) so an idle-but-alive holder keeps a fresh resume
    // pointer the next reader can find without a feed walk. `withWrite`'s publish
    // also calls `writeStatePointer`, and both route through the stamper's single
    // `intentSoc` slot — overlapping them clobbers that reservation and mis-stamps
    // a pointer SOC into a data slot. So serialize the heartbeat with the publish:
    // run it UNDER the write lock (the publish holds the same lock). The outer
    // `activeUploadCount === 0` gate is a cheap skip when an upload is already in
    // flight; the under-lock re-check closes the TOCTOU where an upload starts
    // AFTER the gate but before the heartbeat wins the lock (the concurrent
    // publish then already refreshes the pointer, so the heartbeat is redundant).
    if (this.activeUploadCount === 0) {
      try {
        await this.lock(async () => {
          if (this.disposed || this.partitionLease !== lease) return
          if (this.activeUploadCount !== 0) return // an upload slipped in while queued
          // Pass the live counter so the heartbeat can RELOCATE a retained state
          // chunk that this epoch's rotating pointer/beacon bucket would otherwise
          // evict (idle-holder-crosses-an-epoch). Undefined in legacy single-
          // partition mode → the heartbeat stays a bare pointer write. Every
          // joined batch's pointer is kept fresh, not just the lease batch's —
          // a takeover must find each batch's resume point. Concurrent across
          // batches: each batch's pointer rides its OWN stamper's reserved
          // intent slot and its own state feed, so only same-batch overlap is
          // dangerous — and that stays serialized by this lock.
          //
          // Best-effort PER BATCH (allSettled, like the teardown/idle-yield
          // flush loops): one sick batch (e.g. expired on-chain) must not take
          // the whole account's write path down. Only the LEASE batch's
          // heartbeat feeds the demote streak below; a persistently failing
          // SECONDARY is evicted from the joined set instead — its in-flight
          // stamps fence like a lease loss, and the next targeted write
          // re-joins with a fresh read (failing loudly if the batch is dead).
          const secondaries = [...this.joinedSecondaries.entries()]
          const [leaseResult, ...secondaryResults] = await Promise.allSettled([
            lease.heartbeatStatePointer(
              this.deps.leaseStamper.getLocalCounter(),
            ),
            ...secondaries.map(([, s]) =>
              lease.heartbeatStatePointer(s.getLocalCounter(), s),
            ),
          ])
          const now = Date.now()
          // Lazy prune: drop streaks for batches no longer joined.
          for (const key of this.secondaryHeartbeatFailingSince.keys()) {
            if (!this.joinedSecondaries.has(key)) {
              this.secondaryHeartbeatFailingSince.delete(key)
            }
          }
          secondaries.forEach(([key, s], i) => {
            if (secondaryResults[i].status === "fulfilled") {
              this.secondaryHeartbeatFailingSince.delete(key)
              return
            }
            const since = this.secondaryHeartbeatFailingSince.get(key)
            if (since === undefined) {
              this.secondaryHeartbeatFailingSince.set(key, now)
              return
            }
            if (now - since > STATE_POINTER_EPOCH_MS) {
              console.warn(
                `[BatchWriteCoordinator] Joined batch ${key}: state-pointer heartbeat failing persistently; evicting it from the lease session (the account lease is unaffected).`,
              )
              s.invalidateLease()
              s.unbindPartition()
              this.joinedSecondaries.delete(key)
              this.secondaryHeartbeatFailingSince.delete(key)
            }
          })
          if (leaseResult.status === "rejected") throw leaseResult.reason
        })
        this.pointerHeartbeatFailingSince = undefined
      } catch (err) {
        console.warn(
          "[BatchWriteCoordinator] State-pointer heartbeat failed:",
          err,
        )
        // One failed heartbeat is a blip (the takeover lookup tolerates a few
        // dropped buckets of slack). A PERSISTENT streak is not: the lock
        // renewal above keeps extending `leasedUntil` independently, so the
        // last durable pointer drifts toward the lookup span's floor — past it,
        // a takeover finds no pointer on a CLEAN scan and zero-seeds,
        // re-issuing every acked slot. Demote before the drift can reach the
        // floor (one pointer epoch of failures, well inside the
        // TTL + slack·epoch tolerance): the next upload re-acquires and its
        // publish re-pins the pointer.
        this.pointerHeartbeatFailingSince ??= Date.now()
        if (
          Date.now() - this.pointerHeartbeatFailingSince >
          STATE_POINTER_EPOCH_MS
        ) {
          console.warn(
            `[BatchWriteCoordinator] Refresh: partition ${partition} state-pointer heartbeat failing persistently; demoting before the resume pointer ages out of the takeover lookup.`,
          )
          this.signalLeaseLost()
          await this.lock(async () => {
            if (this.disposed || this.partitionLease !== lease) return
            this.finalizeDemote()
          })
        }
      }
    }
  }

  /**
   * Voluntarily give up the held partition after it has gone idle. Keeps the
   * coordinator able to re-acquire on the next write (re-arm via `ensureLease`).
   * MUST run under the write lock (see the idle-yield note in `refreshTick`).
   */
  private async yieldIdleLease(lease: PartitionLease): Promise<void> {
    this.leaseEpoch++
    const yieldedPartition = lease.currentPartition
    if (this.partitionRefreshTimer !== undefined) {
      clearInterval(this.partitionRefreshTimer)
      this.partitionRefreshTimer = undefined
    }
    const localCounter = this.deps.leaseStamper.getLocalCounter()
    if (localCounter !== undefined) {
      // Joined batches' final counters flush first — a peer's takeover must
      // resume each batch at its acked counter. Best-effort PER BATCH (like
      // teardown): one failed flush must not abort the remaining flushes or
      // the release below — an unreleased slot costs every peer the full
      // LEASE_TTL_MS wait.
      for (const s of this.joinedSecondaries.values()) {
        const counter = s.getLocalCounter()
        if (counter === undefined) continue
        try {
          await lease.publishState(counter, s)
        } catch (err) {
          console.warn(
            "[BatchWriteCoordinator] Idle-yield state publish failed for a joined batch:",
            err,
          )
        }
      }
      try {
        // Best-effort: on a Swarm-write failure the slot still lapses via the
        // TTL within LEASE_TTL_MS, so peers recover either way.
        await lease.release(localCounter)
      } catch (err) {
        console.warn(
          "[BatchWriteCoordinator] Idle partition-lease release failed:",
          err,
        )
      }
    }
    this.forEachBoundStamper((s) => s.unbindPartition())
    this.joinedSecondaries.clear()
    this.partitionLease = undefined
    this.readOnly = false
    this.lastLeaseValidatedAt = 0
    this.deps.writeLeaseCache?.(undefined)
    this.emitLeaseChange()
    console.info(
      `[BatchWriteCoordinator] Released idle partition ${yieldedPartition ?? "?"}; will re-acquire on next write.`,
    )
  }

  /**
   * Stop lease background work and drop the in-memory lease + cache. Used when
   * the acquire path times out. A still-valid cached lease is re-adopted before
   * that path runs, so reaching here means there is no live lease to preserve.
   */
  private pauseLeaseBackgroundWork(): void {
    this.leaseEpoch++
    if (this.partitionRefreshTimer !== undefined) {
      clearInterval(this.partitionRefreshTimer)
      this.partitionRefreshTimer = undefined
    }
    this.partitionLease = undefined
    this.readOnly = false
    this.joinedSecondaries.clear()
    this.deps.writeLeaseCache?.(undefined)
  }

  // ---- helpers ------------------------------------------------------------

  private async buildStamperTarget(
    stamper: UtilizationAwareStamper,
    opts?: WithWriteOptions,
  ): Promise<UploadTarget> {
    const workerPool = opts?.useWorkers
      ? await this.deps.getWorkerPool?.(stamper, opts.workerCount)
      : undefined
    return {
      mode: "stamper",
      bee: this.deps.bee,
      stamper,
      workerPool,
    }
  }

  /**
   * Take the cross-tab Web Lock, run `op`, then flush stamper state — the
   * write's stamper AND the lease stamper (lease SOC writes dirty the
   * latter's buckets even when the data write targeted another batch),
   * deduped when they are the same.
   */
  private async lockAndFlush<T>(
    op: () => Promise<T>,
    writeStamper?: UtilizationAwareStamper,
  ): Promise<T> {
    return withAccountWriteLock(
      this.deps.accountId,
      async () => {
        try {
          return await op()
        } finally {
          await this.deps.flushStamperState?.(this.deps.leaseStamper)
          if (writeStamper && writeStamper !== this.deps.leaseStamper) {
            await this.deps.flushStamperState?.(writeStamper)
          }
        }
      },
      this.batchStateLockIds(writeStamper),
    )
  }

  /** Take the cross-tab Web Lock without the stamper flush (lease mutations). */
  private lock<T>(op: () => Promise<T>): Promise<T> {
    return withAccountWriteLock(
      this.deps.accountId,
      op,
      this.batchStateLockIds(),
    )
  }

  /**
   * Per-batch state-lock keys for this locked section: every batch it may
   * stamp under — the lease batch, every joined secondary, and the write's
   * target batch. Nested inside the account lock and held across the write AND
   * its flush; a PERMANENT invariant (see `withAccountWriteLock`), since
   * `withBatchStateLock`-guarded stamper builds rely on it to order their
   * IndexedDB seed reads after a same-batch flush. Captured at lock-request
   * time; `withWrite`'s not-yet-joined target rides in via `writeStamper`.
   */
  private batchStateLockIds(writeStamper?: UtilizationAwareStamper): string[] {
    const ids = [this.deps.leaseStamper.batchId.toHex()]
    for (const key of this.joinedSecondaries.keys()) ids.push(key)
    if (writeStamper) ids.push(writeStamper.batchId.toHex())
    return ids
  }

  /** Post-acquisition guard: a multi-device account must hold a partition. */
  private ensureHeldForUpload(): void {
    if (this.deps.partitionCount <= 1) return
    if (this.currentPartition === undefined) {
      throw new Error(
        "Uploads are unavailable: the postage batch is fully leased by other devices. " +
          "Sign out of another device or wait for its lease to expire.",
      )
    }
  }

  private emitLeaseChange(): void {
    this.deps.onLeaseChange?.({
      currentPartition: this.currentPartition,
      isReadOnly: this.readOnly,
    })
  }
}
