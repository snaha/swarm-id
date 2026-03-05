import { z } from "zod"
import type {
  PrivateKey as BeePrivateKey,
  Topic as BeeTopic,
} from "@ethersphere/bee-js"
import { NetworkSettingsSchemaV1 } from "./schemas"

// ============================================================================
// Constants
// ============================================================================

export const SWARM_SECRET_PREFIX = "swarm-secret-"

// Storage keys for versioned storage managers
export const STORAGE_KEY_ACCOUNTS = "swarm-id-accounts"
export const STORAGE_KEY_IDENTITIES = "swarm-id-identities"
export const STORAGE_KEY_CONNECTED_APPS = "swarm-id-connected-apps"
export const STORAGE_KEY_POSTAGE_STAMPS = "swarm-id-postage-stamps"
export const STORAGE_KEY_NETWORK_SETTINGS = "swarm-id-network-settings"

// ============================================================================
// Base Types
// ============================================================================

// Helper for hex string validation
const hexString = (length: number) =>
  z.string().regex(new RegExp(`^[0-9a-fA-F]{${length}}$`), {
    message: `Must be a ${length}-character hex string`,
  })

// Support both regular (32-byte = 64 hex chars) and encrypted (64-byte = 128 hex chars) references
export const ReferenceSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$|^[0-9a-fA-F]{128}$/, {
    message:
      "Reference must be 64 hex chars (32 bytes) or 128 hex chars (64 bytes for encrypted)",
  })
export const BatchIdSchema = hexString(64) // 32 bytes
export const AddressSchema = hexString(40) // 20 bytes
export const PrivateKeySchema = hexString(64) // 32 bytes
export const IdentifierSchema = hexString(64) // 32 bytes
export const SignatureSchema = hexString(130) // 65 bytes
export const TimestampSchema = z.union([z.number(), z.string()])
export const FeedIndexSchema = z.union([z.number(), z.string()])

export type Reference = z.infer<typeof ReferenceSchema>
export type BatchId = z.infer<typeof BatchIdSchema>
export type Address = z.infer<typeof AddressSchema>
export type PrivateKey = z.infer<typeof PrivateKeySchema>
export type Identifier = z.infer<typeof IdentifierSchema>
export type Signature = z.infer<typeof SignatureSchema>
export type Timestamp = z.infer<typeof TimestampSchema>
export type FeedIndex = z.infer<typeof FeedIndexSchema>

// ============================================================================
// Upload/Download Options
// ============================================================================

const UploadOptionsObjectSchema = z.object({
  pin: z.boolean().optional(),
  encrypt: z.boolean().optional(),
  encryptManifest: z.boolean().optional(),
  tag: z.number().optional(),
  deferred: z.boolean().optional(),
  redundancyLevel: z.number().min(0).max(4).optional(),
})

export const UploadOptionsSchema = UploadOptionsObjectSchema.optional()

export const ActUploadOptionsSchema = UploadOptionsObjectSchema.extend({
  beeCompatible: z.boolean().optional(),
}).optional()

export const RequestOptionsSchema = z
  .object({
    timeout: z.number().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    endlesslyRetry: z.boolean().optional(),
  })
  .optional()

export const DownloadOptionsSchema = z
  .object({
    redundancyStrategy: z
      .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
      .optional(),
    fallback: z.boolean().optional(),
    timeoutMs: z.number().optional(),
    actPublisher: z.union([z.instanceof(Uint8Array), z.string()]),
    actHistoryAddress: z.union([z.instanceof(Uint8Array), z.string()]),
    actTimestamp: z.union([z.number(), z.string()]),
  })
  .optional()

export interface UploadProgress {
  total: number
  processed: number
}

export interface UploadOptions {
  pin?: boolean
  encrypt?: boolean
  encryptManifest?: boolean
  tag?: number
  deferred?: boolean
  redundancyLevel?: number
  onProgress?: (progress: UploadProgress) => void
}

export type RequestOptions = z.infer<typeof RequestOptionsSchema>
export type DownloadOptions = z.infer<typeof DownloadOptionsSchema>
export interface ActUploadOptions extends UploadOptions {
  beeCompatible?: boolean
}

// ============================================================================
// Upload/Download Results
// ============================================================================

export const UploadResultSchema = z.object({
  reference: ReferenceSchema,
  tagUid: z.number().optional(),
})

export const SocUploadResultSchema = UploadResultSchema.extend({
  encryptionKey: z.string(),
  owner: AddressSchema,
})

export const SocRawUploadResultSchema = UploadResultSchema.extend({
  encryptionKey: z.string().optional(),
  owner: AddressSchema,
})

export const FileDataSchema = z.object({
  name: z.string(),
  data: z.instanceof(Uint8Array),
})

export const PostageBatchSchema = z.object({
  batchID: BatchIdSchema,
  utilization: z.number(),
  usable: z.boolean(),
  label: z.string(),
  depth: z.number(),
  amount: z.string(),
  bucketDepth: z.number(),
  blockNumber: z.number(),
  immutableFlag: z.boolean(),
  exists: z.boolean(),
  batchTTL: z.number().optional(),
})

export type UploadResult = z.infer<typeof UploadResultSchema>
export type SocUploadResult = z.infer<typeof SocUploadResultSchema>
export type SocRawUploadResult = z.infer<typeof SocRawUploadResultSchema>
export type FileData = z.infer<typeof FileDataSchema>
export type PostageBatch = z.infer<typeof PostageBatchSchema>

// ============================================================================
// SOC Types
// ============================================================================

export interface SingleOwnerChunk {
  data: Uint8Array
  identifier: Identifier
  signature: Signature
  span: number
  payload: Uint8Array
  address: Reference
  owner: Address
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
  getOwner: () => Promise<Address>
  /**
   * Download an unencrypted SOC by identifier.
   *
   * @param identifier - SOC identifier (32-byte value)
   */
  rawDownload: (
    identifier: Identifier | Uint8Array | string,
    encryptionKey?: Uint8Array | string,
  ) => Promise<SingleOwnerChunk>
  /**
   * Download and decrypt an encrypted SOC by identifier.
   *
   * @param identifier - SOC identifier (32-byte value)
   * @param encryptionKey - 32-byte encryption key returned by upload
   */
  download: (
    identifier: Identifier | Uint8Array | string,
    encryptionKey: Uint8Array | string,
  ) => Promise<SingleOwnerChunk>
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
  upload: (
    identifier: Identifier | Uint8Array | string,
    data: Uint8Array,
    options?: UploadOptions,
  ) => Promise<SocUploadResult>
  /**
   * Upload an unencrypted SOC.
   *
   * @param identifier - SOC identifier (32-byte value)
   * @param data - SOC payload data (1-4096 bytes)
   * @param options - Optional upload configuration
   */
  rawUpload: (
    identifier: Identifier | Uint8Array | string,
    data: Uint8Array,
    options?: UploadOptions,
  ) => Promise<SocRawUploadResult>
}

// ============================================================================
// Feed Types
// ============================================================================

/**
 * Options for epoch feed reader creation.
 */
export interface FeedReaderOptions {
  /** Feed topic (32 bytes). */
  topic: Identifier | Uint8Array | string | BeeTopic
  /** Optional feed owner address (20 bytes). */
  owner?: Address | Uint8Array | string
}

/**
 * Options for epoch feed writer creation.
 */
export interface FeedWriterOptions {
  /** Feed topic (32 bytes). */
  topic: Identifier | Uint8Array | string | BeeTopic
  /** Optional signer private key (32 bytes). */
  signer?: BeePrivateKey | Uint8Array | string
}

/**
 * Epoch feed reader interface.
 */
export interface EpochFeedDownloadOptions {
  /** Unix timestamp (seconds). */
  at?: bigint | number | string
  /** Hint of latest known update timestamp. */
  after?: bigint | number | string
  /** Optional encryption key for encrypted feed updates. */
  encryptionKey?: Uint8Array | string
}

export interface EpochFeedUploadOptions {
  /** Unix timestamp (seconds). */
  at?: bigint | number | string
  /** Optional upload options for the payload upload. */
  uploadOptions?: UploadOptions
  /** Whether to encrypt payload uploads (defaults to true). */
  encrypt?: boolean
  /** Optional encryption key for encrypted feed updates. */
  encryptionKey?: Uint8Array | string
  /** Optional hints from previous update for stateless epoch calculation. */
  hints?: {
    lastEpoch?: { start: string; level: number }
    lastTimestamp?: string
  }
}

export interface EpochFeedDownloadPayloadResult {
  /** Downloaded payload, if available. */
  payload?: Uint8Array
  /** Reference used to download the payload, if available. */
  reference?: Reference
  /** Encryption key (hex) if the reference is encrypted. */
  encryptionKey?: string
}

export interface EpochFeedDownloadReferenceResult {
  /** Swarm reference (hex), if found. */
  reference?: Reference
  /** Encryption key (hex) if the reference is encrypted. */
  encryptionKey?: string
}

export interface EpochFeedUploadResult {
  /** SOC address for the feed update. */
  socAddress: Reference
  /** Reference stored in the feed update. */
  reference: Reference
  /** Encryption key (hex) if the reference is encrypted. */
  encryptionKey?: string
  /** Epoch used for this update (for caller to store as hint) */
  epoch: { start: string; level: number }
  /** Timestamp used (stringified bigint) */
  timestamp: string
}

/**
 * Epoch feed reader interface.
 */
export interface FeedReader {
  /** Resolve feed owner address (20 bytes). */
  getOwner: () => Promise<Address>
  /** Download the reference for the given timestamp. */
  downloadReference: (
    options?: EpochFeedDownloadOptions,
  ) => Promise<EpochFeedDownloadReferenceResult>
  /** Download the payload for the given timestamp. */
  downloadPayload: (
    options?: EpochFeedDownloadOptions,
  ) => Promise<EpochFeedDownloadPayloadResult>
  /** Download unencrypted reference (for /bzz access). */
  downloadRawReference: (
    options?: Omit<EpochFeedDownloadOptions, "encryptionKey">,
  ) => Promise<EpochFeedDownloadReferenceResult>
  /** Download unencrypted payload (for /bzz access). */
  downloadRawPayload: (
    options?: Omit<EpochFeedDownloadOptions, "encryptionKey">,
  ) => Promise<EpochFeedDownloadPayloadResult>
}

/**
 * Epoch feed writer interface.
 */
export interface FeedWriter extends FeedReader {
  /** Upload payload data and update the feed. */
  uploadPayload: (
    data: Uint8Array | string,
    options?: EpochFeedUploadOptions,
  ) => Promise<EpochFeedUploadResult>
  /** Update the feed with a reference. */
  uploadReference: (
    reference: Uint8Array | string,
    options?: EpochFeedUploadOptions,
  ) => Promise<EpochFeedUploadResult>
  /** Upload unencrypted payload (for /bzz access). */
  uploadRawPayload: (
    data: Uint8Array | string,
    options?: Omit<EpochFeedUploadOptions, "encryptionKey" | "encrypt">,
  ) => Promise<EpochFeedUploadResult>
  /** Upload unencrypted reference (for /bzz access). */
  uploadRawReference: (
    reference: Uint8Array | string,
    options?: Omit<EpochFeedUploadOptions, "encryptionKey">,
  ) => Promise<EpochFeedUploadResult>
}

// ============================================================================
// Sequential Feed Types
// ============================================================================

/**
 * Options for sequential feed reader creation.
 */
export interface SequentialFeedReaderOptions {
  /** Feed topic (32 bytes). */
  topic: Identifier | Uint8Array | string | BeeTopic
  /** Optional feed owner address (20 bytes). */
  owner?: Address | Uint8Array | string
}

/**
 * Options for sequential feed writer creation.
 */
export interface SequentialFeedWriterOptions {
  /** Feed topic (32 bytes). */
  topic: Identifier | Uint8Array | string | BeeTopic
  /** Optional signer private key (32 bytes). */
  signer?: BeePrivateKey | Uint8Array | string
}

/**
 * Options for sequential feed lookups/updates.
 */
export interface SequentialFeedUpdateOptions {
  /** Specific feed index to read/write. */
  index?: FeedIndex | bigint
  /** Timestamp (seconds) used for lookup or payload timestamp. */
  at?: Timestamp | bigint
  /** Whether payload is prefixed with timestamp (default true). */
  hasTimestamp?: boolean
  /** Timeout (ms) for sequential index lookups (default 2000). */
  lookupTimeoutMs?: number
}

/**
 * Options for sequential feed uploads.
 */
export interface SequentialFeedUploadOptions
  extends UploadOptions, SequentialFeedUpdateOptions {}

/**
 * Options for sequential feed raw download (encryptionKey in options).
 */
export interface SequentialFeedDownloadRawOptions extends SequentialFeedUpdateOptions {
  /** Optional encryption key for decrypting encrypted feed updates. */
  encryptionKey?: Uint8Array | string
}

/**
 * Options for sequential feed raw upload (encryptionKey in options).
 */
export interface SequentialFeedUploadRawOptions extends SequentialFeedUploadOptions {
  /** Optional encryption key for encrypting the payload. */
  encryptionKey?: Uint8Array | string
}

/**
 * Result from sequential payload download.
 */
export interface SequentialFeedPayloadResult {
  /** Payload bytes (timestamp removed if present). */
  payload: Uint8Array
  /** Timestamp extracted from payload, if present. */
  timestamp?: number
  /** Current feed index as a stringified uint64. */
  feedIndex: string
  /** Next feed index as a stringified uint64. */
  feedIndexNext: string
}

/**
 * Result from sequential reference download.
 */
export interface SequentialFeedReferenceResult {
  /** Swarm reference stored in the feed update. */
  reference: string
  /** Current feed index as a stringified uint64. */
  feedIndex: string
  /** Next feed index as a stringified uint64. */
  feedIndexNext: string
}

/**
 * Result from sequential feed upload.
 */
export interface SequentialFeedUploadResult {
  /** SOC address of the feed update. */
  reference: string
  /** Feed index used for the update (stringified uint64). */
  feedIndex: string
  /** Owner address for the feed update. */
  owner: string
  /** Encryption key for decrypting payload (if encrypted). */
  encryptionKey?: string
  /** Upload tag UID, if provided. */
  tagUid?: number
}

/**
 * Sequential feed reader interface.
 */
export interface SequentialFeedReader {
  /** Resolve feed owner address (20 bytes). */
  getOwner: () => Promise<Address>
  /**
   * Download and decrypt payload (requires encryption key).
   * @param encryptionKey - 32-byte encryption key.
   */
  downloadPayload: (
    encryptionKey: Uint8Array | string,
    options?: SequentialFeedUpdateOptions,
  ) => Promise<SequentialFeedPayloadResult>
  /**
   * Download raw payload or decrypt if encryptionKey is provided in options.
   */
  downloadRawPayload: (
    options?: SequentialFeedDownloadRawOptions,
  ) => Promise<SequentialFeedPayloadResult>
  /**
   * Download and decrypt reference (requires encryption key).
   * @param encryptionKey - 32-byte encryption key.
   */
  downloadReference: (
    encryptionKey: Uint8Array | string,
    options?: SequentialFeedUpdateOptions,
  ) => Promise<SequentialFeedReferenceResult>
}

/**
 * Sequential feed writer interface.
 */
export interface SequentialFeedWriter extends SequentialFeedReader {
  /**
   * Upload encrypted payload.
   */
  uploadPayload: (
    data: Uint8Array | string,
    options?: SequentialFeedUploadOptions,
  ) => Promise<SequentialFeedUploadResult>
  /**
   * Upload raw payload (or encrypted if encryptionKey provided in options).
   */
  uploadRawPayload: (
    data: Uint8Array | string,
    options?: SequentialFeedUploadRawOptions,
  ) => Promise<SequentialFeedUploadResult>
  /**
   * Upload a reference payload (encrypted by default).
   */
  uploadReference: (
    reference: Uint8Array | string,
    options?: SequentialFeedUploadOptions,
  ) => Promise<SequentialFeedUploadResult>
}

// ============================================================================
// Auth Status
// ============================================================================

export const AuthStatusSchema = z.object({
  authenticated: z.boolean(),
  origin: z.string().optional(),
})

export type AuthStatus = z.infer<typeof AuthStatusSchema>

// ============================================================================
// Connection Info
// ============================================================================

export const ConnectionInfoSchema = z.object({
  canUpload: z.boolean(),
  identity: z
    .object({
      id: z.string(),
      name: z.string(),
      address: z.string().length(40),
    })
    .optional(),
})

export type ConnectionInfo = z.infer<typeof ConnectionInfoSchema>

// ============================================================================
// Button Styles
// ============================================================================

export const ButtonStylesSchema = z
  .object({
    backgroundColor: z.string().optional(),
    color: z.string().optional(),
    border: z.string().optional(),
    borderRadius: z.string().optional(),
    padding: z.string().optional(),
    fontSize: z.string().optional(),
    fontFamily: z.string().optional(),
    fontWeight: z.string().optional(),
    cursor: z.string().optional(),
    width: z.string().optional(),
    height: z.string().optional(),
  })
  .optional()

export type ButtonStyles = z.infer<typeof ButtonStylesSchema>

// ============================================================================
// App Metadata
// ============================================================================

export const AppMetadataSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  icon: z
    .string()
    .optional()
    .refine(
      (val) => {
        if (!val) return true
        if (!val.startsWith("data:image/")) return false
        const mimeMatch = val.match(/^data:image\/(svg\+xml|png);/)
        if (!mimeMatch) return false
        const base64Match = val.match(/base64,(.+)$/)
        if (base64Match) {
          const approximateSize = (base64Match[1].length * 3) / 4
          if (approximateSize > 4096) return false
        }
        return true
      },
      { message: "Icon must be a data URL with SVG or PNG mime type, max 4KB" },
    ),
})

export type AppMetadata = z.infer<typeof AppMetadataSchema>

// ============================================================================
// Button Configuration
// ============================================================================

export const ButtonConfigSchema = z
  .object({
    connectText: z.string().optional(),
    disconnectText: z.string().optional(),
    loadingText: z.string().optional(),
    backgroundColor: z.string().optional(),
    color: z.string().optional(),
    borderRadius: z.string().optional(),
  })
  .optional()

export interface ButtonConfig {
  connectText?: string // Default: "🔐 Login with Swarm ID"
  disconnectText?: string // Default: "🔓 Disconnect from Swarm ID"
  loadingText?: string // Default: "⏳ Loading..."
  backgroundColor?: string // Default: "#dd7200" (connect), "#666" (disconnect)
  color?: string // Default: "white"
  borderRadius?: string // Default: "0", applied to iframe
}

// ============================================================================
// Message Types: Parent → Iframe
// ============================================================================

export const ParentIdentifyMessageSchema = z.object({
  type: z.literal("parentIdentify"),
  beeApiUrl: z.string().url().optional(),
  popupMode: z.enum(["popup", "window"]).optional(),
  metadata: AppMetadataSchema,
  buttonConfig: ButtonConfigSchema,
})

export const CheckAuthMessageSchema = z.object({
  type: z.literal("checkAuth"),
  requestId: z.string(),
})

export const DisconnectMessageSchema = z.object({
  type: z.literal("disconnect"),
  requestId: z.string(),
})

export const RequestAuthMessageSchema = z.object({
  type: z.literal("requestAuth"),
  styles: ButtonStylesSchema,
})

export const UploadDataMessageSchema = z.object({
  type: z.literal("uploadData"),
  requestId: z.string(),
  data: z.instanceof(Uint8Array),
  options: UploadOptionsSchema,
  requestOptions: RequestOptionsSchema,
  enableProgress: z.boolean().optional(),
})

export const DownloadDataMessageSchema = z.object({
  type: z.literal("downloadData"),
  requestId: z.string(),
  reference: ReferenceSchema,
  options: DownloadOptionsSchema,
  requestOptions: RequestOptionsSchema,
})

export const UploadFileMessageSchema = z.object({
  type: z.literal("uploadFile"),
  requestId: z.string(),
  data: z.instanceof(Uint8Array),
  name: z.string().optional(),
  options: UploadOptionsSchema,
  requestOptions: RequestOptionsSchema,
})

export const DownloadFileMessageSchema = z.object({
  type: z.literal("downloadFile"),
  requestId: z.string(),
  reference: ReferenceSchema,
  path: z.string().optional(),
  options: DownloadOptionsSchema,
  requestOptions: RequestOptionsSchema,
})

export const UploadChunkMessageSchema = z.object({
  type: z.literal("uploadChunk"),
  requestId: z.string(),
  data: z.instanceof(Uint8Array),
  options: UploadOptionsSchema,
  requestOptions: RequestOptionsSchema,
})

export const DownloadChunkMessageSchema = z.object({
  type: z.literal("downloadChunk"),
  requestId: z.string(),
  reference: ReferenceSchema,
  options: DownloadOptionsSchema,
  requestOptions: RequestOptionsSchema,
})

export const GetConnectionInfoMessageSchema = z.object({
  type: z.literal("getConnectionInfo"),
  requestId: z.string(),
})

export const IsConnectedMessageSchema = z.object({
  type: z.literal("isConnected"),
  requestId: z.string(),
})

export const GetNodeInfoMessageSchema = z.object({
  type: z.literal("getNodeInfo"),
  requestId: z.string(),
})

export const GsocMineMessageSchema = z.object({
  type: z.literal("gsocMine"),
  requestId: z.string(),
  targetOverlay: z.string(),
  identifier: z.string(),
  proximity: z.number().optional(),
})

export const GsocSendMessageSchema = z.object({
  type: z.literal("gsocSend"),
  requestId: z.string(),
  signer: z.string(),
  identifier: z.string(),
  data: z.instanceof(Uint8Array),
  options: UploadOptionsSchema,
  requestOptions: RequestOptionsSchema,
})

// SOC (Single Owner Chunk) Message Schemas
export const SocUploadMessageSchema = z.object({
  type: z.literal("socUpload"),
  requestId: z.string(),
  identifier: IdentifierSchema,
  data: z.instanceof(Uint8Array),
  signer: PrivateKeySchema.optional(),
  options: UploadOptionsSchema,
  requestOptions: RequestOptionsSchema,
})

export const SocRawUploadMessageSchema = z.object({
  type: z.literal("socRawUpload"),
  requestId: z.string(),
  identifier: IdentifierSchema,
  data: z.instanceof(Uint8Array),
  signer: PrivateKeySchema.optional(),
  options: UploadOptionsSchema,
  requestOptions: RequestOptionsSchema,
})

export const SocDownloadMessageSchema = z.object({
  type: z.literal("socDownload"),
  requestId: z.string(),
  owner: AddressSchema.optional(),
  identifier: IdentifierSchema,
  encryptionKey: PrivateKeySchema,
  requestOptions: RequestOptionsSchema,
})

export const SocRawDownloadMessageSchema = z.object({
  type: z.literal("socRawDownload"),
  requestId: z.string(),
  owner: AddressSchema.optional(),
  identifier: IdentifierSchema,
  encryptionKey: PrivateKeySchema.optional(),
  requestOptions: RequestOptionsSchema,
})

export const SocGetOwnerMessageSchema = z.object({
  type: z.literal("socGetOwner"),
  requestId: z.string(),
})

export const EpochFeedDownloadReferenceMessageSchema = z.object({
  type: z.literal("epochFeedDownloadReference"),
  requestId: z.string(),
  topic: IdentifierSchema,
  owner: AddressSchema.optional(),
  at: TimestampSchema,
  after: TimestampSchema.optional(),
  encryptionKey: PrivateKeySchema.optional(),
  requestOptions: RequestOptionsSchema,
})

// Schema for epoch hints (used for stateless epoch calculation)
export const EpochHintsSchema = z
  .object({
    lastEpoch: z
      .object({
        start: z.string(), // Stringified bigint
        level: z.number(),
      })
      .optional(),
    lastTimestamp: z.string().optional(), // Stringified bigint
  })
  .optional()

export const EpochFeedUploadReferenceMessageSchema = z.object({
  type: z.literal("epochFeedUploadReference"),
  requestId: z.string(),
  topic: IdentifierSchema,
  signer: PrivateKeySchema.optional(),
  at: TimestampSchema,
  reference: ReferenceSchema,
  encryptionKey: PrivateKeySchema.optional(),
  hints: EpochHintsSchema,
  requestOptions: RequestOptionsSchema,
})

export const FeedGetOwnerMessageSchema = z.object({
  type: z.literal("feedGetOwner"),
  requestId: z.string(),
})

export const SequentialFeedGetOwnerMessageSchema = z.object({
  type: z.literal("seqFeedGetOwner"),
  requestId: z.string(),
})

export const SequentialFeedDownloadPayloadMessageSchema = z.object({
  type: z.literal("seqFeedDownloadPayload"),
  requestId: z.string(),
  topic: IdentifierSchema,
  owner: AddressSchema.optional(),
  index: FeedIndexSchema.optional(),
  at: TimestampSchema.optional(),
  hasTimestamp: z.boolean().optional(),
  lookupTimeoutMs: z.number().optional(),
  encryptionKey: PrivateKeySchema,
  requestOptions: RequestOptionsSchema,
})

export const SequentialFeedDownloadRawPayloadMessageSchema = z.object({
  type: z.literal("seqFeedDownloadRawPayload"),
  requestId: z.string(),
  topic: IdentifierSchema,
  owner: AddressSchema.optional(),
  index: FeedIndexSchema.optional(),
  at: TimestampSchema.optional(),
  hasTimestamp: z.boolean().optional(),
  lookupTimeoutMs: z.number().optional(),
  encryptionKey: PrivateKeySchema.optional(),
  requestOptions: RequestOptionsSchema,
})

export const SequentialFeedDownloadReferenceMessageSchema = z.object({
  type: z.literal("seqFeedDownloadReference"),
  requestId: z.string(),
  topic: IdentifierSchema,
  owner: AddressSchema.optional(),
  index: FeedIndexSchema.optional(),
  at: TimestampSchema.optional(),
  hasTimestamp: z.boolean().optional(),
  lookupTimeoutMs: z.number().optional(),
  encryptionKey: PrivateKeySchema,
  requestOptions: RequestOptionsSchema,
})

export const SequentialFeedUploadPayloadMessageSchema = z.object({
  type: z.literal("seqFeedUploadPayload"),
  requestId: z.string(),
  topic: IdentifierSchema,
  signer: PrivateKeySchema.optional(),
  data: z.instanceof(Uint8Array),
  index: FeedIndexSchema.optional(),
  at: TimestampSchema.optional(),
  hasTimestamp: z.boolean().optional(),
  lookupTimeoutMs: z.number().optional(),
  options: UploadOptionsSchema,
  requestOptions: RequestOptionsSchema,
})

export const SequentialFeedUploadRawPayloadMessageSchema = z.object({
  type: z.literal("seqFeedUploadRawPayload"),
  requestId: z.string(),
  topic: IdentifierSchema,
  signer: PrivateKeySchema.optional(),
  data: z.instanceof(Uint8Array),
  index: FeedIndexSchema.optional(),
  at: TimestampSchema.optional(),
  hasTimestamp: z.boolean().optional(),
  lookupTimeoutMs: z.number().optional(),
  encryptionKey: PrivateKeySchema.optional(),
  options: UploadOptionsSchema,
  requestOptions: RequestOptionsSchema,
})

export const SequentialFeedUploadReferenceMessageSchema = z.object({
  type: z.literal("seqFeedUploadReference"),
  requestId: z.string(),
  topic: IdentifierSchema,
  signer: PrivateKeySchema.optional(),
  reference: ReferenceSchema,
  index: FeedIndexSchema.optional(),
  at: TimestampSchema.optional(),
  hasTimestamp: z.boolean().optional(),
  lookupTimeoutMs: z.number().optional(),
  options: UploadOptionsSchema,
  requestOptions: RequestOptionsSchema,
})

// Feed Manifest Message Schema
export const CreateFeedManifestMessageSchema = z.object({
  type: z.literal("createFeedManifest"),
  requestId: z.string(),
  topic: IdentifierSchema,
  owner: AddressSchema.optional(),
  feedType: z.enum(["Sequence", "Epoch"]).optional(),
  uploadOptions: UploadOptionsSchema,
  requestOptions: RequestOptionsSchema,
})

// ACT (Access Control Tries) Message Schemas
export const ActUploadDataMessageSchema = z.object({
  type: z.literal("actUploadData"),
  requestId: z.string(),
  data: z.instanceof(Uint8Array),
  grantees: z.array(z.string()), // Compressed public keys (33 bytes = 66 hex chars)
  options: ActUploadOptionsSchema,
  requestOptions: RequestOptionsSchema,
  enableProgress: z.boolean().optional(),
})

export const ActDownloadDataMessageSchema = z.object({
  type: z.literal("actDownloadData"),
  requestId: z.string(),
  encryptedReference: ReferenceSchema,
  historyReference: ReferenceSchema,
  publisherPubKey: z.string(), // Compressed public key (33 bytes = 66 hex chars)
  timestamp: z.number().optional(), // Optional: specific ACT version
  requestOptions: RequestOptionsSchema,
})

export const ActAddGranteesMessageSchema = z.object({
  type: z.literal("actAddGrantees"),
  requestId: z.string(),
  historyReference: ReferenceSchema,
  grantees: z.array(z.string()), // Compressed public keys to add
  requestOptions: RequestOptionsSchema,
})

export const ActRevokeGranteesMessageSchema = z.object({
  type: z.literal("actRevokeGrantees"),
  requestId: z.string(),
  historyReference: ReferenceSchema,
  encryptedReference: ReferenceSchema, // Needed for key rotation
  revokeGrantees: z.array(z.string()), // Compressed public keys to revoke
  requestOptions: RequestOptionsSchema,
})

export const ActGetGranteesMessageSchema = z.object({
  type: z.literal("actGetGrantees"),
  requestId: z.string(),
  historyReference: ReferenceSchema,
  requestOptions: RequestOptionsSchema,
})

export const GetPostageBatchMessageSchema = z.object({
  type: z.literal("getPostageBatch"),
  requestId: z.string(),
})

export const ParentToIframeMessageSchema = z.discriminatedUnion("type", [
  ParentIdentifyMessageSchema,
  CheckAuthMessageSchema,
  DisconnectMessageSchema,
  RequestAuthMessageSchema,
  UploadDataMessageSchema,
  DownloadDataMessageSchema,
  UploadFileMessageSchema,
  DownloadFileMessageSchema,
  UploadChunkMessageSchema,
  DownloadChunkMessageSchema,
  GetConnectionInfoMessageSchema,
  IsConnectedMessageSchema,
  GetNodeInfoMessageSchema,
  GsocMineMessageSchema,
  GsocSendMessageSchema,
  SocUploadMessageSchema,
  SocRawUploadMessageSchema,
  SocDownloadMessageSchema,
  SocRawDownloadMessageSchema,
  SocGetOwnerMessageSchema,
  EpochFeedDownloadReferenceMessageSchema,
  EpochFeedUploadReferenceMessageSchema,
  FeedGetOwnerMessageSchema,
  SequentialFeedGetOwnerMessageSchema,
  SequentialFeedDownloadPayloadMessageSchema,
  SequentialFeedDownloadRawPayloadMessageSchema,
  SequentialFeedDownloadReferenceMessageSchema,
  SequentialFeedUploadPayloadMessageSchema,
  SequentialFeedUploadRawPayloadMessageSchema,
  SequentialFeedUploadReferenceMessageSchema,
  CreateFeedManifestMessageSchema,
  ActUploadDataMessageSchema,
  ActDownloadDataMessageSchema,
  ActAddGranteesMessageSchema,
  ActRevokeGranteesMessageSchema,
  ActGetGranteesMessageSchema,
  GetPostageBatchMessageSchema,
])

export type ParentIdentifyMessage = z.infer<typeof ParentIdentifyMessageSchema>
export type CheckAuthMessage = z.infer<typeof CheckAuthMessageSchema>
export type DisconnectMessage = z.infer<typeof DisconnectMessageSchema>
export type RequestAuthMessage = z.infer<typeof RequestAuthMessageSchema>
export type UploadDataMessage = z.infer<typeof UploadDataMessageSchema>
export type DownloadDataMessage = z.infer<typeof DownloadDataMessageSchema>
export type UploadFileMessage = z.infer<typeof UploadFileMessageSchema>
export type DownloadFileMessage = z.infer<typeof DownloadFileMessageSchema>
export type UploadChunkMessage = z.infer<typeof UploadChunkMessageSchema>
export type DownloadChunkMessage = z.infer<typeof DownloadChunkMessageSchema>
export type GetConnectionInfoMessage = z.infer<
  typeof GetConnectionInfoMessageSchema
>
export type IsConnectedMessage = z.infer<typeof IsConnectedMessageSchema>
export type GetNodeInfoMessage = z.infer<typeof GetNodeInfoMessageSchema>
export type GsocMineMessage = z.infer<typeof GsocMineMessageSchema>
export type GsocSendMessage = z.infer<typeof GsocSendMessageSchema>
export type SocUploadMessage = z.infer<typeof SocUploadMessageSchema>
export type SocRawUploadMessage = z.infer<typeof SocRawUploadMessageSchema>
export type SocDownloadMessage = z.infer<typeof SocDownloadMessageSchema>
export type SocRawDownloadMessage = z.infer<typeof SocRawDownloadMessageSchema>
export type SocGetOwnerMessage = z.infer<typeof SocGetOwnerMessageSchema>
export type EpochFeedDownloadReferenceMessage = z.infer<
  typeof EpochFeedDownloadReferenceMessageSchema
>
export type EpochFeedUploadReferenceMessage = z.infer<
  typeof EpochFeedUploadReferenceMessageSchema
>
export type FeedGetOwnerMessage = z.infer<typeof FeedGetOwnerMessageSchema>
export type SequentialFeedGetOwnerMessage = z.infer<
  typeof SequentialFeedGetOwnerMessageSchema
>
export type SequentialFeedDownloadPayloadMessage = z.infer<
  typeof SequentialFeedDownloadPayloadMessageSchema
>
export type SequentialFeedDownloadRawPayloadMessage = z.infer<
  typeof SequentialFeedDownloadRawPayloadMessageSchema
>
export type SequentialFeedDownloadReferenceMessage = z.infer<
  typeof SequentialFeedDownloadReferenceMessageSchema
>
export type SequentialFeedUploadPayloadMessage = z.infer<
  typeof SequentialFeedUploadPayloadMessageSchema
>
export type SequentialFeedUploadRawPayloadMessage = z.infer<
  typeof SequentialFeedUploadRawPayloadMessageSchema
>
export type SequentialFeedUploadReferenceMessage = z.infer<
  typeof SequentialFeedUploadReferenceMessageSchema
>
export type CreateFeedManifestMessage = z.infer<
  typeof CreateFeedManifestMessageSchema
>
export type ActUploadDataMessage = z.infer<typeof ActUploadDataMessageSchema>
export type ActDownloadDataMessage = z.infer<
  typeof ActDownloadDataMessageSchema
>
export type ActAddGranteesMessage = z.infer<typeof ActAddGranteesMessageSchema>
export type ActRevokeGranteesMessage = z.infer<
  typeof ActRevokeGranteesMessageSchema
>
export type ActGetGranteesMessage = z.infer<typeof ActGetGranteesMessageSchema>
export type GetPostageBatchMessage = z.infer<
  typeof GetPostageBatchMessageSchema
>
export type ParentToIframeMessage = z.infer<typeof ParentToIframeMessageSchema>

// ============================================================================
// Message Types: Iframe → Parent
// ============================================================================

export const ProxyReadyMessageSchema = z.object({
  type: z.literal("proxyReady"),
  authenticated: z.boolean(),
  parentOrigin: z.string(),
})

export const InitErrorMessageSchema = z.object({
  type: z.literal("initError"),
  error: z.string(),
})

export const AuthStatusResponseMessageSchema = z.object({
  type: z.literal("authStatusResponse"),
  requestId: z.string(),
  authenticated: z.boolean(),
  origin: z.string().optional(),
})

export const DisconnectResponseMessageSchema = z.object({
  type: z.literal("disconnectResponse"),
  requestId: z.string(),
  success: z.boolean(),
})

export const AuthSuccessMessageSchema = z.object({
  type: z.literal("authSuccess"),
  origin: z.string(),
})

export const UploadDataResponseMessageSchema = z.object({
  type: z.literal("uploadDataResponse"),
  requestId: z.string(),
  reference: ReferenceSchema,
  tagUid: z.number().optional(),
})

export const DownloadDataResponseMessageSchema = z.object({
  type: z.literal("downloadDataResponse"),
  requestId: z.string(),
  data: z.instanceof(Uint8Array),
})

export const UploadFileResponseMessageSchema = z.object({
  type: z.literal("uploadFileResponse"),
  requestId: z.string(),
  reference: ReferenceSchema,
  tagUid: z.number().optional(),
})

export const DownloadFileResponseMessageSchema = z.object({
  type: z.literal("downloadFileResponse"),
  requestId: z.string(),
  name: z.string(),
  data: z.instanceof(Uint8Array),
})

export const UploadChunkResponseMessageSchema = z.object({
  type: z.literal("uploadChunkResponse"),
  requestId: z.string(),
  reference: ReferenceSchema,
})

export const DownloadChunkResponseMessageSchema = z.object({
  type: z.literal("downloadChunkResponse"),
  requestId: z.string(),
  data: z.instanceof(Uint8Array),
})

export const UploadProgressMessageSchema = z.object({
  type: z.literal("uploadProgress"),
  requestId: z.string(),
  total: z.number(),
  processed: z.number(),
})

export const ErrorMessageSchema = z.object({
  type: z.literal("error"),
  requestId: z.string(),
  error: z.string(),
})

export const ConnectionInfoResponseMessageSchema = z.object({
  type: z.literal("connectionInfoResponse"),
  requestId: z.string(),
  canUpload: z.boolean(),
  identity: z
    .object({
      id: z.string(),
      name: z.string(),
      address: z.string().length(40),
    })
    .optional(),
})

export const ConnectResponseMessageSchema = z.object({
  type: z.literal("connectResponse"),
  requestId: z.string(),
  success: z.boolean(),
})

export const IsConnectedResponseMessageSchema = z.object({
  type: z.literal("isConnectedResponse"),
  requestId: z.string(),
  connected: z.boolean(),
})

export const GetNodeInfoResponseMessageSchema = z.object({
  type: z.literal("getNodeInfoResponse"),
  requestId: z.string(),
  beeMode: z.string(),
  chequebookEnabled: z.boolean(),
  swapEnabled: z.boolean(),
})

export const GsocMineResponseMessageSchema = z.object({
  type: z.literal("gsocMineResponse"),
  requestId: z.string(),
  signer: z.string(),
})

export const GsocSendResponseMessageSchema = z.object({
  type: z.literal("gsocSendResponse"),
  requestId: z.string(),
  reference: ReferenceSchema,
  tagUid: z.number().optional(),
})

export const SocUploadResponseMessageSchema = z.object({
  type: z.literal("socUploadResponse"),
  requestId: z.string(),
  reference: ReferenceSchema,
  tagUid: z.number().optional(),
  encryptionKey: z.string(),
  owner: AddressSchema,
})

export const SocRawUploadResponseMessageSchema = z.object({
  type: z.literal("socRawUploadResponse"),
  requestId: z.string(),
  reference: ReferenceSchema,
  tagUid: z.number().optional(),
  encryptionKey: z.string().optional(),
  owner: AddressSchema,
})

export const SocDownloadResponseMessageSchema = z.object({
  type: z.literal("socDownloadResponse"),
  requestId: z.string(),
  data: z.instanceof(Uint8Array),
  identifier: IdentifierSchema,
  signature: SignatureSchema,
  span: z.number(),
  payload: z.instanceof(Uint8Array),
  address: ReferenceSchema,
  owner: AddressSchema,
})

export const SocRawDownloadResponseMessageSchema = z.object({
  type: z.literal("socRawDownloadResponse"),
  requestId: z.string(),
  data: z.instanceof(Uint8Array),
  identifier: IdentifierSchema,
  signature: SignatureSchema,
  span: z.number(),
  payload: z.instanceof(Uint8Array),
  address: ReferenceSchema,
  owner: AddressSchema,
})

export const SocGetOwnerResponseMessageSchema = z.object({
  type: z.literal("socGetOwnerResponse"),
  requestId: z.string(),
  owner: AddressSchema,
})

export const EpochFeedDownloadReferenceResponseMessageSchema = z.object({
  type: z.literal("epochFeedDownloadReferenceResponse"),
  requestId: z.string(),
  reference: ReferenceSchema.optional(),
})

export const EpochFeedUploadReferenceResponseMessageSchema = z.object({
  type: z.literal("epochFeedUploadReferenceResponse"),
  requestId: z.string(),
  socAddress: ReferenceSchema,
  encryptionKey: PrivateKeySchema.optional(),
  // Epoch info for next update (stateless hints)
  epoch: z.object({
    start: z.string(), // Stringified bigint
    level: z.number(),
  }),
  timestamp: z.string(), // Stringified bigint
})

export const FeedGetOwnerResponseMessageSchema = z.object({
  type: z.literal("feedGetOwnerResponse"),
  requestId: z.string(),
  owner: AddressSchema,
})

export const SequentialFeedGetOwnerResponseMessageSchema = z.object({
  type: z.literal("seqFeedGetOwnerResponse"),
  requestId: z.string(),
  owner: AddressSchema,
})

export const SequentialFeedDownloadPayloadResponseMessageSchema = z.object({
  type: z.literal("seqFeedDownloadPayloadResponse"),
  requestId: z.string(),
  payload: z.instanceof(Uint8Array),
  timestamp: z.number().optional(),
  feedIndex: z.string(),
  feedIndexNext: z.string(),
})

export const SequentialFeedDownloadRawPayloadResponseMessageSchema = z.object({
  type: z.literal("seqFeedDownloadRawPayloadResponse"),
  requestId: z.string(),
  payload: z.instanceof(Uint8Array),
  timestamp: z.number().optional(),
  feedIndex: z.string(),
  feedIndexNext: z.string(),
})

export const SequentialFeedDownloadReferenceResponseMessageSchema = z.object({
  type: z.literal("seqFeedDownloadReferenceResponse"),
  requestId: z.string(),
  reference: ReferenceSchema,
  feedIndex: z.string(),
  feedIndexNext: z.string(),
})

export const SequentialFeedUploadPayloadResponseMessageSchema = z.object({
  type: z.literal("seqFeedUploadPayloadResponse"),
  requestId: z.string(),
  reference: ReferenceSchema,
  feedIndex: z.string(),
  owner: AddressSchema,
  encryptionKey: z.string().optional(),
  tagUid: z.number().optional(),
})

export const SequentialFeedUploadRawPayloadResponseMessageSchema = z.object({
  type: z.literal("seqFeedUploadRawPayloadResponse"),
  requestId: z.string(),
  reference: ReferenceSchema,
  feedIndex: z.string(),
  owner: AddressSchema,
  encryptionKey: z.string().optional(),
  tagUid: z.number().optional(),
})

export const SequentialFeedUploadReferenceResponseMessageSchema = z.object({
  type: z.literal("seqFeedUploadReferenceResponse"),
  requestId: z.string(),
  reference: ReferenceSchema,
  feedIndex: z.string(),
  owner: AddressSchema,
  encryptionKey: z.string().optional(),
  tagUid: z.number().optional(),
})

// Feed Manifest Response Schema
export const CreateFeedManifestResponseMessageSchema = z.object({
  type: z.literal("createFeedManifestResponse"),
  requestId: z.string(),
  reference: ReferenceSchema,
})

// ACT Response Message Schemas
export const ActUploadDataResponseMessageSchema = z.object({
  type: z.literal("actUploadDataResponse"),
  requestId: z.string(),
  encryptedReference: ReferenceSchema,
  historyReference: ReferenceSchema,
  granteeListReference: ReferenceSchema,
  publisherPubKey: z.string(), // Compressed public key
  actReference: ReferenceSchema,
  tagUid: z.number().optional(),
})

export const ActDownloadDataResponseMessageSchema = z.object({
  type: z.literal("actDownloadDataResponse"),
  requestId: z.string(),
  data: z.instanceof(Uint8Array),
})

export const ActAddGranteesResponseMessageSchema = z.object({
  type: z.literal("actAddGranteesResponse"),
  requestId: z.string(),
  historyReference: ReferenceSchema,
  granteeListReference: ReferenceSchema,
  actReference: ReferenceSchema,
})

export const ActRevokeGranteesResponseMessageSchema = z.object({
  type: z.literal("actRevokeGranteesResponse"),
  requestId: z.string(),
  encryptedReference: ReferenceSchema,
  historyReference: ReferenceSchema,
  granteeListReference: ReferenceSchema,
  actReference: ReferenceSchema,
})

export const ActGetGranteesResponseMessageSchema = z.object({
  type: z.literal("actGetGranteesResponse"),
  requestId: z.string(),
  grantees: z.array(z.string()),
})

export const GetPostageBatchResponseMessageSchema = z.object({
  type: z.literal("getPostageBatchResponse"),
  requestId: z.string(),
  postageBatch: PostageBatchSchema.optional(),
  error: z.string().optional(),
})

export const IframeToParentMessageSchema = z.discriminatedUnion("type", [
  ProxyReadyMessageSchema,
  InitErrorMessageSchema,
  AuthStatusResponseMessageSchema,
  DisconnectResponseMessageSchema,
  AuthSuccessMessageSchema,
  UploadDataResponseMessageSchema,
  DownloadDataResponseMessageSchema,
  UploadFileResponseMessageSchema,
  DownloadFileResponseMessageSchema,
  UploadChunkResponseMessageSchema,
  DownloadChunkResponseMessageSchema,
  UploadProgressMessageSchema,
  ErrorMessageSchema,
  ConnectionInfoResponseMessageSchema,
  ConnectResponseMessageSchema,
  IsConnectedResponseMessageSchema,
  GetNodeInfoResponseMessageSchema,
  GsocMineResponseMessageSchema,
  GsocSendResponseMessageSchema,
  SocUploadResponseMessageSchema,
  SocRawUploadResponseMessageSchema,
  SocDownloadResponseMessageSchema,
  SocRawDownloadResponseMessageSchema,
  SocGetOwnerResponseMessageSchema,
  EpochFeedDownloadReferenceResponseMessageSchema,
  EpochFeedUploadReferenceResponseMessageSchema,
  FeedGetOwnerResponseMessageSchema,
  SequentialFeedGetOwnerResponseMessageSchema,
  SequentialFeedDownloadPayloadResponseMessageSchema,
  SequentialFeedDownloadRawPayloadResponseMessageSchema,
  SequentialFeedDownloadReferenceResponseMessageSchema,
  SequentialFeedUploadPayloadResponseMessageSchema,
  SequentialFeedUploadRawPayloadResponseMessageSchema,
  SequentialFeedUploadReferenceResponseMessageSchema,
  CreateFeedManifestResponseMessageSchema,
  ActUploadDataResponseMessageSchema,
  ActDownloadDataResponseMessageSchema,
  ActAddGranteesResponseMessageSchema,
  ActRevokeGranteesResponseMessageSchema,
  ActGetGranteesResponseMessageSchema,
  GetPostageBatchResponseMessageSchema,
])

export type ProxyReadyMessage = z.infer<typeof ProxyReadyMessageSchema>
export type InitErrorMessage = z.infer<typeof InitErrorMessageSchema>
export type AuthStatusResponseMessage = z.infer<
  typeof AuthStatusResponseMessageSchema
>
export type DisconnectResponseMessage = z.infer<
  typeof DisconnectResponseMessageSchema
>
export type AuthSuccessMessage = z.infer<typeof AuthSuccessMessageSchema>
export type UploadDataResponseMessage = z.infer<
  typeof UploadDataResponseMessageSchema
>
export type DownloadDataResponseMessage = z.infer<
  typeof DownloadDataResponseMessageSchema
>
export type UploadFileResponseMessage = z.infer<
  typeof UploadFileResponseMessageSchema
>
export type DownloadFileResponseMessage = z.infer<
  typeof DownloadFileResponseMessageSchema
>
export type UploadChunkResponseMessage = z.infer<
  typeof UploadChunkResponseMessageSchema
>
export type DownloadChunkResponseMessage = z.infer<
  typeof DownloadChunkResponseMessageSchema
>
export type UploadProgressMessage = z.infer<typeof UploadProgressMessageSchema>
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>
export type ConnectionInfoResponseMessage = z.infer<
  typeof ConnectionInfoResponseMessageSchema
>
export type ConnectResponseMessage = z.infer<
  typeof ConnectResponseMessageSchema
>
export type IsConnectedResponseMessage = z.infer<
  typeof IsConnectedResponseMessageSchema
>
export type GetNodeInfoResponseMessage = z.infer<
  typeof GetNodeInfoResponseMessageSchema
>
export type GsocMineResponseMessage = z.infer<
  typeof GsocMineResponseMessageSchema
>
export type GsocSendResponseMessage = z.infer<
  typeof GsocSendResponseMessageSchema
>
export type SocUploadResponseMessage = z.infer<
  typeof SocUploadResponseMessageSchema
>
export type SocRawUploadResponseMessage = z.infer<
  typeof SocRawUploadResponseMessageSchema
>
export type SocDownloadResponseMessage = z.infer<
  typeof SocDownloadResponseMessageSchema
>
export type SocRawDownloadResponseMessage = z.infer<
  typeof SocRawDownloadResponseMessageSchema
>
export type SocGetOwnerResponseMessage = z.infer<
  typeof SocGetOwnerResponseMessageSchema
>
export type EpochFeedDownloadReferenceResponseMessage = z.infer<
  typeof EpochFeedDownloadReferenceResponseMessageSchema
>
export type EpochFeedUploadReferenceResponseMessage = z.infer<
  typeof EpochFeedUploadReferenceResponseMessageSchema
>
export type FeedGetOwnerResponseMessage = z.infer<
  typeof FeedGetOwnerResponseMessageSchema
>
export type SequentialFeedGetOwnerResponseMessage = z.infer<
  typeof SequentialFeedGetOwnerResponseMessageSchema
>
export type SequentialFeedDownloadPayloadResponseMessage = z.infer<
  typeof SequentialFeedDownloadPayloadResponseMessageSchema
>
export type SequentialFeedDownloadRawPayloadResponseMessage = z.infer<
  typeof SequentialFeedDownloadRawPayloadResponseMessageSchema
>
export type SequentialFeedDownloadReferenceResponseMessage = z.infer<
  typeof SequentialFeedDownloadReferenceResponseMessageSchema
>
export type SequentialFeedUploadPayloadResponseMessage = z.infer<
  typeof SequentialFeedUploadPayloadResponseMessageSchema
>
export type SequentialFeedUploadRawPayloadResponseMessage = z.infer<
  typeof SequentialFeedUploadRawPayloadResponseMessageSchema
>
export type SequentialFeedUploadReferenceResponseMessage = z.infer<
  typeof SequentialFeedUploadReferenceResponseMessageSchema
>
export type CreateFeedManifestResponseMessage = z.infer<
  typeof CreateFeedManifestResponseMessageSchema
>
export type ActUploadDataResponseMessage = z.infer<
  typeof ActUploadDataResponseMessageSchema
>
export type ActDownloadDataResponseMessage = z.infer<
  typeof ActDownloadDataResponseMessageSchema
>
export type ActAddGranteesResponseMessage = z.infer<
  typeof ActAddGranteesResponseMessageSchema
>
export type ActRevokeGranteesResponseMessage = z.infer<
  typeof ActRevokeGranteesResponseMessageSchema
>
export type ActGetGranteesResponseMessage = z.infer<
  typeof ActGetGranteesResponseMessageSchema
>
export type GetPostageBatchResponseMessage = z.infer<
  typeof GetPostageBatchResponseMessageSchema
>
export type IframeToParentMessage = z.infer<typeof IframeToParentMessageSchema>

// ============================================================================
// Message Types: Popup → Iframe
// ============================================================================

export const AuthDataSchema = z.object({
  secret: z.string(),
  postageBatchId: BatchIdSchema.optional(),
  signerKey: PrivateKeySchema.optional(),
  networkSettings: NetworkSettingsSchemaV1.optional(),
})

export type AuthData = z.infer<typeof AuthDataSchema>

export const SetSecretMessageSchema = z.object({
  type: z.literal("setSecret"),
  appOrigin: z.string(),
  data: AuthDataSchema,
})

export const PopupToIframeMessageSchema = z.discriminatedUnion("type", [
  SetSecretMessageSchema,
])

export type SetSecretMessage = z.infer<typeof SetSecretMessageSchema>
export type PopupToIframeMessage = z.infer<typeof PopupToIframeMessageSchema>

// ============================================================================
// Client Configuration
// ============================================================================

export interface ClientOptions {
  iframeOrigin: string
  iframePath?: string
  timeout?: number
  initializationTimeout?: number
  onAuthChange?: (authenticated: boolean) => void
  popupMode?: "popup" | "window" // Default: 'window'
  metadata: AppMetadata
  buttonConfig?: ButtonConfig
  containerId?: string // ID of container element to place iframe in (optional)
}

export interface AuthOptions {
  masterKeyStorageKey?: string
}

/**
 * Configuration options for the connect() method.
 */
export interface ConnectOptions {
  /**
   * Whether to open as a popup window ("popup") or full window ("window").
   * @default "window"
   */
  popupMode?: "popup" | "window"
  /**
   * When true, shows the agent sign-up option on the connect page.
   * Agents are automated services that can perform operations on behalf of users.
   */
  agent?: boolean
}

// ============================================================================
// Entity Types (derived from Zod schemas for type safety)
// ============================================================================

export type {
  PasskeyAccount,
  EthereumAccount,
  AgentAccount,
  Account,
  Identity,
  ConnectedApp,
  PostageStamp,
} from "./schemas"
