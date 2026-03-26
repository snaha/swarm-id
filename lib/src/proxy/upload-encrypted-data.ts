import { Reference, PrivateKey, Identifier } from "@ethersphere/bee-js"
import type {
  Bee,
  BeeRequestOptions,
  Stamper,
  UploadOptions,
  EnvelopeWithBatchId,
} from "@ethersphere/bee-js"
import {
  makeContentAddressedChunk,
  makeEncryptedContentAddressedChunk,
  calculateChunkAddress,
  type EncryptedChunk,
  DEFAULT_UPLOAD_CONCURRENCY,
} from "../chunk"
import { Binary } from "cafe-utility"
import { splitDataIntoChunks } from "./chunking"
import { buildEncryptedMerkleTree } from "./chunking-encrypted"
import { ChunkUploadStream } from "./chunk-upload-stream"
import { marshalEnvelope } from "./stamp-marshal"
import type {
  UploadContext,
  UploadProgress,
  WebSocketUploadOptions,
} from "./types"
import type { StampWorkerPool } from "./stamp-worker-pool"
import { tryCreateTag } from "../utils/tag"

/**
 * Result of uploading encrypted data
 */
export interface UploadEncryptedDataResult {
  reference: string
  tagUid?: number
  chunkAddresses: Uint8Array[] // Addresses of all uploaded chunks
}

// ============================================================================
// Stamper Adapters
// ============================================================================

/**
 * Minimal writer stub — the Stamper interface requires a writer field
 * but never actually calls it during stamp().
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

/** Stamp chunk data by address and return the envelope. */
function stampChunkData(
  stamper: Stamper,
  chunkData: Uint8Array,
  address: Uint8Array,
): EnvelopeWithBatchId {
  return stamper.stamp({
    hash: () => address,
    build: () => chunkData,
    span: 0n,
    writer: new SimpleUint8ArrayWriter(chunkData),
  })
}

/**
 * Async stamp function — abstraction over sync Stamper and parallel StampWorkerPool.
 * Both HTTP and WebSocket upload paths use this type.
 */
type StampChunkFn = (
  chunkData: Uint8Array,
  address: Uint8Array,
) => Promise<EnvelopeWithBatchId>

/** Create a StampChunkFn from a Stamper and optional worker pool. */
function makeStampFn(
  stamper: Stamper,
  workerPool?: StampWorkerPool,
): StampChunkFn {
  if (workerPool) {
    return (chunkData, address) => workerPool.stampChunkData(chunkData, address)
  }
  return (chunkData, address) =>
    Promise.resolve(stampChunkData(stamper, chunkData, address))
}

// ============================================================================
// Encryption
// ============================================================================

interface EncryptedChunkRef {
  address: Uint8Array
  key: Uint8Array
  span: bigint
}

/** Encrypt all payloads into EncryptedChunks and collect their references (CPU-only). */
function encryptChunkPayloads(
  payloads: Uint8Array[],
  encryptionKey?: Uint8Array,
): { chunks: EncryptedChunk[]; refs: EncryptedChunkRef[] } {
  const chunks: EncryptedChunk[] = []
  const refs: EncryptedChunkRef[] = []

  for (const payload of payloads) {
    const chunk = makeEncryptedContentAddressedChunk(payload, encryptionKey)
    chunks.push(chunk)
    refs.push({
      address: chunk.address.toUint8Array(),
      key: chunk.encryptionKey,
      span: BigInt(payload.length),
    })
  }

  return { chunks, refs }
}

// ============================================================================
// Chunk Upload (HTTP / WebSocket)
// ============================================================================

/** A callback invoked after each chunk upload, for progress tracking. */
type OnChunkUploaded = (address: Uint8Array) => void

/** Upload a single stamped chunk via HTTP. */
async function uploadStampedChunkViaHttp(
  bee: Bee,
  stamp: StampChunkFn,
  chunkData: Uint8Array,
  address: Uint8Array,
  options: UploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<void> {
  const envelope = await stamp(chunkData, address)
  await bee.uploadChunk(envelope, chunkData, options, requestOptions)
}

/** Upload a single stamped chunk via WebSocket. */
async function uploadStampedChunkViaWebSocket(
  stamp: StampChunkFn,
  stream: ChunkUploadStream,
  chunkData: Uint8Array,
  address: Uint8Array,
): Promise<void> {
  const envelope = await stamp(chunkData, address)
  const stamped = Binary.concatBytes(marshalEnvelope(envelope), chunkData)
  await stream.uploadChunk(stamped)
}

/** Upload encrypted chunks via HTTP with sliding-window concurrency. */
async function uploadChunksViaHttp(
  bee: Bee,
  stamp: StampChunkFn,
  chunks: EncryptedChunk[],
  options: UploadOptions,
  requestOptions: BeeRequestOptions | undefined,
  onUploaded: OnChunkUploaded,
  concurrency: number = DEFAULT_UPLOAD_CONCURRENCY,
): Promise<void> {
  let nextIndex = 0

  const worker = async () => {
    while (nextIndex < chunks.length) {
      const chunk = chunks[nextIndex++]
      await uploadStampedChunkViaHttp(
        bee,
        stamp,
        chunk.data,
        chunk.address.toUint8Array(),
        options,
        requestOptions,
      )
      onUploaded(chunk.address.toUint8Array())
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, chunks.length) }, () =>
      worker(),
    ),
  )
}

/** Upload encrypted chunks via WebSocket with per-chunk stamping. */
async function uploadChunksViaWebSocket(
  stamp: StampChunkFn,
  stream: ChunkUploadStream,
  chunks: EncryptedChunk[],
  onUploaded: OnChunkUploaded,
): Promise<void> {
  // Worker pool pattern: interleave stamping with I/O so the event loop stays responsive.
  // Each async worker: take next chunk → stamp → send → wait for ack → repeat.
  let nextIndex = 0

  const worker = async () => {
    while (nextIndex < chunks.length) {
      const chunk = chunks[nextIndex++]
      await uploadStampedChunkViaWebSocket(
        stamp,
        stream,
        chunk.data,
        chunk.address.toUint8Array(),
      )
      onUploaded(chunk.address.toUint8Array())
    }
  }

  const workerCount = stream.getConcurrency()
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
}

// ============================================================================
// Merkle Tree
// ============================================================================

/**
 * Build the root reference from encrypted chunk refs.
 * Single-chunk → direct 64-byte reference.
 * Multi-chunk → build merkle tree, uploading intermediate chunks via `uploadIntermediate`.
 */
async function buildRootReference(
  refs: EncryptedChunkRef[],
  uploadIntermediate: (chunkData: Uint8Array) => Promise<void>,
): Promise<Reference> {
  if (refs.length === 1) {
    const ref = new Uint8Array(64)
    ref.set(refs[0].address, 0)
    ref.set(refs[0].key, 32)
    return new Reference(ref)
  }

  return buildEncryptedMerkleTree(refs, uploadIntermediate)
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Upload encrypted data with client-side signing.
 *
 * Pipeline: split → encrypt → upload leaves → build merkle tree → return reference.
 * Supports both HTTP (batched) and WebSocket (per-chunk stamped) transport.
 */
export async function uploadEncryptedDataWithSigning(
  context: UploadContext,
  data: Uint8Array,
  encryptionKey?: Uint8Array,
  options?: UploadOptions,
  onProgress?: (progress: UploadProgress) => void,
  requestOptions?: BeeRequestOptions,
  webSocket?: WebSocketUploadOptions,
  httpConcurrency?: number,
): Promise<UploadEncryptedDataResult> {
  const { bee, stamper, workerPool } = context

  if (!stamper) {
    throw new Error("No authentication method available")
  }

  // Create a tag for tracking upload progress (gateway-compatible)
  const tag = options?.tag ?? (await tryCreateTag(bee))
  const uploadOptionsWithTag = { ...options, tag }

  // Create stamp function — uses worker pool (parallel) or sync stamper
  const stamp = makeStampFn(stamper, workerPool)

  // Step 1: Split and encrypt (CPU work)
  const payloads = splitDataIntoChunks(data)
  const { chunks: encryptedChunks, refs: encryptedChunkRefs } =
    encryptChunkPayloads(payloads, encryptionKey)

  // Progress tracking
  let totalChunks = encryptedChunks.length
  let processedChunks = 0
  const reportProgress = () =>
    onProgress?.({ total: totalChunks, processed: processedChunks })

  const uploadedChunkAddresses: Uint8Array[] = []

  const onChunkUploaded: OnChunkUploaded = (address) => {
    uploadedChunkAddresses.push(address)
    processedChunks++
    reportProgress()
  }

  // Step 2: Open WebSocket stream if requested
  let wsStream: ChunkUploadStream | undefined
  if (webSocket) {
    wsStream = new ChunkUploadStream(bee.url, {
      tag,
      concurrency: webSocket.concurrency,
    })
    await wsStream.open()
  }

  try {
    // Step 3: Upload chunks
    if (wsStream) {
      await uploadChunksViaWebSocket(
        stamp,
        wsStream,
        encryptedChunks,
        onChunkUploaded,
      )
    } else {
      await uploadChunksViaHttp(
        bee,
        stamp,
        encryptedChunks,
        uploadOptionsWithTag,
        requestOptions,
        onChunkUploaded,
        httpConcurrency,
      )
    }

    // Step 4: Build merkle tree (uploads intermediate chunks)
    const rootReference = await buildRootReference(
      encryptedChunkRefs,
      async (chunkData) => {
        const address = calculateChunkAddress(chunkData)
        uploadedChunkAddresses.push(address.toUint8Array())

        if (wsStream) {
          await uploadStampedChunkViaWebSocket(
            stamp,
            wsStream,
            chunkData,
            address.toUint8Array(),
          )
        } else {
          await uploadStampedChunkViaHttp(
            bee,
            stamp,
            chunkData,
            address.toUint8Array(),
            uploadOptionsWithTag,
            requestOptions,
          )
        }

        totalChunks++
        processedChunks++
        reportProgress()
      },
    )

    return {
      reference: rootReference.toHex(),
      tagUid: tag,
      chunkAddresses: uploadedChunkAddresses,
    }
  } finally {
    if (wsStream) {
      await wsStream.close()
    }
  }
}

// ============================================================================
// Single Chunk Upload Helpers
// ============================================================================

/**
 * Upload a single encrypted chunk with client-side signing via HTTP.
 */
export async function uploadSingleEncryptedChunk(
  bee: Bee,
  stamper: Stamper,
  encryptedChunk: EncryptedChunk,
  options?: UploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<void> {
  const stamp = makeStampFn(stamper)
  await uploadStampedChunkViaHttp(
    bee,
    stamp,
    encryptedChunk.data,
    encryptedChunk.address.toUint8Array(),
    { deferred: false, pin: false, ...options },
    requestOptions,
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
  const encryptedChunk = makeEncryptedContentAddressedChunk(
    payload,
    encryptionKey,
  )

  // Upload using the existing function that handles both stamper and batch cases
  await uploadSingleEncryptedChunk(bee, stamper, encryptedChunk, options)
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
 * Result of uploading a SOC
 */
export interface UploadSOCResult {
  socAddress: Uint8Array
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
  const stampHex = Binary.uint8ArrayToHex(marshalEnvelope(envelope))

  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "swarm-postage-stamp": stampHex,
  }

  if (options?.tag) headers["swarm-tag"] = options.tag.toString()
  if (options?.deferred !== undefined) {
    headers["swarm-deferred-upload"] = options.deferred.toString()
  }
  if (options?.pin !== undefined) {
    headers["swarm-pin"] = options.pin.toString()
  }

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
  // Validate data size (1-4096 bytes)
  if (data.length < 1 || data.length > 4096) {
    throw new Error(`Invalid data length: ${data.length} (expected 1-4096)`)
  }

  // Step 1: Create encrypted CAC chunk
  const encryptedChunk = makeEncryptedContentAddressedChunk(data, encryptionKey)

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

  // Step 3: Create tag for tracking (if not provided in options)
  // IMPORTANT: Tag is REQUIRED in dev mode - Bee's /chunks endpoint uses tag presence
  // to determine deferred mode (deferred = tag != 0), and dev mode blocks non-deferred uploads
  const tag = options?.tag ?? (await tryCreateTag(bee))

  // Step 4: Create envelope with stamper
  const envelope = stamper.stamp({
    hash: () => socAddress.toUint8Array(),
    build: () => socData,
    span: 0n, // not used by stamper.stamp
    writer: undefined as any, // not used by stamper.stamp
  })

  // Step 5: Upload using direct fetch (bypasses bee.uploadChunk size check)
  const uploadOptionsWithTag = { tag, deferred: false, ...options }
  await uploadChunkWithFetch(bee, envelope, socData, uploadOptionsWithTag)

  return {
    socAddress: socAddress.toUint8Array(),
    encryptionKey: encryptedChunk.encryptionKey,
    tagUid: tag,
  }
}

/**
 * Upload a plain Single Owner Chunk (SOC) using the fast chunk upload path
 *
 * This constructs an unencrypted SOC and uploads it via /chunks to avoid /soc size limits.
 */
export async function uploadSOC(
  bee: Bee,
  stamper: Stamper,
  signer: PrivateKey,
  identifier: Identifier,
  data: Uint8Array,
  options?: UploadOptions,
): Promise<UploadSOCResult> {
  if (data.length < 1 || data.length > 4096) {
    throw new Error(`Invalid data length: ${data.length} (expected 1-4096)`)
  }

  const cac = makeContentAddressedChunk(data)
  // Bee recognizes SOCs by full SOC size (32+65+4104). Pad CAC to 4104 bytes
  // so /chunks treats this as a SOC instead of a regular chunk, avoiding
  // "stamp signature is invalid" errors.
  const cacData = new Uint8Array(8 + 4096)
  cacData.set(cac.data)
  const owner = signer.publicKey().address()

  const toSign = Binary.concatBytes(
    identifier.toUint8Array(),
    cac.address.toUint8Array(),
  )
  const signature = signer.sign(toSign)

  const socData = Binary.concatBytes(
    identifier.toUint8Array(),
    signature.toUint8Array(),
    cacData,
  )

  const socAddress = makeSOCAddress(identifier, owner.toUint8Array())

  const tag = options?.tag ?? (await tryCreateTag(bee))

  const envelope = stamper.stamp({
    hash: () => socAddress.toUint8Array(),
    build: () => socData,
    span: 0n,
    writer: undefined as any,
  })

  const uploadOptionsWithTag = { tag, deferred: false, ...options }
  await uploadChunkWithFetch(bee, envelope, socData, uploadOptionsWithTag)

  return {
    socAddress: socAddress.toUint8Array(),
    tagUid: tag,
  }
}

/**
 * Upload SOC via the /soc/{owner}/{id} endpoint.
 *
 * Use this for small SOCs (< 4104 bytes) that need to preserve exact CAC size,
 * such as v1 format feeds for /bzz/ compatibility.
 *
 * The /soc endpoint explicitly handles SOC uploads without size-based detection,
 * avoiding "stamp signature is invalid" errors for small SOCs that would be
 * misidentified as CAC by the /chunks endpoint.
 *
 * Key differences from uploadSOC:
 * - Uses /soc/{owner}/{id}?sig=... endpoint (explicit SOC handling)
 * - Does NOT pad CAC data (preserves exact payload size for v1 format)
 * - Stamps using CAC address (what /soc endpoint expects)
 */
export async function uploadSOCViaSocEndpoint(
  bee: Bee,
  stamper: Stamper,
  signer: PrivateKey,
  identifier: Identifier,
  data: Uint8Array,
  options?: UploadOptions,
): Promise<UploadSOCResult> {
  if (data.length < 1 || data.length > 4096) {
    throw new Error(`Invalid data length: ${data.length} (expected 1-4096)`)
  }

  // Build CAC data (span + payload) - NO PADDING
  // This preserves the exact size needed for v1 format (/bzz/ compatibility)
  const cac = makeContentAddressedChunk(data)
  const cacData = cac.data // span(8) + payload - NOT padded

  const owner = signer.publicKey().address()

  // Sign: hash(identifier + cac.address)
  const toSign = Binary.concatBytes(
    identifier.toUint8Array(),
    cac.address.toUint8Array(),
  )
  const signature = signer.sign(toSign)

  // Calculate SOC address (for return value)
  const socAddress = makeSOCAddress(identifier, owner.toUint8Array())

  // Debug logging for v1 format verification

  // Create tag
  const tag = options?.tag ?? (await tryCreateTag(bee))

  // Stamp using SOC address (what Bee validates for /soc endpoint)
  const envelope = stamper.stamp({
    hash: () => socAddress.toUint8Array(),
    build: () => cacData,
    span: 0n,
    writer: undefined as any,
  })

  const stampHex = Binary.uint8ArrayToHex(marshalEnvelope(envelope))

  // Build URL with signature query parameter
  const url = `${bee.url}/soc/${owner.toHex()}/${identifier.toHex()}?sig=${signature.toHex()}`

  // Prepare HTTP headers (matching uploadChunkWithFetch pattern)
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "swarm-postage-stamp": stampHex,
  }

  // Add optional headers only if defined (let Bee use defaults otherwise)
  if (tag) headers["swarm-tag"] = tag.toString()
  if (options?.deferred !== undefined) {
    headers["swarm-deferred-upload"] = options.deferred.toString()
  }
  if (options?.pin !== undefined) {
    headers["swarm-pin"] = options.pin.toString()
  }

  // Upload via /soc endpoint
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: cacData, // Raw CAC data (NOT full SOC structure)
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `SOC upload failed: ${response.status} ${response.statusText} - ${errorText}`,
    )
  }

  return {
    socAddress: socAddress.toUint8Array(),
    tagUid: tag,
  }
}
