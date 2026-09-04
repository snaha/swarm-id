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
export { createSyncAccount } from "./sync-account"
export type { SyncAccountOptions, SyncAccountFunction } from "./sync-account"

// Restore account from Swarm
export {
  restoreAccountFromSwarm,
  SnapshotDataUnavailableError,
} from "./restore-account"
export type { RestoreAccountResult } from "./restore-account"

// Phase 3a: per-device snapshot feeds + append-only roster discovery
export {
  deviceStateTopic,
  accountStateToDeviceView,
  writeDeviceState,
  publishDeviceState,
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
  rosterTopic,
  readRoster,
  ensureInRoster,
  ROSTER_TOPIC_PREFIX,
} from "./device-roster"
export {
  foldAccountFromSwarm,
  foldedToSyncedAccount,
} from "./fold-account-from-swarm"
export type { FoldAccountResult } from "./fold-account-from-swarm"

// Store interfaces
export type {
  AccountsStoreInterface,
  PostageStampsStoreInterface,
  StamperOptions,
  FlushableStamper,
} from "./store-interfaces"

export type { SyncResult } from "./types"
