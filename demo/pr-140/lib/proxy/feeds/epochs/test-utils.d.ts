/**
 * Test utilities for epoch feeds
 *
 * Provides mock storage and helpers for testing epoch feed operations
 */
import { PrivateKey, Topic, EthAddress } from "@ethersphere/bee-js";
/**
 * In-memory chunk storage for testing
 */
export declare class MockChunkStore {
    private chunks;
    put(address: string, data: Uint8Array): Promise<void>;
    get(address: string): Promise<Uint8Array>;
    has(address: string): boolean;
    clear(): void;
    size(): number;
}
/**
 * Mock Bee instance for testing
 */
export declare class MockBee {
    readonly url = "http://localhost:1633";
    private store;
    constructor(store?: MockChunkStore);
    downloadChunk(reference: string): Promise<Uint8Array>;
    uploadChunk(data: Uint8Array, _postageBatchId: string): Promise<{
        reference: string;
    }>;
    getStore(): MockChunkStore;
}
/**
 * Create test signer with a deterministic private key
 */
export declare function createTestSigner(): PrivateKey;
/**
 * Create test topic
 */
export declare function createTestTopic(name?: string): Topic;
/**
 * Create test owner address
 */
export declare function createTestOwner(): EthAddress;
/**
 * Create test reference (32 bytes)
 */
export declare function createTestReference(value: number | bigint): Uint8Array;
/**
 * Create test payload with timestamp
 */
export declare function createTestPayload(at: bigint): Uint8Array;
/**
 * Mock fetch for SOC uploads
 *
 * NOTE: This doesn't actually store data - use a proper mock Bee implementation instead
 */
export declare function mockFetch(store?: MockChunkStore): void;
/**
 * Restore original fetch
 */
export declare function restoreFetch(): void;
//# sourceMappingURL=test-utils.d.ts.map