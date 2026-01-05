/**
 * Swarm ID Sync - State synchronization to Swarm network
 *
 * Provides automatic background syncing of localStorage state
 * (Identities, ConnectedApps, PostageStamps) to the Swarm network
 * using epoch-based feeds for decentralized backup.
 */

export { StateSyncManager } from "./sync/state-sync-manager"
export {
  deriveIdentityBackupKey,
  deriveIdentityEncryptionKey,
  backupKeyToPrivateKey,
} from "./sync/key-derivation"
export {
  serializeIdentityState,
  deserializeIdentityState,
} from "./sync/serialization"

export type {
  IdentityStateSnapshot,
  StateSyncOptions,
  SyncResult,
} from "./sync/types"
