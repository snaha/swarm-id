/**
 * Synchronous Epoch Feed Finder
 *
 * Recursive implementation for finding feed updates at specific timestamps
 * using epoch-based indexing.
 */

import { Binary } from "cafe-utility"
import type { Bee } from "@ethersphere/bee-js"
import { EthAddress, Reference, Topic } from "@ethersphere/bee-js"
import { EpochIndex, lca, MAX_LEVEL } from "./epoch"
import type { EpochFinder } from "./types"

/**
 * Synchronous recursive finder for epoch-based feeds
 *
 * Traverses the epoch tree recursively to find the feed update
 * valid at a specific timestamp.
 *
 * Implements the EpochFinder interface.
 */
export class SyncEpochFinder implements EpochFinder {
  constructor(
    private readonly bee: Bee,
    private readonly topic: Topic,
    private readonly owner: EthAddress,
  ) {}

  /**
   * Find the feed update valid at time `at`
   * @param at - Target unix timestamp (seconds)
   * @param after - Hint of latest known update timestamp (0 if unknown)
   * @returns 32-byte Swarm reference, or undefined if no update found
   */
  async findAt(
    at: bigint,
    after: bigint = 0n,
  ): Promise<Uint8Array | undefined> {
    const { epoch, chunk } = await this.common(at, after)

    if (!chunk && epoch.level === MAX_LEVEL) {
      // No update found at all
      return undefined
    }

    return this.atEpoch(at, epoch, chunk)
  }

  /**
   * Find the lowest common ancestor epoch with an existing chunk
   *
   * Traverses UP the epoch tree from the LCA until finding a chunk,
   * or reaching the top level.
   *
   * @param at - Target timestamp
   * @param after - Reference timestamp
   * @returns Epoch and chunk found at that epoch (if any)
   */
  private async common(
    at: bigint,
    after: bigint,
  ): Promise<{ epoch: EpochIndex; chunk?: Uint8Array }> {
    let epoch = lca(at, after)

    while (true) {
      try {
        const chunk = await this.getEpochChunk(at, epoch)

        // getEpochChunk validates timestamp and returns undefined if invalid
        if (chunk) {
          return { epoch, chunk }
        }

        // Chunk found but timestamp invalid, continue searching up
      } catch (error) {
        // Chunk not found, continue searching up
      }

      // Check if at top before trying to go to parent
      if (epoch.level === MAX_LEVEL) {
        // Reached top without finding anything
        return { epoch }
      }

      // Move to parent epoch
      epoch = epoch.parent()
    }
  }

  /**
   * Recursive descent to find exact update at timestamp
   *
   * Traverses DOWN the epoch tree, handling left/right branches
   * to find the most recent update not later than `at`.
   *
   * @param at - Target timestamp
   * @param epoch - Current epoch being examined
   * @param currentChunk - Best chunk found so far
   * @returns Final chunk reference, or undefined
   */
  private async atEpoch(
    at: bigint,
    epoch: EpochIndex,
    currentChunk?: Uint8Array,
  ): Promise<Uint8Array | undefined> {
    let chunk: Uint8Array | undefined

    try {
      chunk = await this.getEpochChunk(at, epoch)
    } catch (error) {
      // Epoch chunk not found
      if (epoch.isLeft()) {
        // No lower resolution available, return what we have
        return currentChunk
      }

      // Traverse earlier branch (left sibling)
      return this.atEpoch(epoch.start - 1n, epoch.left(), currentChunk)
    }

    // Chunk validation (timestamp) is handled by getEpochChunk
    if (!chunk) {
      // Timestamp invalid (update too recent)
      if (epoch.isLeft()) {
        return currentChunk
      }

      // Traverse earlier branch
      return this.atEpoch(epoch.start - 1n, epoch.left(), currentChunk)
    }

    // Update is valid
    if (epoch.level === 0) {
      // Finest resolution - this is our answer
      return chunk
    }

    // Continue traversing down to finer resolution
    return this.atEpoch(at, epoch.childAt(at), chunk)
  }

  /**
   * Fetch chunk for a specific epoch
   *
   * Calculates the chunk address from topic, epoch, and owner,
   * then downloads it from the Bee node.
   *
   * @param at - Target timestamp for validation
   * @param epoch - Epoch to fetch
   * @returns Chunk reference (32 or 64 bytes), or undefined if timestamp invalid
   * @throws Error if chunk not found or network error
   */
  private async getEpochChunk(
    at: bigint,
    epoch: EpochIndex,
  ): Promise<Uint8Array | undefined> {
    // Calculate epoch identifier: Keccak256(topic || Keccak256(start || level))
    const epochHash = await epoch.marshalBinary()
    const identifier = Binary.keccak256(
      Binary.concatBytes(this.topic.toUint8Array(), epochHash),
    )

    // Calculate chunk address: Keccak256(identifier || owner)
    const address = new Reference(
      Binary.keccak256(
        Binary.concatBytes(identifier, this.owner.toUint8Array()),
      ),
    )

    // Download chunk
    const chunkData = await this.bee.downloadChunk(address.toHex())

    // Extract payload from SOC (Single Owner Chunk)
    // SOC structure: [identifier (32 bytes)][signature (65 bytes)][span (8 bytes)][payload]
    const IDENTIFIER_SIZE = 32
    const SIGNATURE_SIZE = 65
    const SPAN_SIZE = 8
    const TIMESTAMP_SIZE = 8
    const SOC_HEADER_SIZE = IDENTIFIER_SIZE + SIGNATURE_SIZE

    // Read span to get payload length
    const spanStart = SOC_HEADER_SIZE
    const span = chunkData.slice(spanStart, spanStart + SPAN_SIZE)
    const spanView = new DataView(span.buffer, span.byteOffset, span.byteLength)
    const payloadLength = Number(spanView.getBigUint64(0, true)) // little-endian

    // Extract full payload (timestamp + reference)
    const payloadStart = spanStart + SPAN_SIZE
    const payload = chunkData.slice(payloadStart, payloadStart + payloadLength)

    // Read timestamp from payload (first 8 bytes, big-endian)
    const timestampBytes = payload.slice(0, TIMESTAMP_SIZE)
    const timestampView = new DataView(
      timestampBytes.buffer,
      timestampBytes.byteOffset,
      timestampBytes.byteLength,
    )
    const timestamp = timestampView.getBigUint64(0, false) // big-endian

    // Validate timestamp - update must be at or before target time
    if (timestamp > at) {
      return undefined
    }

    // Return reference only (skip 8-byte timestamp prefix)
    return payload.slice(TIMESTAMP_SIZE)
  }
}
