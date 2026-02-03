import type { EnvelopeWithBatchId } from "@ethersphere/bee-js";
export declare function initSyncCoordinator(): void;
export declare function triggerSync(accountId: string): void;
export declare function requestSync(accountId: string): Promise<void>;
export declare function destroySyncCoordinator(): Promise<void>;
export declare function requestStamp(params: {
    chunkHash: Uint8Array;
    batchId: string;
    signerKey: string;
    depth: number;
}): Promise<EnvelopeWithBatchId>;
export declare function flushCoordinatorStamper(batchId: string): Promise<void>;
//# sourceMappingURL=sync-coordinator.d.ts.map