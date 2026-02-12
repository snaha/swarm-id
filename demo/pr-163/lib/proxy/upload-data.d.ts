import type { BeeRequestOptions, UploadOptions } from "@ethersphere/bee-js";
import type { UploadContext, UploadProgress } from "./types";
/**
 * Upload data with client-side signing
 * Handles chunking, merkle tree building, and progress reporting
 */
export declare function uploadDataWithSigning(context: UploadContext, data: Uint8Array, options?: UploadOptions, onProgress?: (progress: UploadProgress) => void, requestOptions?: BeeRequestOptions): Promise<{
    reference: string;
    tagUid?: number;
}>;
//# sourceMappingURL=upload-data.d.ts.map