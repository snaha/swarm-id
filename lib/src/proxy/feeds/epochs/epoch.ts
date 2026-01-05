/**
 * Epoch-based Feed Indexing
 *
 * Implements time-based indexing using a binary tree structure where each epoch
 * represents a time range with start time and level (0-32).
 *
 * Based on the Swarm Book of Feeds and Bee's epochs implementation.
 */

import { Binary } from "cafe-utility"

/** Maximum epoch level (2^32 seconds ≈ 136 years) */
export const MAX_LEVEL = 32

/**
 * Epoch interface - represents a time slot in the epoch tree
 */
export interface Epoch {
  start: bigint // Unix timestamp (seconds)
  level: number // 0-32, where length = 2^level
}

/**
 * EpochIndex class - implements epoch-based feed indexing
 *
 * Each epoch represents a time range:
 * - start: beginning timestamp of the epoch
 * - level: determines the epoch's time span (2^level seconds)
 *
 * Epochs form a binary tree structure for efficient sparse updates.
 */
export class EpochIndex implements Epoch {
  constructor(
    public readonly start: bigint,
    public readonly level: number,
  ) {
    if (level < 0 || level > MAX_LEVEL) {
      throw new Error(
        `Epoch level must be between 0 and ${MAX_LEVEL}, got ${level}`,
      )
    }
  }

  /**
   * Marshal epoch to binary format for hashing
   * Returns Keccak256 hash of start (8 bytes big-endian) + level (1 byte)
   */
  async marshalBinary(): Promise<Uint8Array> {
    const buffer = new Uint8Array(9)
    const view = new DataView(buffer.buffer)

    // Write start as 8-byte big-endian
    view.setBigUint64(0, this.start, false) // false = big-endian

    // Write level as 1 byte
    buffer[8] = this.level

    return Binary.keccak256(buffer)
  }

  /**
   * Calculate the next epoch for a new update
   * @param last - Timestamp of last update
   * @param at - Timestamp of new update
   */
  next(last: bigint, at: bigint): EpochIndex {
    if (this.start + this.length() > at) {
      return this.childAt(at)
    }
    return lca(at, last).childAt(at)
  }

  /**
   * Calculate epoch length in seconds (2^level)
   */
  length(): bigint {
    return 1n << BigInt(this.level)
  }

  /**
   * Get parent epoch
   * UNSAFE: Do not call on top-level epoch (level 32)
   */
  parent(): EpochIndex {
    const length = this.length() << 1n
    const start = (this.start / length) * length
    return new EpochIndex(start, this.level + 1)
  }

  /**
   * Get left sibling epoch
   * UNSAFE: Do not call on left sibling (when start is aligned to 2*length)
   */
  left(): EpochIndex {
    return new EpochIndex(this.start - this.length(), this.level)
  }

  /**
   * Get child epoch containing timestamp `at`
   * UNSAFE: Do not call with `at` outside this epoch's range
   */
  childAt(at: bigint): EpochIndex {
    const newLevel = this.level - 1
    const length = 1n << BigInt(newLevel)
    let start = this.start

    // If `at` falls in right half, adjust start
    if ((at & length) > 0n) {
      start |= length
    }

    return new EpochIndex(start, newLevel)
  }

  /**
   * Check if this epoch is a left child of its parent
   */
  isLeft(): boolean {
    return (this.start & this.length()) === 0n
  }

  /**
   * String representation: "start/level"
   */
  toString(): string {
    return `${this.start}/${this.level}`
  }
}

/**
 * Calculate Lowest Common Ancestor epoch for two timestamps
 *
 * The LCA is the smallest epoch that contains both `at` and `after`.
 * This is used to find the optimal starting point for feed lookups.
 *
 * @param at - Target timestamp
 * @param after - Reference timestamp (0 if no previous update)
 * @returns LCA epoch
 */
export function lca(at: bigint, after: bigint): EpochIndex {
  // If no previous update, start from top-level epoch
  if (after === 0n) {
    return new EpochIndex(0n, MAX_LEVEL)
  }

  const diff = at - after
  let length = 1n
  let level = 0

  // Find the smallest epoch level where both timestamps fall in different epochs
  // OR at and after are in the same epoch
  while (
    level < MAX_LEVEL &&
    (length < diff || at / length !== after / length)
  ) {
    length <<= 1n
    level++
  }

  // Calculate start of the epoch containing both timestamps
  const start = (after / length) * length

  return new EpochIndex(start, level)
}

/**
 * Helper function to get next epoch for update, handling null previous epoch
 * @param prevEpoch - Previous epoch (null if first update)
 * @param last - Timestamp of last update
 * @param at - Timestamp of new update
 */
export function next(
  prevEpoch: EpochIndex | undefined,
  last: bigint,
  at: bigint,
): EpochIndex {
  if (!prevEpoch) {
    return new EpochIndex(0n, MAX_LEVEL)
  }
  return prevEpoch.next(last, at)
}
