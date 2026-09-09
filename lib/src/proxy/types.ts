// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Bee, Stamper } from "@ethersphere/bee-js"
import type { StampWorkerPool } from "./stamp-worker-pool"

/**
 * The slice of a Bee client that chunk I/O uses.
 *
 * Reading is `downloadChunk`; writing adds `uploadChunk` and, for progress
 * tracking, `createTag`; `url` only feeds log lines. Everything that moves
 * chunks takes this rather than a whole `Bee`, so the signature says what is
 * actually called and a store-backed mock can stand in for the client.
 */
export type ChunkClient = Pick<
  Bee,
  "url" | "downloadChunk" | "uploadChunk" | "createTag"
>

/**
 * Upload context shared across handlers
 */
export interface UploadContext {
  bee: ChunkClient
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
  span?: bigint // total data length covered by this reference (bytes)
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
