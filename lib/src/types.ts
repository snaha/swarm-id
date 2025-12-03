import { z } from "zod"

// ============================================================================
// Base Types
// ============================================================================

// Support both regular (32-byte = 64 hex chars) and encrypted (64-byte = 128 hex chars) references
export const ReferenceSchema = z
  .string()
  .refine((val) => val.length === 64 || val.length === 128, {
    message:
      "Reference must be 64 chars (32 bytes) or 128 chars (64 bytes for encrypted)",
  })
export const BatchIdSchema = z.string().length(64)
export const AddressSchema = z.string().length(40)

export type Reference = z.infer<typeof ReferenceSchema>
export type BatchId = z.infer<typeof BatchIdSchema>
export type Address = z.infer<typeof AddressSchema>

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

export type UploadOptions = z.infer<typeof UploadOptionsSchema>
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
// Message Types: Parent → Iframe
// ============================================================================

export const ParentIdentifyMessageSchema = z.object({
  type: z.literal("parentIdentify"),
  beeApiUrl: z.string().url().optional(),
  popupMode: z.enum(["popup", "window"]).optional(),
})

export const CheckAuthMessageSchema = z.object({
  type: z.literal("checkAuth"),
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
  enableProgress: z.boolean().optional(),
})

export const DownloadDataMessageSchema = z.object({
  type: z.literal("downloadData"),
  requestId: z.string(),
  reference: ReferenceSchema,
  options: DownloadOptionsSchema,
})

export const UploadFileMessageSchema = z.object({
  type: z.literal("uploadFile"),
  requestId: z.string(),
  data: z.instanceof(Uint8Array),
  name: z.string().optional(),
  options: UploadOptionsSchema,
})

export const DownloadFileMessageSchema = z.object({
  type: z.literal("downloadFile"),
  requestId: z.string(),
  reference: ReferenceSchema,
  path: z.string().optional(),
  options: DownloadOptionsSchema,
})

export const UploadChunkMessageSchema = z.object({
  type: z.literal("uploadChunk"),
  requestId: z.string(),
  data: z.instanceof(Uint8Array),
  options: UploadOptionsSchema,
})

export const DownloadChunkMessageSchema = z.object({
  type: z.literal("downloadChunk"),
  requestId: z.string(),
  reference: ReferenceSchema,
  options: DownloadOptionsSchema,
})

export const ParentToIframeMessageSchema = z.discriminatedUnion("type", [
  ParentIdentifyMessageSchema,
  CheckAuthMessageSchema,
  RequestAuthMessageSchema,
  UploadDataMessageSchema,
  DownloadDataMessageSchema,
  UploadFileMessageSchema,
  DownloadFileMessageSchema,
  UploadChunkMessageSchema,
  DownloadChunkMessageSchema,
])

export type ParentIdentifyMessage = z.infer<typeof ParentIdentifyMessageSchema>
export type CheckAuthMessage = z.infer<typeof CheckAuthMessageSchema>
export type RequestAuthMessage = z.infer<typeof RequestAuthMessageSchema>
export type UploadDataMessage = z.infer<typeof UploadDataMessageSchema>
export type DownloadDataMessage = z.infer<typeof DownloadDataMessageSchema>
export type UploadFileMessage = z.infer<typeof UploadFileMessageSchema>
export type DownloadFileMessage = z.infer<typeof DownloadFileMessageSchema>
export type UploadChunkMessage = z.infer<typeof UploadChunkMessageSchema>
export type DownloadChunkMessage = z.infer<typeof DownloadChunkMessageSchema>
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

export const IframeToParentMessageSchema = z.discriminatedUnion("type", [
  ProxyReadyMessageSchema,
  InitErrorMessageSchema,
  AuthStatusResponseMessageSchema,
  AuthSuccessMessageSchema,
  UploadDataResponseMessageSchema,
  DownloadDataResponseMessageSchema,
  UploadFileResponseMessageSchema,
  DownloadFileResponseMessageSchema,
  UploadChunkResponseMessageSchema,
  DownloadChunkResponseMessageSchema,
  UploadProgressMessageSchema,
  ErrorMessageSchema,
])

export type ProxyReadyMessage = z.infer<typeof ProxyReadyMessageSchema>
export type InitErrorMessage = z.infer<typeof InitErrorMessageSchema>
export type AuthStatusResponseMessage = z.infer<
  typeof AuthStatusResponseMessageSchema
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
export type IframeToParentMessage = z.infer<typeof IframeToParentMessageSchema>

// ============================================================================
// Message Types: Popup → Iframe
// ============================================================================

export const AuthDataSchema = z
  .object({
    secret: z.string(),
    postageBatchId: BatchIdSchema.optional(),
    signerKey: z.string().length(64).optional(),
  })
  .refine(
    (data) => {
      // Must have at least postageBatchId
      if (!data.postageBatchId) {
        return false
      }
      // If signerKey is provided, it must be used with postageBatchId
      return true
    },
    {
      message:
        "postageBatchId is required. signerKey is optional for client-side signing.",
    },
  )

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
  beeApiUrl?: string
  timeout?: number
  onAuthChange?: (authenticated: boolean) => void
  popupMode?: "popup" | "window" // Default: 'window'
}

export interface ProxyOptions {
  beeApiUrl: string
  allowedOrigins?: string[]
}

export interface AuthOptions {
  masterKeyStorageKey?: string
}
