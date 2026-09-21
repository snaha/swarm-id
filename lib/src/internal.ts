// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `@snaha/swarm-id/internal` — the identity UI's half of the trusted domain.
 *
 * Everything here takes the account record, the master key or the
 * `derivationKey`, none of which ever leaves the trusted domain, so a dApp has
 * no use for any of it; a dApp holds a `SwarmIdClient` from the package root.
 * The proxy iframe, which lives in the same lib, reaches these modules directly.
 * A name is on this list because `ui/` (its tests included) imports it, and for
 * no other reason:
 * nothing is re-exported for a caller that does not exist (#801).
 */

export { AccountBus } from "./bus/account-bus"

export {
  accountDeltaSnapshot,
  restoreLocalSessionFields,
} from "./bus/account-delta"

export { deriveBusContext } from "./bus/bus-context"

export { PRESENCE_INTERVAL_MS, PresenceTracker } from "./bus/presence"

export { SignalingTransport } from "./bus/signaling-transport"

export { downloadEncryptedSOC } from "./proxy/download-data"

export { SocUploadError, uploadSOC } from "./proxy/upload"

export type { UploadTarget } from "./proxy/upload"

export {
  BatchIdSchema,
  DEFAULT_GNOSIS_RPC_URL,
  PostageStampSchemaV1,
  PrivateKeySchema,
  SyncedAccountSchemaV1,
  isSignedOutAccount,
} from "./schemas"

export type {
  AccessMethod,
  Account,
  ConnectedApp,
  Device,
  LocalVault,
  NetworkSettings,
  PostageStamp,
  SignedInAccount,
  SignedOutAccount,
  SyncedAccount,
} from "./schemas"

export { DebouncedUtilizationUploader } from "./storage/debounced-uploader"

export { UtilizationStoreDB } from "./storage/utilization-store"

export { initProxy } from "./swarm-id-proxy"

export {
  createSyncAccount,
  deriveAccountDerivationKey,
  derivePostageSignerKey,
  deriveSwarmEncryptionKey,
  foldAccountFromSwarm,
  foldedToSyncedAccount,
  mergeConnectedApps,
  mergeDevicesList,
  mergePostageStamps,
} from "./sync"

export type { SyncAccountFunction, SyncResult } from "./sync"

export { PartitionLease } from "./sync/partition-lease"

export type { PartitionLeaseStateSnapshot } from "./sync/partition-lease"

export {
  AuthDataSchema,
  STORAGE_CHALLENGE_KEY,
  leaseCacheStorageKey,
} from "./types"

export type { AccountStateSnapshot } from "./utils/account-state-snapshot"

export {
  BUCKET_DEPTH,
  MIN_USABLE_BATCH_DEPTH,
  PARTITION_COUNT,
  UtilizationAwareStamper,
} from "./utils/batch-utilization"

export { runCoalescedAcrossTabs } from "./utils/coalesced-task"

export { DAY, appSessionDuration } from "./utils/constants"

export {
  detectDeviceName,
  getOrCreateDeviceId,
  mergeDevices,
} from "./utils/device-id"

export { hexAddress } from "./utils/hex"

export { deriveSecret, deriveSharingKey } from "./utils/key-derivation"

export {
  calculateContractTTLSeconds,
  fetchOnChainBatchStateResult,
} from "./utils/postage-contract"

export { stampsReachableByApp } from "./utils/postage-stamp-association"

export { sleep, withIdleTimeout } from "./utils/promise"

export { remainingLifespanSeconds } from "./utils/stamp-lifespan"

export {
  createAccountsStorageManager,
  createNetworkSettingsStorageManager,
  serializePostageStamp,
  serializeSyncedAccount,
} from "./utils/storage-managers"

export { markFirstPartyStorage } from "./utils/storage-probe"

export { GNOSIS_BLOCK_TIME, calculateStampAmountForDays } from "./utils/ttl"

export { isHttpUrl } from "./utils/url"
