import { MantarayNode } from "@ethersphere/bee-js";
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
        data: Uint8Array;
        address: string;
    };
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
export declare function buildBzzCompatibleManifest(contentReference: string | Uint8Array): Promise<BzzCompatibleManifestResult>;
/**
 * Result of building a /bzz/-compatible MantarayNode manifest.
 */
export interface BzzManifestNodeResult {
    /** The MantarayNode to be uploaded with saveMantarayTreeRecursively */
    manifestNode: MantarayNode;
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
export declare function buildBzzManifestNode(contentReference: string | Uint8Array): BzzManifestNodeResult;
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
export declare function buildMinimalManifest(contentReference: string | Uint8Array): Uint8Array;
/**
 * Maximum CAC payload size for /bzz/ compatible feed uploads.
 *
 * For the /chunks endpoint to detect SOC correctly, total SOC size must be > 4104 bytes.
 * SOC structure: identifier(32) + signature(65) + span(8) + payload(N)
 * For N=4096: total = 32 + 65 + 8 + 4096 = 4201 bytes > 4104 ✓
 */
export declare const MAX_PADDED_PAYLOAD_SIZE = 4096;
/**
 * Pad payload to 4096 bytes for SOC detection by /chunks endpoint.
 *
 * The span field in the CAC contains the actual payload size (before padding),
 * so Bee's joiner will only read the actual data and ignore padding.
 *
 * @param payload - Original payload (must be <= 4096 bytes)
 * @returns Padded payload (exactly 4096 bytes)
 */
export declare function padPayloadForSOCDetection(payload: Uint8Array): Uint8Array;
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
export declare function extractReferenceFromManifest(manifestData: Uint8Array): string;
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
export declare function extractEntryFromManifest(manifestData: Uint8Array): string;
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
export declare function extractContentFromFlatManifest(manifestData: Uint8Array): string;
//# sourceMappingURL=manifest-builder.d.ts.map