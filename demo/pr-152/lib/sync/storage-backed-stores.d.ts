import type { UtilizationStoreDB } from "../storage/utilization-store";
import type { AccountsStoreInterface, IdentitiesStoreInterface, ConnectedAppsStoreInterface, PostageStampsStoreInterface } from "./store-interfaces";
export declare function createStorageBackedAccountsStore(): AccountsStoreInterface;
export declare function createStorageBackedIdentitiesStore(): IdentitiesStoreInterface;
export declare function createStorageBackedConnectedAppsStore(): ConnectedAppsStoreInterface;
export declare function createStorageBackedPostageStampsStore(utilizationStore?: UtilizationStoreDB): PostageStampsStoreInterface;
//# sourceMappingURL=storage-backed-stores.d.ts.map