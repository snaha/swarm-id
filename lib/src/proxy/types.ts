import type { Bee, Stamper } from "@ethersphere/bee-js"

/**
 * Upload context shared across handlers
 */
export interface UploadContext {
  bee: Bee
  stamper?: Stamper
  postageBatchId?: string
  signerKey?: string
}

/**
 * Upload progress information
 */
export interface UploadProgress {
  total: number      // Total chunks to upload
  processed: number  // Chunks uploaded so far
}

/**
 * Chunk reference (32-byte address)
 */
export interface ChunkReference {
  address: Uint8Array  // 32-byte chunk address
}
