// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Basic Epoch Feed Updater
 *
 * Handles writing updates to epoch-based feeds by calculating the next
 * epoch and uploading chunks.
 */

import { Binary } from "cafe-utility"
import { EthAddress, Topic, PrivateKey, Identifier } from "@ethersphere/bee-js"
import { EpochIndex, MAX_LEVEL } from "./epoch"
import { uploadSOC, isStamperTarget, type UploadTarget } from "../../upload"
import type { EpochUpdater, EpochUpdateHints, EpochUpdateResult } from "./types"
import { AsyncEpochFinder } from "./async-finder"

/**
 * Basic updater for epoch-based feeds
 *
 * Implements Bee-compatible stateless epoch calculation.
 * Each update uses hints from the previous update to calculate the next epoch,
 * creating a proper epoch tree that Bee's finder can traverse.
 *
 * - First update (no hints): uses root epoch (level 32, start 0)
 * - Subsequent updates: calculates next epoch using the standard algorithm:
 *   - If new timestamp within previous epoch's range: dive to child
 *   - Else: jump to LCA(newTimestamp, prevTimestamp) and dive to child
 *
 * Implements the EpochUpdater interface.
 */
export class BasicEpochUpdater implements EpochUpdater {
  constructor(
    private readonly topic: Topic,
    private readonly signer: PrivateKey,
  ) {}

  /**
   * Update feed with a reference at given timestamp
   *
   * @param at - Unix timestamp for this update (seconds)
   * @param reference - 32 or 64-byte Swarm reference to store
   * @param target - Upload target (stamper or subsidised gateway)
   * @param encryptionKey - Optional encryption key for the update
   * @param hints - Optional hints from previous update for calculating epoch
   * @returns Update result with SOC address and epoch info for next update
   */
  async update(
    at: bigint,
    reference: Uint8Array,
    target: UploadTarget,
    encryptionKey?: Uint8Array,
    hints?: EpochUpdateHints,
  ): Promise<EpochUpdateResult> {
    if (reference.length !== 32 && reference.length !== 64) {
      throw new Error(
        `Reference must be 32 or 64 bytes, got ${reference.length}`,
      )
    }

    // Calculate epoch - auto-lookup if no hints provided
    // For subsidised mode, we can't auto-lookup (no bee instance), so hints are required
    const epoch = await this.calculateEpoch(at, hints, encryptionKey, target)

    // Upload the chunk with timestamp + reference
    const socAddress = await this.uploadEpochChunk(
      epoch,
      at,
      reference,
      target,
      encryptionKey,
    )

    // Return result with hints for next update
    return {
      socAddress,
      epoch: { start: epoch.start, level: epoch.level },
      timestamp: at,
    }
  }

  /**
   * Calculate the epoch for this update based on hints or auto-lookup
   *
   * When hints are provided, uses them for fast epoch calculation.
   * When no hints are provided and using stamper mode, looks up the current
   * feed state to calculate the next epoch, preventing overwrites.
   * In subsidised mode without hints, uses root epoch (first update).
   *
   * @param at - Timestamp for this update
   * @param hints - Optional hints from previous update
   * @param encryptionKey - Optional encryption key for looking up encrypted feeds
   * @param target - Upload target for determining if auto-lookup is possible
   * @returns Epoch to use for this update
   */
  private async calculateEpoch(
    at: bigint,
    hints?: EpochUpdateHints,
    encryptionKey?: Uint8Array,
    target?: UploadTarget,
  ): Promise<EpochIndex> {
    // Fast path: use provided hints
    if (hints?.lastEpoch && hints.lastTimestamp !== undefined) {
      const prevEpoch = new EpochIndex(
        hints.lastEpoch.start,
        hints.lastEpoch.level,
      )
      return prevEpoch.next(hints.lastTimestamp, at)
    }

    // Auto-lookup is only possible in stamper mode (we have a bee instance)
    // In subsidised mode without hints, use root epoch (first update)
    if (!target || !isStamperTarget(target)) {
      return new EpochIndex(0n, MAX_LEVEL)
    }

    // Slow path: lookup current state using stamper's bee instance
    const owner = this.signer.publicKey().address()
    const finder = new AsyncEpochFinder(
      target.bee,
      this.topic,
      owner,
      encryptionKey,
    )

    // Use findAtWithMetadata to get both reference AND epoch info
    const current = await finder.findAtWithMetadata(at)

    if (!current) {
      // First update ever - use root epoch
      return new EpochIndex(0n, MAX_LEVEL)
    }

    // Calculate next epoch based on found state
    return current.epoch.next(current.timestamp, at)
  }

  /**
   * Get the owner address (derived from signer)
   */
  getOwner(): EthAddress {
    return this.signer.publicKey().address()
  }

  /**
   * Upload a chunk for a specific epoch
   *
   * @param epoch - Epoch to upload to
   * @param at - Timestamp of this update
   * @param reference - 32 or 64-byte reference to store
   * @param target - Upload target (stamper or subsidised gateway)
   * @returns SOC chunk address for utilization tracking
   */
  private async uploadEpochChunk(
    epoch: EpochIndex,
    at: bigint,
    reference: Uint8Array,
    target: UploadTarget,
    encryptionKey?: Uint8Array,
  ): Promise<Uint8Array> {
    // Calculate epoch identifier: Keccak256(topic || Keccak256(start || level))
    const epochHash = await epoch.marshalBinary()
    const identifier = new Identifier(
      Binary.keccak256(
        Binary.concatBytes(this.topic.toUint8Array(), epochHash),
      ),
    )

    // Timestamp: 8-byte big-endian
    const timestamp = new Uint8Array(8)
    const tsView = new DataView(timestamp.buffer)
    tsView.setBigUint64(0, at, false) // big-endian

    // Payload: timestamp + reference = 40 or 72 bytes
    // The upload function will wrap this in a CAC (adding span) to get 48 or 80 bytes
    // which is the v1 format Bee expects for /bzz/ compatibility
    const payload = Binary.concatBytes(timestamp, reference)

    const result = await uploadSOC(target, this.signer, identifier, payload, {
      encryptionKey,
      deferred: false, // deferred setting is NOT the cause of /bzz/ timeout
    })

    return result.socAddress
  }
}
