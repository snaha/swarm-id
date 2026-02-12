/**
 * TTL (Time To Live) calculation and formatting utilities for postage stamps
 */
/**
 * Gnosis Chain block time in seconds
 */
export declare const GNOSIS_BLOCK_TIME = 5;
/**
 * Swarmscan API URL for price data
 */
export declare const SWARMSCAN_STATS_URL = "https://api.swarmscan.io/v1/postage-stamps/stats";
/**
 * Fetches current price from Swarmscan.
 * @returns pricePerGBPerMonth in BZZ
 */
export declare function fetchSwarmPrice(): Promise<number>;
/**
 * Calculates TTL in seconds from stamp amount and Swarmscan price.
 *
 * @param amount - Stamp amount in PLUR (smallest BZZ unit)
 * @param pricePerGBPerMonth - Price from Swarmscan (in BZZ)
 * @returns TTL in seconds
 */
export declare function calculateTTLSeconds(amount: bigint | number | string, pricePerGBPerMonth: number): number;
/**
 * Formats a TTL value (in seconds) to a human-readable string.
 * Returns "Xd Yh" format (e.g., "30d 14h").
 *
 * @param ttlSeconds - TTL in seconds
 * @returns Human-readable TTL string, or "N/A" if undefined/invalid
 */
export declare function formatTTL(ttlSeconds: number | undefined): string;
/**
 * Fetches block timestamp from Gnosis RPC.
 *
 * @param rpcUrl - Gnosis RPC URL
 * @param blockNumber - Block number to get timestamp for
 * @returns Block timestamp in seconds (Unix timestamp)
 */
export declare function getBlockTimestamp(rpcUrl: string, blockNumber: number): Promise<number>;
/**
 * Calculates expiry timestamp for a postage stamp.
 *
 * @param blockTimestamp - Timestamp when stamp was created (from blockNumber)
 * @param ttlSeconds - TTL in seconds
 * @returns Expiry timestamp in seconds (Unix timestamp)
 */
export declare function calculateExpiryTimestamp(blockTimestamp: number, ttlSeconds: number): number;
//# sourceMappingURL=ttl.d.ts.map