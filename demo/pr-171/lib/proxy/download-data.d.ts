import { EthAddress, Identifier } from '@ethersphere/bee-js';
import type { Bee, BeeRequestOptions, DownloadOptions } from '@ethersphere/bee-js';
import type { UploadProgress } from './types';
import type { SingleOwnerChunk } from '../types';
/**
 * Download data using only the chunk API
 * This ensures encrypted data remains encrypted during transmission and avoids metadata leakage
 *
 * Supports both:
 * - Regular references (64 hex chars = 32 bytes)
 * - Encrypted references (128 hex chars = 64 bytes: 32-byte address + 32-byte encryption key)
 */
export declare function downloadDataWithChunkAPI(bee: Bee, reference: string, options?: DownloadOptions, onProgress?: (progress: UploadProgress) => void, requestOptions?: BeeRequestOptions): Promise<Uint8Array>;
export declare function downloadSOC(bee: Bee, owner: string | Uint8Array | EthAddress, identifier: string | Uint8Array | Identifier, requestOptions?: BeeRequestOptions): Promise<SingleOwnerChunk>;
export declare function downloadEncryptedSOC(bee: Bee, owner: string | Uint8Array | EthAddress, identifier: string | Uint8Array | Identifier, encryptionKey: string | Uint8Array, requestOptions?: BeeRequestOptions): Promise<SingleOwnerChunk>;
//# sourceMappingURL=download-data.d.ts.map