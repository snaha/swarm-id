import type { Bee, PrivateKey, Stamper } from "@ethersphere/bee-js";
import type { PostageStamp } from "../types";
import type { AccountStateSnapshot, AccountMetadata } from "../schemas";
export type { AccountStateSnapshot, AccountMetadata };
/**
 * Callbacks for optional utilization tracking (browser-only)
 */
export interface UtilizationCallbacks {
    /**
     * Called after chunk upload, before feed update
     * @param accountId - Account ID being synced
     * @param chunkAddresses - Addresses of uploaded chunks
     * @returns Promise that resolves when utilization upload completes
     */
    onUtilizationUpdate?: (accountId: string, chunkAddresses: Uint8Array[]) => Promise<void>;
    /**
     * Get current utilization percentage (for logging)
     * @param accountId - Account ID being synced
     * @returns Utilization percentage (0-100)
     */
    getUtilizationPercentage?: (accountId: string) => Promise<number>;
}
/**
 * Options for StateSyncManager
 */
export interface StateSyncOptions {
    bee: Bee;
    getAccountKey: (accountId: string) => Promise<PrivateKey>;
    getStamper: (postageStamp: PostageStamp) => Promise<Stamper>;
    utilization?: UtilizationCallbacks;
}
/**
 * Result of a sync operation
 */
export type SyncResult = {
    status: "success";
    reference: string;
    timestamp: bigint;
    chunkAddresses: Uint8Array[];
} | {
    status: "error";
    error: string;
};
//# sourceMappingURL=types.d.ts.map