// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Partition-lease orchestrator for multi-device postage-batch sharing.
 *
 * State machine:
 *   Acquire  → dispatches Case A (fresh), B (auto-acquire free partition),
 *              or D (crash recovery on expired peer lease)
 *   Hold     → no per-upload coordination; just stamp through the
 *              partition-aware `UtilizationAwareStamper`
 *   Refresh  → bump `leasedUntil` on the device's own claim feed every
 *              `LEASE_REFRESH_MS` (TTL/4)
 *   Release  → publish the device's local counter to the partition-state
 *              feed and write a release entry (partition: -1) to the
 *              claim feed
 *
 * Phase 1 core: Cases A/B/D, no admission feed / Case C handover.
 *
 * Legacy fallback: if the snapshot's `partitionCount === 1` (or absent)
 * we return `partition: undefined`, the stamper stays in single-device
 * mode, and no feed traffic is generated. This is what every account
 * created before partition-lease shipped looks like.
 */

import { Bee, BatchId, PrivateKey } from "@ethersphere/bee-js"
import { uint8ArrayToHex } from "../utils/hex"
import { deriveSecret } from "../utils/key-derivation"
import { LEASE_TTL_MS, NUM_BUCKETS } from "../utils/batch-utilization"
import {
  NO_CLAIM_PARTITION,
  readDeviceClaim,
  writeDeviceClaim,
} from "./partition-claim"
import { readPartitionState, writePartitionState } from "./partition-state"
import type { ActiveDevice, PartitionClaim } from "../schemas"
import type { EpochUpdateHints } from "../proxy/feeds/epochs/types"
import type { Stamper } from "@ethersphere/bee-js"

/** Snapshot fields the orchestrator needs to dispatch a case. */
export interface PartitionLeaseSnapshotInputs {
  activeDevices: ActiveDevice[]
  partitionCount: number
}

/** Result of a successful `acquire()` (or the legacy fall-through). */
export interface AcquireResult {
  /**
   * The partition this device holds, or `undefined` when running in
   * legacy single-device mode (snapshot's `partitionCount === 1` or
   * `activeDevices` empty).
   */
  partition: number | undefined
  /** Total partition count from the snapshot (1 in legacy mode). */
  partitionCount: number
  /** Seeded per-bucket local counter (length 65,536). */
  localCounter: Uint32Array
  /**
   * Updated `activeDevices` to write back to the account snapshot. The
   * caller is responsible for actually mirroring this into the in-memory
   * `Account` and triggering the snapshot sync — the lease orchestrator
   * doesn't reach into the account store directly.
   */
  activeDevices: ActiveDevice[]
  /**
   * Set when no free partition could be claimed (all live, no expired
   * lease, no self-entry). Caller should reject uploads until a refresh
   * cycle frees a slot or the user takes manual action.
   */
  isReadOnly: boolean
}

/**
 * Construct an orchestrator. Inputs are the things that don't change
 * between Acquire/Refresh/Release for a given session.
 */
export class PartitionLease {
  private acquired:
    | {
        partition: number
        accountId: string
        deviceId: string
        batchId: BatchId
        generation: number
        acquiredAt: number
        leasedUntil: number
        claimHints?: EpochUpdateHints
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
      /** Backup signer for all partition-lease feeds (claim + state). */
      backupSigner: PrivateKey
      /**
       * Stamper used for the small feed-payload uploads (claim + state).
       * In practice this is the same `UtilizationAwareStamper` the proxy
       * uses for data uploads; we only need it to stamp the encrypted
       * payload chunks that the feed entries reference.
       */
      stamper: Stamper
      /** Override for tests; defaults to `() => Date.now()`. */
      now?: () => number
    },
  ) {}

  /**
   * Build a `PartitionLease` whose `backupSigner` is derived from the
   * account's `swarmEncryptionKey` via the same `"backup-key"` HKDF
   * context used by `sync-account.ts:332`.
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
  }): Promise<PartitionLease> {
    const swarmEncryptionKeyHex = uint8ArrayToHex(opts.swarmEncryptionKey)
    const backupKeyHex = await deriveSecret(swarmEncryptionKeyHex, "backup-key")
    const backupSigner = new PrivateKey(backupKeyHex)
    return new PartitionLease({ ...opts, backupSigner })
  }

  /**
   * Dispatch Case A / B / D (or the legacy fall-through). On success the
   * device's claim feed has a fresh entry and the local counter is
   * seeded from the partition-state feed (or zero for a fresh
   * partition). The caller wires the partition into the
   * `UtilizationAwareStamper` via its `bindPartition()` method.
   */
  async acquire(
    snapshot: PartitionLeaseSnapshotInputs,
  ): Promise<AcquireResult> {
    const now = this.now()
    const { partitionCount, activeDevices } = snapshot

    // Legacy fall-through: snapshots from before partition-lease shipped
    // arrive with `partitionCount: 1` (the schema default) and no
    // `activeDevices`. Run as today — single-device, no feed traffic.
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
    if (selfEntry) {
      // Self is already in activeDevices — re-seed from our own partition
      // state and write a fresh claim entry. This is the common case for
      // a returning device on its primary browser profile.
      return this.takePartition({
        partition: selfEntry.partition,
        partitionCount,
        activeDevices,
        now,
      })
    }

    // Find a partition that no other device currently holds (Case B), or
    // one whose holder's lease has expired (Case D).
    const occupied = new Map<number, ActiveDevice>()
    for (const d of activeDevices) occupied.set(d.partition, d)

    // Case B candidates: partitions that simply have no entry.
    for (let p = 0; p < partitionCount; p++) {
      if (!occupied.has(p)) {
        return this.takePartition({
          partition: p,
          partitionCount,
          activeDevices: [
            ...activeDevices,
            { deviceId: this.opts.deviceId, partition: p },
          ],
          now,
        })
      }
    }

    // All partitions occupied — check for an expired lease (Case D).
    for (const [partition, holder] of occupied) {
      const claim = await readDeviceClaim({
        bee: this.opts.bee,
        owner: this.opts.backupSigner.publicKey().address(),
        accountId: this.opts.accountId,
        deviceId: holder.deviceId,
      })
      if (!claim || claim.leasedUntil < now) {
        console.warn(
          `[PartitionLease] Case D: taking over partition ${partition} from ${holder.deviceId} (leasedUntil=${claim?.leasedUntil ?? "none"})`,
        )
        return this.takePartition({
          partition,
          partitionCount,
          activeDevices: activeDevices.map((d) =>
            d.partition === partition
              ? { deviceId: this.opts.deviceId, partition }
              : d,
          ),
          now,
        })
      }
    }

    // All partitions held with live leases → read-only.
    return {
      partition: undefined,
      partitionCount,
      localCounter: new Uint32Array(NUM_BUCKETS),
      activeDevices,
      isReadOnly: true,
    }
  }

  /**
   * Bump `leasedUntil` and `generation` on this device's claim feed.
   * No-op when the lease isn't held (legacy mode or read-only).
   */
  async refresh(): Promise<void> {
    if (!this.acquired) return
    const now = this.now()
    const claim: PartitionClaim = {
      partition: this.acquired.partition,
      leasedUntil: now + LEASE_TTL_MS,
      generation: this.acquired.generation + 1,
      acquiredAt: this.acquired.acquiredAt,
    }
    const result = await writeDeviceClaim({
      bee: this.opts.bee,
      stamper: this.opts.stamper,
      accountId: this.acquired.accountId,
      deviceId: this.acquired.deviceId,
      claim,
      swarmEncryptionKey: this.opts.swarmEncryptionKey,
      backupSigner: this.opts.backupSigner,
      hints: this.acquired.claimHints,
    })
    this.acquired.generation = claim.generation
    this.acquired.leasedUntil = claim.leasedUntil
    this.acquired.claimHints = {
      lastEpoch: result.epoch,
      lastTimestamp: result.timestamp,
    }
  }

  /**
   * Publish the current local counter to the partition-state feed, then
   * write a release entry (partition: -1) to the claim feed. No-op when
   * the lease isn't held.
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

    const releaseClaim: PartitionClaim = {
      partition: NO_CLAIM_PARTITION,
      leasedUntil: this.now(),
      generation: this.acquired.generation + 1,
      acquiredAt: this.acquired.acquiredAt,
    }
    await writeDeviceClaim({
      bee: this.opts.bee,
      stamper: this.opts.stamper,
      accountId: this.acquired.accountId,
      deviceId: this.acquired.deviceId,
      claim: releaseClaim,
      swarmEncryptionKey: this.opts.swarmEncryptionKey,
      backupSigner: this.opts.backupSigner,
      hints: this.acquired.claimHints,
    })

    this.acquired = undefined
  }

  /** Current partition (undefined when not holding a lease). */
  get currentPartition(): number | undefined {
    return this.acquired?.partition
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  /**
   * Common back-half of all Acquire cases: read partition-state, write
   * a fresh claim, remember the acquired lease for Refresh/Release.
   */
  private async takePartition(args: {
    partition: number
    partitionCount: number
    activeDevices: ActiveDevice[]
    now: number
  }): Promise<AcquireResult> {
    const { partition, partitionCount, activeDevices, now } = args

    const { localCounter } = await readPartitionState({
      bee: this.opts.bee,
      owner: this.opts.backupSigner.publicKey().address(),
      batchId: this.opts.batchId,
      partition,
      batchDepth: this.opts.batchDepth,
    })

    // Read any prior claim from THIS device to preserve `generation`
    // monotonicity (a peer-side observer expects generation to never
    // decrease for a given deviceId, even across our own reboots).
    const prior = await readDeviceClaim({
      bee: this.opts.bee,
      owner: this.opts.backupSigner.publicKey().address(),
      accountId: this.opts.accountId,
      deviceId: this.opts.deviceId,
    })
    const nextGeneration = (prior?.generation ?? 0) + 1

    const claim: PartitionClaim = {
      partition,
      leasedUntil: now + LEASE_TTL_MS,
      generation: nextGeneration,
      acquiredAt: now,
    }
    const result = await writeDeviceClaim({
      bee: this.opts.bee,
      stamper: this.opts.stamper,
      accountId: this.opts.accountId,
      deviceId: this.opts.deviceId,
      claim,
      swarmEncryptionKey: this.opts.swarmEncryptionKey,
      backupSigner: this.opts.backupSigner,
    })

    this.acquired = {
      partition,
      accountId: this.opts.accountId,
      deviceId: this.opts.deviceId,
      batchId: this.opts.batchId,
      generation: claim.generation,
      acquiredAt: claim.acquiredAt,
      leasedUntil: claim.leasedUntil,
      claimHints: {
        lastEpoch: result.epoch,
        lastTimestamp: result.timestamp,
      },
    }

    return {
      partition,
      partitionCount,
      localCounter,
      activeDevices,
      isReadOnly: false,
    }
  }
}
