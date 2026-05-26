// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Partition-lease orchestrator for multi-device postage-batch sharing.
 *
 * Iteration 2 — the holder of a partition is recorded in a shared
 * per-partition lock SOC (`partition-lock.ts`), written with a
 * read-write-verify protocol. The iteration-1 per-device claim feed
 * (`partition-claim.ts`) is no longer consulted by this module; the file
 * remains in the codebase for external observers / legacy reads.
 *
 * Flow:
 *   Acquire  →  pick a partition (self's existing, or a free / expired
 *               one), `acquirePartitionLock` to claim+verify
 *   Hold     →  per-upload coordination via UtilizationAwareStamper
 *   Refresh  →  re-run `acquirePartitionLock` on the held partition;
 *               extends `leasedUntil` and bumps generation
 *   Release  →  `writePartitionLock` with the NO_HOLDER_DEVICE_ID sentinel
 *               plus a `partition-state` publish for counter handoff
 *
 * Legacy fall-through: snapshots with `partitionCount <= 1` skip all
 * Swarm activity — single-device mode.
 *
 * See: docs/Multi-Device-Partition-Lease-iteration-2.md
 */

import { Bee, BatchId, PrivateKey, type Stamper } from "@ethersphere/bee-js"
import { uint8ArrayToHex } from "../utils/hex"
import { deriveSecret } from "../utils/key-derivation"
import { LEASE_TTL_MS, NUM_BUCKETS } from "../utils/batch-utilization"
import type { CachedLeaseInput } from "../utils/batch-utilization"
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
import type { ActiveDevice } from "../schemas"
import type { EpochUpdateHints } from "../proxy/feeds/epochs/types"

export type { CachedLeaseInput }

/** Default guard time δ for the lock protocol (iteration-2 doc § δ tuning). */
export const PARTITION_LOCK_GUARD_MS = 2000

/** Snapshot fields the orchestrator needs to dispatch a case. */
export interface PartitionLeaseSnapshotInputs {
  activeDevices: ActiveDevice[]
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
  /**
   * Updated `activeDevices` to write back to the account snapshot. Reflects
   * the holder we observed on Swarm; the caller mirrors this into the
   * account store for UI / observability.
   */
  activeDevices: ActiveDevice[]
  isReadOnly: boolean
  /** Latest lock-SOC payload observed after acquire. Undefined when read-only. */
  lockPayload?: PartitionLockPayload
  /**
   * Legacy field — timestampMs of the lock generation. Kept on the
   * interface so swarm-id-proxy's existing `LeaseState` serialisation
   * still works.
   */
  generation?: number
  /**
   * Legacy iteration-1 field. Always `undefined` in iteration 2 — kept
   * for type compat with the proxy's `LeaseState` writes.
   */
  claimHints?: EpochUpdateHints
}

/**
 * Construct an orchestrator. Inputs are the things that don't change
 * between Acquire / Refresh / Release for a given session.
 */
export class PartitionLease {
  private acquired:
    | {
        partition: number
        accountId: string
        deviceId: string
        batchId: BatchId
        acquiredAt: number
        leasedUntil: number
        lockGeneration: PartitionLockGeneration
      }
    | undefined

  constructor(
    private readonly opts: {
      bee: Bee
      accountId: string
      deviceId: string
      batchId: BatchId
      batchDepth: number
      swarmEncryptionKey: Uint8Array
      /** Backup signer for the partition-lock SOC and partition-state feed. */
      backupSigner: PrivateKey
      /**
       * Stamper used to upload the small payload chunks (lock SOC, state
       * feed). In practice this is the `UtilizationAwareStamper` the proxy
       * uses for data uploads.
       */
      stamper: Stamper
      /** Override for tests; defaults to `() => Date.now()`. */
      now?: () => number
      /** Override for tests; defaults to PARTITION_LOCK_GUARD_MS. */
      guardMs?: number
    },
  ) {}

  /**
   * Build a `PartitionLease` whose `backupSigner` is derived from the
   * account's `swarmEncryptionKey` (same derivation as the partition-state
   * and partition-lock feeds).
   */
  static async fromSwarmEncryptionKey(opts: {
    bee: Bee
    accountId: string
    deviceId: string
    batchId: BatchId
    batchDepth: number
    swarmEncryptionKey: Uint8Array
    stamper: Stamper
    now?: () => number
    guardMs?: number
  }): Promise<PartitionLease> {
    const swarmEncryptionKeyHex = uint8ArrayToHex(opts.swarmEncryptionKey)
    const backupKeyHex = await deriveSecret(swarmEncryptionKeyHex, "backup-key")
    const backupSigner = new PrivateKey(backupKeyHex)
    return new PartitionLease({ ...opts, backupSigner })
  }

  /**
   * Acquire a partition. Either refreshes our existing partition (when
   * `selfEntry` is present in the snapshot) or scans the per-partition
   * lock SOCs to find a free / expired one and claims it.
   *
   * @param _cachedLease retained for API compatibility with iteration 1;
   *        ignored in iteration 2 because the lock protocol no longer
   *        depends on cached epoch hints.
   */
  async acquire(
    snapshot: PartitionLeaseSnapshotInputs,
    _cachedLease?: CachedLeaseInput,
  ): Promise<AcquireResult> {
    const now = this.now()
    const { partitionCount, activeDevices } = snapshot

    if (partitionCount <= 1) {
      return {
        partition: undefined,
        partitionCount: 1,
        localCounter: new Uint32Array(NUM_BUCKETS),
        activeDevices,
        isReadOnly: false,
      }
    }

    const selfEntry = activeDevices.find(
      (d) => d.deviceId === this.opts.deviceId,
    )

    let chosenPartition: number | undefined
    if (selfEntry) {
      // Returning device — try to refresh on our existing partition. If
      // we lose the race or get blocked, claimPartition will fall through
      // to read-only.
      chosenPartition = selfEntry.partition
    } else {
      // Fresh device — scan lock SOCs in order and pick the first one
      // that's empty, released, or expired.
      for (let p = 0; p < partitionCount; p++) {
        const lock = await readPartitionLock({
          bee: this.opts.bee,
          backupSigner: this.opts.backupSigner,
          swarmEncryptionKey: this.opts.swarmEncryptionKey,
          accountId: this.opts.accountId,
          partition: p,
        })
        if (
          !lock ||
          lock.holderDeviceId === NO_HOLDER_DEVICE_ID ||
          lock.leasedUntil < now
        ) {
          chosenPartition = p
          break
        }
      }
    }

    if (chosenPartition === undefined) {
      // Every partition is live + foreign-held.
      return {
        partition: undefined,
        partitionCount,
        localCounter: new Uint32Array(NUM_BUCKETS),
        activeDevices,
        isReadOnly: true,
      }
    }

    return this.claimPartition({
      partition: chosenPartition,
      partitionCount,
      activeDevices,
      selfEntry,
    })
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
    activeDevices: ActiveDevice[]
    selfEntry: ActiveDevice | undefined
  }): Promise<AcquireResult> {
    const { partition, partitionCount, activeDevices, selfEntry } = args

    const { localCounter } = await readPartitionState({
      bee: this.opts.bee,
      owner: this.opts.backupSigner.publicKey().address(),
      batchId: this.opts.batchId,
      partition,
      batchDepth: this.opts.batchDepth,
    })

    const lockResult = await acquirePartitionLock({
      bee: this.opts.bee,
      stamper: this.opts.stamper,
      backupSigner: this.opts.backupSigner,
      swarmEncryptionKey: this.opts.swarmEncryptionKey,
      accountId: this.opts.accountId,
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
        activeDevices,
        isReadOnly: true,
      }
    }

    const lockPayload = lockResult.payload
    this.acquired = {
      partition,
      accountId: this.opts.accountId,
      deviceId: this.opts.deviceId,
      batchId: this.opts.batchId,
      acquiredAt: lockPayload.acquiredAt,
      leasedUntil: lockPayload.leasedUntil,
      lockGeneration: lockPayload.generation,
    }

    const updatedActiveDevices = selfEntry
      ? activeDevices.map((d) =>
          d.partition === partition && d.deviceId !== this.opts.deviceId
            ? { deviceId: this.opts.deviceId, partition }
            : d,
        )
      : [...activeDevices, { deviceId: this.opts.deviceId, partition }]

    return {
      partition,
      partitionCount,
      localCounter,
      activeDevices: updatedActiveDevices,
      isReadOnly: false,
      lockPayload,
      generation: lockPayload.generation.timestampMs,
      claimHints: undefined,
    }
  }

  /**
   * Re-run the lock protocol on the currently-held partition to bump
   * `leasedUntil`. Returns the new generation hint (the proxy mirrors it
   * back into `LeaseState`).
   *
   * Returns `undefined` when we don't hold a lease (legacy mode) or the
   * lock protocol returned `blocked` / `lost-race` — the caller should
   * treat that as "lease lost".
   */
  async refresh(): Promise<
    { generation: number; claimHints?: EpochUpdateHints } | undefined
  > {
    if (!this.acquired) return undefined
    const lockResult = await acquirePartitionLock({
      bee: this.opts.bee,
      stamper: this.opts.stamper,
      backupSigner: this.opts.backupSigner,
      swarmEncryptionKey: this.opts.swarmEncryptionKey,
      accountId: this.acquired.accountId,
      partition: this.acquired.partition,
      deviceId: this.acquired.deviceId,
      ttlMs: LEASE_TTL_MS,
      guardMs: this.opts.guardMs ?? PARTITION_LOCK_GUARD_MS,
      now: () => this.now(),
    })
    if (lockResult.outcome !== "acquired" || !lockResult.payload) {
      console.warn(
        `[PartitionLease] Refresh on partition ${this.acquired.partition} returned ${lockResult.outcome}.`,
      )
      return undefined
    }
    this.acquired.lockGeneration = lockResult.payload.generation
    this.acquired.leasedUntil = lockResult.payload.leasedUntil
    return {
      generation: lockResult.payload.generation.timestampMs,
      claimHints: undefined,
    }
  }

  /**
   * Publish the final local counter on the partition-state feed, then
   * write a `holderDeviceId: ""` sentinel to the lock SOC so peers see
   * an immediate, authoritative release. No-op when no lease is held.
   */
  async release(localCounter: Uint32Array): Promise<void> {
    if (!this.acquired) return

    await writePartitionState({
      bee: this.opts.bee,
      stamper: this.opts.stamper,
      batchId: this.acquired.batchId,
      partition: this.acquired.partition,
      localCounter,
      deviceId: this.acquired.deviceId,
      swarmEncryptionKey: this.opts.swarmEncryptionKey,
      backupSigner: this.opts.backupSigner,
    })

    const releasePayload: PartitionLockPayload = {
      holderDeviceId: NO_HOLDER_DEVICE_ID,
      generation: {
        timestampMs: this.now(),
        tiebreaker: this.acquired.lockGeneration.tiebreaker,
      },
      acquiredAt: this.acquired.acquiredAt,
      leasedUntil: this.now(),
    }
    await writePartitionLock({
      bee: this.opts.bee,
      stamper: this.opts.stamper,
      backupSigner: this.opts.backupSigner,
      swarmEncryptionKey: this.opts.swarmEncryptionKey,
      accountId: this.acquired.accountId,
      partition: this.acquired.partition,
      payload: releasePayload,
    })

    this.acquired = undefined
  }

  /** Current partition (undefined when not holding a lease). */
  get currentPartition(): number | undefined {
    return this.acquired?.partition
  }

  /**
   * Seed the internal `acquired` state from values the caller already has
   * locally (typically the proxy's `LeaseState` in localStorage). No
   * Swarm activity. The next `refresh()` writes a fresh lock-SOC entry.
   */
  hydrate(state: {
    partition: number
    /** Legacy: stored as `lockGeneration.timestampMs`. */
    generation: number
    acquiredAt: number
    leasedUntil: number
    /** Legacy iteration-1 hints; iteration-2 ignores this. */
    claimHints?: EpochUpdateHints
  }): void {
    this.acquired = {
      partition: state.partition,
      accountId: this.opts.accountId,
      deviceId: this.opts.deviceId,
      batchId: this.opts.batchId,
      acquiredAt: state.acquiredAt,
      leasedUntil: state.leasedUntil,
      lockGeneration: {
        timestampMs: state.generation,
        tiebreaker: makeDeviceTiebreaker(this.opts.deviceId),
      },
    }
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }
}
