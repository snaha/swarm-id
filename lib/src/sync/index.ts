// Public API
export {
  StateSyncManager,
  ACCOUNT_SYNC_TOPIC_PREFIX,
} from "./state-sync-manager"
export {
  // Account-level key derivation
  deriveAccountBackupKey,
  deriveAccountSwarmEncryptionKey,
  backupKeyToPrivateKey,
} from "./key-derivation"
export { serializeAccountState, deserializeAccountState } from "./serialization"

export type {
  AccountStateSnapshot,
  AccountMetadata,
  StateSyncOptions,
  SyncResult,
} from "./types"
