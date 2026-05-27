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
 * Time constants. `SECONDS_PER_MONTH` is BigInt because its only consumer is
 * the BigInt math in {@link calculateTTLSeconds}; the others stay Number
 * because {@link formatTTL} uses them with `Math.floor` / modulo.
 */
const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR
const SECONDS_PER_MONTH = 2_592_000n // 30 * 24 * 60 * 60

/**
 * Swarm constants. `CHUNKS_PER_GB = 1 GiB / 4 KiB chunk`.
 */
const PLUR_DECIMALS = 16 // 1 BZZ = 1e16 PLUR
const CHUNKS_PER_GB = 262_144n // (1024 * 1024 * 1024) / 4096

/**
 * Converts a BZZ amount (possibly fractional) to PLUR as a BigInt.
 *
 * Goes through a fixed-decimal string instead of `bzz * 1e16` to preserve
 * precision: `1e16` exceeds `Number.MAX_SAFE_INTEGER` (2^53), so direct
 * multiplication loses low-order digits for any non-trivial price.
 */
function bzzToPlur(bzz: number): bigint {
  const str = bzz.toFixed(PLUR_DECIMALS)
  const negative = str.startsWith("-")
  const unsigned = negative ? str.slice(1) : str
  const [intPart, decPart = ""] = unsigned.split(".")
  const paddedDec = decPart.padEnd(PLUR_DECIMALS, "0").slice(0, PLUR_DECIMALS)
  const magnitude = BigInt(intPart + paddedDec)
  return negative ? -magnitude : magnitude
}

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
 * Approximates the lifetime of a postage stamp deposit in seconds, assuming
 * the chain's per-block price stays constant at `pricePerGBPerMonth` for the
 * full lifetime. This is the answer to "how long would a stamp with this
 * deposit last at the current price" — not the remaining TTL of an existing
 * stamp (for that, prefer {@link fetchBatchTTL}, which uses live chain state).
 *
 * Uses BigInt math throughout. `pricePerGBPerMonth * 1e16` (PLUR conversion)
 * silently loses precision in Number, since `1e16 > Number.MAX_SAFE_INTEGER`.
 *
 * @param amount - Stamp amount in PLUR (per-chunk)
 * @param pricePerGBPerMonth - Price in BZZ per GiB per month (from Swarmscan)
 * @returns Lifetime in seconds. Returns `0` if the amount or price is
 *          non-positive or the price is not finite — a 0-price chain
 *          technically never expires stamps, but returning 0 keeps callers
 *          inside safe Number range and is the conservative display choice.
 */
export function calculateTTLSeconds(
  amount: bigint | number | string,
  pricePerGBPerMonth: number,
): number {
  if (!Number.isFinite(pricePerGBPerMonth) || pricePerGBPerMonth <= 0) {
    return 0
  }
  const amountBigInt = BigInt(amount)
  if (amountBigInt <= 0n) {
    return 0
  }
  const perChunkPerMonthCost = bzzToPlur(pricePerGBPerMonth) / CHUNKS_PER_GB
  if (perChunkPerMonthCost <= 0n) {
    // Defensive: the chain's PriceOracle enforces a floor of 24_000 PLUR per
    // chunk per block (≈ 0.33 BZZ/GiB/month), so any real Swarmscan response
    // is ~10^10× above the BigInt-truncates-to-zero threshold. This guard
    // only fires for pathological caller input — without it the next line
    // would throw on divide-by-zero.
    return 0
  }
  return Number((amountBigInt * SECONDS_PER_MONTH) / perChunkPerMonthCost)
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

/**
 * Fetches the remaining batchTTL (in seconds) for a stamp directly from a Bee
 * node's `/stamps/{batchId}` endpoint. The Bee node computes this from current
 * chain state (per-block price and cumulative outpayment), so it is more
 * accurate than the constant-price approximation in {@link calculateTTLSeconds}.
 *
 * @param beeUrl - Bee node URL
 * @param batchId - Hex-encoded batch ID (without `0x` prefix)
 * @returns Remaining TTL in seconds, or `undefined` if the Bee node does not
 *          know about this batch or the request fails. Negative values from
 *          the Bee API are normalised to `0` (expired).
 */
export async function fetchBatchTTL(
  beeUrl: string,
  batchId: string,
): Promise<number | undefined> {
  try {
    const base = beeUrl.replace(/\/$/, "")
    const response = await fetch(`${base}/stamps/${batchId}`)
    if (!response.ok) {
      return undefined
    }
    const data: unknown = await response.json()
    if (typeof data !== "object" || data === null) {
      return undefined
    }
    const ttl = (data as { batchTTL?: unknown }).batchTTL
    if (typeof ttl !== "number") {
      return undefined
    }
    return ttl < 0 ? 0 : ttl
  } catch {
    return undefined
  }
}
