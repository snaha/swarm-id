/**
 * Swarm ID Sync - State synchronization to Swarm network
 *
 * Provides automatic background syncing of localStorage state
 * (Identities, ConnectedApps, PostageStamps) to the Swarm network
 * using epoch-based feeds for decentralized backup.
 */

export { StateSyncManager } from "./sync/state-sync-manager"
export {
  // Account-level key derivation
  deriveAccountBackupKey,
  deriveAccountSwarmEncryptionKey,
  backupKeyToPrivateKey,
} from "./sync/key-derivation"
export {
  serializeAccountState,
  deserializeAccountState,
} from "./sync/serialization"
export {
  updateAfterWrite,
  calculateUtilizationPercentage,
  initializeBatchUtilization,
  saveUtilizationState,
  loadUtilizationState,
} from "./utils/batch-utilization"

export type {
  AccountStateSnapshot,
  AccountMetadata,
  StateSyncOptions,
  SyncResult,
} from "./sync/types"
export type {
  BatchUtilizationState,
  ChunkWithBucket,
  UtilizationUpdate,
} from "./utils/batch-utilization"
