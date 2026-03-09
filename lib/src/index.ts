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

// Key derivation utilities
export {
  deriveSecret,
  deriveIdentityKey,
  generateMasterKey,
  hexToUint8Array,
  uint8ArrayToHex,
  verifySecret,
  utils,
} from "./utils/key-derivation"

// Batch utilization tracking
export {
  initializeBatchUtilization,
  calculateUtilizationUpdate,
  updateAfterWrite,
  saveUtilizationState,
  loadUtilizationState,
  calculateUtilization,
  toBucket,
  assignChunksToBuckets,
  serializeUint32Array,
  deserializeUint32Array,
  splitIntoChunks,
  reconstructFromChunks,
  calculateMaxSlotsPerBucket,
  hasBucketCapacity,
  createStamper,
  prepareBucketState,
  UtilizationAwareStamper,
  NUM_BUCKETS,
  BUCKET_DEPTH,
  UTILIZATION_SLOTS_PER_BUCKET,
  DATA_COUNTER_START,
  CHUNK_SIZE,
  DEFAULT_BATCH_DEPTH,
} from "./utils/batch-utilization"

// Utilization storage (IndexedDB cache)
export {
  UtilizationStoreDB,
  evictOldEntries,
  calculateContentHash,
} from "./storage/utilization-store"

export type {
  ChunkCacheEntry,
  BatchMetadata,
  CacheEvictionPolicy,
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
  createIdentitiesStorageManager,
  createConnectedAppsStorageManager,
  createPostageStampsStorageManager,
  createNetworkSettingsStorageManager,
  serializeAccount,
  serializeIdentity,
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
  PasskeyBackupHeaderSchemaV1,
  EthereumBackupHeaderSchemaV1,
  AgentBackupHeaderSchemaV1,
  EncryptedSwarmIdExportSchemaV1,
} from "./utils/backup-encryption"

export type {
  PasskeyBackupHeader,
  EthereumBackupHeader,
  AgentBackupHeader,
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
  deriveAccountSwarmEncryptionKey,
  backupKeyToPrivateKey,
  serializeAccountState,
  deserializeAccountState,
  // Sync account
  createSyncAccount,
  ACCOUNT_SYNC_TOPIC_PREFIX,
  // Restore account from Swarm
  restoreAccountFromSwarm,
} from "./sync"

// State sync types
export type {
  SyncResult,
  // Sync account types
  SyncAccountOptions,
  SyncAccountFunction,
  // Store interfaces
  AccountsStoreInterface,
  IdentitiesStoreInterface,
  ConnectedAppsStoreInterface,
  PostageStampsStoreInterface,
  StamperOptions,
  FlushableStamper,
  // Restore account types
  RestoreAccountResult,
} from "./sync"

// Type exports
export type {
  ClientOptions,
  AuthStatus,
  ButtonStyles,
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
  Reference,
  BatchId,
  Address,
  ParentToIframeMessage,
  IframeToParentMessage,
  PopupToIframeMessage,
  SetSecretMessage,
  AuthData,
  AppMetadata,
  ButtonConfig,
  ConnectionInfo,
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
  Account,
  PasskeyAccount,
  EthereumAccount,
  AgentAccount,
  Identity,
  ConnectedApp,
  PostageStamp,
  AccountMetadata,
  NetworkSettings,
} from "./schemas"

// Network settings constants and schema
export {
  DEFAULT_BEE_NODE_URL,
  DEFAULT_GNOSIS_RPC_URL,
  NetworkSettingsSchemaV1,
} from "./schemas"

// Batch utilization types
export type {
  BatchUtilizationState,
  ChunkWithBucket,
  UtilizationUpdate,
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
  ReferenceSchema,
  BatchIdSchema,
  AddressSchema,
  UploadOptionsSchema,
  ActUploadOptionsSchema,
  RequestOptionsSchema,
  DownloadOptionsSchema,
  UploadResultSchema,
  FileDataSchema,
  PostageBatchSchema,
  AuthStatusSchema,
  ButtonStylesSchema,
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
export { SWARM_SECRET_PREFIX } from "./types"

// URL building utilities
export { buildAuthUrl } from "./utils/url"

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
  saveMantarayTreeRecursively,
  loadMantarayTreeWithChunkAPI,
} from "./proxy/mantaray"

export type { UploadCallback } from "./proxy/mantaray"

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
  SWARMSCAN_STATS_URL,
  GNOSIS_BLOCK_TIME,
} from "./utils/ttl"
