// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * TTL (Time To Live) calculation and formatting utilities for postage stamps
 */

/**
 * Gnosis Chain block time in seconds
 */
export const GNOSIS_BLOCK_TIME = 5

/**
 * Blocks per day on Gnosis Chain (24h / 5s block time = 17280). BigInt so it
 * composes with the PLUR-denominated price math in
 * {@link calculateStampAmountForDays} without precision loss.
 */
export const BLOCKS_PER_DAY = (24n * 60n * 60n) / BigInt(GNOSIS_BLOCK_TIME)

/**
 * Time constants
 */
const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR
const SECONDS_PER_MONTH = 30 * SECONDS_PER_DAY // 2,592,000

/**
 * Swarm constants
 */
const PLUR_PER_BZZ = 1e16
const CHUNK_SIZE_BYTES = 4096
const BYTES_PER_GB = 1024 * 1024 * 1024
const CHUNKS_PER_GB = Math.floor(BYTES_PER_GB / CHUNK_SIZE_BYTES) // 262144

/**
 * Swarmscan API URL for price data
 */
export const SWARMSCAN_STATS_URL =
  "https://api.swarmscan.io/v1/postage-stamps/stats"

/**
 * Fetches current price from Swarmscan.
 * @returns pricePerGBPerMonth in BZZ
 */
export async function fetchSwarmPrice(): Promise<number> {
  const response = await fetch(SWARMSCAN_STATS_URL)
  if (!response.ok) {
    throw new Error(`Failed to fetch Swarmscan stats: ${response.status}`)
  }
  const data = await response.json()
  return data.pricePerGBPerMonth
}

/**
 * Calculates TTL in seconds from stamp amount and Swarmscan price.
 *
 * @param amount - Stamp amount in PLUR (smallest BZZ unit)
 * @param pricePerGBPerMonth - Price from Swarmscan (in BZZ)
 * @returns TTL in seconds
 */
export function calculateTTLSeconds(
  amount: bigint | number | string,
  pricePerGBPerMonth: number,
): number {
  const amountBigInt = BigInt(amount)
  // Cost per chunk per month in PLUR
  const perChunkPerMonthCost =
    (pricePerGBPerMonth * PLUR_PER_BZZ) / CHUNKS_PER_GB
  // TTL in months
  const ttlMonths = Number(amountBigInt) / perChunkPerMonthCost
  // TTL in seconds
  return ttlMonths * SECONDS_PER_MONTH
}

/**
 * Formats a TTL value (in seconds) to a human-readable string.
 * Returns "Xd Yh" format (e.g., "30d 14h").
 *
 * @param ttlSeconds - TTL in seconds
 * @returns Human-readable TTL string, or "N/A" if undefined/invalid
 */
export function formatTTL(ttlSeconds: number | undefined): string {
  if (ttlSeconds === undefined || ttlSeconds <= 0) {
    return "N/A"
  }

  const days = Math.floor(ttlSeconds / SECONDS_PER_DAY)
  const hours = Math.floor((ttlSeconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR)

  return `${days}d ${hours}h`
}

/**
 * Fetches block timestamp from Gnosis RPC.
 *
 * @param rpcUrl - Gnosis RPC URL
 * @param blockNumber - Block number to get timestamp for
 * @returns Block timestamp in seconds (Unix timestamp)
 */
export async function getBlockTimestamp(
  rpcUrl: string,
  blockNumber: number,
): Promise<number> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_getBlockByNumber",
      params: [`0x${blockNumber.toString(16)}`, false],
      id: 1,
    }),
  })

  const data = await response.json()
  if (data.error) {
    throw new Error(`RPC error: ${data.error.message}`)
  }
  if (!data.result) {
    throw new Error(`Block ${blockNumber} not found`)
  }

  return parseInt(data.result.timestamp, 16)
}

/**
 * Calculates expiry timestamp for a postage stamp.
 *
 * @param blockTimestamp - Timestamp when stamp was created (from blockNumber)
 * @param ttlSeconds - TTL in seconds
 * @returns Expiry timestamp in seconds (Unix timestamp)
 */
export function calculateExpiryTimestamp(
  blockTimestamp: number,
  ttlSeconds: number,
): number {
  return blockTimestamp + ttlSeconds
}

/**
 * Snapshot of Bee's view of the chain, from `GET /chainstate`.
 *
 * `currentPrice` is PLUR per chunk per block — the per-block storage rent rate
 * Bee charges against a stamp's deposit. Bee returns it as a decimal string
 * because Gnosis prices can exceed `Number.MAX_SAFE_INTEGER` on high-traffic
 * chains, so we keep it BigInt all the way through to the stamp-amount math.
 */
export interface ChainState {
  block: number
  currentPrice: bigint
}

/**
 * Fetches the current chain state (block + per-chunk-per-block price) from a
 * Bee node. Used to size new stamp amounts: Bee rejects `POST /stamps` calls
 * whose amount does not cover at least 24h of storage at `currentPrice`.
 *
 * @param beeUrl - Bee node URL
 * @returns Parsed chain state with `currentPrice` as BigInt
 * @throws if the request fails, returns non-OK, or omits required fields.
 *         Callers (e.g. the dev page) surface this directly to the user.
 */
export async function fetchChainState(beeUrl: string): Promise<ChainState> {
  const base = beeUrl.replace(/\/$/, "")
  const response = await fetch(`${base}/chainstate`)
  if (!response.ok) {
    throw new Error(`Failed to fetch chainstate: HTTP ${response.status}`)
  }
  const data: unknown = await response.json()
  if (typeof data !== "object" || data === null) {
    throw new Error("Invalid chainstate response")
  }
  const obj = data as { block?: unknown; currentPrice?: unknown }
  if (typeof obj.block !== "number") {
    throw new Error("chainstate response missing block")
  }
  // Require a string. Bee always serialises currentPrice as a decimal string
  // because high-traffic chains can exceed Number.MAX_SAFE_INTEGER (2^53), and
  // JSON.parse rounds anything above that *before* we get a chance to widen it
  // to BigInt — so accepting a `number` here would silently corrupt the price
  // and defeat the precision the rest of this module guarantees.
  if (typeof obj.currentPrice !== "string") {
    throw new Error(
      "chainstate response missing or non-string currentPrice (got " +
        typeof obj.currentPrice +
        ")",
    )
  }
  return {
    block: obj.block,
    currentPrice: BigInt(obj.currentPrice),
  }
}

/**
 * Minimum stamp amount (PLUR per chunk) that covers `days` days of validity
 * at the given per-block price. Bee enforces a 24h floor on `POST /stamps`, so
 * passing `days = 1` returns the exact minimum that will be accepted.
 *
 * @param currentPrice - Per-chunk-per-block price in PLUR (from {@link fetchChainState})
 * @param days - Positive integer number of days of validity to fund
 * @returns Amount in PLUR per chunk, or `0n` for non-positive / non-integer inputs
 */
export function calculateStampAmountForDays(
  currentPrice: bigint,
  days: number,
): bigint {
  if (currentPrice <= 0n || !Number.isInteger(days) || days <= 0) {
    return 0n
  }
  return currentPrice * BLOCKS_PER_DAY * BigInt(days)
}
