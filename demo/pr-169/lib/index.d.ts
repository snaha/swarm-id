/**
 * Swarm ID Library
 *
 * A TypeScript library for integrating Swarm ID authentication
 * and Bee API operations into dApps.
 */
export { SwarmIdClient } from "./swarm-id-client";
export { SwarmIdProxy, initProxy } from "./swarm-id-proxy";
export { deriveSecret, generateMasterKey, hexToUint8Array, uint8ArrayToHex, verifySecret, utils, } from "./utils/key-derivation";
export { initializeBatchUtilization, calculateUtilizationUpdate, updateAfterWrite, saveUtilizationState, loadUtilizationState, calculateUtilization, toBucket, assignChunksToBuckets, serializeUint32Array, deserializeUint32Array, splitIntoChunks, reconstructFromChunks, calculateMaxSlotsPerBucket, hasBucketCapacity, createStamper, prepareBucketState, UtilizationAwareStamper, NUM_BUCKETS, BUCKET_DEPTH, UTILIZATION_SLOTS_PER_BUCKET, DATA_COUNTER_START, CHUNK_SIZE, DEFAULT_BATCH_DEPTH, } from "./utils/batch-utilization";
export { UtilizationStoreDB, evictOldEntries, calculateContentHash, } from "./storage/utilization-store";
export type { ChunkCacheEntry, BatchMetadata, CacheEvictionPolicy, } from "./storage/utilization-store";
export { DebouncedUtilizationUploader } from "./storage/debounced-uploader";
export { VersionedStorageManager, LocalStorageAdapter, MemoryStorageAdapter, createLocalStorageManager, createMemoryStorageManager, createZodParser, VersionedStorageSchema, } from "./utils/versioned-storage";
export { createAccountsStorageManager, createIdentitiesStorageManager, createConnectedAppsStorageManager, createPostageStampsStorageManager, createNetworkSettingsStorageManager, serializeAccount, serializeIdentity, serializeConnectedApp, serializePostageStamp, serializeNetworkSettings, } from "./utils/storage-managers";
export type { NetworkSettingsStorageManager } from "./utils/storage-managers";
export { EpochIndex, SyncEpochFinder, AsyncEpochFinder, BasicEpochUpdater, lca, next, createSyncEpochFinder, createAsyncEpochFinder, createEpochUpdater, createEpochFinder, // deprecated alias for createSyncEpochFinder
MAX_LEVEL, } from "./proxy/feeds/epochs";
export { deriveAccountBackupKey, deriveAccountSwarmEncryptionKey, backupKeyToPrivateKey, serializeAccountState, deserializeAccountState, createSyncAccount, ACCOUNT_SYNC_TOPIC_PREFIX, } from "./sync";
export type { AccountStateSnapshot, AccountMetadata, SyncResult, SyncAccountOptions, SyncAccountFunction, AccountsStoreInterface, IdentitiesStoreInterface, ConnectedAppsStoreInterface, PostageStampsStoreInterface, StamperOptions, FlushableStamper, } from "./sync";
export type { ClientOptions, AuthStatus, ButtonStyles, UploadResult, FileData, PostageBatch, UploadOptions, ActUploadOptions, SOCReader, SOCWriter, SingleOwnerChunk, SocUploadResult, SocRawUploadResult, UploadProgress, RequestOptions, DownloadOptions, Reference, BatchId, Address, ParentToIframeMessage, IframeToParentMessage, PopupToIframeMessage, SetSecretMessage, AuthData, AppMetadata, ButtonConfig, ConnectionInfo, ActUploadDataMessage, ActDownloadDataMessage, ActAddGranteesMessage, ActRevokeGranteesMessage, ActGetGranteesMessage, ActUploadDataResponseMessage, ActDownloadDataResponseMessage, ActAddGranteesResponseMessage, ActRevokeGranteesResponseMessage, ActGetGranteesResponseMessage, SocUploadMessage, SocRawUploadMessage, SocDownloadMessage, SocRawDownloadMessage, SocGetOwnerMessage, SocUploadResponseMessage, SocRawUploadResponseMessage, SocDownloadResponseMessage, SocRawDownloadResponseMessage, SocGetOwnerResponseMessage, } from "./types";
export type { Account, PasskeyAccount, EthereumAccount, Identity, ConnectedApp, PostageStamp, NetworkSettings, } from "./schemas";
export { DEFAULT_BEE_NODE_URL, DEFAULT_GNOSIS_RPC_URL, NetworkSettingsSchemaV1, } from "./schemas";
export type { BatchUtilizationState, ChunkWithBucket, UtilizationUpdate, } from "./utils/batch-utilization";
export type { VersionedStorage, StorageAdapter, VersionParser, Serializer, VersionedStorageOptions, } from "./utils/versioned-storage";
export type { Epoch, EpochFinder, EpochUpdater, EpochFeedOptions, EpochFeedWriterOptions, EpochLookupResult, } from "./proxy/feeds/epochs";
export { ReferenceSchema, BatchIdSchema, AddressSchema, UploadOptionsSchema, ActUploadOptionsSchema, RequestOptionsSchema, DownloadOptionsSchema, UploadResultSchema, FileDataSchema, PostageBatchSchema, AuthStatusSchema, ButtonStylesSchema, ParentToIframeMessageSchema, IframeToParentMessageSchema, PopupToIframeMessageSchema, SetSecretMessageSchema, AuthDataSchema, ActUploadDataMessageSchema, ActDownloadDataMessageSchema, ActAddGranteesMessageSchema, ActRevokeGranteesMessageSchema, ActGetGranteesMessageSchema, ActUploadDataResponseMessageSchema, ActDownloadDataResponseMessageSchema, ActAddGranteesResponseMessageSchema, ActRevokeGranteesResponseMessageSchema, ActGetGranteesResponseMessageSchema, } from "./types";
export { createActForContent, decryptActReference, addGranteesToAct, revokeGranteesFromAct, getGranteesFromAct, parseCompressedPublicKey, publicKeyFromPrivate, compressPublicKey, publicKeyFromCompressed, } from "./proxy/act";
export type { ActEntry } from "./proxy/act";
export { SWARM_SECRET_PREFIX } from "./types";
export { buildAuthUrl } from "./utils/url";
export { SECOND, MINUTE, HOUR, DAY, DEFAULT_SESSION_DURATION, } from "./utils/constants";
export { calculateTTLSeconds, formatTTL, getBlockTimestamp, calculateExpiryTimestamp, fetchSwarmPrice, SWARMSCAN_STATS_URL, GNOSIS_BLOCK_TIME, } from "./utils/ttl";
//# sourceMappingURL=index.d.ts.map