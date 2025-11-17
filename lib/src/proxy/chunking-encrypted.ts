import { Reference, Span, calculateChunkAddress, newChunkEncrypter } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"

// Constants for encrypted chunking
export const CHUNK_SIZE = 4096
export const ENCRYPTED_REFS_PER_CHUNK = 64  // 4096 / 64 = 64 encrypted refs per intermediate chunk

/**
 * Build encrypted merkle tree from chunk references
 * Adapted from bee-js encrypted-chunk-stream.ts
 * Returns root reference (64 bytes: 32-byte address + 32-byte encryption key)
 */
export async function buildEncryptedMerkleTree(
  encryptedChunks: Array<{ address: Uint8Array; key: Uint8Array; span: bigint }>,
  onChunk: (encryptedChunkData: Uint8Array) => Promise<void>,
): Promise<Reference> {
  // Single chunk case
  if (encryptedChunks.length === 1) {
    // Return 64-byte reference: address + key
    const ref = new Uint8Array(64)
    ref.set(encryptedChunks[0].address, 0)
    ref.set(encryptedChunks[0].key, 32)

    return new Reference(ref)
  }

  // Multi-chunk case: build intermediate chunks
  // Each intermediate chunk can hold 64 references (64 bytes each = 4096 bytes)
  const intermediateChunks: Array<{ address: Uint8Array; key: Uint8Array; span: bigint }> = []

  for (let i = 0; i < encryptedChunks.length; i += ENCRYPTED_REFS_PER_CHUNK) {
    const refs = encryptedChunks.slice(i, Math.min(i + ENCRYPTED_REFS_PER_CHUNK, encryptedChunks.length))

    // Calculate total span from all children (this is the total data size, not refs size!)
    const totalSpan = refs.reduce((sum, ref) => sum + ref.span, 0n)

    console.log(`[BuildEncryptedTree] Creating intermediate chunk for ${refs.length} refs, totalSpan=${totalSpan}`)

    // Build intermediate chunk payload containing all 64-byte references
    // IMPORTANT: Pad to 4096 bytes with zeros BEFORE encryption
    // This ensures that after decryption, the unused bytes are zeros,
    // allowing ChunkPayloadSize to correctly determine the actual payload size
    const payload = new Uint8Array(4096)  // Pre-filled with zeros
    refs.forEach((ref, idx) => {
      payload.set(ref.address, idx * 64)
      payload.set(ref.key, idx * 64 + 32)
    })

    console.log(`[BuildEncryptedTree] Payload size: ${payload.length} bytes (${refs.length} * 64 refs + zero padding)`)

    // Create chunk with correct span (total data size) + payload
    const spanBytes = Span.fromBigInt(totalSpan).toUint8Array()
    const chunkData = Binary.concatBytes(spanBytes, payload)

    console.log(`[BuildEncryptedTree] Chunk data size (before encryption): ${chunkData.length} bytes (span=8 + payload=${payload.length})`)

    // Encrypt the chunk ONCE to get address and key
    const encrypter = newChunkEncrypter()
    const { key, encryptedSpan, encryptedData } = encrypter.encryptChunk(chunkData)
    const encryptedChunkData = Binary.concatBytes(encryptedSpan, encryptedData)

    console.log(`[BuildEncryptedTree] Encrypted chunk data size: ${encryptedChunkData.length} bytes (encryptedSpan=${encryptedSpan.length} + encryptedData=${encryptedData.length})`)

    // Calculate address from encrypted chunk
    const address = await calculateChunkAddress(encryptedChunkData)

    console.log(`[BuildEncryptedTree] Intermediate chunk address: ${address.toHex()}, key: ${Array.from(key).map(b => b.toString(16).padStart(2, '0')).join('')}`)

    // Pass the ENCRYPTED chunk data to callback for upload
    // This ensures the uploaded chunk has the same address we calculated
    await onChunk(encryptedChunkData)

    // Store reference with address, key, and span
    intermediateChunks.push({
      address: address.toUint8Array(),
      key,
      span: totalSpan,
    })
  }

  // Recursively build tree if we have more than one intermediate chunk
  if (intermediateChunks.length > 1) {
    return buildEncryptedMerkleTree(intermediateChunks, onChunk)
  }

  // Return root reference (64 bytes)
  const rootRef = new Uint8Array(64)
  rootRef.set(intermediateChunks[0].address, 0)
  rootRef.set(intermediateChunks[0].key, 32)

  return new Reference(rootRef)
}
