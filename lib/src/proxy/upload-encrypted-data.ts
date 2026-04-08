// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Encrypted data upload functions.
 *
 * @deprecated This module is deprecated. For new code, use the unified API:
 *   import { uploadData, uploadSOC } from "./upload"
 *
 * For encrypted data upload:
 *   await uploadData(target, data, { encryptionKey: true })
 *
 * For encrypted SOC upload:
 *   await uploadSOC(target, signer, identifier, data, { encryptionKey })
 *
 * This module re-exports legacy wrappers for backward compatibility.
 */

export {
  // Types
  type UploadEncryptedDataResult,
  type UploadEncryptedSOCResult,
  type LegacyUploadSOCResult as UploadSOCResult,
  // Functions
  uploadEncryptedDataWithSigning,
  uploadSingleEncryptedChunk,
  uploadSingleChunkWithEncryption,
  uploadEncryptedSOC,
  uploadSOCLegacy as uploadSOC,
  uploadSOCViaSocEndpoint,
} from "./upload-legacy-wrappers"
