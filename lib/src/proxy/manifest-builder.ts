import { Reference, MantarayNode, NULL_ADDRESS } from "@ethersphere/bee-js"
import { makeContentAddressedChunk } from "../chunk"
import { hexToUint8Array } from "../utils/hex"

/**
 * Mantaray v0.2 version hash (31 bytes).
 * From bee-js: the first 31 bytes of keccak256("mantaray:0.2")
 */
const MANTARAY_VERSION_HASH = new Uint8Array([
  0x57, 0x68, 0xb3, 0xb6, 0xa7, 0xdb, 0x56, 0xd2, 0x1d, 0x1a, 0xbf, 0xf4, 0x0d,
  0x41, 0xce, 0xbf, 0xc8, 0x34, 0x48, 0xfe, 0xd8, 0xd7, 0xe9, 0xb0, 0x6e, 0xc0,
  0xd3, 0xb0, 0x73, 0xf2, 0x8f,
])

/**
 * Fork flags for Mantaray format.
 */
const FORK_FLAG_VALUE_TYPE = 0x02 // TYPE_VALUE: has targetAddress (matches bee-js)
const FORK_FLAG_HAS_METADATA = 0x10 // TYPE_WITH_METADATA: has metadata bytes (matches bee-js)

/**
 * Result of building a /bzz/-compatible manifest.
 *
 * This is a FLAT manifest with no child nodes - just the root manifest.
 * Bee's /bzz/ endpoint can directly resolve paths from this structure.
 *
 * IMPORTANT: The `data` field contains RAW manifest bytes (without span prefix).
 * When uploaded via `uploadData()`, span will be added and the resulting address
 * will match the pre-computed `address` field.
 */
export interface BzzCompatibleManifestResult {
  /** The manifest chunk to upload. Raw bytes, no span. */
  manifestChunk: {
    data: Uint8Array
    address: string
  }
}

/**
 * Build a /bzz/-compatible flat manifest with VALUE forks.
 *
 * Creates a flat manifest with two VALUE forks at root level:
 * - "/" → VALUE fork with website-index-document metadata pointing to NULL
 * - "index.bin" → VALUE fork pointing directly to content reference
 *
 * This is built manually because bee-js MantarayNode always creates EDGE forks
 * with child nodes, which causes Bee to fail to resolve the content.
 *
 * When Bee accesses /bzz/manifest/:
 * 1. Finds "/" fork, reads website-index-document metadata
 * 2. Looks up "index.bin" fork at root level
 * 3. "index.bin" is VALUE type → serves content directly
 *
 * Binary format (Mantaray v0.2):
 * - obfuscationKey (32 bytes): All zeros for no obfuscation
 * - versionHash (31 bytes): MANTARAY_VERSION_HASH
 * - refBytesCount (1 byte): 32
 * - entry (32 bytes): All zeros (root has no entry)
 * - indexBitmap (32 bytes): Bits set for '/' (47) and 'i' (105)
 * - fork1 (64+ bytes): "/" fork with metadata
 * - fork2 (64+ bytes): "index.bin" fork with metadata
 *
 * @param contentReference - Reference to the actual content (32 bytes / 64 hex chars)
 * @returns Single manifest chunk to upload
 */
export async function buildBzzCompatibleManifest(
  contentReference: string | Uint8Array,
): Promise<BzzCompatibleManifestResult> {
  const refBytes =
    contentReference instanceof Uint8Array
      ? contentReference
      : new Reference(contentReference).toUint8Array()

  if (refBytes.length !== 32) {
    throw new Error(
      `Invalid content reference length: ${refBytes.length} (expected 32 bytes)`,
    )
  }

  // Prepare metadata JSON for both forks
  const slashMetadata =
    JSON.stringify({ "website-index-document": "index.bin" }) + "\n"
  const indexMetadata =
    JSON.stringify({
      "Content-Type": "application/octet-stream",
      Filename: "index.bin",
    }) + "\n"

  const slashMetadataBytes = new TextEncoder().encode(slashMetadata)
  const indexMetadataBytes = new TextEncoder().encode(indexMetadata)

  // Calculate sizes
  // Header: 32 + 31 + 1 + 32 + 32 = 128 bytes
  // Fork "/" : flags(1) + prefixLen(1) + prefix(30) + reference(32) + metaLen(2) + meta
  // Fork "index.bin": flags(1) + prefixLen(1) + prefix(30) + reference(32) + metaLen(2) + meta
  const HEADER_SIZE = 128
  const FORK_BASE_SIZE = 66 // 1 + 1 + 30 + 32 + 2
  const TOTAL_SIZE =
    HEADER_SIZE +
    FORK_BASE_SIZE +
    slashMetadataBytes.length +
    FORK_BASE_SIZE +
    indexMetadataBytes.length

  const manifest = new Uint8Array(TOTAL_SIZE)
  let offset = 0

  // 1. Obfuscation key (32 bytes) - all zeros for no obfuscation
  offset += 32

  // 2. Version hash (31 bytes)
  manifest.set(MANTARAY_VERSION_HASH, offset)
  offset += 31

  // 3. refBytesCount (1 byte) - 32 for standard reference size
  manifest[offset] = 32
  offset += 1

  // 4. Entry (32 bytes) - all zeros for root node
  offset += 32

  // 5. Index bitmap (32 bytes)
  // Bit 47 set for '/' and bit 105 set for 'i' (start of "index.bin")
  // Byte 47/8 = 5, bit 47%8 = 7 → byte 5 = 0x80
  // Byte 105/8 = 13, bit 105%8 = 1 → byte 13 = 0x02
  manifest[offset + 5] = 0x80 // '/' at position 47
  manifest[offset + 13] = 0x02 // 'i' at position 105
  offset += 32

  // Forks are ordered by their first byte value
  // '/' = 47 comes before 'i' = 105

  // 6. Fork entry for '/' (first because 47 < 105)
  // Flags: TYPE_WITH_METADATA only (0x10) - NO VALUE since reference is NULL
  // The "/" fork is just a metadata carrier for website-index-document
  manifest[offset] = FORK_FLAG_HAS_METADATA
  offset += 1

  // Prefix length
  manifest[offset] = 1
  offset += 1

  // Prefix (30 bytes padded)
  manifest[offset] = 0x2f // '/'
  offset += 30

  // Reference (32 bytes) - NULL_ADDRESS (all zeros) because "/" just has metadata
  // Already zeros, just advance
  offset += 32

  // Metadata length (2 bytes big-endian)
  manifest[offset] = (slashMetadataBytes.length >> 8) & 0xff
  manifest[offset + 1] = slashMetadataBytes.length & 0xff
  offset += 2

  // Metadata content
  manifest.set(slashMetadataBytes, offset)
  offset += slashMetadataBytes.length

  // 7. Fork entry for 'index.bin'
  // Flags: TYPE_VALUE (0x02) + TYPE_WITH_METADATA (0x10) = 0x12
  manifest[offset] = FORK_FLAG_VALUE_TYPE | FORK_FLAG_HAS_METADATA
  offset += 1

  // Prefix length - "index.bin" = 9 characters
  manifest[offset] = 9
  offset += 1

  // Prefix (30 bytes padded)
  const indexBinBytes = new TextEncoder().encode("index.bin")
  manifest.set(indexBinBytes, offset)
  offset += 30

  // Reference (32 bytes) - the actual content reference
  manifest.set(refBytes, offset)
  offset += 32

  // Metadata length (2 bytes big-endian)
  manifest[offset] = (indexMetadataBytes.length >> 8) & 0xff
  manifest[offset + 1] = indexMetadataBytes.length & 0xff
  offset += 2

  // Metadata content
  manifest.set(indexMetadataBytes, offset)
  offset += indexMetadataBytes.length

  // Calculate manifest address
  const rootChunk = makeContentAddressedChunk(manifest)

  return {
    manifestChunk: {
      data: manifest,
      address: rootChunk.address.toHex(),
    },
  }
}

/**
 * Result of building a /bzz/-compatible MantarayNode manifest.
 */
export interface BzzManifestNodeResult {
  /** The MantarayNode to be uploaded with saveMantarayTreeRecursively */
  manifestNode: MantarayNode
}

/**
 * Build a /bzz/-compatible manifest as a MantarayNode.
 *
 * This function creates a MantarayNode with the proper structure for /bzz/ access:
 * - "/" fork with website-index-document metadata pointing to "index.bin"
 * - "index.bin" fork pointing to the actual content reference
 *
 * IMPORTANT: After calling this function, use saveMantarayTreeRecursively() to
 * upload the manifest. This ensures all child nodes are uploaded bottom-up and
 * their addresses are correctly set from Bee's responses.
 *
 * Usage:
 * ```typescript
 * const { manifestNode } = buildBzzManifestNode(contentReference)
 * const result = await saveMantarayTreeRecursively(manifestNode, async (data, isRoot) => {
 *   const uploadResult = await uploadData(bee, stamper, data, uploadOptions)
 *   return { reference: uploadResult.reference }
 * })
 * // result.rootReference is the /bzz/ compatible manifest address
 * ```
 *
 * @param contentReference - Reference to the actual content (32 bytes / 64 hex chars)
 * @returns MantarayNode ready for upload with saveMantarayTreeRecursively
 */
export function buildBzzManifestNode(
  contentReference: string | Uint8Array,
): BzzManifestNodeResult {
  const refBytes =
    contentReference instanceof Uint8Array
      ? contentReference
      : hexToUint8Array(contentReference)

  if (refBytes.length !== 32) {
    throw new Error(
      `Invalid content reference length: ${refBytes.length} (expected 32 bytes)`,
    )
  }

  const manifest = new MantarayNode()

  // Add "/" fork with website-index-document metadata
  // This tells Bee to look for "index.bin" when accessing the root path
  manifest.addFork("/", NULL_ADDRESS, {
    "website-index-document": "index.bin",
  })

  // Add "index.bin" fork pointing to the actual content
  manifest.addFork("index.bin", refBytes, {
    "Content-Type": "application/octet-stream",
    Filename: "index.bin",
  })

  return { manifestNode: manifest }
}

/**
 * @deprecated Use buildBzzManifestNode() with saveMantarayTreeRecursively() instead.
 * This function manually builds binary format but doesn't upload child nodes,
 * which causes Bee to fail to resolve content via /bzz/.
 */

/**
 * @deprecated Use buildBzzCompatibleManifest() for /bzz/ compatibility.
 * This function creates a manifest that won't work with Bee's /bzz/ endpoint
 * because it embeds the content reference directly in the manifest instead
 * of using the proper two-level structure (root → child → content).
 *
 * Build a minimal mantaray manifest for /bzz/ feed compatibility.
 *
 * This creates a manifest with a single "/" fork pointing to a content reference.
 * The manifest is built manually (not using bee-js MantarayNode.marshal()) because
 * bee-js doesn't embed the targetAddress correctly for value-type nodes.
 *
 * Binary format (Mantaray v0.2):
 * - obfuscationKey (32 bytes): All zeros for no obfuscation
 * - versionHash (31 bytes): MANTARAY_VERSION_HASH
 * - refBytesCount (1 byte): 32 (size of entry reference)
 * - entry (32 bytes): All zeros (root has no entry)
 * - indexBitmap (32 bytes): Bitmap with bit 47 set (for '/')
 * - fork (64+ bytes): flags + prefixLen + prefix(30) + reference(32) + metadata
 *
 * @param contentReference - Reference to the actual content (32 bytes / 64 hex chars)
 * @returns Marshaled manifest bytes
 */
export function buildMinimalManifest(
  contentReference: string | Uint8Array,
): Uint8Array {
  // Normalize reference to Uint8Array
  const refBytes =
    contentReference instanceof Uint8Array
      ? contentReference
      : new Reference(contentReference).toUint8Array()

  if (refBytes.length !== 32) {
    throw new Error(
      `Invalid content reference length: ${refBytes.length} (expected 32 bytes)`,
    )
  }

  // Calculate total size
  // Header: 32 + 31 + 1 + 32 + 32 = 128 bytes
  // Fork: 1 + 1 + 30 + 32 = 64 bytes (no metadata for simplicity)
  // Total: 192 bytes
  const HEADER_SIZE = 128
  const FORK_SIZE = 64
  const TOTAL_SIZE = HEADER_SIZE + FORK_SIZE

  const manifest = new Uint8Array(TOTAL_SIZE)
  let offset = 0

  // 1. Obfuscation key (32 bytes) - all zeros for no obfuscation
  offset += 32

  // 2. Version hash (31 bytes)
  manifest.set(MANTARAY_VERSION_HASH, offset)
  offset += 31

  // 3. refBytesCount (1 byte) - 32 for standard reference size
  manifest[offset] = 32
  offset += 1

  // 4. Entry (32 bytes) - all zeros for root node
  offset += 32

  // 5. Index bitmap (32 bytes) - bit 47 set for '/'
  // Byte index = 47 / 8 = 5, bit position = 47 % 8 = 7 (MSB)
  // So we set byte 5 to 0x80 (bit 7 set)
  manifest[offset + 5] = 0x80
  offset += 32

  // 6. Fork entry for '/'
  // Flags: VALUE_TYPE (reference is the target)
  manifest[offset] = FORK_FLAG_VALUE_TYPE
  offset += 1

  // Prefix length
  manifest[offset] = 1
  offset += 1

  // Prefix (30 bytes padded)
  manifest[offset] = 0x2f // '/'
  offset += 30

  // Reference (32 bytes) - the actual content reference
  manifest.set(refBytes, offset)
  offset += 32

  return manifest
}

/**
 * Maximum CAC payload size for /bzz/ compatible feed uploads.
 *
 * For the /chunks endpoint to detect SOC correctly, total SOC size must be > 4104 bytes.
 * SOC structure: identifier(32) + signature(65) + span(8) + payload(N)
 * For N=4096: total = 32 + 65 + 8 + 4096 = 4201 bytes > 4104 ✓
 */
export const MAX_PADDED_PAYLOAD_SIZE = 4096

/**
 * Pad payload to 4096 bytes for SOC detection by /chunks endpoint.
 *
 * The span field in the CAC contains the actual payload size (before padding),
 * so Bee's joiner will only read the actual data and ignore padding.
 *
 * @param payload - Original payload (must be <= 4096 bytes)
 * @returns Padded payload (exactly 4096 bytes)
 */
export function padPayloadForSOCDetection(payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_PADDED_PAYLOAD_SIZE) {
    throw new Error(
      `Payload too large to pad: ${payload.length} > ${MAX_PADDED_PAYLOAD_SIZE}`,
    )
  }

  if (payload.length === MAX_PADDED_PAYLOAD_SIZE) {
    return payload // Already at max size
  }

  // Create padded buffer with zeros
  const padded = new Uint8Array(MAX_PADDED_PAYLOAD_SIZE)
  padded.set(payload, 0)

  return padded
}

/**
 * Extract content reference from a minimal mantaray manifest.
 *
 * This is the reverse of buildMinimalManifest() - it parses the manifest
 * binary format and extracts the "/" fork's targetAddress.
 *
 * Binary format (Mantaray v0.2):
 * - Offset 0-31: obfuscationKey
 * - Offset 32-62: versionHash (31 bytes)
 * - Offset 63: refBytesCount
 * - Offset 64-95: entry (refBytesCount bytes, assuming 32)
 * - Offset 96-127: indexBitmap
 * - Offset 128+: forks (flags + prefixLen + prefix + reference + metadata)
 *
 * For a minimal manifest with just "/" fork:
 * - Fork flags at offset 128
 * - Prefix length at offset 129
 * - Prefix (30 bytes) at offset 130
 * - Reference (32 bytes) at offset 160
 *
 * @param manifestData - Raw manifest bytes (from feed payload)
 * @returns Content reference as 64 hex characters
 */
export function extractReferenceFromManifest(manifestData: Uint8Array): string {
  // Minimum size check: header (128) + minimal fork (64)
  if (manifestData.length < 192) {
    throw new Error(
      `Manifest too small: ${manifestData.length} bytes (expected at least 192)`,
    )
  }

  // Header offsets (for reference)
  // Offset 0-31: obfuscationKey
  // Offset 32-62: versionHash (31 bytes)
  // Offset 63: refBytesCount
  // Offset 64-95: entry (refBytesCount bytes, assuming 32)
  // Offset 96-127: indexBitmap
  // Offset 128+: forks
  const REF_BYTES_COUNT_OFFSET = 63
  const INDEX_BITMAP_OFFSET = 96
  const FORKS_OFFSET = 128

  // Read refBytesCount to determine entry size
  const refBytesCount = manifestData[REF_BYTES_COUNT_OFFSET]
  if (refBytesCount !== 32) {
    console.warn(
      `[ManifestBuilder] Unexpected refBytesCount: ${refBytesCount} (expected 32)`,
    )
  }

  // Verify "/" fork exists in index bitmap
  // Byte 5, bit 7 should be set for '/' (byte value 47)
  // Bit ordering: value N is at byte N/8, bit N%8
  // So value 47 is at byte 5, bit 7 (mask 0x80)
  const indexBitmap = manifestData.slice(
    INDEX_BITMAP_OFFSET,
    INDEX_BITMAP_OFFSET + 32,
  )
  const slashByteIndex = Math.floor(47 / 8) // = 5
  const slashBitMask = 1 << (47 % 8) // = 0x80

  if ((indexBitmap[slashByteIndex] & slashBitMask) === 0) {
    throw new Error('Manifest does not contain "/" fork')
  }

  // Count forks before "/" to find its offset
  // We need to count all set bits for byte values less than 47
  let forkIndex = 0
  // Count all bits in bytes 0-4
  for (let byte = 0; byte < slashByteIndex; byte++) {
    forkIndex += popcount8(indexBitmap[byte])
  }
  // Count bits in byte 5 for values 40-46 (bits 0-6)
  for (let bit = 0; bit < 47 % 8; bit++) {
    if (indexBitmap[slashByteIndex] & (1 << bit)) {
      forkIndex++
    }
  }

  // Calculate fork offset
  // Each fork is: flags(1) + prefixLen(1) + prefix(30) + reference(32) + metadata(variable)
  // For simplicity, assume all forks before "/" have the same minimal structure
  // In a minimal manifest, "/" should be the first (and only) fork

  let forkOffset = FORKS_OFFSET

  // Skip previous forks if any
  for (let i = 0; i < forkIndex; i++) {
    // Read flags to check if metadata exists
    const flags = manifestData[forkOffset]
    const hasMetadata = (flags & FORK_FLAG_HAS_METADATA) !== 0

    forkOffset += 1 + 1 + 30 + 32 // flags + prefixLen + prefix + reference

    if (hasMetadata) {
      // Read metadata length (2 bytes big-endian)
      const metadataLen =
        (manifestData[forkOffset] << 8) | manifestData[forkOffset + 1]
      forkOffset += 2 + metadataLen
    }
  }

  // Now at the "/" fork
  const prefixLen = manifestData[forkOffset + 1]

  // Verify it's actually "/"
  if (prefixLen !== 1 || manifestData[forkOffset + 2] !== 0x2f) {
    throw new Error(
      `Expected "/" prefix, got length ${prefixLen} and byte 0x${manifestData[forkOffset + 2].toString(16)}`,
    )
  }

  // Reference is at offset: forkOffset + 1 (flags) + 1 (prefixLen) + 30 (prefix) = forkOffset + 32
  const referenceOffset = forkOffset + 32
  const reference = manifestData.slice(referenceOffset, referenceOffset + 32)

  if (isAllZeros(reference)) {
    throw new Error('Manifest "/" fork has zero reference')
  }

  const hexRef = new Reference(reference).toHex()

  return hexRef
}

/**
 * Count number of set bits in a byte (population count).
 */
function popcount8(n: number): number {
  let count = 0
  while (n) {
    count += n & 1
    n >>>= 1
  }
  return count
}

/**
 * Check if a Uint8Array is all zeros.
 */
function isAllZeros(arr: Uint8Array): boolean {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] !== 0) return false
  }
  return true
}

/**
 * Extract entry (targetAddress) from a leaf manifest node.
 *
 * In Mantaray v0.2, leaf nodes store their targetAddress in the entry field
 * (bytes 64-95), not in a fork. This is used for the second level of parsing
 * when using buildBzzCompatibleManifest().
 *
 * Binary format (Mantaray v0.2):
 * - Offset 0-31:   obfuscationKey
 * - Offset 32-62:  versionHash (31 bytes)
 * - Offset 63:     refBytesCount
 * - Offset 64-95:  entry (32 bytes) ← targetAddress for leaf nodes
 * - Offset 96-127: indexBitmap
 * - Offset 128+:   forks
 *
 * @param manifestData - Raw manifest bytes (child chunk data from two-level structure)
 * @returns Content reference as 64 hex characters
 */
export function extractEntryFromManifest(manifestData: Uint8Array): string {
  if (manifestData.length < 96) {
    throw new Error(
      `Manifest too small: ${manifestData.length} bytes (expected at least 96)`,
    )
  }

  const ENTRY_OFFSET = 64
  const entry = manifestData.slice(ENTRY_OFFSET, ENTRY_OFFSET + 32)

  if (isAllZeros(entry)) {
    throw new Error("Manifest entry is zero")
  }

  const hexRef = new Reference(entry).toHex()

  return hexRef
}

/**
 * Extract content reference from a flat /bzz/-compatible manifest.
 *
 * In the flat structure, the manifest has:
 * - "/" fork with NULL_ADDRESS and website-index-document metadata
 * - "index.bin" fork with VALUE type pointing to content reference
 *
 * This function looks for the "index.bin" fork ('i' = ASCII 105) and
 * extracts its reference.
 *
 * @param manifestData - Raw manifest bytes (flat manifest)
 * @returns Content reference as 64 hex characters
 */
export function extractContentFromFlatManifest(
  manifestData: Uint8Array,
): string {
  if (manifestData.length < 192) {
    throw new Error(
      `Manifest too small: ${manifestData.length} bytes (expected at least 192)`,
    )
  }

  const INDEX_BITMAP_OFFSET = 96
  const FORKS_OFFSET = 128

  // Look for 'i' (105) in the index bitmap
  // Byte index = 105 / 8 = 13, bit position = 105 % 8 = 1
  const indexBitmap = manifestData.slice(
    INDEX_BITMAP_OFFSET,
    INDEX_BITMAP_OFFSET + 32,
  )
  const iByteIndex = Math.floor(105 / 8) // = 13
  const iBitMask = 1 << (105 % 8) // = 0x02

  if ((indexBitmap[iByteIndex] & iBitMask) === 0) {
    throw new Error('Manifest does not contain "index.bin" fork')
  }

  // Count forks before 'i' to find its offset
  let forkIndex = 0
  for (let byte = 0; byte < iByteIndex; byte++) {
    forkIndex += popcount8(indexBitmap[byte])
  }
  // Count bits in byte 13 for values less than 105
  for (let bit = 0; bit < 105 % 8; bit++) {
    if (indexBitmap[iByteIndex] & (1 << bit)) {
      forkIndex++
    }
  }

  // Navigate to the correct fork by skipping previous forks
  let forkOffset = FORKS_OFFSET
  for (let i = 0; i < forkIndex; i++) {
    const flags = manifestData[forkOffset]
    const hasMetadata = (flags & FORK_FLAG_HAS_METADATA) !== 0
    forkOffset += 1 + 1 + 30 + 32 // flags + prefixLen + prefix + reference

    if (hasMetadata) {
      const metadataLen =
        (manifestData[forkOffset] << 8) | manifestData[forkOffset + 1]
      forkOffset += 2 + metadataLen
    }
  }

  // Now at the "index.bin" fork
  const forkFlags = manifestData[forkOffset]
  const prefixLen = manifestData[forkOffset + 1]

  // Verify it starts with 'i' (index.bin)
  if (manifestData[forkOffset + 2] !== 0x69) {
    // 'i'
    throw new Error(
      `Expected "index.bin" prefix, got byte 0x${manifestData[forkOffset + 2].toString(16)}`,
    )
  }

  // Optionally verify full prefix "index.bin" (9 bytes)
  if (prefixLen >= 9) {
    const prefixBytes = manifestData.slice(forkOffset + 2, forkOffset + 2 + 9)
    const expectedPrefix = new TextEncoder().encode("index.bin")
    const prefixMatches = prefixBytes.every((b, i) => b === expectedPrefix[i])
    if (!prefixMatches) {
      console.warn('[ManifestBuilder] Prefix does not fully match "index.bin"')
    }
  }

  // Check if this is a value type (reference is the target)
  const isValueType = (forkFlags & FORK_FLAG_VALUE_TYPE) !== 0
  if (!isValueType) {
    throw new Error('"index.bin" fork is not a VALUE type')
  }

  // Reference is at offset: forkOffset + 1 (flags) + 1 (prefixLen) + 30 (prefix) = forkOffset + 32
  const referenceOffset = forkOffset + 32
  const reference = manifestData.slice(referenceOffset, referenceOffset + 32)

  if (isAllZeros(reference)) {
    throw new Error('Manifest "index.bin" fork has zero reference')
  }

  const hexRef = new Reference(reference).toHex()

  return hexRef
}
