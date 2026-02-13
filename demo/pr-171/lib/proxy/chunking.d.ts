import { Reference } from '@ethersphere/bee-js';
import type { Chunk as BeeChunk } from '@ethersphere/bee-js';
import type { ChunkReference } from './types';
export declare const CHUNK_SIZE = 4096;
export declare const REFS_PER_CHUNK = 64;
/**
 * Split data into 4096-byte chunks
 */
export declare function splitDataIntoChunks(data: Uint8Array): Uint8Array[];
/**
 * Build merkle tree from chunk references
 * Returns root reference (32 bytes)
 */
export declare function buildMerkleTree(chunkRefs: ChunkReference[], onIntermediateChunk: (chunk: BeeChunk) => Promise<void>): Promise<Reference>;
//# sourceMappingURL=chunking.d.ts.map