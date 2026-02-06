/**
 * ACT (Access Control Tries) Data Structure
 *
 * Bee-compatible JSON manifest format for storing ACT entries.
 * The ACT only stores lookup key -> encrypted access key mappings.
 * All other data (publisher public key, encrypted reference, grantee list)
 * is stored separately and passed out-of-band.
 */

/**
 * Single ACT entry: lookup key + encrypted access key
 */
export interface ActEntry {
  lookupKey: Uint8Array // 32 bytes
  encryptedAccessKey: Uint8Array // 32 bytes
}

/**
 * Bee-compatible ACT manifest (JSON format)
 *
 * This matches Bee's ACT format:
 * ```json
 * {
 *   "entries": {
 *     "<lookupKeyHex>": {
 *       "reference": "<encryptedAccessKeyHex>",
 *       "metadata": {}
 *     }
 *   }
 * }
 * ```
 */
export interface BeeActManifest {
  entries: Record<
    string,
    { reference: string; metadata: Record<string, string> }
  >
}

/**
 * Convert Uint8Array to hex string
 */
function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Convert hex string to Uint8Array
 */
function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return bytes
}

/**
 * Serialize ACT entries to Bee-compatible JSON manifest format
 *
 * This is the format used by Bee for ACT storage. The manifest only contains
 * the lookup key -> encrypted access key mappings.
 */
export function serializeAct(entries: ActEntry[]): Uint8Array {
  const manifest: BeeActManifest = { entries: {} }

  for (const entry of entries) {
    const lookupKeyHex = uint8ArrayToHex(entry.lookupKey)
    const encAccessKeyHex = uint8ArrayToHex(entry.encryptedAccessKey)
    manifest.entries[lookupKeyHex] = {
      reference: encAccessKeyHex,
      metadata: {},
    }
  }

  return new TextEncoder().encode(JSON.stringify(manifest))
}

/**
 * Deserialize ACT entries from Bee-compatible JSON manifest format
 */
export function deserializeAct(data: Uint8Array): ActEntry[] {
  const json = new TextDecoder().decode(data)
  const manifest: BeeActManifest = JSON.parse(json)

  return Object.entries(manifest.entries).map(([lookupKeyHex, entry]) => ({
    lookupKey: hexToUint8Array(lookupKeyHex),
    encryptedAccessKey: hexToUint8Array(entry.reference),
  }))
}

/**
 * Find an ACT entry by lookup key
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
