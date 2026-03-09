// Public API
export {
  // Account-level key derivation
  deriveAccountBackupKey,
  deriveAccountSwarmEncryptionKey,
  backupKeyToPrivateKey,
} from "../utils/key-derivation"
export { serializeAccountState, deserializeAccountState } from "./serialization"

// Sync account
export { createSyncAccount, ACCOUNT_SYNC_TOPIC_PREFIX } from "./sync-account"
export type { SyncAccountOptions, SyncAccountFunction } from "./sync-account"

// Restore account from Swarm
export { restoreAccountFromSwarm } from "./restore-account"
export type { RestoreAccountResult } from "./restore-account"

// Store interfaces
export type {
  AccountsStoreInterface,
  IdentitiesStoreInterface,
  ConnectedAppsStoreInterface,
  PostageStampsStoreInterface,
  StamperOptions,
  FlushableStamper,
} from "./store-interfaces"

export type { SyncResult } from "./types"
