/**
 * TTL (Time To Live) calculation and formatting utilities for postage stamps
 */

/**
 * Gnosis Chain block time in seconds
 */
export const GNOSIS_BLOCK_TIME = 5

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
