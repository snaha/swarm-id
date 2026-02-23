/**
 * ACT (Access Control Tries) - Bee-Compatible Implementation
 *
 * This module provides client-side ACT operations with Bee-compatible
 * Simple Manifest (JSON) format:
 * - ACT manifest (JSON with lookup key -> encrypted access key mappings)
 * - Encrypted grantee list (stored separately)
 * - History manifest (tracks ACT versions over time)
 */
import type { Bee, BeeRequestOptions, UploadOptions } from "@ethersphere/bee-js";
import type { UploadContext, UploadProgress } from "../types";
type ActUploadOptions = UploadOptions & {
    beeCompatible?: boolean;
};
/**
 * Result of ACT upload operation
 */
export interface ActUploadResult {
    encryptedReference: string;
    historyReference: string;
    granteeListReference: string;
    publisherPubKey: string;
    actReference: string;
    tagUid?: number;
}
/**
 * Result of ACT grantee modification
 */
export interface ActGranteeModifyResult {
    historyReference: string;
    granteeListReference: string;
    actReference: string;
    tagUid?: number;
}
/**
 * Result of ACT revocation (includes new encrypted reference due to key rotation)
 */
export interface ActRevocationResult extends ActGranteeModifyResult {
    encryptedReference: string;
}
/**
 * Create an ACT-protected upload
 *
 * This creates:
 * 1. ACT manifest (JSON Simple Manifest with lookup key -> encrypted access key mappings)
 * 2. Encrypted grantee list (for publisher management)
 * 3. History manifest (tracks ACT versions over time)
 *
 * @param context - Upload context with bee and stamper
 * @param contentReference - The reference to protect (32 or 64 bytes)
 * @param publisherPrivateKey - Publisher's private key (32 bytes)
 * @param granteePublicKeys - Array of grantee public keys
 * @param options - Upload options
 * @param requestOptions - Bee request options
 * @param onProgress - Progress callback
 * @returns Multiple references for ACT
 */
export declare function createActForContent(context: UploadContext, contentReference: Uint8Array, publisherPrivateKey: Uint8Array, granteePublicKeys: Array<{
    x: Uint8Array;
    y: Uint8Array;
}>, options?: ActUploadOptions, requestOptions?: BeeRequestOptions, onProgress?: (progress: UploadProgress) => void): Promise<ActUploadResult>;
/**
 * Decrypt an ACT-protected reference
 *
 * @param bee - Bee instance
 * @param encryptedReference - The encrypted reference (hex string)
 * @param historyReference - History manifest reference
 * @param publisherPubKeyHex - Publisher's compressed public key (hex)
 * @param readerPrivateKey - Reader's private key (32 bytes)
 * @param timestamp - Optional timestamp to look up specific ACT version
 * @param requestOptions - Bee request options
 * @returns Decrypted content reference (hex string)
 */
export declare function decryptActReference(bee: Bee, encryptedReference: string, historyReference: string, publisherPubKeyHex: string, readerPrivateKey: Uint8Array, timestamp?: number, requestOptions?: BeeRequestOptions): Promise<string>;
/**
 * Add grantees to an existing ACT
 */
export declare function addGranteesToAct(context: UploadContext, historyReference: string, publisherPrivateKey: Uint8Array, newGranteePublicKeys: Array<{
    x: Uint8Array;
    y: Uint8Array;
}>, options?: ActUploadOptions, requestOptions?: BeeRequestOptions, onProgress?: (progress: UploadProgress) => void): Promise<ActGranteeModifyResult>;
/**
 * Revoke grantees from an ACT (performs key rotation)
 */
export declare function revokeGranteesFromAct(context: UploadContext, historyReference: string, encryptedReference: string, publisherPrivateKey: Uint8Array, revokePublicKeys: Array<{
    x: Uint8Array;
    y: Uint8Array;
}>, options?: ActUploadOptions, requestOptions?: BeeRequestOptions, onProgress?: (progress: UploadProgress) => void): Promise<ActRevocationResult>;
/**
 * Get grantees from an ACT
 */
export declare function getGranteesFromAct(bee: Bee, historyReference: string, publisherPrivateKey: Uint8Array, requestOptions?: BeeRequestOptions): Promise<string[]>;
/**
 * Parse a compressed public key from hex string
 */
export declare function parseCompressedPublicKey(hex: string): {
    x: Uint8Array;
    y: Uint8Array;
};
export { type ActEntry } from "./act";
export { type UncompressedPublicKey } from "./grantee-list";
export { type HistoryEntry, type HistoryEntryMetadata } from "./history";
export { publicKeyFromPrivate, compressPublicKey, publicKeyFromCompressed, } from "./crypto";
//# sourceMappingURL=index.d.ts.map