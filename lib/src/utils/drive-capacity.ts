// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Drive capacity: used, left and size, from a partition's per-bucket counters.
 *
 * A save fails as soon as one of its chunks hashes into a bucket whose
 * partition lane is full; the stamper never moves a chunk elsewhere. Chunk
 * addresses are uniform, so how much still fits is a probability, not a
 * number: `N` more chunks fit when every bucket receives no more than its
 * headroom. Each bucket's share of `N` is Poisson with mean `N / NUM_BUCKETS`,
 * and the buckets are treated as independent, so
 *
 *   P(fit N) = Π_b PoissonCDF(headroom_b; N / NUM_BUCKETS)
 *
 * Buckets with the same headroom share a factor, so this costs one pass over
 * the distinct headroom values. Independence overstates the fit a little, as
 * one bucket's chunks are another's missing ones, and the Poisson marginals
 * understate it a little; at 65,536 buckets both are small. Sizes are in
 * payload bytes: the chunk tree's intermediate chunks and a save's own extra
 * chunks are already taken off.
 */

import {
  CHUNK_SIZE,
  NUM_BUCKETS,
  PARTITION_COUNT,
  partitionCapacity,
} from "./batch-utilization"
import {
  ENCRYPTED_REFS_PER_CHUNK,
  PLAIN_REFS_PER_CHUNK,
  estimateTotalChunks,
} from "../proxy/chunking"
import type { DriveCapacity, PartitionCapacity } from "../types"

/**
 * The fit probability `leftBytes` and `sizeBytes` are reported at. The
 * effective volumes bee-js prices drives by (the Swarm docs table) sit at
 * this point of the same model, so an empty partition's size is the volume a
 * drive is sold as.
 */
export const DEFAULT_FIT_CONFIDENCE = 0.999

/**
 * Chunks a save writes beyond its content's tree: a manifest's nodes and a
 * feed update. Only noticeable for small saves.
 */
export const SAVE_OVERHEAD_CHUNKS = 4

/** Buckets per headroom: how many more chunks each bucket still takes */
export type HeadroomHistogram = ReadonlyMap<number, number>

/** `chunksThatFit` for an empty partition, per `<depth>:<partitions>:<confidence>` */
const emptyPartitionChunks = new Map<string, number>()

export interface CapacityOptions {
  /** Fit probability the byte figures are reported at */
  confidence?: number
  partitionCount?: number
  /** Whether the saves are encrypted, which halves the tree's fan-out */
  encrypt?: boolean
}

/** Every chunk a save of `bytes` writes */
export function chunksForBytes(bytes: number, encrypt = true): number {
  return (
    estimateTotalChunks(
      bytes,
      encrypt ? ENCRYPTED_REFS_PER_CHUNK : PLAIN_REFS_PER_CHUNK,
    ) + SAVE_OVERHEAD_CHUNKS
  )
}

/** The largest save, in bytes, that writes at most `chunks` chunks */
export function bytesForChunks(chunks: number, encrypt = true): number {
  if (chunks < chunksForBytes(0, encrypt)) {
    return 0
  }
  // `chunksForBytes` grows with the leaf count, so search on whole leaves
  let low = 1
  let high = chunks
  while (low < high) {
    const leaves = Math.ceil((low + high) / 2)
    if (chunksForBytes(leaves * CHUNK_SIZE, encrypt) <= chunks) {
      low = leaves
    } else {
      high = leaves - 1
    }
  }
  return low * CHUNK_SIZE
}

/**
 * Buckets grouped by headroom in one partition's lane. A counter past the
 * lane's capacity, as a scratch drive's wraps to, counts as no headroom.
 */
export function headroomHistogram(
  dataCounters: Uint32Array,
  depth: number,
  partitionCount: number = PARTITION_COUNT,
): HeadroomHistogram {
  const capacity = Math.max(0, partitionCapacity(depth, partitionCount))
  const histogram = new Map<number, number>()
  for (const counter of dataCounters) {
    const headroom = Math.max(0, capacity - counter)
    histogram.set(headroom, (histogram.get(headroom) ?? 0) + 1)
  }
  return histogram
}

/** The probability that `chunks` more uniformly placed chunks all fit */
export function fitProbability(
  histogram: HeadroomHistogram,
  chunks: number,
): number {
  if (chunks <= 0) {
    return 1
  }
  // The Poisson model lets the total vary around `chunks`, so it would still
  // give a full partition a chance; more chunks than free slots never fit
  if (chunks > totalHeadroom(histogram)) {
    return 0
  }
  let maxHeadroom = 0
  for (const headroom of histogram.keys()) {
    maxHeadroom = Math.max(maxHeadroom, headroom)
  }
  const logCdf = logPoissonCdf(chunks / NUM_BUCKETS, maxHeadroom)
  let logProbability = 0
  for (const [headroom, buckets] of histogram) {
    logProbability += buckets * logCdf[headroom]
  }
  // Rounding in the log-space sum can leave it a hair above 0
  return Math.min(1, Math.exp(logProbability))
}

/** The most chunks that still fit with at least `confidence` probability */
export function chunksThatFit(
  histogram: HeadroomHistogram,
  confidence: number = DEFAULT_FIT_CONFIDENCE,
): number {
  if (!(confidence > 0 && confidence <= 1)) {
    throw new RangeError(`confidence must be in (0, 1], got ${confidence}`)
  }
  let low = 0
  let high = totalHeadroom(histogram)
  while (low < high) {
    const chunks = Math.ceil((low + high) / 2)
    if (fitProbability(histogram, chunks) >= confidence) {
      low = chunks
    } else {
      high = chunks - 1
    }
  }
  return low
}

export function estimatePartitionCapacity(
  partition: number,
  dataCounters: Uint32Array,
  depth: number,
  options: CapacityOptions = {},
): PartitionCapacity {
  const {
    confidence = DEFAULT_FIT_CONFIDENCE,
    partitionCount = PARTITION_COUNT,
    encrypt = true,
  } = options
  const capacity = Math.max(0, partitionCapacity(depth, partitionCount))
  let usedChunks = 0
  for (const counter of dataCounters) {
    usedChunks += Math.min(counter, capacity)
  }
  const sizeBytes = bytesForChunks(
    chunksThatFitEmpty(capacity, depth, partitionCount, confidence),
    encrypt,
  )
  const usedBytes = usedChunks * CHUNK_SIZE
  const current = headroomHistogram(dataCounters, depth, partitionCount)
  // Chunks already placed are no longer a gamble, so the model alone leaves
  // `used + left` above `size`; capped, "left of size" adds up. Once used
  // passes size, left reads 0 while a small save may still fit
  const leftBytes = Math.min(
    bytesForChunks(chunksThatFit(current, confidence), encrypt),
    Math.max(0, sizeBytes - usedBytes),
  )
  return { partition, sizeBytes, usedBytes, leftBytes }
}

function chunksThatFitEmpty(
  capacity: number,
  depth: number,
  partitionCount: number,
  confidence: number,
): number {
  const key = `${depth}:${partitionCount}:${confidence}`
  let chunks = emptyPartitionChunks.get(key)
  if (chunks === undefined) {
    chunks = chunksThatFit(new Map([[capacity, NUM_BUCKETS]]), confidence)
    emptyPartitionChunks.set(key, chunks)
  }
  return chunks
}

/** Every partition's figures, and the drive's as their sums */
export function estimateDriveCapacity(
  partitions: ReadonlyArray<{ partition: number; dataCounters: Uint32Array }>,
  depth: number,
  options: CapacityOptions = {},
): DriveCapacity {
  const figures = partitions.map(({ partition, dataCounters }) =>
    estimatePartitionCapacity(partition, dataCounters, depth, options),
  )
  const sum = (pick: (figure: PartitionCapacity) => number): number =>
    figures.reduce((total, figure) => total + pick(figure), 0)
  return {
    sizeBytes: sum((figure) => figure.sizeBytes),
    usedBytes: sum((figure) => figure.usedBytes),
    leftBytes: sum((figure) => figure.leftBytes),
    partitions: figures,
  }
}

function totalHeadroom(histogram: HeadroomHistogram): number {
  let total = 0
  for (const [headroom, buckets] of histogram) {
    total += headroom * buckets
  }
  return total
}

/** `log P(X ≤ h)` for `X ~ Poisson(lambda)` and every `h` in `[0, maxH]` */
function logPoissonCdf(lambda: number, maxH: number): Float64Array {
  const logCdf = new Float64Array(maxH + 1)
  const logLambda = Math.log(lambda)
  let logTerm = -lambda
  let logSum = logTerm
  logCdf[0] = logSum
  for (let k = 1; k <= maxH; k++) {
    logTerm += logLambda - Math.log(k)
    logSum = logAddExp(logSum, logTerm)
    logCdf[k] = logSum
  }
  return logCdf
}

function logAddExp(a: number, b: number): number {
  const max = Math.max(a, b)
  return max + Math.log1p(Math.exp(-Math.abs(a - b)))
}
