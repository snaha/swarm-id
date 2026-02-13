import { MantarayNode } from '@ethersphere/bee-js';
import type { Bee, BeeRequestOptions } from '@ethersphere/bee-js';
/**
 * Upload callback type for saveMantarayTreeRecursively
 */
export type UploadCallback = (data: Uint8Array, isRoot: boolean) => Promise<{
    reference: string;
    tagUid?: number;
}>;
/**
 * Save a Mantaray tree by uploading bottom-up
 *
 * This mirrors MantarayNode.saveRecursively() but allows custom upload logic
 * and uses Bee's returned references to avoid address mismatches.
 */
export declare function saveMantarayTreeRecursively(node: MantarayNode, uploadFn: UploadCallback): Promise<{
    rootReference: string;
    tagUid?: number;
}>;
/**
 * Load a Mantaray tree using only the chunk API.
 *
 * This avoids /bytes and supports encrypted references.
 */
export declare function loadMantarayTreeWithChunkAPI(bee: Bee, rootReference: string, requestOptions?: BeeRequestOptions): Promise<MantarayNode>;
//# sourceMappingURL=mantaray.d.ts.map