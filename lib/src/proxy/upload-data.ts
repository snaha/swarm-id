import { makeContentAddressedChunk, Reference } from "@ethersphere/bee-js"
import type { Bee, Stamper, Chunk as BeeChunk, UploadOptions } from "@ethersphere/bee-js"
import { splitDataIntoChunks, buildMerkleTree } from "./chunking"
import type { UploadContext, UploadProgress, ChunkReference } from "./types"

/**
 * Simple Uint8ArrayWriter implementation for ChunkAdapter
 */
class SimpleUint8ArrayWriter {
  cursor: number = 0
  buffer: Uint8Array

  constructor(buffer: Uint8Array) {
    this.buffer = buffer
  }

  write(_reader: unknown): number {
    throw new Error("SimpleUint8ArrayWriter.write() not implemented")
  }

  max(): number {
    return this.buffer.length
  }
}

/**
 * Adapter to convert bee-js Chunk to cafe-utility Chunk interface
 * This allows the Stamper to work with content-addressed chunks
 */
class ChunkAdapter {
  span: bigint
  writer: SimpleUint8ArrayWriter

  constructor(private chunk: BeeChunk) {
    this.span = chunk.span.toBigInt()
    this.writer = new SimpleUint8ArrayWriter(chunk.data)
  }

  hash(): Uint8Array {
    return this.chunk.address.toUint8Array()
  }

  build(): Uint8Array {
    return this.chunk.data
  }
}

/**
 * Upload data with client-side signing
 * Handles chunking, merkle tree building, and progress reporting
 */
export async function uploadDataWithSigning(
  context: UploadContext,
  data: Uint8Array,
  options?: UploadOptions,
  onProgress?: (progress: UploadProgress) => void
): Promise<{ reference: string; tagUid?: number }> {
  const { bee, stamper, postageBatchId } = context

  // Validate authentication method
  if (!stamper && !postageBatchId) {
    throw new Error("No authentication method available")
  }

  // Create a tag for tracking upload progress (required for fast deferred uploads)
  let tag: number | undefined = options?.tag
  if (!tag) {
    const tagResponse = await bee.createTag()
    tag = tagResponse.uid
  }

  // Step 1: Split data into chunks
  const chunkPayloads = splitDataIntoChunks(data)
  let totalChunks = chunkPayloads.length
  let processedChunks = 0

  console.log(`[UploadData] Splitting ${data.length} bytes into ${totalChunks} chunks`)

  // Progress callback helper
  const reportProgress = () => {
    if (onProgress) {
      onProgress({ total: totalChunks, processed: processedChunks })
    }
  }

  // Step 2: Process leaf chunks
  const chunkRefs: ChunkReference[] = []

  // Merge tag into options for all chunk uploads
  const uploadOptionsWithTag = { ...options, tag }

  for (const payload of chunkPayloads) {
    // Create content-addressed chunk
    const chunk = makeContentAddressedChunk(payload)

    // Store reference
    chunkRefs.push({
      address: chunk.address.toUint8Array()
    })

    // Upload chunk with signing
    await uploadSingleChunk(bee, stamper, postageBatchId, chunk, uploadOptionsWithTag)

    processedChunks++
    reportProgress()
  }

  // Step 3: Build merkle tree (if multiple chunks)
  let rootReference: Reference

  if (chunkRefs.length === 1) {
    // Single chunk - use direct reference
    rootReference = new Reference(chunkRefs[0].address)
    console.log("[UploadData] Single chunk upload, reference:", rootReference.toHex())
  } else {
    // Multiple chunks - build tree
    console.log("[UploadData] Building merkle tree for", chunkRefs.length, "chunks")

    rootReference = await buildMerkleTree(chunkRefs, async (intermediateChunk) => {
      await uploadSingleChunk(bee, stamper, postageBatchId, intermediateChunk, uploadOptionsWithTag)

      // Count intermediate chunks in progress
      totalChunks++
      processedChunks++
      reportProgress()
    })

    console.log("[UploadData] Merkle tree complete, root reference:", rootReference.toHex())
  }

  // Return result
  return {
    reference: rootReference.toHex(),
    tagUid: tag
  }
}

/**
 * Upload a single chunk with optional signing
 */
async function uploadSingleChunk(
  bee: Bee,
  stamper: Stamper | undefined,
  postageBatchId: string | undefined,
  chunk: BeeChunk,
  options?: UploadOptions
): Promise<void> {
  // Force deferred mode for faster uploads (don't wait for sync)
  // Note: pinning is incompatible with deferred mode, so disable it
  const uploadOptions = { ...options, deferred: true, pin: false }
  console.log("[UploadData] uploadChunk options:", uploadOptions)

  if (stamper) {
    // Client-side signing - use adapter for cafe-utility Chunk interface
    const chunkAdapter = new ChunkAdapter(chunk)
    const envelope = stamper.stamp(chunkAdapter)
    await bee.uploadChunk(envelope, chunk.data, uploadOptions)
  } else if (postageBatchId) {
    // Node-side stamping
    await bee.uploadChunk(postageBatchId, chunk.data, uploadOptions)
  } else {
    throw new Error("No stamper or batch ID available")
  }
}
