import {
  EthAddress,
  Identifier,
  Reference,
  Signature,
} from "@ethersphere/bee-js"
import type {
  Bee,
  BeeRequestOptions,
  DownloadOptions,
} from "@ethersphere/bee-js"
import {
  calculateChunkAddress,
  decryptChunkData as decryptChunk,
  DEFAULT_DOWNLOAD_CONCURRENCY,
  ENCRYPTED_REF_SIZE,
  IDENTIFIER_SIZE,
  MAX_PAYLOAD_SIZE,
  SOC_HEADER_SIZE,
  SPAN_SIZE,
  UNENCRYPTED_REF_SIZE,
} from "../chunk"
import { Binary } from "cafe-utility"
import type { UploadProgress } from "./types"
import type { SingleOwnerChunk } from "../types"
import { hexToUint8Array } from "../utils/hex"

function readSpan(spanBytes: Uint8Array): number {
  const view = new DataView(
    spanBytes.buffer,
    spanBytes.byteOffset,
    spanBytes.byteLength,
  )
  return Number(view.getBigUint64(0, true))
}

function makeSocAddress(identifier: Identifier, owner: EthAddress): Reference {
  return new Reference(
    Binary.keccak256(
      Binary.concatBytes(identifier.toUint8Array(), owner.toUint8Array()),
    ),
  )
}

function makeSingleOwnerChunkFromData(
  data: Uint8Array,
  address: Reference,
  expectedOwner: EthAddress,
  encryptionKey?: Uint8Array,
): SingleOwnerChunk {
  const identifier = new Identifier(data.slice(0, IDENTIFIER_SIZE))
  const signature = Signature.fromSlice(data, IDENTIFIER_SIZE)
  const cacData = data.slice(SOC_HEADER_SIZE)
  const cacAddress = calculateChunkAddress(cacData)
  const digest = Binary.concatBytes(
    identifier.toUint8Array(),
    cacAddress.toUint8Array(),
  )
  const recoveredOwner = signature.recoverPublicKey(digest).address()

  if (!recoveredOwner.equals(expectedOwner)) {
    throw new Error("SOC owner mismatch")
  }

  const socAddress = makeSocAddress(identifier, recoveredOwner)
  if (!Binary.equals(address.toUint8Array(), socAddress.toUint8Array())) {
    throw new Error("SOC data does not match given address")
  }

  let spanBytes: Uint8Array
  let payload: Uint8Array
  let rebuiltData: Uint8Array

  if (encryptionKey) {
    const decrypted = decryptChunk(encryptionKey, cacData)
    spanBytes = decrypted.slice(0, SPAN_SIZE)
    const span = readSpan(spanBytes)
    payload = decrypted.slice(SPAN_SIZE, SPAN_SIZE + span)
    rebuiltData = Binary.concatBytes(
      identifier.toUint8Array(),
      signature.toUint8Array(),
      spanBytes,
      payload,
    )
  } else {
    spanBytes = data.slice(SOC_HEADER_SIZE, SOC_HEADER_SIZE + SPAN_SIZE)
    const span = readSpan(spanBytes)
    if (span > 4096) {
      throw new Error(
        "SOC payload length is invalid; this chunk likely requires decryption",
      )
    }
    payload = data.slice(
      SOC_HEADER_SIZE + SPAN_SIZE,
      SOC_HEADER_SIZE + SPAN_SIZE + span,
    )
    rebuiltData = data
  }

  const span = readSpan(spanBytes)

  return {
    data: rebuiltData,
    identifier: identifier.toHex(),
    signature: signature.toHex(),
    span,
    payload,
    address: address.toHex(),
    owner: recoveredOwner.toHex(),
  }
}

/**
 * Represents a reference with optional encryption key
 */
interface ChunkRef {
  address: Uint8Array
  encryptionKey?: Uint8Array
}

/**
 * Parse a reference string into address and optional encryption key
 */
function parseReference(reference: string): ChunkRef {
  const refBytes = hexToUint8Array(reference)

  if (refBytes.length === UNENCRYPTED_REF_SIZE) {
    return { address: refBytes }
  } else if (refBytes.length === ENCRYPTED_REF_SIZE) {
    return {
      address: refBytes.slice(0, UNENCRYPTED_REF_SIZE),
      encryptionKey: refBytes.slice(UNENCRYPTED_REF_SIZE),
    }
  }

  throw new Error(
    `Invalid reference length: ${refBytes.length}, expected ${UNENCRYPTED_REF_SIZE} or ${ENCRYPTED_REF_SIZE}`,
  )
}

/**
 * Extract references from an intermediate chunk payload
 */
function extractReferences(
  payload: Uint8Array,
  totalSpan: number,
  isEncrypted: boolean,
): ChunkRef[] {
  const refs: ChunkRef[] = []
  const refSize = isEncrypted ? ENCRYPTED_REF_SIZE : UNENCRYPTED_REF_SIZE

  // Calculate actual number of refs based on payload content
  // For encrypted, refs are 64 bytes each; for unencrypted, 32 bytes each
  const maxRefs = Math.floor(payload.length / refSize)

  // Calculate expected number of refs based on span
  // Each leaf chunk can hold up to MAX_PAYLOAD_SIZE bytes
  const expectedLeafChunks = Math.ceil(totalSpan / MAX_PAYLOAD_SIZE)

  // We need to determine how many refs are actually in this chunk
  // For intermediate chunks at higher levels, the number of children varies
  const numRefs = Math.min(maxRefs, expectedLeafChunks)

  for (let i = 0; i < numRefs; i++) {
    const offset = i * refSize
    if (offset + refSize > payload.length) break

    const address = payload.slice(offset, offset + UNENCRYPTED_REF_SIZE)

    // Check if this is a zero address (padding)
    if (address.every((b) => b === 0)) break

    if (isEncrypted) {
      const key = payload.slice(
        offset + UNENCRYPTED_REF_SIZE,
        offset + ENCRYPTED_REF_SIZE,
      )
      refs.push({ address, encryptionKey: key })
    } else {
      refs.push({ address })
    }
  }

  return refs
}

/**
 * Download and process a single chunk
 */
async function downloadAndProcessChunk(
  bee: Bee,
  ref: ChunkRef,
  requestOptions?: BeeRequestOptions,
): Promise<{ span: number; payload: Uint8Array }> {
  const addressHex = Binary.uint8ArrayToHex(ref.address)
  const rawChunk = await bee.downloadChunk(
    addressHex,
    undefined,
    requestOptions,
  )

  let chunkData: Uint8Array
  if (ref.encryptionKey) {
    chunkData = decryptChunk(ref.encryptionKey, rawChunk)
  } else {
    chunkData = rawChunk
  }

  const span = readSpan(chunkData.slice(0, SPAN_SIZE))
  const payload = chunkData.slice(SPAN_SIZE)

  return { span, payload }
}

/**
 * Recursively join chunks to reconstruct data
 * Uses parallel fetching for performance
 */
async function joinChunks(
  bee: Bee,
  ref: ChunkRef,
  isEncrypted: boolean,
  concurrency: number,
  onChunkDownloaded: () => void,
  requestOptions?: BeeRequestOptions,
): Promise<Uint8Array> {
  const { span, payload } = await downloadAndProcessChunk(
    bee,
    ref,
    requestOptions,
  )
  onChunkDownloaded()

  // Leaf chunk: data is in payload
  if (span <= MAX_PAYLOAD_SIZE) {
    return payload.slice(0, span)
  }

  // Intermediate chunk: contains references to other chunks
  const childRefs = extractReferences(payload, span, isEncrypted)

  if (childRefs.length === 0) {
    throw new Error("No valid references found in intermediate chunk")
  }

  // Download children in parallel with concurrency limit
  const results: Uint8Array[] = new Array(childRefs.length)

  // Process in batches respecting concurrency limit
  for (let i = 0; i < childRefs.length; i += concurrency) {
    const batch = childRefs.slice(
      i,
      Math.min(i + concurrency, childRefs.length),
    )
    const batchResults = await Promise.all(
      batch.map((childRef) =>
        joinChunks(
          bee,
          childRef,
          isEncrypted,
          concurrency,
          onChunkDownloaded,
          requestOptions,
        ),
      ),
    )
    for (let j = 0; j < batchResults.length; j++) {
      results[i + j] = batchResults[j]
    }
  }

  // Concatenate all results
  const totalLength = results.reduce((sum, r) => sum + r.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of results) {
    result.set(chunk, offset)
    offset += chunk.length
  }

  return result
}

/**
 * Estimate total chunks for progress tracking
 * This is an approximation based on span
 */
function estimateTotalChunks(span: number): number {
  if (span <= MAX_PAYLOAD_SIZE) {
    return 1
  }

  // Number of leaf chunks
  const leafChunks = Math.ceil(span / MAX_PAYLOAD_SIZE)

  // For a full binary tree with 64-way branching, intermediate chunks
  // This is a rough estimate - actual count depends on tree structure
  let intermediateChunks = 0
  let level = leafChunks
  while (level > 1) {
    const branchingFactor = 64 // REFS_PER_CHUNK
    level = Math.ceil(level / branchingFactor)
    intermediateChunks += level
  }

  return leafChunks + intermediateChunks
}

/**
 * Download data using only the chunk API
 * This ensures encrypted data remains encrypted during transmission and avoids metadata leakage
 *
 * Supports both:
 * - Regular references (64 hex chars = 32 bytes)
 * - Encrypted references (128 hex chars = 64 bytes: 32-byte address + 32-byte encryption key)
 */
export async function downloadDataWithChunkAPI(
  bee: Bee,
  reference: string,
  _options?: DownloadOptions,
  onProgress?: (progress: UploadProgress) => void,
  requestOptions?: BeeRequestOptions,
): Promise<Uint8Array> {
  const rootRef = parseReference(reference)
  const isEncrypted = rootRef.encryptionKey !== undefined

  // First, download root chunk to get span for progress estimation
  const { span, payload } = await downloadAndProcessChunk(
    bee,
    rootRef,
    requestOptions,
  )

  // For leaf chunks (small data), return immediately
  if (span <= MAX_PAYLOAD_SIZE) {
    if (onProgress) {
      onProgress({ total: 1, processed: 1 })
    }
    return payload.slice(0, span)
  }

  // Estimate total chunks for progress tracking
  const estimatedTotal = estimateTotalChunks(span)
  let processedChunks = 1 // Already downloaded root

  const onChunkDownloaded = () => {
    processedChunks++
    if (onProgress) {
      onProgress({ total: estimatedTotal, processed: processedChunks })
    }
  }

  // Report initial progress
  if (onProgress) {
    onProgress({ total: estimatedTotal, processed: 1 })
  }

  // Extract child references and join recursively
  const childRefs = extractReferences(payload, span, isEncrypted)

  if (childRefs.length === 0) {
    throw new Error("No valid references found in root chunk")
  }

  // Download children in parallel
  const results: Uint8Array[] = new Array(childRefs.length)

  for (let i = 0; i < childRefs.length; i += DEFAULT_DOWNLOAD_CONCURRENCY) {
    const batch = childRefs.slice(
      i,
      Math.min(i + DEFAULT_DOWNLOAD_CONCURRENCY, childRefs.length),
    )
    const batchResults = await Promise.all(
      batch.map((childRef) =>
        joinChunks(
          bee,
          childRef,
          isEncrypted,
          DEFAULT_DOWNLOAD_CONCURRENCY,
          onChunkDownloaded,
          requestOptions,
        ),
      ),
    )
    for (let j = 0; j < batchResults.length; j++) {
      results[i + j] = batchResults[j]
    }
  }

  // Concatenate all results
  const totalLength = results.reduce((sum, r) => sum + r.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of results) {
    result.set(chunk, offset)
    offset += chunk.length
  }

  // Final progress update
  if (onProgress) {
    onProgress({ total: processedChunks, processed: processedChunks })
  }

  return result
}

export async function downloadSOC(
  bee: Bee,
  owner: string | Uint8Array | EthAddress,
  identifier: string | Uint8Array | Identifier,
  requestOptions?: BeeRequestOptions,
): Promise<SingleOwnerChunk> {
  const ownerAddress = new EthAddress(owner)
  const id = new Identifier(identifier)
  const socAddress = makeSocAddress(id, ownerAddress)

  const data = await bee.downloadChunk(
    socAddress.toHex(),
    undefined,
    requestOptions,
  )

  return makeSingleOwnerChunkFromData(data, socAddress, ownerAddress)
}

export async function downloadEncryptedSOC(
  bee: Bee,
  owner: string | Uint8Array | EthAddress,
  identifier: string | Uint8Array | Identifier,
  encryptionKey: string | Uint8Array,
  requestOptions?: BeeRequestOptions,
): Promise<SingleOwnerChunk> {
  const ownerAddress = new EthAddress(owner)
  const id = new Identifier(identifier)
  const socAddress = makeSocAddress(id, ownerAddress)
  const keyBytes =
    typeof encryptionKey === "string"
      ? hexToUint8Array(encryptionKey)
      : encryptionKey

  const data = await bee.downloadChunk(
    socAddress.toHex(),
    undefined,
    requestOptions,
  )

  return makeSingleOwnerChunkFromData(data, socAddress, ownerAddress, keyBytes)
}
