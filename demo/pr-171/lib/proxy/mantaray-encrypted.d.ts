import type { MantarayNode } from "@ethersphere/bee-js";
/**
 * Upload callback type for saveMantarayTreeRecursivelyEncrypted
 *
 * @param encryptedData - The encrypted chunk data to upload
 * @param address - The 32-byte address of the encrypted chunk
 * @param isRoot - Whether this is the root node
 * @returns Upload result with optional tag UID
 */
export type EncryptedUploadCallback = (encryptedData: Uint8Array, address: Uint8Array, isRoot: boolean) => Promise<{
    tagUid?: number;
}>;
/**
 * Save a Mantaray tree with encryption by uploading bottom-up
 *
 * This mirrors saveMantarayTreeRecursively but encrypts each manifest node
 * and creates 64-byte encrypted references (address + encryption key).
 *
 * @param node - Root Mantaray node to save
 * @param uploadFn - Callback to upload each encrypted chunk
 * @returns Root reference (128 hex chars = 64 bytes) and optional tag UID
 */
export declare function saveMantarayTreeRecursivelyEncrypted(node: MantarayNode, uploadFn: EncryptedUploadCallback): Promise<{
    rootReference: string;
    tagUid?: number;
}>;
//# sourceMappingURL=mantaray-encrypted.d.ts.map