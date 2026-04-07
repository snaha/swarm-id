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
} from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import {
  makeContentAddressedChunk,
  makeEncryptedContentAddressedChunk,
} from "../chunk"
import { splitDataIntoChunks, buildMerkleTree } from "./chunking"
import { saveMantarayTreeRecursively } from "./mantaray"
import { hexToUint8Array } from "../utils/hex"
import type { ChunkReference } from "./types"

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
