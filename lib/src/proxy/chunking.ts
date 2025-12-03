import { makeContentAddressedChunk, Reference } from "@ethersphere/bee-js"
import type { Chunk as BeeChunk } from "@ethersphere/bee-js"
import type { ChunkReference } from "./types"

// Constants
export const CHUNK_SIZE = 4096
export const REFS_PER_CHUNK = 64 // 4096 / 64 = 64 refs per intermediate chunk

/**
 * Split data into 4096-byte chunks
 */
export function splitDataIntoChunks(data: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    chunks.push(data.slice(i, Math.min(i + CHUNK_SIZE, data.length)))
  }
  return chunks
}

/**
 * Build merkle tree from chunk references
 * Returns root reference (32 bytes)
 */
export async function buildMerkleTree(
  chunkRefs: ChunkReference[],
  onIntermediateChunk: (chunk: BeeChunk) => Promise<void>,
): Promise<Reference> {
  // Single chunk - return direct reference
  if (chunkRefs.length === 1) {
    return new Reference(chunkRefs[0].address)
  }

  // Build intermediate level
  const intermediateRefs: ChunkReference[] = []

  for (let i = 0; i < chunkRefs.length; i += REFS_PER_CHUNK) {
    const refs = chunkRefs.slice(
      i,
      Math.min(i + REFS_PER_CHUNK, chunkRefs.length),
    )

    // Build payload with 32-byte references
    const payload = new Uint8Array(refs.length * 32)
    refs.forEach((ref, idx) => {
      payload.set(ref.address, idx * 32)
    })

    // Create intermediate chunk
    const chunk = makeContentAddressedChunk(payload)
    intermediateRefs.push({
      address: chunk.address.toUint8Array(),
    })

    // Upload intermediate chunk
    await onIntermediateChunk(chunk)
  }

  // Recursively build tree if needed
  if (intermediateRefs.length > 1) {
    return buildMerkleTree(intermediateRefs, onIntermediateChunk)
  }

  // Return root reference
  return new Reference(intermediateRefs[0].address)
}
