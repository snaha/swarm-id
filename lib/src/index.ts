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

// Auth popup
export { SwarmIdAuth, initAuth } from "./swarm-id-auth"

// Key derivation utilities
export {
  deriveSecret,
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
  getOrInitializeState,
  saveUtilizationState,
  loadUtilizationState,
  clearUtilizationState,
  calculateUtilizationPercentage,
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
  NUM_BUCKETS,
  BUCKET_DEPTH,
  UTILIZATION_SLOTS_PER_BUCKET,
  DATA_COUNTER_START,
  CHUNK_SIZE,
  DEFAULT_BATCH_DEPTH,
} from "./utils/batch-utilization"

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
  serializeAccount,
  serializeIdentity,
  serializeConnectedApp,
  serializePostageStamp,
} from "./utils/storage-managers"

// Type exports
export type {
  ClientOptions,
  ProxyOptions,
  AuthOptions,
  AuthStatus,
  ButtonStyles,
  UploadResult,
  FileData,
  PostageBatch,
  UploadOptions,
  DownloadOptions,
  Reference,
  BatchId,
  Address,
  ParentToIframeMessage,
  IframeToParentMessage,
  PopupToIframeMessage,
  SetSecretMessage,
  AuthData,
} from "./types"

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

// Schema exports (for validation)
export {
  ReferenceSchema,
  BatchIdSchema,
  AddressSchema,
  UploadOptionsSchema,
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
} from "./types"

// Constant exports
export { SWARM_SECRET_PREFIX } from "./types"
