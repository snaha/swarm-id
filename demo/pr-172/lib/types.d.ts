import { z } from "zod";
import type { PrivateKey as BeePrivateKey, Topic as BeeTopic } from "@ethersphere/bee-js";
export declare const SWARM_SECRET_PREFIX = "swarm-secret-";
export declare const STORAGE_KEY_ACCOUNTS = "swarm-id-accounts";
export declare const STORAGE_KEY_IDENTITIES = "swarm-id-identities";
export declare const STORAGE_KEY_CONNECTED_APPS = "swarm-id-connected-apps";
export declare const STORAGE_KEY_POSTAGE_STAMPS = "swarm-id-postage-stamps";
export declare const STORAGE_KEY_NETWORK_SETTINGS = "swarm-id-network-settings";
export declare const ReferenceSchema: z.ZodString;
export declare const BatchIdSchema: z.ZodString;
export declare const AddressSchema: z.ZodString;
export declare const PrivateKeySchema: z.ZodString;
export declare const IdentifierSchema: z.ZodString;
export declare const SignatureSchema: z.ZodString;
export declare const TimestampSchema: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
export declare const FeedIndexSchema: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
export type Reference = z.infer<typeof ReferenceSchema>;
export type BatchId = z.infer<typeof BatchIdSchema>;
export type Address = z.infer<typeof AddressSchema>;
export type PrivateKey = z.infer<typeof PrivateKeySchema>;
export type Identifier = z.infer<typeof IdentifierSchema>;
export type Signature = z.infer<typeof SignatureSchema>;
export type Timestamp = z.infer<typeof TimestampSchema>;
export type FeedIndex = z.infer<typeof FeedIndexSchema>;
export declare const UploadOptionsSchema: z.ZodOptional<z.ZodObject<{
    pin: z.ZodOptional<z.ZodBoolean>;
    encrypt: z.ZodOptional<z.ZodBoolean>;
    tag: z.ZodOptional<z.ZodNumber>;
    deferred: z.ZodOptional<z.ZodBoolean>;
    redundancyLevel: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>>;
export declare const ActUploadOptionsSchema: z.ZodOptional<z.ZodObject<{
    pin: z.ZodOptional<z.ZodBoolean>;
    encrypt: z.ZodOptional<z.ZodBoolean>;
    tag: z.ZodOptional<z.ZodNumber>;
    deferred: z.ZodOptional<z.ZodBoolean>;
    redundancyLevel: z.ZodOptional<z.ZodNumber>;
    beeCompatible: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>>;
export declare const RequestOptionsSchema: z.ZodOptional<z.ZodObject<{
    timeout: z.ZodOptional<z.ZodNumber>;
    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>>;
export declare const DownloadOptionsSchema: z.ZodOptional<z.ZodObject<{
    redundancyStrategy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>>;
    fallback: z.ZodOptional<z.ZodBoolean>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
    actPublisher: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
    actHistoryAddress: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
    actTimestamp: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
}, z.core.$strip>>;
export interface UploadProgress {
    total: number;
    processed: number;
}
export interface UploadOptions {
    pin?: boolean;
    encrypt?: boolean;
    tag?: number;
    deferred?: boolean;
    redundancyLevel?: number;
    onProgress?: (progress: UploadProgress) => void;
}
export type RequestOptions = z.infer<typeof RequestOptionsSchema>;
export type DownloadOptions = z.infer<typeof DownloadOptionsSchema>;
export interface ActUploadOptions extends UploadOptions {
    beeCompatible?: boolean;
}
export declare const UploadResultSchema: z.ZodObject<{
    reference: z.ZodString;
    tagUid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const SocUploadResultSchema: z.ZodObject<{
    reference: z.ZodString;
    tagUid: z.ZodOptional<z.ZodNumber>;
    encryptionKey: z.ZodString;
    owner: z.ZodString;
}, z.core.$strip>;
export declare const SocRawUploadResultSchema: z.ZodObject<{
    reference: z.ZodString;
    tagUid: z.ZodOptional<z.ZodNumber>;
    encryptionKey: z.ZodOptional<z.ZodString>;
    owner: z.ZodString;
}, z.core.$strip>;
export declare const FileDataSchema: z.ZodObject<{
    name: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>;
export declare const PostageBatchSchema: z.ZodObject<{
    batchID: z.ZodString;
    utilization: z.ZodNumber;
    usable: z.ZodBoolean;
    label: z.ZodString;
    depth: z.ZodNumber;
    amount: z.ZodString;
    bucketDepth: z.ZodNumber;
    blockNumber: z.ZodNumber;
    immutableFlag: z.ZodBoolean;
    exists: z.ZodBoolean;
    batchTTL: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type UploadResult = z.infer<typeof UploadResultSchema>;
export type SocUploadResult = z.infer<typeof SocUploadResultSchema>;
export type SocRawUploadResult = z.infer<typeof SocRawUploadResultSchema>;
export type FileData = z.infer<typeof FileDataSchema>;
export type PostageBatch = z.infer<typeof PostageBatchSchema>;
export interface SingleOwnerChunk {
    data: Uint8Array;
    identifier: Identifier;
    signature: Signature;
    span: number;
    payload: Uint8Array;
    address: Reference;
    owner: Address;
}
/**
 * Interface for downloading single owner chunks (SOC).
 *
 * `download` expects an encryption key and returns decrypted content.
 * `rawDownload` returns unencrypted SOC data.
 */
export interface SOCReader {
    /**
     * Resolve SOC owner address. For SOCWriter without signer, this may be
     * resolved via the proxy.
     */
    getOwner: () => Promise<Address>;
    /**
     * Download an unencrypted SOC by identifier.
     *
     * @param identifier - SOC identifier (32-byte value)
     */
    rawDownload: (identifier: Identifier | Uint8Array | string, encryptionKey?: Uint8Array | string) => Promise<SingleOwnerChunk>;
    /**
     * Download and decrypt an encrypted SOC by identifier.
     *
     * @param identifier - SOC identifier (32-byte value)
     * @param encryptionKey - 32-byte encryption key returned by upload
     */
    download: (identifier: Identifier | Uint8Array | string, encryptionKey: Uint8Array | string) => Promise<SingleOwnerChunk>;
}
/**
 * Interface for downloading and uploading single owner chunks (SOC).
 *
 * `upload` creates an encrypted SOC by default.
 * `rawUpload` creates an unencrypted SOC.
 */
export interface SOCWriter extends SOCReader {
    /**
     * Upload an encrypted SOC.
     *
     * @param identifier - SOC identifier (32-byte value)
     * @param data - SOC payload data (1-4096 bytes)
     * @param options - Optional upload configuration
     */
    upload: (identifier: Identifier | Uint8Array | string, data: Uint8Array, options?: UploadOptions) => Promise<SocUploadResult>;
    /**
     * Upload an unencrypted SOC.
     *
     * @param identifier - SOC identifier (32-byte value)
     * @param data - SOC payload data (1-4096 bytes)
     * @param options - Optional upload configuration
     */
    rawUpload: (identifier: Identifier | Uint8Array | string, data: Uint8Array, options?: UploadOptions) => Promise<SocRawUploadResult>;
}
/**
 * Options for epoch feed reader creation.
 */
export interface FeedReaderOptions {
    /** Feed topic (32 bytes). */
    topic: Identifier | Uint8Array | string | BeeTopic;
    /** Optional feed owner address (20 bytes). */
    owner?: Address | Uint8Array | string;
}
/**
 * Options for epoch feed writer creation.
 */
export interface FeedWriterOptions {
    /** Feed topic (32 bytes). */
    topic: Identifier | Uint8Array | string | BeeTopic;
    /** Optional signer private key (32 bytes). */
    signer?: BeePrivateKey | Uint8Array | string;
}
/**
 * Epoch feed reader interface.
 */
export interface EpochFeedDownloadOptions {
    /** Unix timestamp (seconds). */
    at?: bigint | number | string;
    /** Hint of latest known update timestamp. */
    after?: bigint | number | string;
    /** Optional encryption key for encrypted feed updates. */
    encryptionKey?: Uint8Array | string;
}
export interface EpochFeedUploadOptions {
    /** Unix timestamp (seconds). */
    at?: bigint | number | string;
    /** Optional upload options for the payload upload. */
    uploadOptions?: UploadOptions;
    /** Whether to encrypt payload uploads (defaults to true). */
    encrypt?: boolean;
    /** Optional encryption key for encrypted feed updates. */
    encryptionKey?: Uint8Array | string;
    /** Optional hints from previous update for stateless epoch calculation. */
    hints?: {
        lastEpoch?: {
            start: string;
            level: number;
        };
        lastTimestamp?: string;
    };
}
export interface EpochFeedDownloadPayloadResult {
    /** Downloaded payload, if available. */
    payload?: Uint8Array;
    /** Reference used to download the payload, if available. */
    reference?: Reference;
    /** Encryption key (hex) if the reference is encrypted. */
    encryptionKey?: string;
}
export interface EpochFeedDownloadReferenceResult {
    /** Swarm reference (hex), if found. */
    reference?: Reference;
    /** Encryption key (hex) if the reference is encrypted. */
    encryptionKey?: string;
}
export interface EpochFeedUploadResult {
    /** SOC address for the feed update. */
    socAddress: Reference;
    /** Reference stored in the feed update. */
    reference: Reference;
    /** Encryption key (hex) if the reference is encrypted. */
    encryptionKey?: string;
    /** Epoch used for this update (for caller to store as hint) */
    epoch: {
        start: string;
        level: number;
    };
    /** Timestamp used (stringified bigint) */
    timestamp: string;
}
/**
 * Epoch feed reader interface.
 */
export interface FeedReader {
    /** Resolve feed owner address (20 bytes). */
    getOwner: () => Promise<Address>;
    /** Download the reference for the given timestamp. */
    downloadReference: (options?: EpochFeedDownloadOptions) => Promise<EpochFeedDownloadReferenceResult>;
    /** Download the payload for the given timestamp. */
    downloadPayload: (options?: EpochFeedDownloadOptions) => Promise<EpochFeedDownloadPayloadResult>;
    /** Download unencrypted reference (for /bzz access). */
    downloadRawReference: (options?: Omit<EpochFeedDownloadOptions, "encryptionKey">) => Promise<EpochFeedDownloadReferenceResult>;
    /** Download unencrypted payload (for /bzz access). */
    downloadRawPayload: (options?: Omit<EpochFeedDownloadOptions, "encryptionKey">) => Promise<EpochFeedDownloadPayloadResult>;
}
/**
 * Epoch feed writer interface.
 */
export interface FeedWriter extends FeedReader {
    /** Upload payload data and update the feed. */
    uploadPayload: (data: Uint8Array | string, options?: EpochFeedUploadOptions) => Promise<EpochFeedUploadResult>;
    /** Update the feed with a reference. */
    uploadReference: (reference: Uint8Array | string, options?: EpochFeedUploadOptions) => Promise<EpochFeedUploadResult>;
    /** Upload unencrypted payload (for /bzz access). */
    uploadRawPayload: (data: Uint8Array | string, options?: Omit<EpochFeedUploadOptions, "encryptionKey" | "encrypt">) => Promise<EpochFeedUploadResult>;
    /** Upload unencrypted reference (for /bzz access). */
    uploadRawReference: (reference: Uint8Array | string, options?: Omit<EpochFeedUploadOptions, "encryptionKey">) => Promise<EpochFeedUploadResult>;
}
/**
 * Options for sequential feed reader creation.
 */
export interface SequentialFeedReaderOptions {
    /** Feed topic (32 bytes). */
    topic: Identifier | Uint8Array | string | BeeTopic;
    /** Optional feed owner address (20 bytes). */
    owner?: Address | Uint8Array | string;
}
/**
 * Options for sequential feed writer creation.
 */
export interface SequentialFeedWriterOptions {
    /** Feed topic (32 bytes). */
    topic: Identifier | Uint8Array | string | BeeTopic;
    /** Optional signer private key (32 bytes). */
    signer?: BeePrivateKey | Uint8Array | string;
}
/**
 * Options for sequential feed lookups/updates.
 */
export interface SequentialFeedUpdateOptions {
    /** Specific feed index to read/write. */
    index?: FeedIndex | bigint;
    /** Timestamp (seconds) used for lookup or payload timestamp. */
    at?: Timestamp | bigint;
    /** Whether payload is prefixed with timestamp (default true). */
    hasTimestamp?: boolean;
    /** Timeout (ms) for sequential index lookups (default 2000). */
    lookupTimeoutMs?: number;
}
/**
 * Options for sequential feed uploads.
 */
export interface SequentialFeedUploadOptions extends UploadOptions, SequentialFeedUpdateOptions {
}
/**
 * Options for sequential feed raw download (encryptionKey in options).
 */
export interface SequentialFeedDownloadRawOptions extends SequentialFeedUpdateOptions {
    /** Optional encryption key for decrypting encrypted feed updates. */
    encryptionKey?: Uint8Array | string;
}
/**
 * Options for sequential feed raw upload (encryptionKey in options).
 */
export interface SequentialFeedUploadRawOptions extends SequentialFeedUploadOptions {
    /** Optional encryption key for encrypting the payload. */
    encryptionKey?: Uint8Array | string;
}
/**
 * Result from sequential payload download.
 */
export interface SequentialFeedPayloadResult {
    /** Payload bytes (timestamp removed if present). */
    payload: Uint8Array;
    /** Timestamp extracted from payload, if present. */
    timestamp?: number;
    /** Current feed index as a stringified uint64. */
    feedIndex: string;
    /** Next feed index as a stringified uint64. */
    feedIndexNext: string;
}
/**
 * Result from sequential reference download.
 */
export interface SequentialFeedReferenceResult {
    /** Swarm reference stored in the feed update. */
    reference: string;
    /** Current feed index as a stringified uint64. */
    feedIndex: string;
    /** Next feed index as a stringified uint64. */
    feedIndexNext: string;
}
/**
 * Result from sequential feed upload.
 */
export interface SequentialFeedUploadResult {
    /** SOC address of the feed update. */
    reference: string;
    /** Feed index used for the update (stringified uint64). */
    feedIndex: string;
    /** Owner address for the feed update. */
    owner: string;
    /** Encryption key for decrypting payload (if encrypted). */
    encryptionKey?: string;
    /** Upload tag UID, if provided. */
    tagUid?: number;
}
/**
 * Sequential feed reader interface.
 */
export interface SequentialFeedReader {
    /** Resolve feed owner address (20 bytes). */
    getOwner: () => Promise<Address>;
    /**
     * Download and decrypt payload (requires encryption key).
     * @param encryptionKey - 32-byte encryption key.
     */
    downloadPayload: (encryptionKey: Uint8Array | string, options?: SequentialFeedUpdateOptions) => Promise<SequentialFeedPayloadResult>;
    /**
     * Download raw payload or decrypt if encryptionKey is provided in options.
     */
    downloadRawPayload: (options?: SequentialFeedDownloadRawOptions) => Promise<SequentialFeedPayloadResult>;
    /**
     * Download and decrypt reference (requires encryption key).
     * @param encryptionKey - 32-byte encryption key.
     */
    downloadReference: (encryptionKey: Uint8Array | string, options?: SequentialFeedUpdateOptions) => Promise<SequentialFeedReferenceResult>;
}
/**
 * Sequential feed writer interface.
 */
export interface SequentialFeedWriter extends SequentialFeedReader {
    /**
     * Upload encrypted payload.
     */
    uploadPayload: (data: Uint8Array | string, options?: SequentialFeedUploadOptions) => Promise<SequentialFeedUploadResult>;
    /**
     * Upload raw payload (or encrypted if encryptionKey provided in options).
     */
    uploadRawPayload: (data: Uint8Array | string, options?: SequentialFeedUploadRawOptions) => Promise<SequentialFeedUploadResult>;
    /**
     * Upload a reference payload (encrypted by default).
     */
    uploadReference: (reference: Uint8Array | string, options?: SequentialFeedUploadOptions) => Promise<SequentialFeedUploadResult>;
}
export declare const AuthStatusSchema: z.ZodObject<{
    authenticated: z.ZodBoolean;
    origin: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type AuthStatus = z.infer<typeof AuthStatusSchema>;
export declare const ConnectionInfoSchema: z.ZodObject<{
    canUpload: z.ZodBoolean;
    identity: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        address: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ConnectionInfo = z.infer<typeof ConnectionInfoSchema>;
export declare const ButtonStylesSchema: z.ZodOptional<z.ZodObject<{
    backgroundColor: z.ZodOptional<z.ZodString>;
    color: z.ZodOptional<z.ZodString>;
    border: z.ZodOptional<z.ZodString>;
    borderRadius: z.ZodOptional<z.ZodString>;
    padding: z.ZodOptional<z.ZodString>;
    fontSize: z.ZodOptional<z.ZodString>;
    fontFamily: z.ZodOptional<z.ZodString>;
    fontWeight: z.ZodOptional<z.ZodString>;
    cursor: z.ZodOptional<z.ZodString>;
    width: z.ZodOptional<z.ZodString>;
    height: z.ZodOptional<z.ZodString>;
}, z.core.$strip>>;
export type ButtonStyles = z.infer<typeof ButtonStylesSchema>;
export declare const AppMetadataSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    icon: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type AppMetadata = z.infer<typeof AppMetadataSchema>;
export declare const ButtonConfigSchema: z.ZodOptional<z.ZodObject<{
    connectText: z.ZodOptional<z.ZodString>;
    disconnectText: z.ZodOptional<z.ZodString>;
    loadingText: z.ZodOptional<z.ZodString>;
    backgroundColor: z.ZodOptional<z.ZodString>;
    color: z.ZodOptional<z.ZodString>;
    borderRadius: z.ZodOptional<z.ZodString>;
}, z.core.$strip>>;
export interface ButtonConfig {
    connectText?: string;
    disconnectText?: string;
    loadingText?: string;
    backgroundColor?: string;
    color?: string;
    borderRadius?: string;
}
export declare const ParentIdentifyMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"parentIdentify">;
    beeApiUrl: z.ZodOptional<z.ZodString>;
    popupMode: z.ZodOptional<z.ZodEnum<{
        popup: "popup";
        window: "window";
    }>>;
    metadata: z.ZodObject<{
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        icon: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    buttonConfig: z.ZodOptional<z.ZodObject<{
        connectText: z.ZodOptional<z.ZodString>;
        disconnectText: z.ZodOptional<z.ZodString>;
        loadingText: z.ZodOptional<z.ZodString>;
        backgroundColor: z.ZodOptional<z.ZodString>;
        color: z.ZodOptional<z.ZodString>;
        borderRadius: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const CheckAuthMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"checkAuth">;
    requestId: z.ZodString;
}, z.core.$strip>;
export declare const DisconnectMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"disconnect">;
    requestId: z.ZodString;
}, z.core.$strip>;
export declare const RequestAuthMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"requestAuth">;
    styles: z.ZodOptional<z.ZodObject<{
        backgroundColor: z.ZodOptional<z.ZodString>;
        color: z.ZodOptional<z.ZodString>;
        border: z.ZodOptional<z.ZodString>;
        borderRadius: z.ZodOptional<z.ZodString>;
        padding: z.ZodOptional<z.ZodString>;
        fontSize: z.ZodOptional<z.ZodString>;
        fontFamily: z.ZodOptional<z.ZodString>;
        fontWeight: z.ZodOptional<z.ZodString>;
        cursor: z.ZodOptional<z.ZodString>;
        width: z.ZodOptional<z.ZodString>;
        height: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const UploadDataMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"uploadData">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    enableProgress: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const DownloadDataMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"downloadData">;
    requestId: z.ZodString;
    reference: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        redundancyStrategy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>>;
        fallback: z.ZodOptional<z.ZodBoolean>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
        actPublisher: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actHistoryAddress: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actTimestamp: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const UploadFileMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"uploadFile">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    name: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const DownloadFileMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"downloadFile">;
    requestId: z.ZodString;
    reference: z.ZodString;
    path: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{
        redundancyStrategy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>>;
        fallback: z.ZodOptional<z.ZodBoolean>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
        actPublisher: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actHistoryAddress: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actTimestamp: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const UploadChunkMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"uploadChunk">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const DownloadChunkMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"downloadChunk">;
    requestId: z.ZodString;
    reference: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        redundancyStrategy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>>;
        fallback: z.ZodOptional<z.ZodBoolean>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
        actPublisher: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actHistoryAddress: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actTimestamp: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const GetConnectionInfoMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"getConnectionInfo">;
    requestId: z.ZodString;
}, z.core.$strip>;
export declare const IsConnectedMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"isConnected">;
    requestId: z.ZodString;
}, z.core.$strip>;
export declare const GetNodeInfoMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"getNodeInfo">;
    requestId: z.ZodString;
}, z.core.$strip>;
export declare const GsocMineMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"gsocMine">;
    requestId: z.ZodString;
    targetOverlay: z.ZodString;
    identifier: z.ZodString;
    proximity: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const GsocSendMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"gsocSend">;
    requestId: z.ZodString;
    signer: z.ZodString;
    identifier: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const SocUploadMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"socUpload">;
    requestId: z.ZodString;
    identifier: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    signer: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const SocRawUploadMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"socRawUpload">;
    requestId: z.ZodString;
    identifier: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    signer: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const SocDownloadMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"socDownload">;
    requestId: z.ZodString;
    owner: z.ZodOptional<z.ZodString>;
    identifier: z.ZodString;
    encryptionKey: z.ZodString;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const SocRawDownloadMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"socRawDownload">;
    requestId: z.ZodString;
    owner: z.ZodOptional<z.ZodString>;
    identifier: z.ZodString;
    encryptionKey: z.ZodOptional<z.ZodString>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const SocGetOwnerMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"socGetOwner">;
    requestId: z.ZodString;
}, z.core.$strip>;
export declare const EpochFeedDownloadReferenceMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"epochFeedDownloadReference">;
    requestId: z.ZodString;
    topic: z.ZodString;
    owner: z.ZodOptional<z.ZodString>;
    at: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    after: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    encryptionKey: z.ZodOptional<z.ZodString>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const EpochHintsSchema: z.ZodOptional<z.ZodObject<{
    lastEpoch: z.ZodOptional<z.ZodObject<{
        start: z.ZodString;
        level: z.ZodNumber;
    }, z.core.$strip>>;
    lastTimestamp: z.ZodOptional<z.ZodString>;
}, z.core.$strip>>;
export declare const EpochFeedUploadReferenceMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"epochFeedUploadReference">;
    requestId: z.ZodString;
    topic: z.ZodString;
    signer: z.ZodOptional<z.ZodString>;
    at: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    reference: z.ZodString;
    encryptionKey: z.ZodOptional<z.ZodString>;
    hints: z.ZodOptional<z.ZodObject<{
        lastEpoch: z.ZodOptional<z.ZodObject<{
            start: z.ZodString;
            level: z.ZodNumber;
        }, z.core.$strip>>;
        lastTimestamp: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const FeedGetOwnerMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"feedGetOwner">;
    requestId: z.ZodString;
}, z.core.$strip>;
export declare const SequentialFeedGetOwnerMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"seqFeedGetOwner">;
    requestId: z.ZodString;
}, z.core.$strip>;
export declare const SequentialFeedDownloadPayloadMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"seqFeedDownloadPayload">;
    requestId: z.ZodString;
    topic: z.ZodString;
    owner: z.ZodOptional<z.ZodString>;
    index: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    at: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    hasTimestamp: z.ZodOptional<z.ZodBoolean>;
    lookupTimeoutMs: z.ZodOptional<z.ZodNumber>;
    encryptionKey: z.ZodString;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const SequentialFeedDownloadRawPayloadMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"seqFeedDownloadRawPayload">;
    requestId: z.ZodString;
    topic: z.ZodString;
    owner: z.ZodOptional<z.ZodString>;
    index: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    at: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    hasTimestamp: z.ZodOptional<z.ZodBoolean>;
    lookupTimeoutMs: z.ZodOptional<z.ZodNumber>;
    encryptionKey: z.ZodOptional<z.ZodString>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const SequentialFeedDownloadReferenceMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"seqFeedDownloadReference">;
    requestId: z.ZodString;
    topic: z.ZodString;
    owner: z.ZodOptional<z.ZodString>;
    index: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    at: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    hasTimestamp: z.ZodOptional<z.ZodBoolean>;
    lookupTimeoutMs: z.ZodOptional<z.ZodNumber>;
    encryptionKey: z.ZodString;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const SequentialFeedUploadPayloadMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"seqFeedUploadPayload">;
    requestId: z.ZodString;
    topic: z.ZodString;
    signer: z.ZodOptional<z.ZodString>;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    index: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    at: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    hasTimestamp: z.ZodOptional<z.ZodBoolean>;
    lookupTimeoutMs: z.ZodOptional<z.ZodNumber>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const SequentialFeedUploadRawPayloadMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"seqFeedUploadRawPayload">;
    requestId: z.ZodString;
    topic: z.ZodString;
    signer: z.ZodOptional<z.ZodString>;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    index: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    at: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    hasTimestamp: z.ZodOptional<z.ZodBoolean>;
    lookupTimeoutMs: z.ZodOptional<z.ZodNumber>;
    encryptionKey: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const SequentialFeedUploadReferenceMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"seqFeedUploadReference">;
    requestId: z.ZodString;
    topic: z.ZodString;
    signer: z.ZodOptional<z.ZodString>;
    reference: z.ZodString;
    index: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    at: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    hasTimestamp: z.ZodOptional<z.ZodBoolean>;
    lookupTimeoutMs: z.ZodOptional<z.ZodNumber>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const CreateFeedManifestMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"createFeedManifest">;
    requestId: z.ZodString;
    topic: z.ZodString;
    owner: z.ZodOptional<z.ZodString>;
    feedType: z.ZodOptional<z.ZodEnum<{
        Sequence: "Sequence";
        Epoch: "Epoch";
    }>>;
    uploadOptions: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ActUploadDataMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"actUploadData">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    grantees: z.ZodArray<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
        beeCompatible: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    enableProgress: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const ActDownloadDataMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"actDownloadData">;
    requestId: z.ZodString;
    encryptedReference: z.ZodString;
    historyReference: z.ZodString;
    publisherPubKey: z.ZodString;
    timestamp: z.ZodOptional<z.ZodNumber>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ActAddGranteesMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"actAddGrantees">;
    requestId: z.ZodString;
    historyReference: z.ZodString;
    grantees: z.ZodArray<z.ZodString>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ActRevokeGranteesMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"actRevokeGrantees">;
    requestId: z.ZodString;
    historyReference: z.ZodString;
    encryptedReference: z.ZodString;
    revokeGrantees: z.ZodArray<z.ZodString>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ActGetGranteesMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"actGetGrantees">;
    requestId: z.ZodString;
    historyReference: z.ZodString;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const GetPostageBatchMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"getPostageBatch">;
    requestId: z.ZodString;
}, z.core.$strip>;
export declare const ParentToIframeMessageSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"parentIdentify">;
    beeApiUrl: z.ZodOptional<z.ZodString>;
    popupMode: z.ZodOptional<z.ZodEnum<{
        popup: "popup";
        window: "window";
    }>>;
    metadata: z.ZodObject<{
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        icon: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    buttonConfig: z.ZodOptional<z.ZodObject<{
        connectText: z.ZodOptional<z.ZodString>;
        disconnectText: z.ZodOptional<z.ZodString>;
        loadingText: z.ZodOptional<z.ZodString>;
        backgroundColor: z.ZodOptional<z.ZodString>;
        color: z.ZodOptional<z.ZodString>;
        borderRadius: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"checkAuth">;
    requestId: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"disconnect">;
    requestId: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"requestAuth">;
    styles: z.ZodOptional<z.ZodObject<{
        backgroundColor: z.ZodOptional<z.ZodString>;
        color: z.ZodOptional<z.ZodString>;
        border: z.ZodOptional<z.ZodString>;
        borderRadius: z.ZodOptional<z.ZodString>;
        padding: z.ZodOptional<z.ZodString>;
        fontSize: z.ZodOptional<z.ZodString>;
        fontFamily: z.ZodOptional<z.ZodString>;
        fontWeight: z.ZodOptional<z.ZodString>;
        cursor: z.ZodOptional<z.ZodString>;
        width: z.ZodOptional<z.ZodString>;
        height: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"uploadData">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    enableProgress: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"downloadData">;
    requestId: z.ZodString;
    reference: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        redundancyStrategy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>>;
        fallback: z.ZodOptional<z.ZodBoolean>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
        actPublisher: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actHistoryAddress: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actTimestamp: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"uploadFile">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    name: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"downloadFile">;
    requestId: z.ZodString;
    reference: z.ZodString;
    path: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{
        redundancyStrategy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>>;
        fallback: z.ZodOptional<z.ZodBoolean>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
        actPublisher: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actHistoryAddress: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actTimestamp: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"uploadChunk">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"downloadChunk">;
    requestId: z.ZodString;
    reference: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        redundancyStrategy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>>;
        fallback: z.ZodOptional<z.ZodBoolean>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
        actPublisher: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actHistoryAddress: z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodString]>;
        actTimestamp: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"getConnectionInfo">;
    requestId: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"isConnected">;
    requestId: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"getNodeInfo">;
    requestId: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"gsocMine">;
    requestId: z.ZodString;
    targetOverlay: z.ZodString;
    identifier: z.ZodString;
    proximity: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"gsocSend">;
    requestId: z.ZodString;
    signer: z.ZodString;
    identifier: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"socUpload">;
    requestId: z.ZodString;
    identifier: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    signer: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"socRawUpload">;
    requestId: z.ZodString;
    identifier: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    signer: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"socDownload">;
    requestId: z.ZodString;
    owner: z.ZodOptional<z.ZodString>;
    identifier: z.ZodString;
    encryptionKey: z.ZodString;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"socRawDownload">;
    requestId: z.ZodString;
    owner: z.ZodOptional<z.ZodString>;
    identifier: z.ZodString;
    encryptionKey: z.ZodOptional<z.ZodString>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"socGetOwner">;
    requestId: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"epochFeedDownloadReference">;
    requestId: z.ZodString;
    topic: z.ZodString;
    owner: z.ZodOptional<z.ZodString>;
    at: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    after: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    encryptionKey: z.ZodOptional<z.ZodString>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"epochFeedUploadReference">;
    requestId: z.ZodString;
    topic: z.ZodString;
    signer: z.ZodOptional<z.ZodString>;
    at: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    reference: z.ZodString;
    encryptionKey: z.ZodOptional<z.ZodString>;
    hints: z.ZodOptional<z.ZodObject<{
        lastEpoch: z.ZodOptional<z.ZodObject<{
            start: z.ZodString;
            level: z.ZodNumber;
        }, z.core.$strip>>;
        lastTimestamp: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"feedGetOwner">;
    requestId: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"seqFeedGetOwner">;
    requestId: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"seqFeedDownloadPayload">;
    requestId: z.ZodString;
    topic: z.ZodString;
    owner: z.ZodOptional<z.ZodString>;
    index: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    at: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    hasTimestamp: z.ZodOptional<z.ZodBoolean>;
    lookupTimeoutMs: z.ZodOptional<z.ZodNumber>;
    encryptionKey: z.ZodString;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"seqFeedDownloadRawPayload">;
    requestId: z.ZodString;
    topic: z.ZodString;
    owner: z.ZodOptional<z.ZodString>;
    index: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    at: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    hasTimestamp: z.ZodOptional<z.ZodBoolean>;
    lookupTimeoutMs: z.ZodOptional<z.ZodNumber>;
    encryptionKey: z.ZodOptional<z.ZodString>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"seqFeedDownloadReference">;
    requestId: z.ZodString;
    topic: z.ZodString;
    owner: z.ZodOptional<z.ZodString>;
    index: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    at: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    hasTimestamp: z.ZodOptional<z.ZodBoolean>;
    lookupTimeoutMs: z.ZodOptional<z.ZodNumber>;
    encryptionKey: z.ZodString;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"seqFeedUploadPayload">;
    requestId: z.ZodString;
    topic: z.ZodString;
    signer: z.ZodOptional<z.ZodString>;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    index: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    at: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    hasTimestamp: z.ZodOptional<z.ZodBoolean>;
    lookupTimeoutMs: z.ZodOptional<z.ZodNumber>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"seqFeedUploadRawPayload">;
    requestId: z.ZodString;
    topic: z.ZodString;
    signer: z.ZodOptional<z.ZodString>;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    index: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    at: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    hasTimestamp: z.ZodOptional<z.ZodBoolean>;
    lookupTimeoutMs: z.ZodOptional<z.ZodNumber>;
    encryptionKey: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"seqFeedUploadReference">;
    requestId: z.ZodString;
    topic: z.ZodString;
    signer: z.ZodOptional<z.ZodString>;
    reference: z.ZodString;
    index: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    at: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    hasTimestamp: z.ZodOptional<z.ZodBoolean>;
    lookupTimeoutMs: z.ZodOptional<z.ZodNumber>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"createFeedManifest">;
    requestId: z.ZodString;
    topic: z.ZodString;
    owner: z.ZodOptional<z.ZodString>;
    feedType: z.ZodOptional<z.ZodEnum<{
        Sequence: "Sequence";
        Epoch: "Epoch";
    }>>;
    uploadOptions: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"actUploadData">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    grantees: z.ZodArray<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{
        pin: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        tag: z.ZodOptional<z.ZodNumber>;
        deferred: z.ZodOptional<z.ZodBoolean>;
        redundancyLevel: z.ZodOptional<z.ZodNumber>;
        beeCompatible: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    enableProgress: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"actDownloadData">;
    requestId: z.ZodString;
    encryptedReference: z.ZodString;
    historyReference: z.ZodString;
    publisherPubKey: z.ZodString;
    timestamp: z.ZodOptional<z.ZodNumber>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"actAddGrantees">;
    requestId: z.ZodString;
    historyReference: z.ZodString;
    grantees: z.ZodArray<z.ZodString>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"actRevokeGrantees">;
    requestId: z.ZodString;
    historyReference: z.ZodString;
    encryptedReference: z.ZodString;
    revokeGrantees: z.ZodArray<z.ZodString>;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"actGetGrantees">;
    requestId: z.ZodString;
    historyReference: z.ZodString;
    requestOptions: z.ZodOptional<z.ZodObject<{
        timeout: z.ZodOptional<z.ZodNumber>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        endlesslyRetry: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"getPostageBatch">;
    requestId: z.ZodString;
}, z.core.$strip>], "type">;
export type ParentIdentifyMessage = z.infer<typeof ParentIdentifyMessageSchema>;
export type CheckAuthMessage = z.infer<typeof CheckAuthMessageSchema>;
export type DisconnectMessage = z.infer<typeof DisconnectMessageSchema>;
export type RequestAuthMessage = z.infer<typeof RequestAuthMessageSchema>;
export type UploadDataMessage = z.infer<typeof UploadDataMessageSchema>;
export type DownloadDataMessage = z.infer<typeof DownloadDataMessageSchema>;
export type UploadFileMessage = z.infer<typeof UploadFileMessageSchema>;
export type DownloadFileMessage = z.infer<typeof DownloadFileMessageSchema>;
export type UploadChunkMessage = z.infer<typeof UploadChunkMessageSchema>;
export type DownloadChunkMessage = z.infer<typeof DownloadChunkMessageSchema>;
export type GetConnectionInfoMessage = z.infer<typeof GetConnectionInfoMessageSchema>;
export type IsConnectedMessage = z.infer<typeof IsConnectedMessageSchema>;
export type GetNodeInfoMessage = z.infer<typeof GetNodeInfoMessageSchema>;
export type GsocMineMessage = z.infer<typeof GsocMineMessageSchema>;
export type GsocSendMessage = z.infer<typeof GsocSendMessageSchema>;
export type SocUploadMessage = z.infer<typeof SocUploadMessageSchema>;
export type SocRawUploadMessage = z.infer<typeof SocRawUploadMessageSchema>;
export type SocDownloadMessage = z.infer<typeof SocDownloadMessageSchema>;
export type SocRawDownloadMessage = z.infer<typeof SocRawDownloadMessageSchema>;
export type SocGetOwnerMessage = z.infer<typeof SocGetOwnerMessageSchema>;
export type EpochFeedDownloadReferenceMessage = z.infer<typeof EpochFeedDownloadReferenceMessageSchema>;
export type EpochFeedUploadReferenceMessage = z.infer<typeof EpochFeedUploadReferenceMessageSchema>;
export type FeedGetOwnerMessage = z.infer<typeof FeedGetOwnerMessageSchema>;
export type SequentialFeedGetOwnerMessage = z.infer<typeof SequentialFeedGetOwnerMessageSchema>;
export type SequentialFeedDownloadPayloadMessage = z.infer<typeof SequentialFeedDownloadPayloadMessageSchema>;
export type SequentialFeedDownloadRawPayloadMessage = z.infer<typeof SequentialFeedDownloadRawPayloadMessageSchema>;
export type SequentialFeedDownloadReferenceMessage = z.infer<typeof SequentialFeedDownloadReferenceMessageSchema>;
export type SequentialFeedUploadPayloadMessage = z.infer<typeof SequentialFeedUploadPayloadMessageSchema>;
export type SequentialFeedUploadRawPayloadMessage = z.infer<typeof SequentialFeedUploadRawPayloadMessageSchema>;
export type SequentialFeedUploadReferenceMessage = z.infer<typeof SequentialFeedUploadReferenceMessageSchema>;
export type CreateFeedManifestMessage = z.infer<typeof CreateFeedManifestMessageSchema>;
export type ActUploadDataMessage = z.infer<typeof ActUploadDataMessageSchema>;
export type ActDownloadDataMessage = z.infer<typeof ActDownloadDataMessageSchema>;
export type ActAddGranteesMessage = z.infer<typeof ActAddGranteesMessageSchema>;
export type ActRevokeGranteesMessage = z.infer<typeof ActRevokeGranteesMessageSchema>;
export type ActGetGranteesMessage = z.infer<typeof ActGetGranteesMessageSchema>;
export type GetPostageBatchMessage = z.infer<typeof GetPostageBatchMessageSchema>;
export type ParentToIframeMessage = z.infer<typeof ParentToIframeMessageSchema>;
export declare const ProxyReadyMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"proxyReady">;
    authenticated: z.ZodBoolean;
    parentOrigin: z.ZodString;
}, z.core.$strip>;
export declare const InitErrorMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"initError">;
    error: z.ZodString;
}, z.core.$strip>;
export declare const AuthStatusResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"authStatusResponse">;
    requestId: z.ZodString;
    authenticated: z.ZodBoolean;
    origin: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const DisconnectResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"disconnectResponse">;
    requestId: z.ZodString;
    success: z.ZodBoolean;
}, z.core.$strip>;
export declare const AuthSuccessMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"authSuccess">;
    origin: z.ZodString;
}, z.core.$strip>;
export declare const UploadDataResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"uploadDataResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    tagUid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const DownloadDataResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"downloadDataResponse">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>;
export declare const UploadFileResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"uploadFileResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    tagUid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const DownloadFileResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"downloadFileResponse">;
    requestId: z.ZodString;
    name: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>;
export declare const UploadChunkResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"uploadChunkResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
}, z.core.$strip>;
export declare const DownloadChunkResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"downloadChunkResponse">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>;
export declare const UploadProgressMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"uploadProgress">;
    requestId: z.ZodString;
    total: z.ZodNumber;
    processed: z.ZodNumber;
}, z.core.$strip>;
export declare const ErrorMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"error">;
    requestId: z.ZodString;
    error: z.ZodString;
}, z.core.$strip>;
export declare const ConnectionInfoResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"connectionInfoResponse">;
    requestId: z.ZodString;
    canUpload: z.ZodBoolean;
    identity: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        address: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ConnectResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"connectResponse">;
    requestId: z.ZodString;
    success: z.ZodBoolean;
}, z.core.$strip>;
export declare const IsConnectedResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"isConnectedResponse">;
    requestId: z.ZodString;
    connected: z.ZodBoolean;
}, z.core.$strip>;
export declare const GetNodeInfoResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"getNodeInfoResponse">;
    requestId: z.ZodString;
    beeMode: z.ZodString;
    chequebookEnabled: z.ZodBoolean;
    swapEnabled: z.ZodBoolean;
}, z.core.$strip>;
export declare const GsocMineResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"gsocMineResponse">;
    requestId: z.ZodString;
    signer: z.ZodString;
}, z.core.$strip>;
export declare const GsocSendResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"gsocSendResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    tagUid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const SocUploadResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"socUploadResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    tagUid: z.ZodOptional<z.ZodNumber>;
    encryptionKey: z.ZodString;
    owner: z.ZodString;
}, z.core.$strip>;
export declare const SocRawUploadResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"socRawUploadResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    tagUid: z.ZodOptional<z.ZodNumber>;
    encryptionKey: z.ZodOptional<z.ZodString>;
    owner: z.ZodString;
}, z.core.$strip>;
export declare const SocDownloadResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"socDownloadResponse">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    identifier: z.ZodString;
    signature: z.ZodString;
    span: z.ZodNumber;
    payload: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    address: z.ZodString;
    owner: z.ZodString;
}, z.core.$strip>;
export declare const SocRawDownloadResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"socRawDownloadResponse">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    identifier: z.ZodString;
    signature: z.ZodString;
    span: z.ZodNumber;
    payload: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    address: z.ZodString;
    owner: z.ZodString;
}, z.core.$strip>;
export declare const SocGetOwnerResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"socGetOwnerResponse">;
    requestId: z.ZodString;
    owner: z.ZodString;
}, z.core.$strip>;
export declare const EpochFeedDownloadReferenceResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"epochFeedDownloadReferenceResponse">;
    requestId: z.ZodString;
    reference: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const EpochFeedUploadReferenceResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"epochFeedUploadReferenceResponse">;
    requestId: z.ZodString;
    socAddress: z.ZodString;
    encryptionKey: z.ZodOptional<z.ZodString>;
    epoch: z.ZodObject<{
        start: z.ZodString;
        level: z.ZodNumber;
    }, z.core.$strip>;
    timestamp: z.ZodString;
}, z.core.$strip>;
export declare const FeedGetOwnerResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"feedGetOwnerResponse">;
    requestId: z.ZodString;
    owner: z.ZodString;
}, z.core.$strip>;
export declare const SequentialFeedGetOwnerResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"seqFeedGetOwnerResponse">;
    requestId: z.ZodString;
    owner: z.ZodString;
}, z.core.$strip>;
export declare const SequentialFeedDownloadPayloadResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"seqFeedDownloadPayloadResponse">;
    requestId: z.ZodString;
    payload: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    timestamp: z.ZodOptional<z.ZodNumber>;
    feedIndex: z.ZodString;
    feedIndexNext: z.ZodString;
}, z.core.$strip>;
export declare const SequentialFeedDownloadRawPayloadResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"seqFeedDownloadRawPayloadResponse">;
    requestId: z.ZodString;
    payload: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    timestamp: z.ZodOptional<z.ZodNumber>;
    feedIndex: z.ZodString;
    feedIndexNext: z.ZodString;
}, z.core.$strip>;
export declare const SequentialFeedDownloadReferenceResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"seqFeedDownloadReferenceResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    feedIndex: z.ZodString;
    feedIndexNext: z.ZodString;
}, z.core.$strip>;
export declare const SequentialFeedUploadPayloadResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"seqFeedUploadPayloadResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    feedIndex: z.ZodString;
    owner: z.ZodString;
    encryptionKey: z.ZodOptional<z.ZodString>;
    tagUid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const SequentialFeedUploadRawPayloadResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"seqFeedUploadRawPayloadResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    feedIndex: z.ZodString;
    owner: z.ZodString;
    encryptionKey: z.ZodOptional<z.ZodString>;
    tagUid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const SequentialFeedUploadReferenceResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"seqFeedUploadReferenceResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    feedIndex: z.ZodString;
    owner: z.ZodString;
    encryptionKey: z.ZodOptional<z.ZodString>;
    tagUid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const CreateFeedManifestResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"createFeedManifestResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
}, z.core.$strip>;
export declare const ActUploadDataResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"actUploadDataResponse">;
    requestId: z.ZodString;
    encryptedReference: z.ZodString;
    historyReference: z.ZodString;
    granteeListReference: z.ZodString;
    publisherPubKey: z.ZodString;
    actReference: z.ZodString;
    tagUid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const ActDownloadDataResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"actDownloadDataResponse">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>;
export declare const ActAddGranteesResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"actAddGranteesResponse">;
    requestId: z.ZodString;
    historyReference: z.ZodString;
    granteeListReference: z.ZodString;
    actReference: z.ZodString;
}, z.core.$strip>;
export declare const ActRevokeGranteesResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"actRevokeGranteesResponse">;
    requestId: z.ZodString;
    encryptedReference: z.ZodString;
    historyReference: z.ZodString;
    granteeListReference: z.ZodString;
    actReference: z.ZodString;
}, z.core.$strip>;
export declare const ActGetGranteesResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"actGetGranteesResponse">;
    requestId: z.ZodString;
    grantees: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export declare const GetPostageBatchResponseMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"getPostageBatchResponse">;
    requestId: z.ZodString;
    postageBatch: z.ZodOptional<z.ZodObject<{
        batchID: z.ZodString;
        utilization: z.ZodNumber;
        usable: z.ZodBoolean;
        label: z.ZodString;
        depth: z.ZodNumber;
        amount: z.ZodString;
        bucketDepth: z.ZodNumber;
        blockNumber: z.ZodNumber;
        immutableFlag: z.ZodBoolean;
        exists: z.ZodBoolean;
        batchTTL: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    error: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const IframeToParentMessageSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"proxyReady">;
    authenticated: z.ZodBoolean;
    parentOrigin: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"initError">;
    error: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"authStatusResponse">;
    requestId: z.ZodString;
    authenticated: z.ZodBoolean;
    origin: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"disconnectResponse">;
    requestId: z.ZodString;
    success: z.ZodBoolean;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"authSuccess">;
    origin: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"uploadDataResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    tagUid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"downloadDataResponse">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"uploadFileResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    tagUid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"downloadFileResponse">;
    requestId: z.ZodString;
    name: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"uploadChunkResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"downloadChunkResponse">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"uploadProgress">;
    requestId: z.ZodString;
    total: z.ZodNumber;
    processed: z.ZodNumber;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"error">;
    requestId: z.ZodString;
    error: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"connectionInfoResponse">;
    requestId: z.ZodString;
    canUpload: z.ZodBoolean;
    identity: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        address: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"connectResponse">;
    requestId: z.ZodString;
    success: z.ZodBoolean;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"isConnectedResponse">;
    requestId: z.ZodString;
    connected: z.ZodBoolean;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"getNodeInfoResponse">;
    requestId: z.ZodString;
    beeMode: z.ZodString;
    chequebookEnabled: z.ZodBoolean;
    swapEnabled: z.ZodBoolean;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"gsocMineResponse">;
    requestId: z.ZodString;
    signer: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"gsocSendResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    tagUid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"socUploadResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    tagUid: z.ZodOptional<z.ZodNumber>;
    encryptionKey: z.ZodString;
    owner: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"socRawUploadResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    tagUid: z.ZodOptional<z.ZodNumber>;
    encryptionKey: z.ZodOptional<z.ZodString>;
    owner: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"socDownloadResponse">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    identifier: z.ZodString;
    signature: z.ZodString;
    span: z.ZodNumber;
    payload: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    address: z.ZodString;
    owner: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"socRawDownloadResponse">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    identifier: z.ZodString;
    signature: z.ZodString;
    span: z.ZodNumber;
    payload: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    address: z.ZodString;
    owner: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"socGetOwnerResponse">;
    requestId: z.ZodString;
    owner: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"epochFeedDownloadReferenceResponse">;
    requestId: z.ZodString;
    reference: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"epochFeedUploadReferenceResponse">;
    requestId: z.ZodString;
    socAddress: z.ZodString;
    encryptionKey: z.ZodOptional<z.ZodString>;
    epoch: z.ZodObject<{
        start: z.ZodString;
        level: z.ZodNumber;
    }, z.core.$strip>;
    timestamp: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"feedGetOwnerResponse">;
    requestId: z.ZodString;
    owner: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"seqFeedGetOwnerResponse">;
    requestId: z.ZodString;
    owner: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"seqFeedDownloadPayloadResponse">;
    requestId: z.ZodString;
    payload: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    timestamp: z.ZodOptional<z.ZodNumber>;
    feedIndex: z.ZodString;
    feedIndexNext: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"seqFeedDownloadRawPayloadResponse">;
    requestId: z.ZodString;
    payload: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    timestamp: z.ZodOptional<z.ZodNumber>;
    feedIndex: z.ZodString;
    feedIndexNext: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"seqFeedDownloadReferenceResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    feedIndex: z.ZodString;
    feedIndexNext: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"seqFeedUploadPayloadResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    feedIndex: z.ZodString;
    owner: z.ZodString;
    encryptionKey: z.ZodOptional<z.ZodString>;
    tagUid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"seqFeedUploadRawPayloadResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    feedIndex: z.ZodString;
    owner: z.ZodString;
    encryptionKey: z.ZodOptional<z.ZodString>;
    tagUid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"seqFeedUploadReferenceResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
    feedIndex: z.ZodString;
    owner: z.ZodString;
    encryptionKey: z.ZodOptional<z.ZodString>;
    tagUid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"createFeedManifestResponse">;
    requestId: z.ZodString;
    reference: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"actUploadDataResponse">;
    requestId: z.ZodString;
    encryptedReference: z.ZodString;
    historyReference: z.ZodString;
    granteeListReference: z.ZodString;
    publisherPubKey: z.ZodString;
    actReference: z.ZodString;
    tagUid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"actDownloadDataResponse">;
    requestId: z.ZodString;
    data: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"actAddGranteesResponse">;
    requestId: z.ZodString;
    historyReference: z.ZodString;
    granteeListReference: z.ZodString;
    actReference: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"actRevokeGranteesResponse">;
    requestId: z.ZodString;
    encryptedReference: z.ZodString;
    historyReference: z.ZodString;
    granteeListReference: z.ZodString;
    actReference: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"actGetGranteesResponse">;
    requestId: z.ZodString;
    grantees: z.ZodArray<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"getPostageBatchResponse">;
    requestId: z.ZodString;
    postageBatch: z.ZodOptional<z.ZodObject<{
        batchID: z.ZodString;
        utilization: z.ZodNumber;
        usable: z.ZodBoolean;
        label: z.ZodString;
        depth: z.ZodNumber;
        amount: z.ZodString;
        bucketDepth: z.ZodNumber;
        blockNumber: z.ZodNumber;
        immutableFlag: z.ZodBoolean;
        exists: z.ZodBoolean;
        batchTTL: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    error: z.ZodOptional<z.ZodString>;
}, z.core.$strip>], "type">;
export type ProxyReadyMessage = z.infer<typeof ProxyReadyMessageSchema>;
export type InitErrorMessage = z.infer<typeof InitErrorMessageSchema>;
export type AuthStatusResponseMessage = z.infer<typeof AuthStatusResponseMessageSchema>;
export type DisconnectResponseMessage = z.infer<typeof DisconnectResponseMessageSchema>;
export type AuthSuccessMessage = z.infer<typeof AuthSuccessMessageSchema>;
export type UploadDataResponseMessage = z.infer<typeof UploadDataResponseMessageSchema>;
export type DownloadDataResponseMessage = z.infer<typeof DownloadDataResponseMessageSchema>;
export type UploadFileResponseMessage = z.infer<typeof UploadFileResponseMessageSchema>;
export type DownloadFileResponseMessage = z.infer<typeof DownloadFileResponseMessageSchema>;
export type UploadChunkResponseMessage = z.infer<typeof UploadChunkResponseMessageSchema>;
export type DownloadChunkResponseMessage = z.infer<typeof DownloadChunkResponseMessageSchema>;
export type UploadProgressMessage = z.infer<typeof UploadProgressMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type ConnectionInfoResponseMessage = z.infer<typeof ConnectionInfoResponseMessageSchema>;
export type ConnectResponseMessage = z.infer<typeof ConnectResponseMessageSchema>;
export type IsConnectedResponseMessage = z.infer<typeof IsConnectedResponseMessageSchema>;
export type GetNodeInfoResponseMessage = z.infer<typeof GetNodeInfoResponseMessageSchema>;
export type GsocMineResponseMessage = z.infer<typeof GsocMineResponseMessageSchema>;
export type GsocSendResponseMessage = z.infer<typeof GsocSendResponseMessageSchema>;
export type SocUploadResponseMessage = z.infer<typeof SocUploadResponseMessageSchema>;
export type SocRawUploadResponseMessage = z.infer<typeof SocRawUploadResponseMessageSchema>;
export type SocDownloadResponseMessage = z.infer<typeof SocDownloadResponseMessageSchema>;
export type SocRawDownloadResponseMessage = z.infer<typeof SocRawDownloadResponseMessageSchema>;
export type SocGetOwnerResponseMessage = z.infer<typeof SocGetOwnerResponseMessageSchema>;
export type EpochFeedDownloadReferenceResponseMessage = z.infer<typeof EpochFeedDownloadReferenceResponseMessageSchema>;
export type EpochFeedUploadReferenceResponseMessage = z.infer<typeof EpochFeedUploadReferenceResponseMessageSchema>;
export type FeedGetOwnerResponseMessage = z.infer<typeof FeedGetOwnerResponseMessageSchema>;
export type SequentialFeedGetOwnerResponseMessage = z.infer<typeof SequentialFeedGetOwnerResponseMessageSchema>;
export type SequentialFeedDownloadPayloadResponseMessage = z.infer<typeof SequentialFeedDownloadPayloadResponseMessageSchema>;
export type SequentialFeedDownloadRawPayloadResponseMessage = z.infer<typeof SequentialFeedDownloadRawPayloadResponseMessageSchema>;
export type SequentialFeedDownloadReferenceResponseMessage = z.infer<typeof SequentialFeedDownloadReferenceResponseMessageSchema>;
export type SequentialFeedUploadPayloadResponseMessage = z.infer<typeof SequentialFeedUploadPayloadResponseMessageSchema>;
export type SequentialFeedUploadRawPayloadResponseMessage = z.infer<typeof SequentialFeedUploadRawPayloadResponseMessageSchema>;
export type SequentialFeedUploadReferenceResponseMessage = z.infer<typeof SequentialFeedUploadReferenceResponseMessageSchema>;
export type CreateFeedManifestResponseMessage = z.infer<typeof CreateFeedManifestResponseMessageSchema>;
export type ActUploadDataResponseMessage = z.infer<typeof ActUploadDataResponseMessageSchema>;
export type ActDownloadDataResponseMessage = z.infer<typeof ActDownloadDataResponseMessageSchema>;
export type ActAddGranteesResponseMessage = z.infer<typeof ActAddGranteesResponseMessageSchema>;
export type ActRevokeGranteesResponseMessage = z.infer<typeof ActRevokeGranteesResponseMessageSchema>;
export type ActGetGranteesResponseMessage = z.infer<typeof ActGetGranteesResponseMessageSchema>;
export type GetPostageBatchResponseMessage = z.infer<typeof GetPostageBatchResponseMessageSchema>;
export type IframeToParentMessage = z.infer<typeof IframeToParentMessageSchema>;
export declare const AuthDataSchema: z.ZodObject<{
    secret: z.ZodString;
    postageBatchId: z.ZodOptional<z.ZodString>;
    signerKey: z.ZodOptional<z.ZodString>;
    networkSettings: z.ZodOptional<z.ZodObject<{
        beeNodeUrl: z.ZodString;
        gnosisRpcUrl: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type AuthData = z.infer<typeof AuthDataSchema>;
export declare const SetSecretMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"setSecret">;
    appOrigin: z.ZodString;
    data: z.ZodObject<{
        secret: z.ZodString;
        postageBatchId: z.ZodOptional<z.ZodString>;
        signerKey: z.ZodOptional<z.ZodString>;
        networkSettings: z.ZodOptional<z.ZodObject<{
            beeNodeUrl: z.ZodString;
            gnosisRpcUrl: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const PopupToIframeMessageSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"setSecret">;
    appOrigin: z.ZodString;
    data: z.ZodObject<{
        secret: z.ZodString;
        postageBatchId: z.ZodOptional<z.ZodString>;
        signerKey: z.ZodOptional<z.ZodString>;
        networkSettings: z.ZodOptional<z.ZodObject<{
            beeNodeUrl: z.ZodString;
            gnosisRpcUrl: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>], "type">;
export type SetSecretMessage = z.infer<typeof SetSecretMessageSchema>;
export type PopupToIframeMessage = z.infer<typeof PopupToIframeMessageSchema>;
export interface ClientOptions {
    iframeOrigin: string;
    iframePath?: string;
    timeout?: number;
    initializationTimeout?: number;
    onAuthChange?: (authenticated: boolean) => void;
    popupMode?: "popup" | "window";
    metadata: AppMetadata;
    buttonConfig?: ButtonConfig;
    containerId?: string;
}
export interface AuthOptions {
    masterKeyStorageKey?: string;
}
export type { PasskeyAccount, EthereumAccount, Account, Identity, ConnectedApp, PostageStamp, } from "./schemas";
//# sourceMappingURL=types.d.ts.map