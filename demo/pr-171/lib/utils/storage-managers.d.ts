/**
 * Pre-configured Storage Managers for Entity Types
 *
 * Provides ready-to-use storage managers for accounts, identities,
 * connected apps, and postage stamps with versioning support.
 */
import { VersionedStorageManager } from './versioned-storage';
import type { Account, Identity, ConnectedApp, PostageStamp } from '../types';
import { type NetworkSettings } from '../schemas';
/**
 * Serialize Account for storage
 */
export declare function serializeAccount(account: Account): Record<string, unknown>;
/**
 * Serialize Identity for storage
 */
export declare function serializeIdentity(identity: Identity): Record<string, unknown>;
/**
 * Serialize ConnectedApp for storage
 */
export declare function serializeConnectedApp(app: ConnectedApp): Record<string, unknown>;
/**
 * Serialize PostageStamp for storage
 */
export declare function serializePostageStamp(stamp: PostageStamp): Record<string, unknown>;
/**
 * Create storage manager for accounts
 */
export declare function createAccountsStorageManager(): VersionedStorageManager<Account>;
/**
 * Create storage manager for identities
 */
export declare function createIdentitiesStorageManager(): VersionedStorageManager<Identity>;
/**
 * Create storage manager for connected apps
 */
export declare function createConnectedAppsStorageManager(): VersionedStorageManager<ConnectedApp>;
/**
 * Create storage manager for postage stamps
 */
export declare function createPostageStampsStorageManager(): VersionedStorageManager<PostageStamp>;
/**
 * Serialize NetworkSettings for storage
 */
export declare function serializeNetworkSettings(settings: NetworkSettings): Record<string, unknown>;
/**
 * Singleton storage manager interface for network settings
 */
export interface NetworkSettingsStorageManager {
    load(): NetworkSettings | undefined;
    save(settings: NetworkSettings): void;
    clear(): void;
}
/**
 * Create storage manager for network settings (singleton)
 * Unlike other storage managers, this stores a single object, not an array
 */
export declare function createNetworkSettingsStorageManager(): NetworkSettingsStorageManager;
//# sourceMappingURL=storage-managers.d.ts.map