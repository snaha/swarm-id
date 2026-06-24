// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Public API
export {
  // Account-level key derivation
  deriveAccountBackupKey,
  deriveAccountDerivationKey,
  deriveSwarmEncryptionKey,
  derivePostageSignerKey,
  backupKeyToPrivateKey,
} from "../utils/key-derivation"
export { serializeAccountState, deserializeAccountState } from "./serialization"

// Snapshot merge primitives (shared by the publish and refresh paths so the
// rules can't drift — #337).
export {
  mergeSnapshotWithRemote,
  mergeConnectedApps,
  mergePostageStamps,
  mergeDevicesList,
  snapshotContainsContribution,
} from "./merge-snapshot"

// Sync account
export { createSyncAccount, ACCOUNT_SYNC_TOPIC_PREFIX } from "./sync-account"
export type { SyncAccountOptions, SyncAccountFunction } from "./sync-account"

// Restore account from Swarm
export {
  restoreAccountFromSwarm,
  SnapshotDataUnavailableError,
} from "./restore-account"
export type { RestoreAccountResult } from "./restore-account"

// Phase 3a: per-device snapshot feeds + device-registry discovery
export {
  deviceStateTopic,
  writeDeviceState,
  readLatestDeviceState,
  foldAccount,
  deserializeDeviceState,
  DeviceStateSnapshotSchemaV1,
  DEVICE_STATE_TOPIC_PREFIX,
} from "./device-state"
export type {
  DeviceStateSnapshot,
  DeviceStateView,
  FoldedAccount,
  AccountSettings,
} from "./device-state"
export {
  deviceRegistryTopic,
  readDeviceRegistry,
  writeDeviceRegistry,
  upsertDevice,
  deserializeRegistry,
  DeviceRegistrySchemaV1,
  DEVICE_REGISTRY_TOPIC_PREFIX,
} from "./device-registry"
export type { DeviceRegistry } from "./device-registry"
export { foldAccountFromSwarm } from "./fold-account-from-swarm"
export type { FoldAccountResult } from "./fold-account-from-swarm"

// Store interfaces
export type {
  AccountsStoreInterface,
  PostageStampsStoreInterface,
  StamperOptions,
  FlushableStamper,
} from "./store-interfaces"

export type { SyncResult } from "./types"
