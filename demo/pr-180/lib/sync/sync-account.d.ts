/**
 * Sync Account
 *
 * Factory function that creates a sync function for syncing account state
 * to Swarm. This integrates store access, key derivation, and utilization
 * tracking.
 */
import { Bee } from "@ethersphere/bee-js";
import type { UtilizationStoreDB } from "../storage/utilization-store";
import type { DebouncedUtilizationUploader } from "../storage/debounced-uploader";
import type { AccountsStoreInterface, IdentitiesStoreInterface, ConnectedAppsStoreInterface, PostageStampsStoreInterface } from "./store-interfaces";
import type { SyncResult } from "./types";
export declare const ACCOUNT_SYNC_TOPIC_PREFIX = "swarm-id-backup-v1:account";
/**
 * Options for creating a sync account function
 */
export interface SyncAccountOptions {
    /** Bee client for Swarm operations */
    bee: Bee;
    /** Store providing account data */
    accountsStore: AccountsStoreInterface;
    /** Store providing identity data */
    identitiesStore: IdentitiesStoreInterface;
    /** Store providing connected app data */
    connectedAppsStore: ConnectedAppsStoreInterface;
    /** Store providing postage stamp data */
    postageStampsStore: PostageStampsStoreInterface;
    /** Utilization store for browser-based utilization tracking */
    utilizationStore: UtilizationStoreDB;
    /** Debounced uploader for batch utilization state */
    utilizationUploader: DebouncedUtilizationUploader;
}
/**
 * Sync account function type
 */
export type SyncAccountFunction = (accountId: string) => Promise<SyncResult | undefined>;
/**
 * Create a sync account function with dependency-injected stores
 *
 * @param options - Configuration options including stores and optional utilization tracking
 * @returns Function that syncs an account to Swarm
 */
export declare function createSyncAccount(options: SyncAccountOptions): SyncAccountFunction;
//# sourceMappingURL=sync-account.d.ts.map