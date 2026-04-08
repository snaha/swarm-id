// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Subsidised gateway upload helpers.
 *
 * These functions upload data to a subsidised gateway that handles stamping
 * server-side. They do NOT require a postage batch ID.
 *
 * IMPORTANT: This module uses /chunks and /soc endpoints ONLY.
 * Never use /bytes or /bzz - the subsidised gateway may not support them.
 */

import {
  PrivateKey,
  Identifier,
  MantarayNode,
  NULL_ADDRESS,
  Reference,
  Span,
} from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import {
  makeContentAddressedChunk,
  makeEncryptedContentAddressedChunk,
  calculateChunkAddress,
  newChunkEncrypter,
} from "../chunk"
import { splitDataIntoChunks, buildMerkleTree } from "./chunking"
import { ENCRYPTED_REFS_PER_CHUNK } from "./chunking-encrypted"
import { saveMantarayTreeRecursively } from "./mantaray"
import { hexToUint8Array } from "../utils/hex"
import type { ChunkReference, UploadProgress } from "./types"

/**
 * Normalize a URL by removing trailing slash.
 * Prevents double-slash issues when concatenating with endpoint paths.
 */
function normalizeUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url
}

/**
 * Upload a Single Owner Chunk via the subsidised gateway.
 * The gateway handles stamping - we just sign the SOC and upload.
 */
export async function uploadSocViaSubsidisedGateway(
  subsidisedGatewayUrl: string,
  signer: PrivateKey,
  identifier: Identifier,
  data: Uint8Array,
  options?: { pin?: boolean; deferred?: boolean },
): Promise<{ socAddress: Uint8Array; tagUid?: number }> {
  // Build CAC data (span + payload)
  const cac = makeContentAddressedChunk(data)
  const cacData = cac.data

  const owner = signer.publicKey().address()

  // Sign: hash(identifier + cac.address)
  const toSign = Binary.concatBytes(
    identifier.toUint8Array(),
    cac.address.toUint8Array(),
  )
  const signature = signer.sign(toSign)

  // Calculate SOC address
  const socAddressBytes = Binary.keccak256(
    Binary.concatBytes(identifier.toUint8Array(), owner.toUint8Array()),
  )

  // Build URL with signature query parameter (normalize to prevent double slashes)
  const url = `${normalizeUrl(subsidisedGatewayUrl)}/soc/${owner.toHex()}/${identifier.toHex()}?sig=${signature.toHex()}`

  // Prepare HTTP headers - NO stamp header, gateway handles stamping
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
  }

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
    body: cacData,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Subsidised SOC upload failed: ${response.status} ${response.statusText} - ${errorText}`,
    )
  }

  return {
    socAddress: socAddressBytes,
  }
}

/**
 * Upload an encrypted Single Owner Chunk via the subsidised gateway.
 * Encrypts the data, signs the SOC, and uploads - gateway handles stamping.
 */
export async function uploadEncryptedSocViaSubsidisedGateway(
  subsidisedGatewayUrl: string,
  signer: PrivateKey,
  identifier: Identifier,
  data: Uint8Array,
  encryptionKey?: Uint8Array,
  options?: { pin?: boolean; deferred?: boolean },
): Promise<{
  socAddress: Uint8Array
  encryptionKey: Uint8Array
  tagUid?: number
}> {
  // Create encrypted content-addressed chunk
  const encryptedChunk = makeEncryptedContentAddressedChunk(data, encryptionKey)

  const owner = signer.publicKey().address()

  // Sign: hash(identifier + encryptedChunk.address)
  const toSign = Binary.concatBytes(
    identifier.toUint8Array(),
    encryptedChunk.address.toUint8Array(),
  )
  const signature = signer.sign(toSign)

  // Calculate SOC address
  const socAddressBytes = Binary.keccak256(
    Binary.concatBytes(identifier.toUint8Array(), owner.toUint8Array()),
  )

  // Build URL with signature query parameter (normalize to prevent double slashes)
  const url = `${normalizeUrl(subsidisedGatewayUrl)}/soc/${owner.toHex()}/${identifier.toHex()}?sig=${signature.toHex()}`

  // Prepare HTTP headers - NO stamp header, gateway handles stamping
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
  }

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
    body: encryptedChunk.data,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Subsidised encrypted SOC upload failed: ${response.status} ${response.statusText} - ${errorText}`,
    )
  }

  return {
    socAddress: socAddressBytes,
    encryptionKey: encryptedChunk.encryptionKey,
  }
}

/**
 * Upload a single pre-built chunk via the subsidised gateway.
 * The gateway handles stamping - we just send the chunk data.
 *
 * @param subsidisedGatewayUrl - Gateway URL
 * @param chunkData - Full chunk data (span + payload, 8 + 1-4096 bytes)
 * @param options - Upload options
 * @returns The chunk reference
 */
export async function uploadChunkViaSubsidisedGateway(
  subsidisedGatewayUrl: string,
  chunkData: Uint8Array,
  options?: { pin?: boolean; deferred?: boolean },
): Promise<{ reference: string }> {
  const url = `${normalizeUrl(subsidisedGatewayUrl)}/chunks`

  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
  }

  if (options?.deferred !== undefined) {
    headers["swarm-deferred-upload"] = options.deferred.toString()
  }
  if (options?.pin !== undefined) {
    headers["swarm-pin"] = options.pin.toString()
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: chunkData,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Subsidised chunk upload failed: ${response.status} ${response.statusText} - ${errorText}`,
    )
  }

  const result = await response.json()
  return { reference: result.reference }
}

/**
 * Upload data via the subsidised gateway using /chunks endpoint.
 *
 * This function splits data into chunks locally, creates content-addressed
 * chunks, uploads them via /chunks, and builds a merkle tree for large data.
 *
 * The gateway handles stamping - we don't provide a postage batch ID.
 *
 * NOTE: The encrypt option is not supported with subsidised gateway.
 * Encryption must be done client-side before calling this function.
 */
export async function uploadDataViaSubsidisedGateway(
  subsidisedGatewayUrl: string,
  data: Uint8Array,
  options?: {
    pin?: boolean
    deferred?: boolean
    redundancyLevel?: number
  },
): Promise<{ reference: string; tagUid?: number }> {
  // Split data into 4096-byte payloads
  const chunkPayloads = splitDataIntoChunks(data)

  // Create CAC for each payload and upload
  const chunkRefs: ChunkReference[] = []

  for (const payload of chunkPayloads) {
    const chunk = makeContentAddressedChunk(payload)
    await uploadChunkViaSubsidisedGateway(
      subsidisedGatewayUrl,
      chunk.data,
      options,
    )
    chunkRefs.push({ address: chunk.address.toUint8Array() })
  }

  // If single chunk, return its reference directly
  if (chunkRefs.length === 1) {
    return {
      reference: uint8ArrayToHex(chunkRefs[0].address),
    }
  }

  // Build merkle tree for multiple chunks
  const rootRef = await buildMerkleTree(
    chunkRefs,
    async (intermediateChunk) => {
      await uploadChunkViaSubsidisedGateway(
        subsidisedGatewayUrl,
        intermediateChunk.data,
        options,
      )
    },
  )

  return { reference: rootRef.toHex() }
}

/**
 * Convert Uint8Array to hex string.
 */
function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Result of uploading encrypted data via subsidised gateway
 */
export interface UploadEncryptedDataSubsidisedResult {
  reference: string // 64-byte reference as hex: address (32) + encryption key (32)
  tagUid?: number
}

/**
 * Encrypted chunk reference for building merkle tree
 */
interface EncryptedChunkRef {
  address: Uint8Array // 32-byte address
  key: Uint8Array // 32-byte encryption key
  span: bigint // Span of the original data
}

/**
 * Upload encrypted data via the subsidised gateway using /chunks endpoint.
 *
 * This function:
 * 1. Splits data into 4096-byte payloads
 * 2. Encrypts each payload client-side (generates random key per chunk)
 * 3. Uploads encrypted chunks via /chunks endpoint (gateway handles stamping)
 * 4. Builds encrypted merkle tree for multi-chunk data
 *
 * Returns a 64-byte encrypted reference: address (32) + encryption key (32)
 *
 * @param subsidisedGatewayUrl - Gateway URL
 * @param data - Raw data to encrypt and upload
 * @param encryptionKey - Optional encryption key (32 bytes) for single chunk.
 *                        For multi-chunk data, this is ignored and random keys are used.
 * @param options - Upload options
 * @param onProgress - Progress callback
 */
export async function uploadEncryptedDataViaSubsidisedGateway(
  subsidisedGatewayUrl: string,
  data: Uint8Array,
  encryptionKey?: Uint8Array,
  options?: { pin?: boolean; deferred?: boolean },
  onProgress?: (progress: UploadProgress) => void,
): Promise<UploadEncryptedDataSubsidisedResult> {
  // Split data into 4096-byte payloads
  const payloads = splitDataIntoChunks(data)

  // Encrypt each payload and collect references
  const encryptedChunks: Array<{
    data: Uint8Array
    address: Uint8Array
    key: Uint8Array
  }> = []
  const encryptedRefs: EncryptedChunkRef[] = []

  for (const payload of payloads) {
    // Use provided key for single chunk, or let makeEncryptedContentAddressedChunk generate random key
    const chunk = makeEncryptedContentAddressedChunk(
      payload,
      payloads.length === 1 ? encryptionKey : undefined,
    )
    encryptedChunks.push({
      data: chunk.data,
      address: chunk.address.toUint8Array(),
      key: chunk.encryptionKey,
    })
    encryptedRefs.push({
      address: chunk.address.toUint8Array(),
      key: chunk.encryptionKey,
      span: BigInt(payload.length),
    })
  }

  // Track progress
  const totalChunks = encryptedChunks.length
  let processedChunks = 0

  // Upload all encrypted chunks
  for (const chunk of encryptedChunks) {
    await uploadChunkViaSubsidisedGateway(subsidisedGatewayUrl, chunk.data, {
      ...options,
    })
    processedChunks++
    onProgress?.({ total: totalChunks, processed: processedChunks })
  }

  // If single chunk, return 64-byte reference directly
  if (encryptedRefs.length === 1) {
    const ref = new Uint8Array(64)
    ref.set(encryptedRefs[0].address, 0)
    ref.set(encryptedRefs[0].key, 32)
    return { reference: uint8ArrayToHex(ref) }
  }

  // Build encrypted merkle tree for multiple chunks
  const rootRef = await buildEncryptedMerkleTreeSubsidised(
    encryptedRefs,
    async (chunkData) => {
      await uploadChunkViaSubsidisedGateway(subsidisedGatewayUrl, chunkData, {
        ...options,
      })
    },
  )

  return { reference: rootRef.toHex() }
}

/**
 * Build encrypted merkle tree and upload intermediate chunks via subsidised gateway.
 *
 * This is adapted from chunking-encrypted.ts but uses the subsidised gateway for uploads.
 */
async function buildEncryptedMerkleTreeSubsidised(
  encryptedChunks: EncryptedChunkRef[],
  onChunk: (encryptedChunkData: Uint8Array) => Promise<void>,
): Promise<Reference> {
  // Single chunk case
  if (encryptedChunks.length === 1) {
    const ref = new Uint8Array(64)
    ref.set(encryptedChunks[0].address, 0)
    ref.set(encryptedChunks[0].key, 32)
    return new Reference(ref)
  }

  // Multi-chunk case: build intermediate chunks
  const intermediateChunks: EncryptedChunkRef[] = []

  for (let i = 0; i < encryptedChunks.length; i += ENCRYPTED_REFS_PER_CHUNK) {
    const refs = encryptedChunks.slice(
      i,
      Math.min(i + ENCRYPTED_REFS_PER_CHUNK, encryptedChunks.length),
    )

    // Calculate total span from all children
    const totalSpan = refs.reduce((sum, ref) => sum + ref.span, 0n)

    // Build intermediate chunk payload containing all 64-byte references
    // Pad to 4096 bytes with zeros BEFORE encryption
    const payload = new Uint8Array(4096)
    refs.forEach((ref, idx) => {
      payload.set(ref.address, idx * 64)
      payload.set(ref.key, idx * 64 + 32)
    })

    // Create chunk with correct span + payload
    const spanBytes = Span.fromBigInt(totalSpan).toUint8Array()
    const chunkData = Binary.concatBytes(spanBytes, payload)

    // Encrypt the chunk
    const encrypter = newChunkEncrypter()
    const { key, encryptedSpan, encryptedData } =
      encrypter.encryptChunk(chunkData)
    const encryptedChunkData = Binary.concatBytes(encryptedSpan, encryptedData)

    // Calculate address from encrypted chunk
    const address = await calculateChunkAddress(encryptedChunkData)

    // Upload the encrypted chunk
    await onChunk(encryptedChunkData)

    // Store reference
    intermediateChunks.push({
      address: address.toUint8Array(),
      key,
      span: totalSpan,
    })
  }

  // Recursively build tree if needed
  if (intermediateChunks.length > 1) {
    return buildEncryptedMerkleTreeSubsidised(intermediateChunks, onChunk)
  }

  // Return root reference (64 bytes)
  const rootRef = new Uint8Array(64)
  rootRef.set(intermediateChunks[0].address, 0)
  rootRef.set(intermediateChunks[0].key, 32)
  return new Reference(rootRef)
}

/**
 * Upload file via the subsidised gateway using /chunks endpoint.
 *
 * This function:
 * 1. Uploads file content via uploadDataViaSubsidisedGateway
 * 2. Builds a Mantaray manifest with proper metadata
 * 3. Uploads the manifest tree via /chunks
 *
 * The gateway handles stamping - we don't provide a postage batch ID.
 *
 * NOTE: The encrypt option is not supported with subsidised gateway.
 * Encryption must be done client-side before calling this function.
 */
export async function uploadFileViaSubsidisedGateway(
  subsidisedGatewayUrl: string,
  data: Uint8Array,
  fileName: string,
  options?: {
    pin?: boolean
    deferred?: boolean
    redundancyLevel?: number
    contentType?: string
  },
): Promise<{ reference: string; tagUid?: number }> {
  // 1. Upload file content
  const contentResult = await uploadDataViaSubsidisedGateway(
    subsidisedGatewayUrl,
    data,
    options,
  )
  const contentRefBytes = hexToUint8Array(contentResult.reference)

  // 2. Build manifest with fileName (matching handleUploadFile pattern)
  const manifest = new MantarayNode()

  // Add file fork with content-type and filename metadata
  manifest.addFork(fileName, contentRefBytes, {
    "Content-Type": options?.contentType || "application/octet-stream",
    Filename: fileName,
  })

  // Add root fork with website-index-document pointing to fileName
  manifest.addFork("/", NULL_ADDRESS, {
    "website-index-document": fileName,
  })

  // 3. Upload manifest tree using saveMantarayTreeRecursively
  const result = await saveMantarayTreeRecursively(
    manifest,
    async (nodeData) => {
      const chunk = makeContentAddressedChunk(nodeData)
      await uploadChunkViaSubsidisedGateway(
        subsidisedGatewayUrl,
        chunk.data,
        options,
      )
      return { reference: chunk.address.toHex() }
    },
  )

  return { reference: result.rootReference }
}
