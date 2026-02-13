/**
 * Test utilities for epoch feeds
 *
 * Provides mock storage and helpers for testing epoch feed operations
 */
import { PrivateKey, Topic, EthAddress } from '@ethersphere/bee-js';
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
    private tagCounter;
    constructor(store?: MockChunkStore);
    createTag(): Promise<{
        uid: number;
        split: number;
        seen: number;
        stored: number;
        sent: number;
        synced: number;
        address: string;
        startedAt: string;
    }>;
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
 * Create a mock Stamper for testing
 *
 * Returns an object with a stamp() method that produces a valid-looking
 * EnvelopeWithBatchId without performing real cryptographic operations.
 */
export declare function createMockStamper(): {
    stamp(_chunk: any): {
        batchId: {
            toUint8Array: () => Uint8Array<ArrayBuffer>;
        };
        index: Uint8Array<ArrayBuffer>;
        timestamp: Uint8Array<ArrayBuffer>;
        signature: Uint8Array<ArrayBuffer>;
        issuer: Uint8Array<ArrayBuffer>;
    };
};
/**
 * Mock fetch for SOC and chunk uploads
 *
 * Intercepts fetch calls to /soc/ and /chunks endpoints, storing data
 * in the provided MockChunkStore.
 *
 * @param store - Mock chunk store for persisting uploaded data
 * @param owner - Owner address for computing SOC addresses on /chunks uploads
 */
export declare function mockFetch(store?: MockChunkStore, owner?: EthAddress): void;
/**
 * Restore original fetch
 */
export declare function restoreFetch(): void;
//# sourceMappingURL=test-utils.d.ts.map