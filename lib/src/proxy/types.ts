// Copyright 2024 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Bee, Stamper } from "@ethersphere/bee-js"
import type { StampWorkerPool } from "./stamp-worker-pool"

/**
 * Upload context shared across handlers
 */
export interface UploadContext {
  bee: Bee
  stamper: Stamper
  workerPool?: StampWorkerPool
}

/**
 * Upload progress information
 */
export interface UploadProgress {
  total: number // Total chunks to upload
  processed: number // Chunks uploaded so far
}

/**
 * Chunk reference (32-byte address)
 */
export interface ChunkReference {
  address: Uint8Array // 32-byte chunk address
}

/**
 * Encrypted chunk reference (64-byte reference: address + encryption key)
 */
export interface EncryptedChunkReference {
  address: Uint8Array // 32-byte chunk address
  key: Uint8Array // 32-byte encryption key
}

/**
 * Options for WebSocket-based chunk upload
 */
export interface WebSocketUploadOptions {
  /** WebSocket concurrency (in-flight chunks). Defaults to 32. */
  concurrency?: number
}
