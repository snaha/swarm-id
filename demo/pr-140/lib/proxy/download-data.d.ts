import type { Bee, DownloadOptions } from "@ethersphere/bee-js";
import type { UploadProgress } from "./types";
/**
 * Download data using only the chunk API
 * This ensures encrypted data remains encrypted during transmission and avoids metadata leakage
 *
 * Supports both:
 * - Regular references (64 hex chars = 32 bytes)
 * - Encrypted references (128 hex chars = 64 bytes: 32-byte address + 32-byte encryption key)
 */
export declare function downloadDataWithChunkAPI(bee: Bee, reference: string, options?: DownloadOptions, onProgress?: (progress: UploadProgress) => void): Promise<Uint8Array>;
//# sourceMappingURL=download-data.d.ts.map