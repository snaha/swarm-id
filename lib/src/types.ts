import { z } from "zod"
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

export type Reference = z.infer<typeof ReferenceSchema>
export type BatchId = z.infer<typeof BatchIdSchema>
export type Address = z.infer<typeof AddressSchema>
export type PrivateKey = z.infer<typeof PrivateKeySchema>

// ============================================================================
// Upload/Download Options
// ============================================================================

export const UploadOptionsSchema = z
  .object({
    pin: z.boolean().optional(),
    encrypt: z.boolean().optional(),
    tag: z.number().optional(),
    deferred: z.boolean().optional(),
    redundancyLevel: z.number().min(0).max(4).optional(),
  })
  .optional()

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
  tag?: number
  deferred?: boolean
  redundancyLevel?: number
  onProgress?: (progress: UploadProgress) => void
}

export type RequestOptions = z.infer<typeof RequestOptionsSchema>
export type DownloadOptions = z.infer<typeof DownloadOptionsSchema>

// ============================================================================
// Upload/Download Results
// ============================================================================

export const UploadResultSchema = z.object({
  reference: ReferenceSchema,
  tagUid: z.number().optional(),
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
export type FileData = z.infer<typeof FileDataSchema>
export type PostageBatch = z.infer<typeof PostageBatchSchema>

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
  GsocMineMessageSchema,
  GsocSendMessageSchema,
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
export type GsocMineMessage = z.infer<typeof GsocMineMessageSchema>
export type GsocSendMessage = z.infer<typeof GsocSendMessageSchema>
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
  GsocMineResponseMessageSchema,
  GsocSendResponseMessageSchema,
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
export type GsocMineResponseMessage = z.infer<
  typeof GsocMineResponseMessageSchema
>
export type GsocSendResponseMessage = z.infer<
  typeof GsocSendResponseMessageSchema
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
  onAuthChange?: (authenticated: boolean) => void
  popupMode?: "popup" | "window" // Default: 'window'
  metadata: AppMetadata
  buttonConfig?: ButtonConfig
  containerId?: string // ID of container element to place iframe in (optional)
}

export interface AuthOptions {
  masterKeyStorageKey?: string
}

// ============================================================================
// Entity Types (derived from Zod schemas for type safety)
// ============================================================================

export type {
  PasskeyAccount,
  EthereumAccount,
  Account,
  Identity,
  ConnectedApp,
  PostageStamp,
} from "./schemas"
