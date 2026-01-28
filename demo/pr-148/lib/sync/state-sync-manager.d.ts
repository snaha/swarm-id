import type { StateSyncOptions, SyncResult, AccountStateSnapshot } from "./types";
import { PostageStamp } from "../types";
export declare const ACCOUNT_SYNC_TOPIC_PREFIX = "swarm-id-backup-v1:account";
export declare class StateSyncManager {
    private options;
    constructor(options: StateSyncOptions);
    /**
     * Sync account state to Swarm
     *
     * @param accountId - Account ID (EthAddress hex string)
     * @param state - Account state snapshot to upload
     * @param postageBatchId - Batch ID for stamping
     * @param encryptionKey - 32-byte encryption key (hex string)
     * @returns Sync result with reference and timestamp
     */
    syncAccount(accountId: string, state: AccountStateSnapshot, postageStamp: PostageStamp, encryptionKey: string): Promise<SyncResult>;
}
//# sourceMappingURL=state-sync-manager.d.ts.map