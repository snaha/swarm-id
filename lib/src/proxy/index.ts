// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export * from "./types"
export * from "./chunking"

// New unified upload API (preferred)
export {
  uploadData,
  uploadSOC,
  uploadChunk,
  isStamperTarget,
  isSubsidisedTarget,
  type UploadTarget,
  type UploadDataOptions,
  type UploadDataResult,
  type UploadSOCOptions,
  type UploadSOCResult,
  type UploadChunkOptions,
  type UploadChunkResult,
} from "./upload"

// Legacy upload APIs (for backward compatibility)
export * from "./upload-data"
export * from "./upload-subsidised"

export * from "./feeds"
export * from "./act"
