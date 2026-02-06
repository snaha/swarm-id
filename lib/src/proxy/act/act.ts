/**
 * ACT (Access Control Tries) Data Structure
 *
 * Bee-compatible Simple Manifest (JSON) format for storing ACT entries.
 * The ACT stores lookup key -> encrypted access key mappings.
 *
 * Bee's ACT format is a Simple Manifest with structure:
 * {
 *   "entries": {
 *     "<lookupKeyHex>": {
 *       "reference": "<encryptedAccessKeyHex>",
 *       "metadata": {}
 *     }
 *   }
 * }
 *
 * All other data (publisher public key, encrypted reference, grantee list)
 * is stored separately and passed out-of-band.
 */

import { hexToUint8Array, uint8ArrayToHex } from "../../utils/hex"

/**
 * Single ACT entry: lookup key + encrypted access key
 */
export interface ActEntry {
  lookupKey: Uint8Array // 32 bytes
  encryptedAccessKey: Uint8Array // 32 bytes
}

/**
 * Bee's Simple Manifest entry format
 */
interface SimpleManifestEntry {
  reference: string
  metadata?: Record<string, string>
}

/**
 * Bee's Simple Manifest format for ACT
 */
interface SimpleManifest {
  entries: Record<string, SimpleManifestEntry>
}

/**
 * Serialize ACT entries to JSON bytes (Bee-compatible Simple Manifest format)
 *
 * @param entries - Array of ACT entries
 * @returns JSON-encoded bytes
 */
export function serializeAct(entries: ActEntry[]): Uint8Array {
  const manifest: SimpleManifest = {
    entries: {},
  }

  for (const entry of entries) {
    // Path is the hex-encoded lookup key (64 chars)
    const path = uint8ArrayToHex(entry.lookupKey)
    // Reference is the hex-encoded encrypted access key (64 chars)
    manifest.entries[path] = {
      reference: uint8ArrayToHex(entry.encryptedAccessKey),
      metadata: {},
    }
  }

  const json = JSON.stringify(manifest)
  return new TextEncoder().encode(json)
}

/**
 * Deserialize ACT entries from JSON bytes (Bee-compatible Simple Manifest format)
 *
 * @param data - JSON-encoded bytes
 * @returns Array of ACT entries
 */
export function deserializeAct(data: Uint8Array): ActEntry[] {
  const json = new TextDecoder().decode(data)
  const manifest: SimpleManifest = JSON.parse(json)

  const entries: ActEntry[] = []

  for (const [path, entry] of Object.entries(manifest.entries)) {
    entries.push({
      lookupKey: hexToUint8Array(path),
      encryptedAccessKey: hexToUint8Array(entry.reference),
    })
  }

  return entries
}

/**
 * Find an ACT entry by lookup key
 *
 * @param entries - Array of ACT entries
 * @param lookupKey - 32-byte lookup key
 * @returns The entry if found, undefined otherwise
 */
export function findEntryByLookupKey(
  entries: ActEntry[],
  lookupKey: Uint8Array,
): ActEntry | undefined {
  return entries.find((entry) => {
    if (entry.lookupKey.length !== lookupKey.length) return false
    for (let i = 0; i < lookupKey.length; i++) {
      if (entry.lookupKey[i] !== lookupKey[i]) return false
    }
    return true
  })
}

/**
 * Check if two public keys are equal
 */
export function publicKeysEqual(
  a: { x: Uint8Array; y: Uint8Array },
  b: { x: Uint8Array; y: Uint8Array },
): boolean {
  if (a.x.length !== b.x.length || a.y.length !== b.y.length) return false
  for (let i = 0; i < a.x.length; i++) {
    if (a.x[i] !== b.x[i]) return false
  }
  for (let i = 0; i < a.y.length; i++) {
    if (a.y[i] !== b.y[i]) return false
  }
  return true
}

/**
 * Helper to collect all ACT entries from JSON-encoded ACT data
 *
 * This is a convenience function for working with JSON ACT data directly from storage.
 *
 * @param actData - JSON-encoded ACT data from storage
 * @returns Array of ACT entries
 */
export function collectActEntriesFromJson(actData: Uint8Array): ActEntry[] {
  return deserializeAct(actData)
}

/**
 * Helper to find an ACT entry by lookup key from JSON-encoded ACT data
 *
 * This is a convenience function for working with JSON ACT data directly from storage.
 *
 * @param actData - JSON-encoded ACT data from storage
 * @param lookupKey - 32-byte lookup key to search for
 * @returns The encrypted access key if found, undefined otherwise
 */
export function findActEntryByKey(
  actData: Uint8Array,
  lookupKey: Uint8Array,
): Uint8Array | undefined {
  const entries = deserializeAct(actData)
  const entry = findEntryByLookupKey(entries, lookupKey)
  return entry?.encryptedAccessKey
}
