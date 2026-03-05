/**
 * Synchronous Epoch Feed Finder
 *
 * Recursive implementation for finding feed updates at specific timestamps
 * using epoch-based indexing.
 */

import { Binary } from "cafe-utility"
import type { Bee, BeeRequestOptions } from "@ethersphere/bee-js"
import { EthAddress, Reference, Topic } from "@ethersphere/bee-js"
import { EpochIndex, lca, MAX_LEVEL } from "./epoch"
import type { EpochFinder } from "./types"
import { findPreviousLeaf } from "./utils"

const EPOCH_LOOKUP_TIMEOUT_MS = 2000

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
    // Fast path: exact timestamp updates are written at level-0 and should be
    // retrievable without traversing potentially poisoned ancestors.
    const exactEpoch = new EpochIndex(at, 0)
    try {
      const exact = await this.getEpochChunk(at, exactEpoch)
      if (exact) {
        return exact
      }
    } catch {
      // Ignore and fall back to standard traversal.
    }

    const { epoch, chunk } = await this.common(at, after)

    if (!chunk && epoch.level === MAX_LEVEL) {
      // No update found at all
      return undefined
    }

    const traversed = await this.atEpoch(at, epoch, chunk)
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
      if (epoch.level > 0) {
        const down = await this.atEpoch(at, epoch.childAt(at), currentChunk)
        if (down) {
          return down
        }
      }
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
    const requestOptions: BeeRequestOptions = {
      timeout: EPOCH_LOOKUP_TIMEOUT_MS,
    }
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
    const chunkData = await this.bee.downloadChunk(
      address.toHex(),
      undefined,
      requestOptions,
    )

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

    // Return reference only (skip timestamp and optional span prefix)
    return payload.slice(timestampOffset + TIMESTAMP_SIZE)
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
