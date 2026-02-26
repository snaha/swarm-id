import type { Bee, BeeRequestOptions, Stamper, Chunk as BeeChunk, UploadOptions, UploadResult } from "@ethersphere/bee-js";
import type { UploadContext, UploadProgress } from "./types";
/**
 * Upload data with client-side signing
 * Handles chunking, merkle tree building, and progress reporting
 */
export declare function uploadDataWithSigning(context: UploadContext, data: Uint8Array, options?: UploadOptions, onProgress?: (progress: UploadProgress) => void, requestOptions?: BeeRequestOptions): Promise<{
    reference: string;
    tagUid?: number;
}>;
/**
 * Upload a single chunk with optional signing
 * Returns UploadResult with Bee's actual stored reference for verification
 */
export declare function uploadSingleChunk(bee: Bee, stamper: Stamper | undefined, chunk: BeeChunk, options?: UploadOptions, requestOptions?: BeeRequestOptions): Promise<UploadResult>;
//# sourceMappingURL=upload-data.d.ts.map