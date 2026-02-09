import {
  makeEncryptedContentAddressedChunk,
  Reference,
  calculateChunkAddress,
  PrivateKey,
  Identifier,
} from "@ethersphere/bee-js"
import type {
  Bee,
  BeeRequestOptions,
  Stamper,
  EncryptedChunk,
  UploadOptions,
  EnvelopeWithBatchId,
} from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import { splitDataIntoChunks } from "./chunking"
import { buildEncryptedMerkleTree } from "./chunking-encrypted"
import type { UploadContext, UploadProgress } from "./types"

/**
 * Result of uploading encrypted data
 */
export interface UploadEncryptedDataResult {
  reference: string
  tagUid?: number
  chunkAddresses: Uint8Array[] // Addresses of all uploaded chunks
}

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
 *
 * @param context - Upload context with bee instance and authentication
 * @param data - Data to encrypt and upload
 * @param encryptionKey - Optional 32-byte encryption key (generates random if not provided)
 * @param options - Upload options
 * @param onProgress - Progress callback
 */
export async function uploadEncryptedDataWithSigning(
  context: UploadContext,
  data: Uint8Array,
  encryptionKey?: Uint8Array,
  options?: UploadOptions,
  onProgress?: (progress: UploadProgress) => void,
  requestOptions?: BeeRequestOptions,
): Promise<UploadEncryptedDataResult> {
  const { bee, stamper } = context

  // Validate authentication method
  if (!stamper) {
    throw new Error("No authentication method available")
  }

  // Create a tag for tracking upload progress (required for fast deferred uploads)
  // IMPORTANT: Tag is REQUIRED in dev mode - Bee's /chunks endpoint uses tag presence
  // to determine deferred mode (deferred = tag != 0), and dev mode blocks non-deferred uploads
  let tag: number | undefined = options?.tag
  if (!tag) {
    console.log(`[UploadEncryptedData] Creating tag (required for dev mode)...`)
    const tagResponse = await bee.createTag()
    tag = tagResponse.uid
    console.log(`[UploadEncryptedData] Tag created successfully: ${tag}`)
  } else {
    console.log(`[UploadEncryptedData] Using existing tag from options: ${tag}`)
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

  // Track all uploaded chunk addresses for utilization
  const uploadedChunkAddresses: Uint8Array[] = []

  // Merge tag into options for all chunk uploads
  const uploadOptionsWithTag = { ...options, tag }

  for (const payload of chunkPayloads) {
    // Create and encrypt content-addressed chunk
    const encryptedChunk = makeEncryptedContentAddressedChunk(
      payload,
      encryptionKey,
    )

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
      encryptedChunk,
      uploadOptionsWithTag,
      requestOptions,
    )

    // Track uploaded chunk address for utilization
    uploadedChunkAddresses.push(encryptedChunk.address.toUint8Array())

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

        // Calculate address for this intermediate chunk (needed for both stamper and utilization tracking)
        const address = calculateChunkAddress(encryptedChunkData)

        // Track this intermediate chunk address for utilization
        uploadedChunkAddresses.push(address.toUint8Array())

        // For client-side signing, use the calculated address
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
          requestOptions,
        )
        console.log(
          `[UploadCallback] Upload complete for address: ${address.toHex()}`,
        )

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
    chunkAddresses: uploadedChunkAddresses,
  }
}

/**
 * Upload a single encrypted chunk with optional signing
 */
async function uploadSingleEncryptedChunk(
  bee: Bee,
  stamper: Stamper,
  encryptedChunk: EncryptedChunk,
  options?: UploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<void> {
  // Client-side signing - use adapter for cafe-utility Chunk interface
  const chunkAdapter = new EncryptedChunkAdapter(encryptedChunk)
  const envelope = stamper.stamp(chunkAdapter)
  await uploadSingleChunkWithEnvelope(
    bee,
    envelope,
    encryptedChunk.data,
    options,
    requestOptions,
  )
}

/**
 * Upload a single encrypted chunk with optional signing
 */
async function uploadSingleChunkWithEnvelope(
  bee: Bee,
  envelope: EnvelopeWithBatchId,
  data: Uint8Array,
  options?: UploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<void> {
  const startTime = performance.now()
  // Use non-deferred mode for faster uploads (returns immediately)
  // Note: pinning is incompatible with deferred mode, so disable it
  const uploadOptions = { deferred: false, pin: false, ...options }
  console.log(
    `[uploadSingleChunkWithEnvelope] Options prepared:`,
    uploadOptions,
  )

  const beeUploadStart = performance.now()
  await bee.uploadChunk(envelope, data, uploadOptions, requestOptions)
  console.log(
    `[uploadSingleChunkWithEnvelope] bee.uploadChunk (stamper) completed (+${(performance.now() - beeUploadStart).toFixed(2)}ms)`,
  )

  console.log(
    `[uploadSingleChunkWithEnvelope] TOTAL: ${(performance.now() - startTime).toFixed(2)}ms`,
  )
}

/**
 * Upload a single encrypted chunk with optional signing
 *
 * This is the unified interface for uploading encrypted chunks.
 * Use this instead of direct Bee API calls with fetch.
 *
 * @param bee - Bee client instance
 * @param stamper - Stamper for client-side signing
 * @param payload - Raw chunk data to encrypt and upload (1-4096 bytes)
 * @param encryptionKey - Encryption key (32 bytes)
 * @param options - Upload options (deferred, tag, etc.)
 */
export async function uploadSingleChunkWithEncryption(
  bee: Bee,
  stamper: Stamper,
  payload: Uint8Array,
  encryptionKey: Uint8Array,
  options?: UploadOptions,
): Promise<void> {
  const startTime = performance.now()
  console.log(
    `[UploadSingleChunk] Starting upload, batch: ${stamper.batchId}, options:`,
    options,
  )

  // Validate payload size (1-4096 bytes, encryption handles padding)
  if (payload.length < 1 || payload.length > 4096) {
    throw new Error(
      `Invalid payload length: ${payload.length} (expected 1-4096)`,
    )
  }

  // Validate encryption key
  if (encryptionKey.length !== 32) {
    throw new Error(
      `Invalid encryption key length: ${encryptionKey.length} (expected 32)`,
    )
  }

  // Create encrypted content-addressed chunk
  const encryptChunkStart = performance.now()
  const encryptedChunk = makeEncryptedContentAddressedChunk(
    payload,
    encryptionKey,
  )
  console.log(
    `[UploadSingleChunk] Encryption complete (+${(performance.now() - encryptChunkStart).toFixed(2)}ms)`,
  )

  // Upload using the existing function that handles both stamper and batch cases
  const uploadStart = performance.now()
  await uploadSingleEncryptedChunk(bee, stamper, encryptedChunk, options)
  console.log(
    `[UploadSingleChunk] Upload complete (+${(performance.now() - uploadStart).toFixed(2)}ms, TOTAL: ${(performance.now() - startTime).toFixed(2)}ms)`,
  )
}

/**
 * Result of uploading an encrypted SOC
 */
export interface UploadEncryptedSOCResult {
  socAddress: Uint8Array
  encryptionKey: Uint8Array
  tagUid?: number
}

/**
 * Upload chunk via direct fetch to /chunks endpoint
 *
 * This is a temporary workaround for bee.uploadChunk's 4104-byte size limit.
 * Can be replaced with bee.uploadChunk when it supports SOC chunks (4201 bytes).
 *
 * @param bee - Bee client instance
 * @param envelope - Envelope with postage stamp signature
 * @param chunkData - Full chunk data (can be > 4104 bytes for SOC)
 * @param options - Upload options
 * @returns Reference to the uploaded chunk
 */
async function uploadChunkWithFetch(
  bee: Bee,
  envelope: EnvelopeWithBatchId,
  chunkData: Uint8Array,
  options?: UploadOptions,
): Promise<Reference> {
  // Marshal the envelope to hex for the HTTP header
  // Order: batchId (32) + index (8) + timestamp (8) + signature (65) = 113 bytes
  const marshaledStamp = Binary.concatBytes(
    envelope.batchId.toUint8Array(),
    envelope.index,
    envelope.timestamp,
    envelope.signature,
  )

  // Convert to hex string (226 chars) - using Binary.uint8ArrayToHex for browser compatibility
  const stampHex = Binary.uint8ArrayToHex(marshaledStamp)

  // Prepare HTTP headers
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "swarm-postage-stamp": stampHex,
  }

  // Add optional headers
  if (options?.tag) headers["swarm-tag"] = options.tag.toString()
  if (options?.deferred !== undefined) {
    headers["swarm-deferred-upload"] = options.deferred.toString()
  }
  if (options?.pin !== undefined) {
    headers["swarm-pin"] = options.pin.toString()
  }

  console.log(
    `[uploadChunkWithFetch] Uploading ${chunkData.length} bytes to ${bee.url}/chunks`,
  )
  console.log(`[uploadChunkWithFetch] Tag in options: ${options?.tag}`)
  console.log(`[uploadChunkWithFetch] Headers being sent:`, headers)

  // Make direct fetch call to /chunks endpoint
  const response = await fetch(`${bee.url}/chunks`, {
    method: "POST",
    headers,
    body: chunkData,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Chunk upload failed: ${response.status} ${response.statusText} - ${errorText}`,
    )
  }

  const result = await response.json()
  console.log(
    `[uploadChunkWithFetch] Upload successful, reference: ${result.reference}`,
  )

  return new Reference(result.reference)
}

/**
 * Calculate SOC address from identifier and owner
 */
function makeSOCAddress(
  identifier: Identifier,
  ownerAddress: Uint8Array,
): Reference {
  return new Reference(
    Binary.keccak256(
      Binary.concatBytes(identifier.toUint8Array(), ownerAddress),
    ),
  )
}

/**
 * Upload an encrypted Single Owner Chunk (SOC) using the fast chunk upload path
 *
 * This function constructs an encrypted SOC manually and uploads it via the regular
 * /chunks endpoint for better performance compared to the /soc endpoint.
 *
 * SOC Structure (Book of Swarm 2.2.3, 2.2.4):
 * - 32 bytes: identifier
 * - 65 bytes: signature (r, s, v)
 * - 8 bytes: span (from encrypted CAC)
 * - up to 4096 bytes: encrypted payload (from encrypted CAC)
 *
 * The signature signs: hash(identifier + encrypted_CAC.address)
 * SOC address: Keccak256(identifier + owner_address)
 *
 * @param bee - Bee client instance
 * @param stamper - Stamper for client-side signing
 * @param signer - SOC owner's private key
 * @param identifier - 32-byte SOC identifier
 * @param data - Payload data (1-4096 bytes)
 * @param encryptionKey - Optional 32-byte encryption key (random if not provided)
 * @param options - Upload options (tag, deferred, etc.)
 * @returns SOC address, encryption key, and optional tag UID
 */
export async function uploadEncryptedSOC(
  bee: Bee,
  stamper: Stamper,
  signer: PrivateKey,
  identifier: Identifier,
  data: Uint8Array,
  encryptionKey?: Uint8Array,
  options?: UploadOptions,
): Promise<UploadEncryptedSOCResult> {
  const startTime = performance.now()
  console.log(`[UploadEncryptedSOC] Starting encrypted SOC upload`, {
    dataLength: data.length,
    identifier: identifier.toHex().substring(0, 16) + "...",
  })

  // Validate data size (1-4096 bytes)
  if (data.length < 1 || data.length > 4096) {
    throw new Error(`Invalid data length: ${data.length} (expected 1-4096)`)
  }

  // Step 1: Create encrypted CAC chunk
  const encryptChunkStart = performance.now()
  const encryptedChunk = makeEncryptedContentAddressedChunk(data, encryptionKey)
  console.log(
    `[UploadEncryptedSOC] Created encrypted CAC (+${(performance.now() - encryptChunkStart).toFixed(2)}ms)`,
    {
      encryptedChunkAddress:
        encryptedChunk.address.toHex().substring(0, 16) + "...",
      encryptedChunkSize: encryptedChunk.data.length,
    },
  )

  // Step 2: Construct SOC structure
  const owner = signer.publicKey().address()

  // Sign: hash(identifier + encrypted_CAC.address)
  const toSign = Binary.concatBytes(
    identifier.toUint8Array(),
    encryptedChunk.address.toUint8Array(),
  )
  const signature = signer.sign(toSign)

  // Build SOC data: identifier (32) + signature (65) + encrypted_CAC.data
  const socData = Binary.concatBytes(
    identifier.toUint8Array(),
    signature.toUint8Array(),
    encryptedChunk.data,
  )

  // Calculate SOC address: Keccak256(identifier + owner_address)
  const socAddress = makeSOCAddress(identifier, owner.toUint8Array())

  console.log(
    `[UploadEncryptedSOC] Constructed SOC (+${(performance.now() - startTime).toFixed(2)}ms)`,
    {
      socAddress: socAddress.toHex().substring(0, 16) + "...",
      socDataSize: socData.length,
      owner: owner.toHex().substring(0, 16) + "...",
    },
  )

  // Step 3: Create tag for tracking (if not provided in options)
  // IMPORTANT: Tag is REQUIRED in dev mode - Bee's /chunks endpoint uses tag presence
  // to determine deferred mode (deferred = tag != 0), and dev mode blocks non-deferred uploads
  let tag: number | undefined = options?.tag
  if (!tag) {
    console.log(`[UploadEncryptedSOC] Creating tag (required for dev mode)...`)
    const tagResponse = await bee.createTag()
    tag = tagResponse.uid
    console.log(`[UploadEncryptedSOC] Tag created successfully: ${tag}`)
  } else {
    console.log(`[UploadEncryptedSOC] Using existing tag from options: ${tag}`)
  }

  // Step 4: Create envelope with stamper
  const envelope = stamper.stamp({
    hash: () => socAddress.toUint8Array(),
    build: () => socData,
    span: 0n, // not used by stamper.stamp
    writer: undefined as any, // not used by stamper.stamp
  })

  console.log(
    `[UploadEncryptedSOC] Uploading to regular chunk endpoint... (+${(performance.now() - startTime).toFixed(2)}ms)`,
  )

  // Step 5: Upload using direct fetch (bypasses bee.uploadChunk size check)
  const uploadOptionsWithTag = { tag, deferred: false, pin: false, ...options }
  await uploadChunkWithFetch(bee, envelope, socData, uploadOptionsWithTag)

  console.log(
    `[UploadEncryptedSOC] ✅ Upload complete (TOTAL: ${(performance.now() - startTime).toFixed(2)}ms)`,
  )

  return {
    socAddress: socAddress.toUint8Array(),
    encryptionKey: encryptedChunk.encryptionKey,
    tagUid: tag,
  }
}
