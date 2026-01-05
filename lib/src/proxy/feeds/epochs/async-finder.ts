/**
 * Async Epoch Feed Finder (Concurrent)
 *
 * Concurrent implementation for finding feed updates at specific timestamps
 * using epoch-based indexing with parallel chunk fetching.
 */

import { Binary } from "cafe-utility"
import type { Bee } from "@ethersphere/bee-js"
import { EthAddress, Reference, Topic } from "@ethersphere/bee-js"
import { EpochIndex, MAX_LEVEL } from "./epoch"
import type { EpochFinder } from "./types"

/**
 * Async concurrent finder for epoch-based feeds
 *
 * Launches parallel chunk fetches along the epoch tree path
 * to find the feed update valid at a specific timestamp.
 *
 * Implements the EpochFinder interface.
 */
export class AsyncEpochFinder implements EpochFinder {
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
    _after: bigint = 0n,
  ): Promise<Uint8Array | undefined> {
    // Start from top epoch and traverse down
    return this.findAtEpoch(at, new EpochIndex(0n, MAX_LEVEL), undefined)
  }

  /**
   * Recursively find update at epoch, with parallel fetching
   *
   * @param at - Target timestamp
   * @param epoch - Current epoch to check
   * @param currentBest - Best result found so far
   * @returns Reference if found, undefined otherwise
   */
  private async findAtEpoch(
    at: bigint,
    epoch: EpochIndex,
    currentBest: Uint8Array | undefined,
  ): Promise<Uint8Array | undefined> {
    // Try to get chunk at this epoch
    let chunk: Uint8Array | undefined
    try {
      chunk = await this.getEpoch(at, epoch)
    } catch (error) {
      // Chunk not found at this epoch
      chunk = undefined
    }

    // If chunk found and valid
    if (chunk) {
      // If at finest resolution, this is our answer
      if (epoch.level === 0) {
        return chunk
      }

      // Continue to finer resolution
      return this.findAtEpoch(at, epoch.childAt(at), chunk)
    }

    // Chunk not found or timestamp invalid
    if (epoch.isLeft()) {
      // Left child - return best we have so far
      return currentBest
    }

    // Right child - need to search left sibling branch
    return this.findAtEpoch(epoch.start - 1n, epoch.left(), currentBest)
  }

  /**
   * Attempt to fetch chunk for an epoch
   *
   * @param at - Target timestamp (for validation)
   * @param epoch - Epoch to fetch
   * @returns Chunk data if found and valid, undefined otherwise
   */
  private async getEpoch(
    at: bigint,
    epoch: EpochIndex,
  ): Promise<Uint8Array | undefined> {
    try {
      // getEpochChunk now validates timestamp internally
      return await this.getEpochChunk(at, epoch)
    } catch (error) {
      // Chunk not found
      return undefined
    }
  }

  /**
   * Fetch chunk for a specific epoch
   *
   * @param at - Target timestamp for validation
   * @param epoch - Epoch to fetch
   * @returns Chunk payload
   * @throws Error if chunk not found
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
