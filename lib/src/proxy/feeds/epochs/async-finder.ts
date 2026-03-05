/**
 * Async Epoch Feed Finder (Concurrent)
 *
 * Concurrent implementation for finding feed updates at specific timestamps
 * using epoch-based indexing with parallel chunk fetching.
 */

import { Binary } from "cafe-utility"
import type { Bee, BeeRequestOptions } from "@ethersphere/bee-js"
import { EthAddress, Reference, Topic } from "@ethersphere/bee-js"
import { EpochIndex, MAX_LEVEL } from "./epoch"
import type { EpochFinder, EpochLookupResult } from "./types"
import { downloadEncryptedSOC } from "../../download-data"
import { findPreviousLeaf } from "./utils"

const EPOCH_LOOKUP_TIMEOUT_MS = 2000

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
    private readonly encryptionKey?: Uint8Array,
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
    // Fast path: exact timestamp updates are written at level-0 and should be
    // retrievable without traversing potentially poisoned ancestors.
    const exactEpoch = new EpochIndex(at, 0)
    try {
      const exact = await this.getEpochChunk(at, exactEpoch)
      if (exact) {
        return exact
      }
    } catch {
      // Ignore and fall back to tree traversal.
    }

    // Start from top epoch and traverse down
    const traversed = await this.findAtEpoch(
      at,
      new EpochIndex(0n, MAX_LEVEL),
      undefined,
    )
    if (traversed) {
      return traversed
    }

    // Recovery fallback for poisoned-ancestor histories: only enable bounded
    // leaf back-scan when root epoch exists but is invalid for `at`.
    try {
      const rootProbe = await this.getEpochChunk(
        at,
        new EpochIndex(0n, MAX_LEVEL),
      )
      if (rootProbe === undefined) {
        return this.findPreviousLeaf(at, after)
      }
    } catch {
      // Root missing - no evidence of poisoned ancestors.
    }

    return undefined
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
    // Try to get chunk at this epoch.
    // getEpochChunk throws when chunk is missing, returns undefined when
    // chunk exists but timestamp is invalid for `at`.
    let chunk: Uint8Array | undefined
    try {
      chunk = await this.getEpochChunk(at, epoch)
    } catch (error) {
      // Chunk missing at this epoch.
      if (epoch.isLeft()) {
        return currentBest
      }
      return this.findAtEpoch(epoch.start - 1n, epoch.left(), currentBest)
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

    // Chunk exists but timestamp invalid.
    // Keep descending towards the target epoch first, because finer epochs
    // may still contain a valid update.
    if (epoch.level > 0) {
      const down = await this.findAtEpoch(at, epoch.childAt(at), currentBest)
      if (down) {
        return down
      }
    }

    if (epoch.isLeft()) {
      // Left child - return best we have so far
      return currentBest
    }

    // Right child - need to search left sibling branch
    return this.findAtEpoch(epoch.start - 1n, epoch.left(), currentBest)
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
    const result = await this.getEpochChunkWithMetadata(at, epoch)
    return result?.reference
  }

  /**
   * Find the feed update valid at time `at` with full metadata
   * Used by updater to calculate next epoch when no hints provided
   *
   * @param at - Target unix timestamp (seconds)
   * @returns EpochLookupResult with reference, epoch, and timestamp, or undefined if no update found
   */
  async findAtWithMetadata(at: bigint): Promise<EpochLookupResult | undefined> {
    // Fast path: exact timestamp updates are written at level-0
    const exactEpoch = new EpochIndex(at, 0)
    try {
      const exact = await this.getEpochChunkWithMetadata(at, exactEpoch)
      if (exact) {
        return {
          reference: exact.reference,
          epoch: exactEpoch,
          timestamp: exact.timestamp,
        }
      }
    } catch {
      // Ignore and fall back to tree traversal
    }

    // Start from top epoch and traverse down, tracking found epoch
    return this.findAtEpochWithMetadata(
      at,
      new EpochIndex(0n, MAX_LEVEL),
      undefined,
    )
  }

  /**
   * Recursively find update at epoch with full metadata tracking
   *
   * @param at - Target timestamp
   * @param epoch - Current epoch to check
   * @param currentBest - Best result found so far
   * @returns EpochLookupResult if found, undefined otherwise
   */
  private async findAtEpochWithMetadata(
    at: bigint,
    epoch: EpochIndex,
    currentBest: EpochLookupResult | undefined,
  ): Promise<EpochLookupResult | undefined> {
    // Try to get chunk at this epoch
    let chunkData: { reference: Uint8Array; timestamp: bigint } | undefined
    try {
      chunkData = await this.getEpochChunkWithMetadata(at, epoch)
    } catch (error) {
      // Chunk missing at this epoch
      if (epoch.isLeft()) {
        return currentBest
      }
      return this.findAtEpochWithMetadata(
        epoch.start - 1n,
        epoch.left(),
        currentBest,
      )
    }

    // If chunk found and valid
    if (chunkData) {
      const result: EpochLookupResult = {
        reference: chunkData.reference,
        epoch,
        timestamp: chunkData.timestamp,
      }

      // If at finest resolution, this is our answer
      if (epoch.level === 0) {
        return result
      }

      // Continue to finer resolution
      return this.findAtEpochWithMetadata(at, epoch.childAt(at), result)
    }

    // Chunk exists but timestamp invalid
    // Keep descending towards the target epoch first
    if (epoch.level > 0) {
      const down = await this.findAtEpochWithMetadata(
        at,
        epoch.childAt(at),
        currentBest,
      )
      if (down) {
        return down
      }
    }

    if (epoch.isLeft()) {
      return currentBest
    }

    // Right child - need to search left sibling branch
    return this.findAtEpochWithMetadata(
      epoch.start - 1n,
      epoch.left(),
      currentBest,
    )
  }

  /**
   * Fetch chunk for a specific epoch and return full metadata
   *
   * @param at - Target timestamp for validation
   * @param epoch - Epoch to fetch
   * @returns Object with reference and timestamp, or undefined if timestamp > at
   * @throws Error if chunk not found
   */
  private async getEpochChunkWithMetadata(
    at: bigint,
    epoch: EpochIndex,
  ): Promise<{ reference: Uint8Array; timestamp: bigint } | undefined> {
    const requestOptions: BeeRequestOptions = {
      timeout: EPOCH_LOOKUP_TIMEOUT_MS,
    }
    // Calculate epoch identifier: Keccak256(topic || Keccak256(start || level))
    const epochHash = await epoch.marshalBinary()
    const identifier = Binary.keccak256(
      Binary.concatBytes(this.topic.toUint8Array(), epochHash),
    )

    let payload: Uint8Array
    if (this.encryptionKey) {
      const soc = await downloadEncryptedSOC(
        this.bee,
        this.owner,
        identifier,
        this.encryptionKey,
        requestOptions,
      )
      payload = soc.payload
    } else {
      // Calculate chunk address: Keccak256(identifier || owner)
      const address = new Reference(
        Binary.keccak256(
          Binary.concatBytes(identifier, this.owner.toUint8Array()),
        ),
      )

      // Download chunk
      const chunkData = await this.bee.downloadChunk(
        address.toHex(),
        undefined,
        requestOptions,
      )

      // Extract payload from SOC (Single Owner Chunk)
      const IDENTIFIER_SIZE = 32
      const SIGNATURE_SIZE = 65
      const SPAN_SIZE = 8
      const SOC_HEADER_SIZE = IDENTIFIER_SIZE + SIGNATURE_SIZE

      // Read span to get payload length
      const spanStart = SOC_HEADER_SIZE
      const span = chunkData.slice(spanStart, spanStart + SPAN_SIZE)
      const spanView = new DataView(
        span.buffer,
        span.byteOffset,
        span.byteLength,
      )
      const payloadLength = Number(spanView.getBigUint64(0, true)) // little-endian

      // Extract full payload (timestamp + reference)
      const payloadStart = spanStart + SPAN_SIZE
      payload = chunkData.slice(payloadStart, payloadStart + payloadLength)
    }

    // Detect payload format based on length:
    // - 40 bytes: timestamp(8) + reference(32) - from /soc endpoint
    // - 48 bytes: span(8) + timestamp(8) + reference(32) - from /chunks with v1 format
    // - 72 bytes: timestamp(8) + encrypted_reference(64) - from /soc endpoint
    // - 80 bytes: span(8) + timestamp(8) + encrypted_reference(64) - from /chunks with v1 format
    const VALID_PAYLOAD_LENGTHS = [40, 48, 72, 80]
    if (!VALID_PAYLOAD_LENGTHS.includes(payload.length)) {
      console.warn(
        `Unexpected feed payload length: ${payload.length}. Expected 40, 48, 72, or 80 bytes.`,
      )
      return undefined
    }

    const TIMESTAMP_SIZE = 8
    const hasSpanPrefix = payload.length === 48 || payload.length === 80

    const timestampOffset = hasSpanPrefix ? 8 : 0
    const timestampBytes = payload.slice(
      timestampOffset,
      timestampOffset + TIMESTAMP_SIZE,
    )
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

    // Return reference and timestamp (skip timestamp and optional span prefix)
    return {
      reference: payload.slice(timestampOffset + TIMESTAMP_SIZE),
      timestamp,
    }
  }

  private findPreviousLeaf(
    at: bigint,
    after: bigint,
  ): Promise<Uint8Array | undefined> {
    return findPreviousLeaf(at, after, (targetAt, epoch) =>
      this.getEpochChunk(targetAt, epoch),
    )
  }
}
