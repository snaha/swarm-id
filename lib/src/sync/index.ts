// Public API
export { StateSyncManager } from "./state-sync-manager"
export {
  deriveIdentityBackupKey,
  deriveIdentityEncryptionKey,
  backupKeyToPrivateKey,
} from "./key-derivation"
export {
  serializeIdentityState,
  deserializeIdentityState,
} from "./serialization"

export type {
  IdentityStateSnapshot,
  StateSyncOptions,
  SyncResult,
} from "./types"
