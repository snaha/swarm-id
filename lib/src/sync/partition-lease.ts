// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Consolidated partition-lease state.
 *
 * This is the single in-code model of "who holds which partition" for one
 * account+batch. The per-partition lock SOC on Swarm
 * (`partition-lock.ts`) remains the cross-device authority; this class is
 * the one structure every code path consults, replacing the previous trio
 * of scattered representations (the `LeaseState` localStorage blob, the
 * `activeDevices` snapshot mirror, and ad-hoc `holderDeviceId` reads).
 *
 * It holds:
 *   - `self`         — this device's own lease (undefined when not holding)
 *   - `holders`      — observed holder per partition, derived from the lock
 *                      SOCs; this is what models the up-to-`partitionCount`
 *                      simultaneously-active devices
 *   - admin          — deviceId / batchId / partitionCount
 *
 * The proxy owns one instance, persists it as a *cache*
 * (`serialize`/`deserialize`), and re-validates against the lock SOC before
 * trusting `self`. Only the proxy mutates lock SOCs; readers (the SwarmID
 * UI) construct a read-only instance and call `refreshFromSwarm` +
 * `getHolders` to inspect the live holders.
 */

import { Bee, BatchId, PrivateKey, type Stamper } from "@ethersphere/bee-js"
import { uint8ArrayToHex } from "../utils/hex"
import { deriveSecret } from "../utils/key-derivation"
import {
  LEASE_TTL_MS,
  NUM_BUCKETS,
  UtilizationAwareStamper,
} from "../utils/batch-utilization"
import {
  acquirePartitionLock,
  makeDeviceTiebreaker,
  NO_HOLDER_DEVICE_ID,
  readPartitionLock,
  writePartitionLock,
  type PartitionLockGeneration,
  type PartitionLockPayload,
} from "./partition-lock"
import { readPartitionState, writePartitionState } from "./partition-state"

/** Default guard time δ for the lock protocol (iteration-2 doc § δ tuning). */
export const PARTITION_LOCK_GUARD_MS = 2000

/** This device's own lease over a partition. */
export interface SelfLease {
  partition: number
  generation: PartitionLockGeneration
  acquiredAt: number
  leasedUntil: number
}

/** An observed holder of a partition (from the lock SOC). */
export interface PartitionHolderEntry {
  deviceId: string
  generation: PartitionLockGeneration
  acquiredAt: number
  leasedUntil: number
}

/** Inputs the orchestrator needs to dispatch a case. */
export interface PartitionLeaseSnapshotInputs {
  partitionCount: number
}

/** Result of `acquire()` (or the legacy fall-through). */
export interface AcquireResult {
  /**
   * The partition this device holds, or `undefined` for legacy mode and
   * the read-only path (every partition is held by a live foreign holder).
   */
  partition: number | undefined
  partitionCount: number
  localCounter: Uint32Array
  isReadOnly: boolean
  /** Latest lock-SOC payload observed after acquire. Undefined when read-only. */
  lockPayload?: PartitionLockPayload
}

/**
 * Serialised form of the lease state, used as the local persistence cache.
 * Never trusted on its own — callers re-validate `self` against the lock
 * SOC before acting on it.
 */
export interface PartitionLeaseStateSnapshot {
  deviceId: string
  batchId: string
  self?: SelfLease
}

export class PartitionLease {
  private self: SelfLease | undefined
  /** Per-partition holders observed by the last `refreshFromSwarm()`. */
  private holders = new Map<number, PartitionHolderEntry>()

  constructor(
    private readonly opts: {
      bee: Bee
      deviceId: string
      swarmEncryptionKey: Uint8Array
      /** Backup signer for the partition-lock SOC and partition-state feed. */
      backupSigner: PrivateKey
      /**
       * Batch + stamper are only needed for the WRITE paths (acquire,
       * refresh, release). They're optional so a reader — e.g. the SwarmID
       * UI's Devices tab — can build a lease purely to `refreshFromSwarm`
       * and inspect holders without a stamper.
       */
      batchId?: BatchId
      batchDepth?: number
      /**
       * Stamper used to upload the small payload chunks (lock SOC, state
       * feed). In practice this is the `UtilizationAwareStamper` the proxy
       * uses for data uploads. Omitted for read-only use.
       */
      stamper?: Stamper
      /** Override for tests; defaults to `() => Date.now()`. */
      now?: () => number
      /** Override for tests; defaults to PARTITION_LOCK_GUARD_MS. */
      guardMs?: number
    },
  ) {}

  /**
   * Build a `PartitionLease` whose `backupSigner` is derived from the
   * account's `swarmEncryptionKey` (same derivation as the partition-state
   * and partition-lock feeds). Pass `stamper`/`batchId`/`batchDepth` for the
   * write path; omit them for a read-only lease (UI display).
   */
  static async fromSwarmEncryptionKey(opts: {
    bee: Bee
    deviceId: string
    swarmEncryptionKey: Uint8Array
    batchId?: BatchId
    batchDepth?: number
    stamper?: Stamper
    now?: () => number
    guardMs?: number
  }): Promise<PartitionLease> {
    const swarmEncryptionKeyHex = uint8ArrayToHex(opts.swarmEncryptionKey)
    const backupKeyHex = await deriveSecret(swarmEncryptionKeyHex, "backup-key")
    const backupSigner = new PrivateKey(backupKeyHex)
    return new PartitionLease({ ...opts, backupSigner })
  }

  /**
   * Read every partition's lock SOC and populate `holders` with the live
   * (unexpired, non-released) ones. The single source of truth for "who is
   * active" — used by `isActive`, `heldPartition`, and `pickFreeOrExpired`.
   */
  async refreshFromSwarm(partitionCount: number): Promise<void> {
    const now = this.now()
    this.holders.clear()
    for (let p = 0; p < partitionCount; p++) {
      const lock = await readPartitionLock({
        bee: this.opts.bee,
        backupSigner: this.opts.backupSigner,
        swarmEncryptionKey: this.opts.swarmEncryptionKey,
        partition: p,
      })
      if (
        !lock ||
        lock.holderDeviceId === NO_HOLDER_DEVICE_ID ||
        lock.leasedUntil <= now
      ) {
        continue
      }
      this.holders.set(p, {
        deviceId: lock.holderDeviceId,
        generation: lock.generation,
        acquiredAt: lock.acquiredAt,
        leasedUntil: lock.leasedUntil,
      })
    }
  }

  /** True if `deviceId` is a live holder of any partition (post-refresh). */
  isActive(deviceId: string): boolean {
    for (const holder of this.holders.values()) {
      if (holder.deviceId === deviceId) return true
    }
    return false
  }

  /** The partition this device currently holds per the lock SOCs, else undefined. */
  heldPartition(): number | undefined {
    for (const [partition, holder] of this.holders) {
      if (holder.deviceId === this.opts.deviceId) return partition
    }
    return undefined
  }

  /**
   * Live holders observed by the last `refreshFromSwarm`, one entry per
   * partition currently held. The single read view of "who's active" — the
   * SwarmID UI renders the Devices tab from this.
   */
  getHolders(): { partition: number; deviceId: string; leasedUntil: number }[] {
    return Array.from(this.holders.entries()).map(([partition, holder]) => ({
      partition,
      deviceId: holder.deviceId,
      leasedUntil: holder.leasedUntil,
    }))
  }

  /** The partition `deviceId` currently holds per the lock SOCs, else undefined. */
  partitionFor(deviceId: string): number | undefined {
    for (const [partition, holder] of this.holders) {
      if (holder.deviceId === deviceId) return partition
    }
    return undefined
  }

  /**
   * Lowest partition in `[0, partitionCount)` with no live holder that
   * isn't us, else `undefined`. Drives candidate selection in `acquire`.
   */
  private pickFreeOrExpired(partitionCount: number): number | undefined {
    for (let p = 0; p < partitionCount; p++) {
      const holder = this.holders.get(p)
      if (!holder || holder.deviceId === this.opts.deviceId) return p
    }
    return undefined
  }

  /**
   * Acquire a partition. Always consults the lock SOCs (via
   * `refreshFromSwarm`) — there is no local-state shortcut. Refreshes our
   * existing partition when we already hold one; otherwise claims the first
   * free / expired one. Returns read-only when every partition is held by a
   * live foreign holder.
   */
  async acquire(
    snapshot: PartitionLeaseSnapshotInputs,
  ): Promise<AcquireResult> {
    const { partitionCount } = snapshot

    if (partitionCount <= 1) {
      return {
        partition: undefined,
        partitionCount: 1,
        localCounter: new Uint32Array(NUM_BUCKETS),
        isReadOnly: false,
      }
    }

    await this.refreshFromSwarm(partitionCount)

    // Prefer the partition we already hold; otherwise the first free/expired.
    const chosenPartition =
      this.heldPartition() ?? this.pickFreeOrExpired(partitionCount)

    if (chosenPartition === undefined) {
      // Every partition is live + foreign-held.
      return {
        partition: undefined,
        partitionCount,
        localCounter: new Uint32Array(NUM_BUCKETS),
        isReadOnly: true,
      }
    }

    return this.claimPartition({ partition: chosenPartition, partitionCount })
  }

  /**
   * Read partition-state for counter seeding, then drive
   * `acquirePartitionLock` to claim + verify the partition.
   *
   * On a `lost-race` or `blocked` outcome we fall back to read-only.
   */
  private async claimPartition(args: {
    partition: number
    partitionCount: number
  }): Promise<AcquireResult> {
    const { partition, partitionCount } = args
    const { stamper, batchId, batchDepth } = this.requireWriteContext()

    // Cache-aware seed: pass the reference our local counter is already in
    // sync with. If the feed still points there, `readPartitionState` skips
    // the reference + counter-chunk downloads and we reuse the local counter.
    const knownReference =
      stamper instanceof UtilizationAwareStamper
        ? await stamper.getSyncedReference(partition)
        : undefined
    const stateResult = await readPartitionState(
      {
        bee: this.opts.bee,
        owner: this.opts.backupSigner.publicKey().address(),
        batchId,
        partition,
        batchDepth,
      },
      knownReference,
    )
    const localCounter =
      stateResult.unchanged && stamper instanceof UtilizationAwareStamper
        ? stamper.buildLeaseLocalCounter()
        : (stateResult.localCounter ?? new Uint32Array(NUM_BUCKETS))

    const lockResult = await acquirePartitionLock({
      bee: this.opts.bee,
      stamper,
      backupSigner: this.opts.backupSigner,
      swarmEncryptionKey: this.opts.swarmEncryptionKey,
      partition,
      deviceId: this.opts.deviceId,
      ttlMs: LEASE_TTL_MS,
      guardMs: this.opts.guardMs ?? PARTITION_LOCK_GUARD_MS,
      now: () => this.now(),
    })

    if (lockResult.outcome !== "acquired" || !lockResult.payload) {
      console.warn(
        `[PartitionLease] Lock acquire for partition ${partition} outcome=${lockResult.outcome}; falling back to read-only.`,
      )
      return {
        partition: undefined,
        partitionCount,
        localCounter: new Uint32Array(NUM_BUCKETS),
        isReadOnly: true,
      }
    }

    // Lock acquired → the caller will bind this counter, so record the feed
    // reference we just downloaded as our "synced reference" (lets the next
    // acquire skip the download). Only on a real read — never on `unchanged`
    // (already cached) or a failed read (no `referenceHex`).
    if (
      !stateResult.unchanged &&
      stateResult.referenceHex &&
      stamper instanceof UtilizationAwareStamper
    ) {
      await stamper.setSyncedReference(partition, stateResult.referenceHex)
    }

    const payload = lockResult.payload
    this.self = {
      partition,
      generation: payload.generation,
      acquiredAt: payload.acquiredAt,
      leasedUntil: payload.leasedUntil,
    }
    this.holders.set(partition, {
      deviceId: this.opts.deviceId,
      generation: payload.generation,
      acquiredAt: payload.acquiredAt,
      leasedUntil: payload.leasedUntil,
    })

    return {
      partition,
      partitionCount,
      localCounter,
      isReadOnly: false,
      lockPayload: payload,
    }
  }

  /**
   * Re-run the lock protocol on the currently-held partition to bump
   * `leasedUntil`. Returns `false` when we don't hold a lease (legacy mode)
   * or the lock protocol returned `blocked` / `lost-race` — the caller
   * should treat that as "lease lost".
   */
  async refresh(): Promise<boolean> {
    if (!this.self) return false
    const { stamper } = this.requireWriteContext()
    const lockResult = await acquirePartitionLock({
      bee: this.opts.bee,
      stamper,
      backupSigner: this.opts.backupSigner,
      swarmEncryptionKey: this.opts.swarmEncryptionKey,
      partition: this.self.partition,
      deviceId: this.opts.deviceId,
      ttlMs: LEASE_TTL_MS,
      guardMs: this.opts.guardMs ?? PARTITION_LOCK_GUARD_MS,
      now: () => this.now(),
    })
    if (lockResult.outcome !== "acquired" || !lockResult.payload) {
      console.warn(
        `[PartitionLease] Refresh on partition ${this.self.partition} returned ${lockResult.outcome}.`,
      )
      return false
    }
    const payload = lockResult.payload
    this.self = {
      partition: this.self.partition,
      generation: payload.generation,
      acquiredAt: payload.acquiredAt,
      leasedUntil: payload.leasedUntil,
    }
    return true
  }

  /**
   * Publish the final local counter on the partition-state feed, then
   * write a `holderDeviceId: ""` sentinel to the lock SOC so peers see
   * an immediate, authoritative release. No-op when no lease is held.
   */
  async release(localCounter: Uint32Array): Promise<void> {
    if (!this.self) return
    const partition = this.self.partition
    const { stamper, batchId, batchDepth } = this.requireWriteContext()

    const publishedReference = await writePartitionState({
      bee: this.opts.bee,
      stamper,
      batchId,
      batchDepth,
      partition,
      localCounter,
      backupSigner: this.opts.backupSigner,
    })

    // Record the reference we just published as our synced reference: the next
    // acquire (if no peer publishes meanwhile) skips re-downloading our own
    // counter. Our local counter equals what we published, so reusing it is
    // correct.
    if (stamper instanceof UtilizationAwareStamper) {
      await stamper.setSyncedReference(partition, publishedReference)
    }

    const releasePayload: PartitionLockPayload = {
      holderDeviceId: NO_HOLDER_DEVICE_ID,
      generation: {
        timestampMs: this.now(),
        tiebreaker: makeDeviceTiebreaker(this.opts.deviceId),
      },
      acquiredAt: this.self.acquiredAt,
      leasedUntil: this.now(),
    }
    await writePartitionLock({
      bee: this.opts.bee,
      stamper,
      backupSigner: this.opts.backupSigner,
      swarmEncryptionKey: this.opts.swarmEncryptionKey,
      partition,
      payload: releasePayload,
    })

    this.self = undefined
    this.holders.delete(partition)
  }

  /** Current partition (undefined when not holding a lease). */
  get currentPartition(): number | undefined {
    return this.self?.partition
  }

  /**
   * Advance the locally-held lease's `leasedUntil` to `now + ttlMs` without
   * any Swarm write. The caller bumps this every refresh tick as a
   * "this device is alive" heartbeat, so the persisted cache stays fresh
   * even when the Swarm lock-SOC write is transiently failing. No-op when no
   * lease is held. (The cross-device lock SOC is refreshed separately by
   * `refresh()`; this only touches local state.)
   */
  bumpLocalLease(ttlMs: number): void {
    if (!this.self) return
    this.self = { ...this.self, leasedUntil: this.now() + ttlMs }
  }

  /**
   * Re-adopt a still-valid `self` from the persisted cache (after `hydrate`)
   * without any Swarm round-trip. Returns the held partition when the cached
   * lease is still within its TTL, else `undefined` (caller falls back to the
   * cold `acquire()` lock-SOC scan). On adoption it bumps `leasedUntil` and
   * mirrors `self` into `holders` so `getHolders()`/`heldPartition()` agree.
   *
   * This is what lets a reload keep the lease: the fresh page reconstructs the
   * binding from local state alone, surviving transient lock-SOC read/write
   * failures. The next `refresh()` reconciles with Swarm.
   */
  adoptIfLive(): number | undefined {
    if (!this.self || this.self.leasedUntil <= this.now()) return undefined
    this.self = { ...this.self, leasedUntil: this.now() + LEASE_TTL_MS }
    this.holders.set(this.self.partition, {
      deviceId: this.opts.deviceId,
      generation: this.self.generation,
      acquiredAt: this.self.acquiredAt,
      leasedUntil: this.self.leasedUntil,
    })
    return this.self.partition
  }

  /**
   * Serialise the lease state for the local persistence cache. The cache is
   * a fast hint only — callers re-validate `self` against the lock SOC
   * (`refresh()` / `acquire()`) before trusting it.
   */
  serialize(): PartitionLeaseStateSnapshot {
    return {
      deviceId: this.opts.deviceId,
      batchId: this.opts.batchId?.toHex() ?? "",
      self: this.self,
    }
  }

  /**
   * Seed `self` from a persisted cache snapshot. No Swarm activity — the
   * next `refresh()`/`acquire()` re-validates against the lock SOC. Ignores
   * snapshots for a different device or batch (and read-only instances,
   * which have no batch).
   */
  hydrate(snapshot: PartitionLeaseStateSnapshot): void {
    if (snapshot.deviceId !== this.opts.deviceId) return
    if (!this.opts.batchId || snapshot.batchId !== this.opts.batchId.toHex()) {
      return
    }
    this.self = snapshot.self
  }

  /**
   * Assert the write context (stamper + batch) is present. Throws on a
   * read-only instance — acquire / refresh / release require it.
   */
  private requireWriteContext(): {
    stamper: Stamper
    batchId: BatchId
    batchDepth: number
  } {
    if (
      !this.opts.stamper ||
      !this.opts.batchId ||
      this.opts.batchDepth === undefined
    ) {
      throw new Error(
        "PartitionLease: write operation requires stamper + batchId + batchDepth (read-only instance)",
      )
    }
    return {
      stamper: this.opts.stamper,
      batchId: this.opts.batchId,
      batchDepth: this.opts.batchDepth,
    }
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }
}
