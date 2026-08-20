// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Swarm ID Library
 *
 * A TypeScript library for integrating Swarm ID authentication
 * and Bee API operations into dApps.
 */

// Main client for parent windows
export { SwarmIdClient } from "./swarm-id-client"

// Proxy for iframe
export { SwarmIdProxy, initProxy } from "./swarm-id-proxy"
export type { ProxyConfig } from "./swarm-id-proxy"

// Key derivation utilities
export {
  deriveSecret,
  generateMasterKey,
  hexToUint8Array,
  uint8ArrayToHex,
  verifySecret,
  utils,
} from "./utils/key-derivation"

// Hex address utility
export { hexAddress } from "./utils/hex"

// Account avatars — `SwarmIdClient.getAvatar()` resolves the one to render;
// the generator is exported for callers that want the SVG inline
export { generatedAvatar, generatedAvatarSvg } from "./utils/avatar"

// Cross-tab coalescing: run a task at most once per window across same-origin tabs
export { runCoalescedAcrossTabs } from "./utils/coalesced-task"

// Stamp worker pool for parallel ECDSA signing
export { StampWorkerPool } from "./proxy/stamp-worker-pool"

// Batch utilization tracking
export {
  initializeBatchUtilization,
  updateAfterWrite,
  saveUtilizationState,
  loadUtilizationState,
  calculateUtilization,
  toBucket,
  serializeUint32Array,
  deserializeUint32Array,
  serializeUint16Array,
  deserializeUint16Array,
  calculateMaxSlotsPerBucket,
  hasBucketCapacity,
  UtilizationAwareStamper,
  PartitionLeaseLostError,
  getChunkLayout,
  deriveUtilizationChunkKey,
  NUM_BUCKETS,
  BUCKET_DEPTH,
  UTILIZATION_SLOTS_PER_BUCKET,
  DATA_COUNTER_START,
  CHUNK_SIZE,
  DEFAULT_BATCH_DEPTH,
  UINT16_COUNTER_MAX_DEPTH,
  PARTITION_COUNT,
  LEASE_TTL_MS,
  LEASE_REFRESH_MS,
} from "./utils/batch-utilization"
export type { UtilizationChunkKey } from "./utils/batch-utilization"

// Storage key constants (for cross-frame localStorage listeners)
export {
  STORAGE_KEY_ACCOUNTS,
  STORAGE_KEY_NETWORK_SETTINGS,
  STORAGE_KEY_LEASE_CACHE_PREFIX,
  leaseCacheStorageKey,
} from "./types"

// Partition-lease orchestrator and feeds
export { PartitionLease } from "./sync/partition-lease"
export type {
  AcquireResult,
  PartitionLeaseSnapshotInputs,
  PartitionLeaseStateSnapshot,
  SelfLease,
  PartitionHolderEntry,
} from "./sync/partition-lease"
export {
  makePartitionStateTopic,
  readPartitionState,
  writePartitionState,
  PartitionStateSchemaV1,
} from "./sync/partition-state"
export type { PartitionState } from "./sync/partition-state"
export {
  acquirePartitionLock,
  compareGenerations,
  makeDeviceTiebreaker,
  makePartitionLockIdentifier,
  readPartitionLock,
  writePartitionLock,
  lockSocAddress,
  lockSocBucket,
  NO_HOLDER_DEVICE_ID,
} from "./sync/partition-lock"
export type {
  AcquirePartitionLockResult,
  PartitionLockGeneration,
  PartitionLockPayload,
} from "./sync/partition-lock"
export {
  PartitionLockPayloadSchemaV1,
  PartitionLockGenerationSchemaV1,
} from "./schemas"

// Utilization storage (IndexedDB cache)
export { UtilizationStoreDB } from "./storage/utilization-store"

export type {
  ChunkCacheEntry,
  BatchMetadata,
} from "./storage/utilization-store"

// Debounced utilization uploader
export { DebouncedUtilizationUploader } from "./storage/debounced-uploader"

// Versioned storage utilities
export {
  VersionedStorageManager,
  LocalStorageAdapter,
  MemoryStorageAdapter,
  createLocalStorageManager,
  createMemoryStorageManager,
  createZodParser,
  VersionedStorageSchema,
} from "./utils/versioned-storage"

// Storage managers for entities
export {
  createAccountsStorageManager,
  createNetworkSettingsStorageManager,
  serializeAccount,
  serializeSyncedAccount,
  serializeConnectedApp,
  serializePostageStamp,
  serializeNetworkSettings,
} from "./utils/storage-managers"

// Storage manager types
export type { NetworkSettingsStorageManager } from "./utils/storage-managers"

// Account state snapshot (shared by file export and Swarm sync)
export {
  serializeAccountStateSnapshot,
  deserializeAccountStateSnapshot,
  AccountStateSnapshotSchemaV1,
} from "./utils/account-state-snapshot"

export type {
  AccountStateSnapshot,
  AccountStateSnapshotResult,
} from "./utils/account-state-snapshot"

// Encrypted backup (.swarmid) support
export {
  deriveBackupEncryptionKey,
  encryptBackupPayload,
  decryptBackupPayload,
  buildBackupHeader,
  createEncryptedExport,
  decryptEncryptedExport,
  parseEncryptedExportHeader,
  EncryptedSwarmIdExportSchemaV1,
} from "./utils/backup-encryption"

export type {
  EncryptedSwarmIdExport,
  BackupHeaderWithoutCiphertext,
  ParseHeaderResult,
} from "./utils/backup-encryption"

// Epoch-based feeds - implementations
export {
  EpochIndex,
  SyncEpochFinder,
  AsyncEpochFinder,
  BasicEpochUpdater,
  lca,
  next,
  createSyncEpochFinder,
  createAsyncEpochFinder,
  createEpochUpdater,
  createEpochFinder, // deprecated alias for createSyncEpochFinder
  MAX_LEVEL,
} from "./proxy/feeds/epochs"

// State sync to Swarm
export {
  // Account-level key derivation
  deriveAccountBackupKey,
  deriveAccountDerivationKey,
  deriveSwarmEncryptionKey,
  derivePostageSignerKey,
  backupKeyToPrivateKey,
  serializeAccountState,
  deserializeAccountState,
  // Snapshot merge primitives (shared by publish + refresh)
  mergeSnapshotWithRemote,
  mergeConnectedApps,
  mergePostageStamps,
  mergeDevicesList,
  snapshotContainsContribution,
  // Sync account
  createSyncAccount,
  ACCOUNT_SYNC_TOPIC_PREFIX,
  // Restore account from Swarm
  restoreAccountFromSwarm,
  SnapshotDataUnavailableError,
  // Phase 3a: per-device snapshot feeds + append-only roster discovery
  deviceStateTopic,
  writeDeviceState,
  publishDeviceState,
  readLatestDeviceState,
  foldAccount,
  deserializeDeviceState,
  DeviceStateSnapshotSchemaV1,
  DEVICE_STATE_TOPIC_PREFIX,
  rosterTopic,
  readRoster,
  ensureInRoster,
  ROSTER_TOPIC_PREFIX,
  foldAccountFromSwarm,
  foldedToSyncedAccount,
} from "./sync"

// State sync types
export type {
  SyncResult,
  // Sync account types
  SyncAccountOptions,
  SyncAccountFunction,
  // Store interfaces
  AccountsStoreInterface,
  PostageStampsStoreInterface,
  StamperOptions,
  FlushableStamper,
  // Restore account types
  RestoreAccountResult,
  // Phase 3a types
  DeviceStateSnapshot,
  DeviceStateView,
  FoldedAccount,
  AccountSettings,
  FoldAccountResult,
} from "./sync"

// Type exports
export type {
  ClientOptions,
  AuthStatus,
  UploadResult,
  FileData,
  PostageBatch,
  UploadOptions,
  ActUploadOptions,
  SOCReader,
  SOCWriter,
  SingleOwnerChunk,
  SocUploadResult,
  SocRawUploadResult,
  FeedReaderOptions,
  FeedWriterOptions,
  FeedReader,
  FeedWriter,
  SequentialFeedReaderOptions,
  SequentialFeedWriterOptions,
  SequentialFeedUpdateOptions,
  SequentialFeedUploadOptions,
  SequentialFeedPayloadResult,
  SequentialFeedReferenceResult,
  SequentialFeedUploadResult,
  SequentialFeedReader,
  SequentialFeedWriter,
  UploadProgress,
  RequestOptions,
  DownloadOptions,
  ParentToIframeMessage,
  IframeToParentMessage,
  PopupToIframeMessage,
  SetSecretMessage,
  AuthData,
  AppMetadata,
  ButtonConfig,
  ConnectionInfo,
  ConnectionIdentity,
  Avatar,
  AvatarSource,
  // ACT message types
  ActUploadDataMessage,
  ActDownloadDataMessage,
  ActAddGranteesMessage,
  ActRevokeGranteesMessage,
  ActGetGranteesMessage,
  ActUploadDataResponseMessage,
  ActDownloadDataResponseMessage,
  ActAddGranteesResponseMessage,
  ActRevokeGranteesResponseMessage,
  ActGetGranteesResponseMessage,
  ConnectionInfoChangedMessage,
  DeriveAppSecretMessage,
  DeriveAppSecretResponseMessage,
  SocUploadMessage,
  SocRawUploadMessage,
  SocDownloadMessage,
  SocRawDownloadMessage,
  SocGetOwnerMessage,
  EpochFeedDownloadReferenceMessage,
  EpochFeedUploadReferenceMessage,
  FeedGetOwnerMessage,
  SequentialFeedGetOwnerMessage,
  SequentialFeedDownloadPayloadMessage,
  SequentialFeedDownloadRawPayloadMessage,
  SequentialFeedDownloadReferenceMessage,
  SequentialFeedUploadPayloadMessage,
  SequentialFeedUploadRawPayloadMessage,
  SequentialFeedUploadReferenceMessage,
  SocUploadResponseMessage,
  SocRawUploadResponseMessage,
  SocDownloadResponseMessage,
  SocRawDownloadResponseMessage,
  SocGetOwnerResponseMessage,
  EpochFeedDownloadReferenceResponseMessage,
  EpochFeedUploadReferenceResponseMessage,
  FeedGetOwnerResponseMessage,
  SequentialFeedGetOwnerResponseMessage,
  SequentialFeedDownloadPayloadResponseMessage,
  SequentialFeedDownloadRawPayloadResponseMessage,
  SequentialFeedDownloadReferenceResponseMessage,
  SequentialFeedUploadPayloadResponseMessage,
  SequentialFeedUploadRawPayloadResponseMessage,
  SequentialFeedUploadReferenceResponseMessage,
} from "./types"

// Entity types from schemas
export type {
  Device,
  Account,
  SyncedAccount,
  SignedInAccount,
  SignedOutAccount,
  LocalVault,
  AccessMethod,
  ConnectedApp,
  PostageStamp,
  AccountMetadata,
  NetworkSettings,
} from "./schemas"

// Network settings constants and schema
export {
  DeviceSchemaV1,
  DEFAULT_BEE_NODE_URL,
  DEFAULT_GNOSIS_RPC_URL,
  NetworkSettingsSchemaV1,
  LocalAccountSchemaV1,
  SyncedAccountSchemaV1,
  LocalVaultSchemaV1,
  AccessMethodSchemaV1,
  PostageStampSchemaV1,
  isLocalAccount,
  isSignedOutAccount,
} from "./schemas"

// Base validation schemas and types
export {
  ReferenceSchema,
  BatchIdSchema,
  AddressSchema,
  PrivateKeySchema,
  CompressedPublicKeySchema,
  EncryptionKeySchema,
  IdentifierSchema,
  SignatureSchema,
  TimestampSchema,
  FeedIndexSchema,
} from "./schemas"
export type {
  Reference,
  BatchId,
  Address,
  PrivateKey,
  CompressedPublicKey,
  Identifier,
  Signature,
  Timestamp,
  FeedIndex,
} from "./schemas"

// Device ID utilities
export {
  getOrCreateDeviceId,
  getDeviceId,
  mergeDevices,
  detectDeviceName,
} from "./utils/device-id"

// Batch utilization types
export type {
  BatchUtilizationState,
  ChunkLayout,
} from "./utils/batch-utilization"

// Versioned storage types
export type {
  VersionedStorage,
  StorageAdapter,
  VersionParser,
  Serializer,
  VersionedStorageOptions,
} from "./utils/versioned-storage"

// Epoch feed types
export type {
  Epoch,
  EpochFinder,
  EpochUpdater,
  EpochFeedOptions,
  EpochFeedWriterOptions,
  EpochLookupResult,
} from "./proxy/feeds/epochs"

// Schema exports (for validation)
export {
  UploadOptionsSchema,
  ActUploadOptionsSchema,
  RequestOptionsSchema,
  DownloadOptionsSchema,
  UploadResultSchema,
  FileDataSchema,
  PostageBatchSchema,
  AuthStatusSchema,
  ParentToIframeMessageSchema,
  IframeToParentMessageSchema,
  PopupToIframeMessageSchema,
  SetSecretMessageSchema,
  AuthDataSchema,
  // ACT message schemas
  ActUploadDataMessageSchema,
  ActDownloadDataMessageSchema,
  ActAddGranteesMessageSchema,
  ActRevokeGranteesMessageSchema,
  ActGetGranteesMessageSchema,
  ActUploadDataResponseMessageSchema,
  ActDownloadDataResponseMessageSchema,
  ActAddGranteesResponseMessageSchema,
  ActRevokeGranteesResponseMessageSchema,
  ActGetGranteesResponseMessageSchema,
} from "./types"

// Download data utility
export { downloadDataWithChunkAPI } from "./proxy/download-data"

// SOC write/read primitives (used by dev tooling, e.g. the gateway
// retrievability self-check: write a SOC then read it back).
export { downloadEncryptedSOC } from "./proxy/download-data"
export {
  uploadSOC,
  SocUploadError,
  type UploadTarget,
  type UploadSOCOptions,
} from "./proxy/upload"

// ACT (Access Control Tries) exports
export {
  createActForContent,
  decryptActReference,
  addGranteesToAct,
  revokeGranteesFromAct,
  getGranteesFromAct,
  parseCompressedPublicKey,
  publicKeyFromPrivate,
  compressPublicKey,
  publicKeyFromCompressed,
} from "./proxy/act"

export type { ActEntry } from "./proxy/act"

// Constant exports
export { SWARM_SECRET_PREFIX, STORAGE_CHALLENGE_KEY } from "./types"

// URL building utilities
export { buildAuthUrl, isHttpUrl } from "./utils/url"

// Browser detection utilities
export { isWebKit } from "./utils/browser"

// Promise utilities
export { rejectAfter } from "./utils/promise"

// Manifest builder utilities for /bzz/ feed compatibility
export {
  buildBzzCompatibleManifest,
  buildBzzManifestNode,
  buildMinimalManifest,
  extractReferenceFromManifest,
  extractEntryFromManifest,
  extractContentFromFlatManifest,
  padPayloadForSOCDetection,
  MAX_PADDED_PAYLOAD_SIZE,
} from "./proxy/manifest-builder"

export type {
  BzzCompatibleManifestResult,
  BzzManifestNodeResult,
} from "./proxy/manifest-builder"

// Mantaray tree utilities for recursive upload/download
export {
  saveMantarayTree,
  saveMantarayTreeRecursively,
  loadMantarayTreeWithChunkAPI,
} from "./proxy/mantaray"

export type {
  MantarayUploadCallback,
  SaveMantarayOptions,
  UploadCallback,
} from "./proxy/mantaray"

// Time and session constants
export {
  SECOND,
  MINUTE,
  HOUR,
  DAY,
  DEFAULT_SESSION_DURATION,
} from "./utils/constants"

// TTL calculation and formatting utilities
export {
  calculateTTLSeconds,
  formatTTL,
  getBlockTimestamp,
  calculateExpiryTimestamp,
  fetchSwarmPrice,
  fetchChainState,
  calculateStampAmountForDays,
  fetchBatchTTL,
  SWARMSCAN_STATS_URL,
  GNOSIS_BLOCK_TIME,
  BLOCKS_PER_DAY,
} from "./utils/ttl"
export type { ChainState } from "./utils/ttl"

// On-chain postage batch reads (PostageStamp contract, ground-truth TTL)
export {
  fetchOnChainBatchState,
  fetchOnChainBatchStateResult,
  fetchBatchTTLFromContract,
  fetchAuthoritativeBatchTTL,
  resolveBatchStatus,
  resolvePostageStampContractAddress,
  calculateContractTTLSeconds,
  decodeBatches,
  decodeUint,
  POSTAGE_STAMP_CONTRACT_ADDRESS,
} from "./utils/postage-contract"
export type {
  OnChainPostageBatch,
  OnChainBatchState,
  OnChainBatchResult,
  BatchResolution,
} from "./utils/postage-contract"

// Postage stamp <-> account/app association
export {
  resolveStampForApp,
  collectAccountStampBatchIds,
} from "./utils/postage-stamp-association"
