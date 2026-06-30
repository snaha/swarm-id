// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `BatchWriteCoordinator` — the write path for one account+batch.
 *
 * Owns everything needed to **write to a shared postage batch as a partition
 * holder**, and nothing about client communication:
 *   - the cross-tab Web Lock (`withBatchWriteLock`),
 *   - the partition-lease lifecycle (acquire / refresh / yield / demote),
 *   - stamper-state flush under the lock.
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

import { Bee, BatchId, PrivateKey } from "@ethersphere/bee-js"
import {
  LEASE_TTL_MS,
  LEASE_REFRESH_MS,
  IDLE_YIELD_MS,
  UtilizationAwareStamper,
} from "../utils/batch-utilization"
import { withBatchWriteLock } from "../utils/batch-write-lock"
import { PartitionLease } from "./partition-lease"
import type {
  LeaseRefreshOutcome,
  PartitionLeaseStateSnapshot,
} from "./partition-lease"
import { readPartitionLock, NO_HOLDER_DEVICE_ID } from "./partition-lock"
import type { UploadTarget } from "../proxy/upload"
import type { StampWorkerPool } from "../proxy/stamp-worker-pool"

/** Hard cap on the acquire path (including any wait-for-slot retry). */
const PARTITION_LEASE_ACQUIRE_TIMEOUT_MS = 45000
/** Max time the acquire spends polling for a slot when all are held. */
const SLOT_WAIT_TIMEOUT_MS = 30000
/**
 * Local-clock margin for treating a lease as "could have lapsed". When
 * `now >= leasedUntil - LEASE_SKEW_MARGIN_MS` the freshness check stops
 * trusting the throttle and re-reads the lock SOC before a write/ack — the
 * reverse-clobber guard (a slept/throttled holder must not overwrite a new
 * holder's acked data). Bounded by NTP-level skew, like the lock protocol.
 */
const LEASE_SKEW_MARGIN_MS = 2000

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
  /** Postage batch id (hex) — the `withBatchWriteLock` key. */
  batchId: string
  /** Already created + account-bound by the caller; the coordinator only
   *  binds/unbinds the held partition on it. */
  stamper: UtilizationAwareStamper
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
  /** Flush stamper bucket state after a write (proxy: `saveStamperState`). */
  flushStamperState?: () => Promise<void>
  /** Build/reuse a parallel-signing worker pool (proxy: `getOrCreateWorkerPool`). */
  getWorkerPool?: (count?: number) => Promise<StampWorkerPool | undefined>
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

  /** The bound stamper — exposed for the proxy's `buildConnectionInfo`
   *  (appKey / uploadMode). */
  get stamperRef(): UtilizationAwareStamper {
    return this.deps.stamper
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
   * partition (acquire / slot-wait, or skip-with-throw), runs `op` against a
   * stamper upload target, and flushes stamper state. Subsidised mode is NOT a
   * coordinator concern — the proxy only calls this in stamper mode.
   */
  async withWrite<T>(
    op: (target: UploadTarget) => Promise<T>,
    opts?: WithWriteOptions,
  ): Promise<T> {
    const wait =
      opts?.wait ?? (this.deps.mode === "persistent" ? "block" : "skip")
    return this.lockAndFlush(async () => {
      await this.ensureLease(wait)
      this.ensureHeldForUpload()
      const target = await this.buildStamperTarget(opts)
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
        // ack is. Bounded by skew + TTL (see Partition-Acquire-Optimistic-Lease.md).
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
        const localCounter = this.deps.stamper.getLocalCounter()
        if (localCounter !== undefined) {
          await this.partitionLease?.publishState(localCounter)
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
    })
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
    const stamper = this.deps.stamper
    if (lease) {
      const localCounter = stamper.getLocalCounter()
      if (localCounter !== undefined) {
        // Serialize the detached release under the batch write lock (#349):
        // a successor coordinator's acquire (`startLease`/`withWrite` →
        // `lockAndFlush`) queues on the same origin-wide Web Lock, so the
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
        void this.lock(() => lease.release(localCounter)).catch((err) =>
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
      // `PartitionLeaseLostError` instead.
      stamper.invalidateLease()
      stamper.unbindPartition()
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
        const timeout = new Promise<void>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `Partition lease timed out after ${PARTITION_LEASE_ACQUIRE_TIMEOUT_MS}ms`,
                ),
              ),
            PARTITION_LEASE_ACQUIRE_TIMEOUT_MS,
          ),
        )
        try {
          await Promise.race([this.acquireWithSlotWait(), timeout])
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
    const { stamper, partitionCount, swarmEncryptionKey } = this.deps
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
        batchId: new BatchId(this.deps.batchId),
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
        // Diagnostic: this re-binds a CACHED lease with no Swarm scan and no
        // intent round. If two devices both adopt partition 0 from stale
        // caches, that's a dual-hold the intent round never gets to arbitrate.
        console.log(
          `[BatchWriteCoordinator] Adopted cached lease p=${adopted} (no acquire/intent round) for device=${this.deps.deviceId}`,
        )
        this.partitionLease = lease
        this.readOnly = false
        stamper.bindPartition({
          partition: adopted,
          partitionCount,
          localCounter: stamper.buildLeaseLocalCounter(),
        })
        this.deps.writeLeaseCache?.(lease.serialize())
        this.startRefreshTimer(lease)
        this.lastLeaseValidatedAt = Date.now()
        this.lastLeaseActivityAt = Date.now()
        this.deps.onLeaseAcquired?.(adopted)
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
      this.deps.writeLeaseCache?.(lease.serialize())
      this.startRefreshTimer(lease)
      this.lastLeaseValidatedAt = Date.now()
      this.lastLeaseActivityAt = Date.now()
      this.deps.onLeaseAcquired?.(result.partition)
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
    // Epoch capture: when the Promise.race timeout in `ensureLease` fires,
    // this loop keeps running detached (race can't cancel it) and would
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
      this.lastLeaseValidatedAt = Date.now()
      this.deps.writeLeaseCache?.(this.partitionLease.serialize())
      return
    }

    this.partitionLease.bumpLocalLease(LEASE_TTL_MS)
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
    this.deps.stamper.invalidateLease()
  }

  /**
   * Phase 2 of demotion: drop the claim on the current partition. MUST run
   * under the write lock when called outside a held lock (see `refreshTick`),
   * so no `stamp()` runs between `invalidateLease` and `unbindPartition`.
   */
  private finalizeDemote(): void {
    this.leaseEpoch++
    this.deps.stamper.unbindPartition()
    if (this.partitionRefreshTimer !== undefined) {
      clearInterval(this.partitionRefreshTimer)
      this.partitionRefreshTimer = undefined
    }
    this.partitionLease = undefined
    this.readOnly = true
    this.lastLeaseValidatedAt = 0
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
    // The yield itself MUST run under the write lock: this tick is off-lock, so
    // an upload can enter `withWrite` between the idle check here and the
    // unbind inside `yieldIdleLease` — releasing the partition to peers and
    // unbinding the stamper (which resets the `leaseStale` breaker) underneath
    // an in-flight `stamp()` is the same slot-corruption race as a displacement.
    // Holding the lock excludes in-flight uploads; the re-checks inside cover
    // an upload that completed (or a demote/teardown that ran) while this tick
    // waited for the lock.
    if (
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
    try {
      const outcome = await lease.refresh()
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

    // Alive + not displaced → bump the local heartbeat and persist it so the
    // UI stays Active even when the Swarm write is transiently failing.
    // Guard the tail too: after teardown/demote cleared the cache, a stale
    // tick must not re-write a live-looking snapshot that a future acquire
    // would hydrate + adoptIfLive without any Swarm round-trip.
    if (this.disposed || this.partitionLease !== lease) return
    lease.bumpLocalLease(LEASE_TTL_MS)
    this.lastLeaseValidatedAt = Date.now()
    this.deps.writeLeaseCache?.(lease.serialize())
    // Heartbeat the state pointer to the current rotating bucket (best-effort,
    // off the critical path) so an idle-but-alive holder keeps a fresh resume
    // pointer the next reader can find without a feed walk. SKIP while an upload
    // is in flight: this tick runs off the write lock, but `withWrite`'s publish
    // (which holds it) also calls `writeStatePointer`, and both route through the
    // stamper's single `intentSoc` slot — overlapping them clobbers that
    // reservation and mis-stamps a pointer SOC into a data slot. The concurrent
    // publish already refreshes the pointer, so the heartbeat is redundant here.
    if (this.activeUploadCount === 0) {
      void lease
        .heartbeatStatePointer()
        .catch((err) =>
          console.warn(
            "[BatchWriteCoordinator] State-pointer heartbeat failed:",
            err,
          ),
        )
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
    const localCounter = this.deps.stamper.getLocalCounter()
    if (localCounter !== undefined) {
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
    this.deps.stamper.unbindPartition()
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
    this.deps.writeLeaseCache?.(undefined)
  }

  // ---- helpers ------------------------------------------------------------

  private async buildStamperTarget(
    opts?: WithWriteOptions,
  ): Promise<UploadTarget> {
    const workerPool = opts?.useWorkers
      ? await this.deps.getWorkerPool?.(opts.workerCount)
      : undefined
    return {
      mode: "stamper",
      bee: this.deps.bee,
      stamper: this.deps.stamper,
      workerPool,
    }
  }

  /** Take the cross-tab Web Lock, run `op`, then flush stamper state. */
  private async lockAndFlush<T>(op: () => Promise<T>): Promise<T> {
    return withBatchWriteLock(this.deps.batchId, async () => {
      try {
        return await op()
      } finally {
        await this.deps.flushStamperState?.()
      }
    })
  }

  /** Take the cross-tab Web Lock without the stamper flush (lease mutations). */
  private lock<T>(op: () => Promise<T>): Promise<T> {
    return withBatchWriteLock(this.deps.batchId, op)
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
