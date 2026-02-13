import type { Bee, Stamper } from '@ethersphere/bee-js';
/**
 * Upload context shared across handlers
 */
export interface UploadContext {
    bee: Bee;
    stamper: Stamper;
}
/**
 * Upload progress information
 */
export interface UploadProgress {
    total: number;
    processed: number;
}
/**
 * Chunk reference (32-byte address)
 */
export interface ChunkReference {
    address: Uint8Array;
}
/**
 * Encrypted chunk reference (64-byte reference: address + encryption key)
 */
export interface EncryptedChunkReference {
    address: Uint8Array;
    key: Uint8Array;
}
//# sourceMappingURL=types.d.ts.map