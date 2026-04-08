// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Subsidised gateway upload helpers.
 *
 * @deprecated This module is deprecated. For new code, use the unified API:
 *   import { uploadData, uploadSOC, uploadChunk, type UploadTarget } from "./upload"
 *
 * For subsidised gateway uploads:
 *   const target: UploadTarget = { mode: "subsidised", gatewayUrl: "..." }
 *   await uploadData(target, data)
 *   await uploadSOC(target, signer, identifier, data)
 *   await uploadChunk(target, chunkData)
 *
 * This module re-exports legacy wrappers for backward compatibility.
 */

export {
  // Types
  type UploadEncryptedDataSubsidisedResult,
  // Functions
  uploadSocViaSubsidisedGateway,
  uploadEncryptedSocViaSubsidisedGateway,
  uploadChunkViaSubsidisedGateway,
  uploadDataViaSubsidisedGateway,
  uploadEncryptedDataViaSubsidisedGateway,
  uploadFileViaSubsidisedGateway,
} from "./upload-legacy-wrappers"
