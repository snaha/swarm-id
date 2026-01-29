// Public API
export {
  // Account-level key derivation
  deriveAccountBackupKey,
  deriveAccountSwarmEncryptionKey,
  backupKeyToPrivateKey,
} from "./key-derivation"
export { serializeAccountState, deserializeAccountState } from "./serialization"

// Sync account
export { createSyncAccount, ACCOUNT_SYNC_TOPIC_PREFIX } from "./sync-account"
export type { SyncAccountOptions, SyncAccountFunction } from "./sync-account"

// Store interfaces
export type {
  AccountsStoreInterface,
  IdentitiesStoreInterface,
  ConnectedAppsStoreInterface,
  PostageStampsStoreInterface,
  StamperOptions,
  FlushableStamper,
} from "./store-interfaces"

export type { AccountStateSnapshot, AccountMetadata, SyncResult } from "./types"
