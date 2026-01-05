/**
 * SOC (Single Owner Chunk) Upload Helper
 *
 * This file contains helpers copied from bee-js for uploading
 * Single Owner Chunks with custom identifiers (for epoch feeds).
 *
 * Based on bee-js/src/chunk/soc.ts and bee-js/src/modules/soc.ts
 */

import { Binary } from "cafe-utility"
import {
  PrivateKey,
  Identifier,
  Signature,
  EthAddress,
  Reference,
} from "@ethersphere/bee-js"

/**
 * Make SOC address from identifier and owner
 */
function makeSOCAddress(identifier: Identifier, owner: EthAddress): Reference {
  return new Reference(
    Binary.keccak256(
      Binary.concatBytes(identifier.toUint8Array(), owner.toUint8Array()),
    ),
  )
}

/**
 * Calculate BMT hash for content-addressed chunk
 * Simplified version - for small data (<4KB) just use Keccak256
 */
function calculateChunkAddress(data: Uint8Array): Uint8Array {
  // For simplicity, use Keccak256 as BMT hash
  // Full BMT implementation would be more complex
  return Binary.keccak256(data)
}

/**
 * Create content-addressed chunk from data
 */
function makeContentAddressedChunk(data: Uint8Array): {
  data: Uint8Array
  address: Uint8Array
} {
  // Prepend span (8 bytes, little-endian length)
  const span = new Uint8Array(8)
  const view = new DataView(span.buffer)
  view.setBigUint64(0, BigInt(data.length), true) // true = little-endian

  const chunkData = Binary.concatBytes(span, data)
  const address = calculateChunkAddress(chunkData)

  return { data: chunkData, address }
}

/**
 * Create Single Owner Chunk
 */
function makeSingleOwnerChunk(
  cac: { data: Uint8Array; address: Uint8Array },
  identifier: Identifier,
  signer: PrivateKey,
): {
  data: Uint8Array
  identifier: Identifier
  signature: Signature
  owner: EthAddress
  address: Reference
  span: Uint8Array
  payload: Uint8Array
} {
  const owner = signer.publicKey().address()
  const address = makeSOCAddress(identifier, owner)

  // Sign: Keccak256(identifier || chunkAddress)
  const digest = Binary.concatBytes(identifier.toUint8Array(), cac.address)
  const signature = signer.sign(digest)

  // SOC data: identifier || signature || CAC data
  const data = Binary.concatBytes(
    identifier.toUint8Array(),
    signature.toUint8Array(),
    cac.data,
  )

  // Extract span and payload from CAC data
  const span = cac.data.slice(0, 8)
  const payload = cac.data.slice(8)

  return {
    data,
    identifier,
    signature,
    owner,
    address,
    span,
    payload,
  }
}

/**
 * Upload SOC to Bee node
 */
export async function uploadSOC(
  bee: any, // Bee instance
  signer: PrivateKey,
  postageBatchId: string,
  identifier: Identifier,
  data: Uint8Array,
): Promise<{ reference: string }> {
  // Create CAC
  const cac = makeContentAddressedChunk(data)

  // Create SOC
  const soc = makeSingleOwnerChunk(cac, identifier, signer)

  // Prepare data to upload (span + payload)
  const uploadData = Binary.concatBytes(soc.span, soc.payload)

  // Make HTTP request to Bee API
  // POST /soc/{owner}/{identifier}?sig={signature}
  const url = `${bee.url}/soc/${soc.owner.toHex()}/${identifier.toHex()}?sig=${soc.signature.toHex()}`

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "swarm-postage-batch-id": postageBatchId,
      "swarm-deferred-upload": "false",
    },
    body: uploadData,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(
      `Failed to upload SOC: ${response.status} ${response.statusText}: ${text}`,
    )
  }

  const result = await response.json()
  return { reference: result.reference }
}
