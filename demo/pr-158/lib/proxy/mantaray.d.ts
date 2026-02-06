import type { MantarayNode } from "@ethersphere/bee-js";
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
//# sourceMappingURL=mantaray.d.ts.map