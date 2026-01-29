import { Reference } from "@ethersphere/bee-js";
export declare const CHUNK_SIZE = 4096;
export declare const ENCRYPTED_REFS_PER_CHUNK = 64;
/**
 * Build encrypted merkle tree from chunk references
 * Adapted from bee-js encrypted-chunk-stream.ts
 * Returns root reference (64 bytes: 32-byte address + 32-byte encryption key)
 */
export declare function buildEncryptedMerkleTree(encryptedChunks: Array<{
    address: Uint8Array;
    key: Uint8Array;
    span: bigint;
}>, onChunk: (encryptedChunkData: Uint8Array) => Promise<void>): Promise<Reference>;
//# sourceMappingURL=chunking-encrypted.d.ts.map