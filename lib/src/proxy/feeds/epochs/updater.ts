/**
 * Basic Epoch Feed Updater
 *
 * Handles writing updates to epoch-based feeds by calculating the next
 * epoch and uploading chunks.
 */

import { Binary } from "cafe-utility"
import type { Bee } from "@ethersphere/bee-js"
import { EthAddress, Topic, PrivateKey, Identifier } from "@ethersphere/bee-js"
import { EpochIndex, next } from "./epoch"
import { uploadSOC } from "./soc-helper"
import type { EpochUpdater } from "./types"

/**
 * Basic updater for epoch-based feeds
 *
 * Maintains state of the last update and calculates the next epoch
 * for new updates.
 *
 * Implements the EpochUpdater interface.
 */
export class BasicEpochUpdater implements EpochUpdater {
  private lastUpdate: bigint = 0n
  private lastEpoch: EpochIndex | undefined = undefined

  constructor(
    private readonly bee: Bee,
    private readonly topic: Topic,
    private readonly signer: PrivateKey,
  ) {}

  /**
   * Update feed with a reference at given timestamp
   *
   * @param at - Unix timestamp for this update (seconds)
   * @param reference - 32 or 64-byte Swarm reference to store
   * @param postageBatchId - Batch ID for stamping
   */
  async update(
    at: bigint,
    reference: Uint8Array,
    postageBatchId: string,
  ): Promise<void> {
    if (reference.length !== 32 && reference.length !== 64) {
      throw new Error(
        `Reference must be 32 or 64 bytes, got ${reference.length}`,
      )
    }

    // Calculate next epoch for this update
    const epoch = next(this.lastEpoch, this.lastUpdate, at)

    // Upload the chunk with timestamp + reference
    await this.uploadEpochChunk(epoch, at, reference, postageBatchId)

    // Update state
    this.lastUpdate = at
    this.lastEpoch = epoch
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
   * @param postageBatchId - Batch ID for stamping
   */
  private async uploadEpochChunk(
    epoch: EpochIndex,
    at: bigint,
    reference: Uint8Array,
    postageBatchId: string,
  ): Promise<void> {
    // Calculate epoch identifier: Keccak256(topic || Keccak256(start || level))
    const epochHash = await epoch.marshalBinary()
    const identifier = new Identifier(
      Binary.keccak256(
        Binary.concatBytes(this.topic.toUint8Array(), epochHash),
      ),
    )

    // Payload: 8-byte timestamp (big-endian) + reference
    const timestamp = new Uint8Array(8)
    const view = new DataView(timestamp.buffer)
    view.setBigUint64(0, at, false) // big-endian

    const payload = Binary.concatBytes(timestamp, reference)

    // Upload as Single Owner Chunk using our SOC helper
    await uploadSOC(this.bee, this.signer, postageBatchId, identifier, payload)
  }

  /**
   * Reset updater state (useful for testing or reinitialization)
   */
  reset(): void {
    this.lastUpdate = 0n
    this.lastEpoch = undefined
  }

  /**
   * Get current state (for persistence/debugging)
   */
  getState(): { lastUpdate: bigint; lastEpoch: EpochIndex | undefined } {
    return {
      lastUpdate: this.lastUpdate,
      lastEpoch: this.lastEpoch,
    }
  }

  /**
   * Restore state (from persistence)
   */
  setState(state: { lastUpdate: bigint; lastEpoch?: EpochIndex }): void {
    this.lastUpdate = state.lastUpdate
    this.lastEpoch = state.lastEpoch
  }
}
