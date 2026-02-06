/**
 * ACT History Management
 *
 * This module provides timestamped versioning of ACT entries, matching Bee's
 * approach to tracking ACT versions over time.
 *
 * Key concepts:
 * - Each ACT update creates a new history entry
 * - Entries are keyed by reversed timestamp (MaxInt64 - timestamp)
 * - History enables looking up ACT state at any point in time
 * - Encrypted grantee list reference is stored in metadata
 *
 * Bee's History format uses Mantaray manifests. This implementation uses a
 * simplified JSON manifest for initial compatibility, with the same semantics.
 */

// Constants
const MAX_INT64 = BigInt("9223372036854775807")

/**
 * Single history entry metadata
 */
export interface HistoryEntryMetadata {
  actReference: string // Reference to the ACT manifest
  encryptedGranteeListRef?: string // Reference to encrypted grantee list (publisher only)
}

/**
 * History entry with timestamp
 */
export interface HistoryEntry {
  timestamp: number // Unix timestamp in seconds
  metadata: HistoryEntryMetadata
}

/**
 * History manifest - stores all ACT versions
 *
 * Format matches Bee's history structure but uses JSON instead of Mantaray.
 * Keys are reversed timestamps (stringified BigInt), values are entry metadata.
 */
export interface HistoryManifest {
  // Map of reversed timestamp key -> entry metadata
  entries: Record<string, HistoryEntryMetadata>
}

/**
 * Calculate reversed timestamp key for history lookup
 *
 * Bee uses reversed timestamps so that the latest entry sorts first.
 * Key = MaxInt64 - timestamp
 *
 * @param timestamp - Unix timestamp in seconds
 * @returns Reversed timestamp as string (for use as map key)
 */
export function calculateReversedTimestamp(timestamp: number): string {
  const reversed = MAX_INT64 - BigInt(timestamp)
  return reversed.toString()
}

/**
 * Calculate original timestamp from reversed key
 *
 * @param reversedKey - Reversed timestamp string
 * @returns Original Unix timestamp in seconds
 */
export function calculateOriginalTimestamp(reversedKey: string): number {
  const reversed = BigInt(reversedKey)
  const original = MAX_INT64 - reversed
  return Number(original)
}

/**
 * Create a new empty history manifest
 */
export function createHistoryManifest(): HistoryManifest {
  return { entries: {} }
}

/**
 * Add an entry to the history manifest
 *
 * @param manifest - Existing history manifest
 * @param timestamp - Unix timestamp for this entry
 * @param actReference - Reference to the ACT manifest
 * @param encryptedGranteeListRef - Optional reference to encrypted grantee list
 * @returns Updated history manifest
 */
export function addHistoryEntry(
  manifest: HistoryManifest,
  timestamp: number,
  actReference: string,
  encryptedGranteeListRef?: string,
): HistoryManifest {
  const key = calculateReversedTimestamp(timestamp)
  const metadata: HistoryEntryMetadata = {
    actReference,
    ...(encryptedGranteeListRef && { encryptedGranteeListRef }),
  }

  return {
    entries: {
      ...manifest.entries,
      [key]: metadata,
    },
  }
}

/**
 * Get the latest history entry (most recent timestamp)
 *
 * Since keys are reversed timestamps, the smallest key is the latest entry.
 *
 * @param manifest - History manifest
 * @returns Latest entry with its timestamp, or undefined if empty
 */
export function getLatestEntry(
  manifest: HistoryManifest,
): HistoryEntry | undefined {
  const keys = Object.keys(manifest.entries)
  if (keys.length === 0) {
    return undefined
  }

  // Sort keys ascending (smallest first = latest timestamp)
  keys.sort()
  const latestKey = keys[0]
  const metadata = manifest.entries[latestKey]

  return {
    timestamp: calculateOriginalTimestamp(latestKey),
    metadata,
  }
}

/**
 * Get entry at or before a specific timestamp
 *
 * This finds the ACT state that was valid at the given timestamp.
 *
 * @param manifest - History manifest
 * @param timestamp - Target timestamp
 * @returns Entry at or before timestamp, or undefined if none exists
 */
export function getEntryAtTimestamp(
  manifest: HistoryManifest,
  timestamp: number,
): HistoryEntry | undefined {
  const targetKey = calculateReversedTimestamp(timestamp)

  // Get all keys and sort ascending
  const keys = Object.keys(manifest.entries).sort()

  // Find the first key >= targetKey (which corresponds to timestamp <= target)
  for (const key of keys) {
    if (key >= targetKey) {
      const metadata = manifest.entries[key]
      return {
        timestamp: calculateOriginalTimestamp(key),
        metadata,
      }
    }
  }

  // If no entry at or before timestamp, return the oldest entry
  // (this is the "first" ACT state)
  if (keys.length > 0) {
    const oldestKey = keys[keys.length - 1]
    return {
      timestamp: calculateOriginalTimestamp(oldestKey),
      metadata: manifest.entries[oldestKey],
    }
  }

  return undefined
}

/**
 * Get all history entries sorted by timestamp (newest first)
 *
 * @param manifest - History manifest
 * @returns Array of entries sorted newest first
 */
export function getAllEntries(manifest: HistoryManifest): HistoryEntry[] {
  const keys = Object.keys(manifest.entries).sort()

  return keys.map((key) => ({
    timestamp: calculateOriginalTimestamp(key),
    metadata: manifest.entries[key],
  }))
}

/**
 * Serialize history manifest to JSON bytes
 *
 * @param manifest - History manifest
 * @returns Serialized manifest as Uint8Array
 */
export function serializeHistory(manifest: HistoryManifest): Uint8Array {
  const json = JSON.stringify(manifest)
  return new TextEncoder().encode(json)
}

/**
 * Deserialize history manifest from JSON bytes
 *
 * @param data - Serialized manifest
 * @returns Parsed history manifest
 */
export function deserializeHistory(data: Uint8Array): HistoryManifest {
  const json = new TextDecoder().decode(data)
  return JSON.parse(json) as HistoryManifest
}

/**
 * Get current Unix timestamp in seconds
 */
export function getCurrentTimestamp(): number {
  return Math.floor(Date.now() / 1000)
}
