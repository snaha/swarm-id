import { PrivateKey, Identifier } from '@ethersphere/bee-js';
import type { Bee, BeeRequestOptions, Stamper, UploadOptions } from '@ethersphere/bee-js';
import type { UploadContext, UploadProgress } from './types';
/**
 * Result of uploading encrypted data
 */
export interface UploadEncryptedDataResult {
    reference: string;
    tagUid?: number;
    chunkAddresses: Uint8Array[];
}
/**
 * Upload encrypted data with client-side signing
 * Handles chunking, encryption, merkle tree building, and progress reporting
 *
 * @param context - Upload context with bee instance and authentication
 * @param data - Data to encrypt and upload
 * @param encryptionKey - Optional 32-byte encryption key (generates random if not provided)
 * @param options - Upload options
 * @param onProgress - Progress callback
 */
export declare function uploadEncryptedDataWithSigning(context: UploadContext, data: Uint8Array, encryptionKey?: Uint8Array, options?: UploadOptions, onProgress?: (progress: UploadProgress) => void, requestOptions?: BeeRequestOptions): Promise<UploadEncryptedDataResult>;
/**
 * Upload a single encrypted chunk with optional signing
 *
 * This is the unified interface for uploading encrypted chunks.
 * Use this instead of direct Bee API calls with fetch.
 *
 * @param bee - Bee client instance
 * @param stamper - Stamper for client-side signing
 * @param payload - Raw chunk data to encrypt and upload (1-4096 bytes)
 * @param encryptionKey - Encryption key (32 bytes)
 * @param options - Upload options (deferred, tag, etc.)
 */
export declare function uploadSingleChunkWithEncryption(bee: Bee, stamper: Stamper, payload: Uint8Array, encryptionKey: Uint8Array, options?: UploadOptions): Promise<void>;
/**
 * Result of uploading an encrypted SOC
 */
export interface UploadEncryptedSOCResult {
    socAddress: Uint8Array;
    encryptionKey: Uint8Array;
    tagUid?: number;
}
/**
 * Result of uploading a SOC
 */
export interface UploadSOCResult {
    socAddress: Uint8Array;
    tagUid?: number;
}
/**
 * Upload an encrypted Single Owner Chunk (SOC) using the fast chunk upload path
 *
 * This function constructs an encrypted SOC manually and uploads it via the regular
 * /chunks endpoint for better performance compared to the /soc endpoint.
 *
 * SOC Structure (Book of Swarm 2.2.3, 2.2.4):
 * - 32 bytes: identifier
 * - 65 bytes: signature (r, s, v)
 * - 8 bytes: span (from encrypted CAC)
 * - up to 4096 bytes: encrypted payload (from encrypted CAC)
 *
 * The signature signs: hash(identifier + encrypted_CAC.address)
 * SOC address: Keccak256(identifier + owner_address)
 *
 * @param bee - Bee client instance
 * @param stamper - Stamper for client-side signing
 * @param signer - SOC owner's private key
 * @param identifier - 32-byte SOC identifier
 * @param data - Payload data (1-4096 bytes)
 * @param encryptionKey - Optional 32-byte encryption key (random if not provided)
 * @param options - Upload options (tag, deferred, etc.)
 * @returns SOC address, encryption key, and optional tag UID
 */
export declare function uploadEncryptedSOC(bee: Bee, stamper: Stamper, signer: PrivateKey, identifier: Identifier, data: Uint8Array, encryptionKey?: Uint8Array, options?: UploadOptions): Promise<UploadEncryptedSOCResult>;
/**
 * Upload a plain Single Owner Chunk (SOC) using the fast chunk upload path
 *
 * This constructs an unencrypted SOC and uploads it via /chunks to avoid /soc size limits.
 */
export declare function uploadSOC(bee: Bee, stamper: Stamper, signer: PrivateKey, identifier: Identifier, data: Uint8Array, options?: UploadOptions): Promise<UploadSOCResult>;
//# sourceMappingURL=upload-encrypted-data.d.ts.map