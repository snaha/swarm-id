// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Plain data upload functions.
 *
 * @deprecated This module is deprecated. For new code, use the unified API:
 *   import { uploadData, uploadChunk } from "./upload"
 *
 * This module re-exports legacy wrappers for backward compatibility.
 */

export {
  uploadDataWithSigning,
  uploadSingleChunk,
} from "./upload-legacy-wrappers"
