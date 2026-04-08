// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Legacy wrappers for backward compatibility.
 *
 * These functions wrap the new unified upload API to maintain
 * backward compatibility with existing code.
 *
 * For new code, prefer using the unified API from ./upload.ts:
 *   - uploadData() for all data uploads
 *   - uploadSOC() for all SOC uploads
 *   - uploadChunk() for single chunk uploads
 */

import type {
  Bee,
  BeeRequestOptions,
  Stamper,
  UploadOptions,
} from "@ethersphere/bee-js"
import {
  PrivateKey,
  Identifier,
  MantarayNode,
  NULL_ADDRESS,
} from "@ethersphere/bee-js"
import { makeContentAddressedChunk, type ContentAddressedChunk } from "../chunk"
import { uploadData, uploadSOC, uploadChunk, type UploadTarget } from "./upload"
import type {
  UploadContext,
  UploadProgress,
  WebSocketUploadOptions,
} from "./types"
import { saveMantarayTreeRecursively } from "./mantaray"
import { hexToUint8Array } from "../utils/hex"

// ============================================================================
// Data Upload Wrappers (upload-data.ts)
// ============================================================================

/**
 * Upload data with client-side signing
 * @deprecated Use uploadData() from ./upload.ts instead
 */
export async function uploadDataWithSigning(
  context: UploadContext,
  data: Uint8Array,
  options?: UploadOptions,
  onProgress?: (progress: UploadProgress) => void,
  requestOptions?: BeeRequestOptions,
): Promise<{ reference: string; tagUid?: number }> {
  const target: UploadTarget = {
    mode: "stamper",
    bee: context.bee,
    stamper: context.stamper,
    workerPool: context.workerPool,
  }

  const result = await uploadData(target, data, {
    pin: options?.pin,
    deferred: options?.deferred,
    tag: options?.tag,
    onProgress,
    requestOptions,
  })

  return { reference: result.reference, tagUid: result.tagUid }
}

/**
 * Upload a single chunk with optional signing
 * @deprecated Use uploadChunk() from ./upload.ts instead
 */
export async function uploadSingleChunk(
  bee: Bee,
  stamper: Stamper | undefined,
  chunk: ContentAddressedChunk,
  options?: UploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<{ reference: { toHex(): string } }> {
  if (!stamper) {
    throw new Error("No stamper or batch ID available")
  }

  const target: UploadTarget = {
    mode: "stamper",
    bee,
    stamper,
  }

  const result = await uploadChunk(target, chunk.data, {
    pin: options?.pin,
    deferred: options?.deferred,
    tag: options?.tag,
    requestOptions,
  })

  return {
    reference: {
      toHex: () => result.reference,
    },
  }
}

// ============================================================================
// Encrypted Data Upload Wrappers (upload-encrypted-data.ts)
// ============================================================================

/**
 * Result of uploading encrypted data
 */
export interface UploadEncryptedDataResult {
  reference: string
  tagUid?: number
  chunkAddresses: Uint8Array[]
}

/**
 * Upload encrypted data with client-side signing
 * @deprecated Use uploadData() with encryptionKey option instead
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
  const target: UploadTarget = {
    mode: "stamper",
    bee: context.bee,
    stamper: context.stamper,
    workerPool: context.workerPool,
  }

  const result = await uploadData(target, data, {
    encryptionKey: encryptionKey ?? true,
    pin: options?.pin,
    deferred: options?.deferred,
    tag: options?.tag,
    webSocket,
    httpConcurrency,
    onProgress,
    requestOptions,
  })

  return {
    reference: result.reference,
    tagUid: result.tagUid,
    chunkAddresses: result.chunkAddresses ?? [],
  }
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
export interface LegacyUploadSOCResult {
  socAddress: Uint8Array
  tagUid?: number
}

/**
 * Upload an encrypted Single Owner Chunk via the /soc endpoint
 * @deprecated Use uploadSOC() with encryptionKey option instead
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
  const target: UploadTarget = {
    mode: "stamper",
    bee,
    stamper,
  }

  const result = await uploadSOC(target, signer, identifier, data, {
    encryptionKey,
    pin: options?.pin,
    deferred: options?.deferred,
    tag: options?.tag,
  })

  return {
    socAddress: result.socAddress,
    encryptionKey: result.encryptionKey!,
    tagUid: result.tagUid,
  }
}

/**
 * Upload a plain Single Owner Chunk via the /soc endpoint
 * @deprecated Use uploadSOC() instead
 */
export async function uploadSOCLegacy(
  bee: Bee,
  stamper: Stamper,
  signer: PrivateKey,
  identifier: Identifier,
  data: Uint8Array,
  options?: UploadOptions,
): Promise<LegacyUploadSOCResult> {
  const target: UploadTarget = {
    mode: "stamper",
    bee,
    stamper,
  }

  const result = await uploadSOC(target, signer, identifier, data, {
    pin: options?.pin,
    deferred: options?.deferred,
    tag: options?.tag,
  })

  return {
    socAddress: result.socAddress,
    tagUid: result.tagUid,
  }
}

/**
 * Upload SOC via the /soc/{owner}/{id} endpoint
 * @deprecated Use uploadSOC() instead
 */
export async function uploadSOCViaSocEndpoint(
  bee: Bee,
  stamper: Stamper,
  signer: PrivateKey,
  identifier: Identifier,
  data: Uint8Array,
  options?: UploadOptions,
): Promise<LegacyUploadSOCResult> {
  // This is the same as uploadSOCLegacy - the original distinction
  // was about how the data was padded, but the unified API handles this
  return uploadSOCLegacy(bee, stamper, signer, identifier, data, options)
}

// ============================================================================
// Subsidised Gateway Wrappers (upload-subsidised.ts)
// ============================================================================

/**
 * Upload a Single Owner Chunk via the subsidised gateway
 * @deprecated Use uploadSOC() with subsidised target instead
 */
export async function uploadSocViaSubsidisedGateway(
  subsidisedGatewayUrl: string,
  signer: PrivateKey,
  identifier: Identifier,
  data: Uint8Array,
  options?: { pin?: boolean; deferred?: boolean },
): Promise<{ socAddress: Uint8Array; tagUid?: number }> {
  const target: UploadTarget = {
    mode: "subsidised",
    gatewayUrl: subsidisedGatewayUrl,
  }

  const result = await uploadSOC(target, signer, identifier, data, {
    pin: options?.pin,
    deferred: options?.deferred,
  })

  return {
    socAddress: result.socAddress,
  }
}

/**
 * Upload an encrypted Single Owner Chunk via the subsidised gateway
 * @deprecated Use uploadSOC() with subsidised target and encryptionKey option instead
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
  const target: UploadTarget = {
    mode: "subsidised",
    gatewayUrl: subsidisedGatewayUrl,
  }

  const result = await uploadSOC(target, signer, identifier, data, {
    encryptionKey,
    pin: options?.pin,
    deferred: options?.deferred,
  })

  return {
    socAddress: result.socAddress,
    encryptionKey: result.encryptionKey!,
  }
}

/**
 * Upload a single pre-built chunk via the subsidised gateway
 * @deprecated Use uploadChunk() with subsidised target instead
 */
export async function uploadChunkViaSubsidisedGateway(
  subsidisedGatewayUrl: string,
  chunkData: Uint8Array,
  options?: { pin?: boolean; deferred?: boolean },
): Promise<{ reference: string }> {
  const target: UploadTarget = {
    mode: "subsidised",
    gatewayUrl: subsidisedGatewayUrl,
  }

  return uploadChunk(target, chunkData, {
    pin: options?.pin,
    deferred: options?.deferred,
  })
}

/**
 * Upload data via the subsidised gateway using /chunks endpoint
 * @deprecated Use uploadData() with subsidised target instead
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
  const target: UploadTarget = {
    mode: "subsidised",
    gatewayUrl: subsidisedGatewayUrl,
  }

  const result = await uploadData(target, data, {
    pin: options?.pin,
    deferred: options?.deferred,
  })

  return { reference: result.reference }
}

/**
 * Result of uploading encrypted data via subsidised gateway
 */
export interface UploadEncryptedDataSubsidisedResult {
  reference: string
  tagUid?: number
}

/**
 * Upload encrypted data via the subsidised gateway using /chunks endpoint
 * @deprecated Use uploadData() with subsidised target and encryptionKey option instead
 */
export async function uploadEncryptedDataViaSubsidisedGateway(
  subsidisedGatewayUrl: string,
  data: Uint8Array,
  encryptionKey?: Uint8Array,
  options?: { pin?: boolean; deferred?: boolean },
  onProgress?: (progress: UploadProgress) => void,
): Promise<UploadEncryptedDataSubsidisedResult> {
  const target: UploadTarget = {
    mode: "subsidised",
    gatewayUrl: subsidisedGatewayUrl,
  }

  const result = await uploadData(target, data, {
    encryptionKey: encryptionKey ?? true,
    pin: options?.pin,
    deferred: options?.deferred,
    onProgress,
  })

  return { reference: result.reference }
}

/**
 * Upload file via the subsidised gateway using /chunks endpoint
 * @deprecated Consider using uploadData() with a custom manifest builder
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

  // 2. Build manifest with fileName
  const manifest = new MantarayNode()

  manifest.addFork(fileName, contentRefBytes, {
    "Content-Type": options?.contentType || "application/octet-stream",
    Filename: fileName,
  })

  manifest.addFork("/", NULL_ADDRESS, {
    "website-index-document": fileName,
  })

  // 3. Upload manifest tree
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

// ============================================================================
// Additional helper exports for upload-encrypted-data.ts compatibility
// ============================================================================

/**
 * Upload a single encrypted chunk with client-side signing via HTTP
 * @deprecated Use uploadChunk() instead
 */
export { uploadSingleChunk as uploadSingleEncryptedChunk }

/**
 * Upload a single chunk with encryption
 * @deprecated Use makeEncryptedContentAddressedChunk + uploadChunk instead
 */
export async function uploadSingleChunkWithEncryption(
  bee: Bee,
  stamper: Stamper,
  payload: Uint8Array,
  encryptionKey: Uint8Array,
  options?: UploadOptions,
): Promise<void> {
  // Validate payload size
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

  const target: UploadTarget = {
    mode: "stamper",
    bee,
    stamper,
  }

  // Upload encrypted data (single chunk)
  await uploadData(target, payload, {
    encryptionKey,
    pin: options?.pin,
    deferred: options?.deferred,
    tag: options?.tag,
  })
}
