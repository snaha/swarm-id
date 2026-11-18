// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `BatchWriteCoordinator` — the write path for one account+batch.
 *
 * Owns everything needed to **write to a shared postage batch as the holder of
 * one of its lanes**, and nothing about client communication:
 *   - taking a lane over the account bus (`bus-lease.ts`),
 *   - resuming and publishing the lane's counter (`lane-state.ts`),
 *   - the cross-tab Web Lock (`withBatchWriteLock`) and the stamper-state
 *     flush under it.
 *
 * Two consumers share it:
 *   - the proxy iframe — long-lived (`mode: "persistent"`): eager
 *     `startLease()`; an upload that cannot get a lane waits for one and then
 *     throws.
 *   - `sync-account` — one-off (`mode: "oneshot"`): a write waits only as long
 *     as a context alone in the room needs, and throws
 *     `PartitionContendedError` so the caller skips.
 *
 * A lane is held by a context, not by a device: every tab and iframe claims
 * for itself, and a context without a confirmed connection to the bus cannot
 * write. Nothing is stored on Swarm to say who holds a lane. See
 * `docs/BatchWriteCoordinator.md`.
 *
 * ## Losing the lane during an upload
 *
 * The lane can go while an upload is mid-`stamp()`: the connection went
 * unconfirmed for too long. The stamper carries a deadline, moved forward by
 * every confirmation, past which `stamp()` throws `PartitionLeaseLostError`,
 * so the upload stops by itself; and the hold is checked again before the
 * upload is acknowledged. A handover never lands mid-upload: a holder with a
 * write in flight does not answer a claim.
 */

import { Bee, BatchId, PrivateKey } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import {
  PartitionLeaseLostError,
  UtilizationAwareStamper,
} from "../utils/batch-utilization"
import { abortedError } from "../errors"
import { withBatchWriteLock } from "../utils/batch-write-lock"
import { withTimeout } from "../utils/promise"
import {
  LEASE_STOP_MS,
  LEASE_WAIT_MS,
  type BusLane,
  type BusLanes,
} from "./bus-lease"
import { LaneState } from "./lane-state"
import type { UploadTarget } from "../proxy/upload"
import type { StampWorkerPool } from "../proxy/stamp-worker-pool"

/** Hard cap on getting a lane, the read of its published counter included. */
const LANE_ACQUIRE_TIMEOUT_MS = 45000
/** How long a blocking write waits for a lane to be handed over. */
export const SLOT_WAIT_TIMEOUT_MS = 30000
/**
 * How long a one-off write waits. A context that has just joined must see
 * everyone else absent for `LEASE_WAIT_MS` before it may take a lane nobody
 * answers for, so anything shorter would never succeed on a fresh page.
 */
const ONESHOT_WAIT_TIMEOUT_MS = LEASE_WAIT_MS + 2000
/**
 * Every lane is asked for gently first: one nobody holds is taken, and a
 * holder is left alone. Only when every lane has answered "held" is the
 * holder of the device's home lane asked to hand over, and after each such
 * step the holder of the next lane as well.
 */
export const NEXT_LANE_AFTER_MS = 1500
/** How often a pending claim is looked at when nothing else wakes it. */
const CLAIM_POLL_MS = 250
/** A write that finds its lane gone under the lock asks again this often. */
const MAX_WRITE_ATTEMPTS = 3

/**
 * Minimum idle time before a holder hands its lane to a context that asks.
 * Non-zero so a holder between two uploads of a burst does not give the lane
 * away and ask for it back.
 */
export const PEER_YIELD_MIN_IDLE_MS = 3000

/**
 * Thrown by `withWrite` when no lane could be taken: every lane is held by a
 * context that is writing, or this context has no confirmed connection to the
 * account bus. `sync-account` catches it and skips the publish — distinct
 * from an operational error (missing stamper, a failed read), which
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

/** Long-lived (proxy) vs one-off (`sync-account`) behaviour. */
export type CoordinatorMode = "persistent" | "oneshot"

/** Per-transition snapshot handed to `onLeaseChange`. */
export interface LeaseChangeInfo {
  currentPartition: number | undefined
  isReadOnly: boolean
}

export interface WithWriteOptions {
  useWorkers?: boolean
  workerCount?: number
  /** Override the mode default: persistent → "block", oneshot → "skip". */
  wait?: "block" | "skip"
  /** A write aborted while it waited stops there. */
  signal?: AbortSignal
}

export interface BatchWriteCoordinatorDeps {
  bee: Bee
  /** Postage batch id (hex) — the `withBatchWriteLock` key. */
  batchId: string
  /** Already created + account-bound by the caller; the coordinator only
   *  binds/unbinds the held partition on it. */
  stamper: UtilizationAwareStamper
  /** This device's identity: which lane is asked for first. */
  deviceId: string
  accountId: string
  /**
   * This context's lanes on the account bus. Without them a batch that is
   * split into partitions cannot be written: there is nobody to ask.
   */
  lanes?: BusLanes
  /** Owns the lane's published state (derived from the account key). */
  backupSigner: PrivateKey
  swarmEncryptionKey: Uint8Array
  partitionCount: number
  mode: CoordinatorMode
  /** Flush stamper bucket state after a write (proxy: `saveStamperState`). */
  flushStamperState?: () => Promise<void>
  /** Build/reuse a parallel-signing worker pool (proxy: `getOrCreateWorkerPool`). */
  getWorkerPool?: (count?: number) => Promise<StampWorkerPool | undefined>
  /** Fired on every partition / read-only transition. */
  onLeaseChange?: (info: LeaseChangeInfo) => void
  /** Fired when a lane is taken and its counter bound. */
  onLeaseAcquired?: (partition: number) => void
}

/**
 * The lane a device asks for first: a fixed function of its id, so devices
 * spread over the lanes and one device keeps coming back to the same one.
 */
export function deviceHomePartition(
  deviceId: string,
  partitionCount: number,
): number {
  const hash = Binary.keccak256(new TextEncoder().encode(deviceId))
  const n = ((hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3]) >>> 0
  return n % partitionCount
}

/** A write found its lane gone once it had the lock: ask again. */
const LANE_GONE = Symbol("lane-gone")

export class BatchWriteCoordinator {
  private readonly deps: BatchWriteCoordinatorDeps

  /** This batch's lanes this context takes part in, opened on first use. */
  private lanes = new Map<number, BusLane>()
  private states = new Map<number, LaneState>()
  /** The lane whose counter is bound on the stamper. */
  private held: number | undefined
  /** Counts holds: every bind and every loss of the bound lane. An upload
   *  is acknowledged only under the hold it began with. */
  private hold = 0
  /** A lane just taken whose published counter is still being read. */
  private resuming: number | undefined
  private readOnly: boolean = false
  /** Wall-clock ms of the last upload activity. */
  private lastActivityAt: number = 0
  /** Uploads currently executing; a holder with one does not hand over. */
  private activeUploadCount: number = 0
  /** The one lane acquisition in progress, shared by everyone waiting. */
  private acquiring: Promise<void> | undefined
  /** Counts acquisitions, so one that outlived its timeout binds nothing. */
  private acquireRun = 0
  /** Cuts the claim loop's sleep short: a lane was taken or lost. */
  private wakeClaim: (() => void) | undefined
  private stopConfirmed: (() => void) | undefined
  /** Set by `teardown()`. A disposed coordinator never takes a lane again: an
   *  in-flight `withWrite` can outlive a disconnect or sign-out. */
  private disposed: boolean = false

  constructor(deps: BatchWriteCoordinatorDeps) {
    this.deps = deps
    this.stopConfirmed = deps.lanes?.onConfirmed(() => this.syncStampDeadline())
  }

  /** Current held partition, or undefined (read-only / legacy / not yet taken). */
  get currentPartition(): number | undefined {
    return this.held
  }

  /** True when the last attempt to take a lane failed. */
  get isReadOnly(): boolean {
    return this.readOnly
  }

  /** The bound stamper — exposed for the proxy's `buildConnectionInfo`
   *  (appKey / uploadMode). */
  get stamperRef(): UtilizationAwareStamper {
    return this.deps.stamper
  }

  /** The account this coordinator (and its batch) was built for — exposed so
   *  the proxy can refuse to publish a snapshot assembled for a different
   *  account through this coordinator's batch. */
  get accountId(): string {
    return this.deps.accountId
  }

  get batchId(): string {
    return this.deps.batchId
  }

  // ---- write entry point --------------------------------------------------

  /**
   * The single write entry point. Makes sure a lane is held, takes the
   * cross-tab Web Lock, runs `op` against a stamper upload target, publishes
   * the counter and flushes stamper state. Subsidised mode is NOT a
   * coordinator concern — the proxy only calls this in stamper mode.
   */
  async withWrite<T>(
    op: (target: UploadTarget) => Promise<T>,
    opts?: WithWriteOptions,
  ): Promise<T> {
    const wait =
      opts?.wait ?? (this.deps.mode === "persistent" ? "block" : "skip")
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      if (opts?.signal?.aborted) throw abortedError(opts.signal)
      // Outside the lock: waiting for a lane can take seconds, and the lock is
      // shared with every other context of this browser.
      await this.ensureLane(wait)
      const outcome = await this.lockAndFlush(async () => {
        if (opts?.signal?.aborted) throw abortedError(opts.signal)
        if (!this.mayWrite()) return LANE_GONE
        // Counted with no await since the check above: from here a claim is
        // not answered, so the lane cannot be handed over under the upload.
        this.activeUploadCount++
        this.lastActivityAt = Date.now()
        const hold = this.hold
        try {
          const target = await this.buildStamperTarget(opts)
          const result = await op(target)
          await this.commit(hold)
          return { result }
        } finally {
          this.activeUploadCount--
          this.lastActivityAt = Date.now()
          // The lane went during the upload: the stamper was left bound so
          // the rest of the upload failed instead of stamping at legacy slots.
          if (this.held === undefined && this.deps.partitionCount > 1) {
            this.deps.stamper.unbindPartition()
          }
        }
      })
      if (outcome !== LANE_GONE) return outcome.result
    }
    throw new PartitionContendedError(
      "The partition was handed to another device before the upload could start.",
      this.deps.accountId,
    )
  }

  /**
   * Commit-ordered ack: an upload is reported durable only after the lane's
   * counter, which reserves its slots, is published under the hold the upload
   * began with (`hold`).
   *  1. That hold must still stand. A lane lost and taken again is another
   *     hold, with a counter that knows nothing of this upload's stamps.
   *  2. Publish the counter. The publish asks once more just before it writes
   *     the pointer entry, the one write the next holder acts on.
   *  3. The hold must still stand when the publish is done: the next holder
   *     may have read the lane before the entry landed.
   * A throw propagates → the upload is reported failed, never acked (chunks
   * are content-addressed → a retry is safe).
   */
  private async commit(hold: number): Promise<void> {
    if (this.deps.partitionCount <= 1) return
    const stillHeld = () => this.hold === hold && this.mayWrite()
    const confirmed = () =>
      withTimeout(
        this.confirmedAgain(),
        LANE_ACQUIRE_TIMEOUT_MS,
        "The connection to the account's other devices was not confirmed",
      )
    if (this.hold !== hold) throw new PartitionLeaseLostError()
    await confirmed()
    const partition = this.held
    if (!stillHeld() || partition === undefined) {
      throw new PartitionLeaseLostError()
    }
    const localCounter = this.deps.stamper.getLocalCounter()
    if (localCounter === undefined) {
      // Acking here would ack an upload whose slot reservation never reached
      // Swarm. Fail loudly instead.
      throw new Error(
        `[BatchWriteCoordinator] Held partition ${partition} but the stamper ` +
          "exposed no local counter — cannot publish the slot reservation " +
          "(ack-after-publish); failing the upload.",
      )
    }
    await this.state(partition).publish(localCounter, stillHeld)
    await confirmed()
    if (!stillHeld()) throw new PartitionLeaseLostError()
  }

  /** Persistent mode: take a lane in the background so the first upload does
   *  not pay for it. */
  startLease(): void {
    if (this.disposed) return
    if (this.deps.mode !== "persistent") return
    if (this.deps.partitionCount <= 1) return
    void this.ensureLane("block").catch((err) =>
      console.warn(
        "[BatchWriteCoordinator] Background lane warm-up failed:",
        err,
      ),
    )
  }

  /**
   * Give up every lane and stop. Used on sign-out / disconnect. Never throws.
   * Nothing is written: the counter was published with the last upload, and a
   * context that asks for the lane from now on is answered "free".
   */
  teardown(): void {
    this.disposed = true
    this.stopConfirmed?.()
    this.stopConfirmed = undefined
    for (const partition of this.lanes.keys()) {
      this.deps.lanes?.close(this.laneKey(partition))
    }
    this.lanes.clear()
    this.dropHeld()
    this.readOnly = false
    this.wakeClaim?.()
    this.emitLeaseChange()
  }

  // ---- lanes --------------------------------------------------------------

  private laneKey(partition: number) {
    return {
      accountId: this.deps.accountId,
      batchId: this.deps.batchId,
      partition,
    }
  }

  private lane(partition: number, lanes: BusLanes): BusLane {
    let lane = this.lanes.get(partition)
    if (!lane) {
      lane = lanes.open(this.laneKey(partition), {
        isBusy: (gentle) =>
          this.resuming === partition ||
          (this.held === partition &&
            (gentle ||
              this.activeUploadCount > 0 ||
              Date.now() - this.lastActivityAt < PEER_YIELD_MIN_IDLE_MS)),
        onAcquired: () => this.wakeClaim?.(),
        onLost: () => {
          if (this.held === partition) {
            // `ui/tests/devices-rig.ts` reads this line as "a lane was lost
            // other than by a disconnect"; reword it there too.
            console.info(
              `[BatchWriteCoordinator] Partition ${partition} is no longer held; will ask again on the next write.`,
            )
            this.dropHeld()
            this.emitLeaseChange()
          }
          this.wakeClaim?.()
        },
      })
      this.lanes.set(partition, lane)
    }
    return lane
  }

  private state(partition: number): LaneState {
    let state = this.states.get(partition)
    if (!state) {
      state = new LaneState({
        bee: this.deps.bee,
        batchId: new BatchId(this.deps.batchId),
        partition,
        backupSigner: this.deps.backupSigner,
        swarmEncryptionKey: this.deps.swarmEncryptionKey,
        stamper: this.deps.stamper,
      })
      this.states.set(partition, state)
    }
    return state
  }

  /** May this context stamp right now? Legacy batches have no lanes. */
  private mayWrite(): boolean {
    if (this.deps.partitionCount <= 1) return !this.disposed
    return (
      !this.disposed &&
      this.held !== undefined &&
      this.lanes.get(this.held)?.holds() === true
    )
  }

  /**
   * Stop stamping on the held lane. The breaker is armed first and outlives
   * the unbind, so an upload in flight fails instead of stamping at legacy
   * slots; with one in flight the unbind is left to its `finally`.
   */
  private dropHeld(): void {
    if (this.held === undefined) return
    this.held = undefined
    this.hold++
    this.deps.stamper.invalidateLease()
    if (this.activeUploadCount === 0) this.deps.stamper.unbindPartition()
  }

  /**
   * Tell the stamper until when it may stamp: `LEASE_STOP_MS` after the last
   * confirmation of this context's connection. Past it the lane is no longer
   * held, whether or not anything has noticed yet.
   */
  private syncStampDeadline(): void {
    const lanes = this.deps.lanes
    if (this.held === undefined || !lanes) return
    this.deps.stamper.setLeaseValidUntil(
      Date.now() - lanes.confirmedAgoMs() + LEASE_STOP_MS,
    )
  }

  /** Make sure a lane is held, taking one if not. */
  private ensureLane(wait: "block" | "skip"): Promise<void> {
    if (this.deps.partitionCount <= 1) return Promise.resolve()
    if (this.disposed) {
      return Promise.reject(
        new Error("BatchWriteCoordinator has been torn down."),
      )
    }
    if (this.mayWrite()) return Promise.resolve()
    this.acquiring ??= withTimeout(
      this.confirmedAgain().then(() =>
        this.mayWrite() ? undefined : this.acquire(wait),
      ),
      LANE_ACQUIRE_TIMEOUT_MS,
      `Taking a partition timed out after ${LANE_ACQUIRE_TIMEOUT_MS}ms`,
    ).finally(() => {
      this.acquiring = undefined
      this.emitLeaseChange()
    })
    return this.acquiring
  }

  /**
   * The held lane's confirmation is overdue (a busy tab answers the server
   * late): wait for the next one. It keeps the lane, or the connection turns
   * out to be a new one and the lane is gone.
   */
  private async confirmedAgain(): Promise<void> {
    const lanes = this.deps.lanes
    while (
      lanes &&
      !this.disposed &&
      this.held !== undefined &&
      this.lanes.get(this.held)?.suspended
    ) {
      await new Promise<void>((resolve) => {
        const stop = lanes.onConfirmed(() => {
          stop()
          resolve()
        })
      })
    }
  }

  /** Take a lane, read its published counter and bind it on the stamper. */
  private async acquire(wait: "block" | "skip"): Promise<void> {
    const { stamper, partitionCount, lanes } = this.deps
    if (!lanes) {
      this.readOnly = true
      throw new PartitionContendedError(
        "This context is not connected to the account's other devices, so it cannot write to a shared batch.",
        this.deps.accountId,
      )
    }
    const run = ++this.acquireRun
    const deadline =
      Date.now() +
      (wait === "block" ? SLOT_WAIT_TIMEOUT_MS : ONESHOT_WAIT_TIMEOUT_MS)
    const home = deviceHomePartition(this.deps.deviceId, partitionCount)
    const order = Array.from(
      { length: partitionCount },
      (_, i) => (home + i) % partitionCount,
    )

    for (;;) {
      const partition = await this.claimAny(order, lanes, deadline)
      if (partition === undefined) {
        if (!this.disposed) this.readOnly = true
        throw new PartitionContendedError(
          "No partition available — all slots are held by other devices.",
          this.deps.accountId,
        )
      }
      const lane = this.lane(partition, lanes)
      let localCounter: Uint32Array | undefined
      this.resuming = partition
      try {
        localCounter = await this.state(partition).resume()
      } catch (error) {
        lane.release()
        throw error
      } finally {
        this.resuming = undefined
      }
      if (localCounter === undefined) {
        // The lane has a published counter that could not be read. Stamping
        // from a guess would re-issue used slots: give the lane back.
        lane.release()
        this.readOnly = true
        throw new Error(
          `Partition ${partition}'s published state could not be read; not writing.`,
        )
      }
      // The lane can go while its counter is read (the connection lapsed).
      if (this.disposed || !lane.holds()) {
        lane.release()
        continue
      }
      // Timed out meanwhile, and a later acquisition is at work on these
      // lanes: the lane is its to bind.
      if (run !== this.acquireRun) return
      stamper.bindPartition({ partition, partitionCount, localCounter })
      this.held = partition
      this.hold++
      this.readOnly = false
      this.syncStampDeadline()
      this.lastActivityAt = Date.now()
      this.deps.onLeaseAcquired?.(partition)
      return
    }
  }

  /**
   * Ask for the lanes in `order` until one is held; the claims of the others
   * are then dropped. Gently for all at first; once every lane is known to
   * be held, insisting on one more every `NEXT_LANE_AFTER_MS`. Undefined when
   * none was held by `deadline`.
   */
  private async claimAny(
    order: number[],
    lanes: BusLanes,
    deadline: number,
  ): Promise<number | undefined> {
    const standDown = (except?: number) => {
      for (const partition of order) {
        if (partition !== except) this.lanes.get(partition)?.release()
      }
    }
    /** Since when every lane is known to be held by someone. */
    let allHeldSince: number | undefined
    for (;;) {
      if (this.disposed) return undefined
      const held = () =>
        order.find((partition) => this.lanes.get(partition)?.holds())
      // A claim cannot start while the connection is unconfirmed; the next
      // round asks again.
      for (const partition of order) {
        const lane = this.lane(partition, lanes)
        if (!lane.holds() && !lane.claiming) lane.claim({ gentle: true })
      }
      // Nobody is asked to move while a lane may still come by itself: one
      // nobody holds, one whose last holder has just gone, or one a context
      // that has just joined has not answered for yet.
      const allHeld = order.every(
        (partition) => this.lanes.get(partition)?.knownHeld,
      )
      if (!allHeld) allHeldSince = undefined
      else {
        allHeldSince ??= Date.now()
        const insisted =
          1 + Math.floor((Date.now() - allHeldSince) / NEXT_LANE_AFTER_MS)
        for (const partition of order.slice(0, insisted)) {
          this.lanes.get(partition)?.insist()
        }
      }
      const partition = held()
      if (partition !== undefined) {
        standDown(partition)
        return partition
      }
      if (Date.now() >= deadline) {
        standDown()
        return undefined
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLAIM_POLL_MS)
        this.wakeClaim = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      this.wakeClaim = undefined
    }
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
      // A stamp that is due while the confirmation is overdue waits for it:
      // the stamper would refuse, and the upload fail, with the lane kept.
      ready: async () => {
        if (this.held !== undefined && this.lanes.get(this.held)?.suspended) {
          await this.confirmedAgain()
        }
      },
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

  private emitLeaseChange(): void {
    this.deps.onLeaseChange?.({
      currentPartition: this.currentPartition,
      isReadOnly: this.readOnly,
    })
  }
}
