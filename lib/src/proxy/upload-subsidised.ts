// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Subsidised gateway upload helpers.
 *
 * These functions upload data to a subsidised gateway that handles stamping
 * server-side. They do NOT require a postage batch ID.
 */

import { PrivateKey, Identifier } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import {
  makeContentAddressedChunk,
  makeEncryptedContentAddressedChunk,
} from "../chunk"

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

  // Build URL with signature query parameter
  const url = `${subsidisedGatewayUrl}/soc/${owner.toHex()}/${identifier.toHex()}?sig=${signature.toHex()}`

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

  // Build URL with signature query parameter
  const url = `${subsidisedGatewayUrl}/soc/${owner.toHex()}/${identifier.toHex()}?sig=${signature.toHex()}`

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
 * Upload data via the subsidised gateway using direct HTTP.
 * The gateway handles stamping - we don't provide a postage batch ID.
 */
export async function uploadDataViaSubsidisedGateway(
  subsidisedGatewayUrl: string,
  data: Uint8Array,
  options?: {
    pin?: boolean
    encrypt?: boolean
    deferred?: boolean
    redundancyLevel?: number
  },
): Promise<{ reference: string; tagUid?: number }> {
  // Build URL - use /bytes endpoint for raw data upload
  const url = `${subsidisedGatewayUrl}/bytes`

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
  if (options?.encrypt !== undefined) {
    headers["swarm-encrypt"] = options.encrypt.toString()
  }
  if (options?.redundancyLevel !== undefined) {
    headers["swarm-redundancy-level"] = options.redundancyLevel.toString()
  }

  // Upload via /bytes endpoint
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: data,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Subsidised data upload failed: ${response.status} ${response.statusText} - ${errorText}`,
    )
  }

  const result = await response.json()
  return {
    reference: result.reference,
    tagUid: result.tagUid,
  }
}

/**
 * Upload file via the subsidised gateway using direct HTTP.
 * The gateway handles stamping - we don't provide a postage batch ID.
 */
export async function uploadFileViaSubsidisedGateway(
  subsidisedGatewayUrl: string,
  data: Uint8Array,
  fileName: string,
  options?: {
    pin?: boolean
    encrypt?: boolean
    deferred?: boolean
    redundancyLevel?: number
    contentType?: string
  },
): Promise<{ reference: string; tagUid?: number }> {
  // Build URL - use /bzz endpoint for file upload with manifest
  const encodedFileName = encodeURIComponent(fileName)
  const url = `${subsidisedGatewayUrl}/bzz?name=${encodedFileName}`

  // Prepare HTTP headers - NO stamp header, gateway handles stamping
  const headers: Record<string, string> = {
    "content-type": options?.contentType || "application/octet-stream",
  }

  if (options?.deferred !== undefined) {
    headers["swarm-deferred-upload"] = options.deferred.toString()
  }
  if (options?.pin !== undefined) {
    headers["swarm-pin"] = options.pin.toString()
  }
  if (options?.encrypt !== undefined) {
    headers["swarm-encrypt"] = options.encrypt.toString()
  }
  if (options?.redundancyLevel !== undefined) {
    headers["swarm-redundancy-level"] = options.redundancyLevel.toString()
  }

  // Upload via /bzz endpoint
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: data,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Subsidised file upload failed: ${response.status} ${response.statusText} - ${errorText}`,
    )
  }

  const result = await response.json()
  return {
    reference: result.reference,
    tagUid: result.tagUid,
  }
}
