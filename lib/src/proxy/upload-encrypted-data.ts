import {
  makeEncryptedContentAddressedChunk,
  Reference,
  calculateChunkAddress,
} from "@ethersphere/bee-js"
import type {
  Bee,
  Stamper,
  EncryptedChunk,
  UploadOptions,
} from "@ethersphere/bee-js"
import { splitDataIntoChunks } from "./chunking"
import { buildEncryptedMerkleTree } from "./chunking-encrypted"
import type { UploadContext, UploadProgress } from "./types"

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
 * Adapter to convert EncryptedChunk to cafe-utility Chunk interface
 * This allows the Stamper to work with encrypted chunks
 */
class EncryptedChunkAdapter {
  span: bigint
  writer: SimpleUint8ArrayWriter

  constructor(private encryptedChunk: EncryptedChunk) {
    this.span = encryptedChunk.span.toBigInt()
    this.writer = new SimpleUint8ArrayWriter(encryptedChunk.data)
  }

  hash(): Uint8Array {
    return this.encryptedChunk.address.toUint8Array()
  }

  build(): Uint8Array {
    return this.encryptedChunk.data
  }
}

/**
 * Upload encrypted data with client-side signing
 * Handles chunking, encryption, merkle tree building, and progress reporting
 */
export async function uploadEncryptedDataWithSigning(
  context: UploadContext,
  data: Uint8Array,
  options?: UploadOptions,
  onProgress?: (progress: UploadProgress) => void,
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

  console.log(
    `[UploadEncryptedData] Splitting ${data.length} bytes into ${totalChunks} chunks`,
  )

  // Progress callback helper
  const reportProgress = () => {
    if (onProgress) {
      onProgress({ total: totalChunks, processed: processedChunks })
    }
  }

  // Step 2: Process and encrypt leaf chunks
  const encryptedChunkRefs: Array<{
    address: Uint8Array
    key: Uint8Array
    span: bigint
  }> = []

  // Merge tag into options for all chunk uploads
  const uploadOptionsWithTag = { ...options, tag }

  for (const payload of chunkPayloads) {
    // Create and encrypt content-addressed chunk
    const encryptedChunk = makeEncryptedContentAddressedChunk(payload)

    console.log(
      `[UploadEncryptedData] Leaf chunk ${encryptedChunkRefs.length}: address=${encryptedChunk.address.toHex()}, span=${payload.length}, data size=${encryptedChunk.data.length}`,
    )

    // Store reference with span (payload size for leaf chunks)
    encryptedChunkRefs.push({
      address: encryptedChunk.address.toUint8Array(),
      key: encryptedChunk.encryptionKey,
      span: BigInt(payload.length),
    })

    // Upload chunk with signing
    await uploadSingleEncryptedChunk(
      bee,
      stamper,
      postageBatchId,
      encryptedChunk,
      uploadOptionsWithTag,
    )

    processedChunks++
    reportProgress()
  }

  // Step 3: Build encrypted merkle tree (if multiple chunks)
  let rootReference: Reference

  if (encryptedChunkRefs.length === 1) {
    // Single chunk - use direct reference (64 bytes)
    const ref = new Uint8Array(64)
    ref.set(encryptedChunkRefs[0].address, 0)
    ref.set(encryptedChunkRefs[0].key, 32)
    rootReference = new Reference(ref)
    console.log(
      "[UploadEncryptedData] Single chunk upload, reference:",
      rootReference.toHex(),
    )
  } else {
    // Multiple chunks - build encrypted tree using bee-js's implementation
    console.log(
      "[UploadEncryptedData] Building encrypted merkle tree for",
      encryptedChunkRefs.length,
      "chunks",
    )

    rootReference = await buildEncryptedMerkleTree(
      encryptedChunkRefs,
      async (encryptedChunkData) => {
        // Upload the already-encrypted intermediate chunk
        // encryptedChunkData = encryptedSpan (8 bytes) + encryptedPayload (4096 bytes) = 4104 bytes
        // We need to upload this without any modification

        console.log(
          `[UploadCallback] Received encrypted chunk data, size: ${encryptedChunkData.length} bytes`,
        )

        if (stamper) {
          // For client-side signing, calculate the address from the encrypted chunk
          const address = await calculateChunkAddress(encryptedChunkData)
          console.log(
            `[UploadCallback] Calculated address for upload: ${address.toHex()}`,
          )

          const envelope = stamper.stamp({
            hash: () => address.toUint8Array(),
            build: () => encryptedChunkData,
            span: 0n, // not used by stamper.stamp
            writer: undefined as any, // not used by stamper.stamp
          })

          console.log(
            `[UploadCallback] Uploading intermediate chunk with client-side signing...`,
          )
          await bee.uploadChunk(
            envelope,
            encryptedChunkData,
            uploadOptionsWithTag,
          )
          console.log(
            `[UploadCallback] Upload complete for address: ${address.toHex()}`,
          )
        } else {
          // For node-side stamping, just upload directly
          console.log(
            `[UploadCallback] Uploading intermediate chunk with node-side stamping...`,
          )
          await bee.uploadChunk(
            postageBatchId!,
            encryptedChunkData,
            uploadOptionsWithTag,
          )
          console.log(`[UploadCallback] Upload complete`)
        }

        // Count intermediate chunks in progress
        totalChunks++
        processedChunks++
        reportProgress()
      },
    )

    console.log(
      "[UploadEncryptedData] Encrypted merkle tree complete, root reference:",
      rootReference.toHex(),
    )
  }

  // Return result with 64-byte reference (128 hex chars)
  return {
    reference: rootReference.toHex(),
    tagUid: tag,
  }
}

/**
 * Upload a single encrypted chunk with optional signing
 */
async function uploadSingleEncryptedChunk(
  bee: Bee,
  stamper: Stamper | undefined,
  postageBatchId: string | undefined,
  encryptedChunk: EncryptedChunk,
  options?: UploadOptions,
): Promise<void> {
  // Force deferred mode for faster uploads (don't wait for sync)
  // Note: pinning is incompatible with deferred mode, so disable it
  const uploadOptions = { ...options, deferred: true, pin: false }

  if (stamper) {
    // Client-side signing - use adapter for cafe-utility Chunk interface
    const chunkAdapter = new EncryptedChunkAdapter(encryptedChunk)
    const envelope = stamper.stamp(chunkAdapter)
    await bee.uploadChunk(envelope, encryptedChunk.data, uploadOptions)
  } else if (postageBatchId) {
    // Node-side stamping
    await bee.uploadChunk(postageBatchId, encryptedChunk.data, uploadOptions)
  } else {
    throw new Error("No stamper or batch ID available")
  }
}
