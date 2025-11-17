import { ChunkJoiner, Reference } from "@ethersphere/bee-js"
import type { Bee, DownloadOptions } from "@ethersphere/bee-js"
import type { UploadProgress } from "./types"

/**
 * Download data using only the chunk API
 * This ensures encrypted data remains encrypted during transmission and avoids metadata leakage
 *
 * Supports both:
 * - Regular references (64 hex chars = 32 bytes)
 * - Encrypted references (128 hex chars = 64 bytes: 32-byte address + 32-byte encryption key)
 */
export async function downloadDataWithChunkAPI(
  bee: Bee,
  reference: string,
  options?: DownloadOptions,
  onProgress?: (progress: UploadProgress) => void
): Promise<Uint8Array> {
  console.log(`[DownloadData] Downloading from reference: ${reference} (${reference.length} chars)`)

  // Convert hex string to Reference
  const ref = new Reference(reference)

  // Create ChunkJoiner with progress callback
  const joiner = new ChunkJoiner(bee, ref, {
    downloadOptions: options,
    onDownloadProgress: onProgress ? (progress) => {
      onProgress({
        total: progress.total,
        processed: progress.processed
      })
    } : undefined,
    // Use reasonable concurrency for parallel chunk fetching
    concurrency: 64
  })

  // Download and assemble all chunks
  const data = await joiner.readAll()

  console.log(`[DownloadData] Download complete, ${data.length} bytes`)

  return data
}
