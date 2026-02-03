import type { Bee, EnvelopeWithBatchId } from "@ethersphere/bee-js";
/**
 * Async stamp function that requests a stamp for a chunk hash.
 * On the leader tab this stamps locally; on a follower tab this
 * round-trips through the SyncCoordinator BroadcastChannel.
 */
export type StampFunction = (chunkHash: Uint8Array) => Promise<EnvelopeWithBatchId>;
/**
 * Upload context shared across handlers
 */
export interface UploadContext {
    bee: Bee;
    stamp: StampFunction;
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