import { z } from "zod"

// ============================================================================
// Base Types
// ============================================================================

export const ReferenceSchema = z.string().length(64)
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
    decrypt: z.boolean().optional(),
    cache: z.boolean().optional(),
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
})

export const RequestAuthMessageSchema = z.object({
  type: z.literal("requestAuth"),
  styles: ButtonStylesSchema,
})

export const UploadDataMessageSchema = z.object({
  type: z.literal("uploadData"),
  requestId: z.string(),
  postageBatchId: BatchIdSchema,
  data: z.instanceof(Uint8Array),
  options: UploadOptionsSchema,
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
  postageBatchId: BatchIdSchema,
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
  postageBatchId: BatchIdSchema,
  data: z.instanceof(Uint8Array),
  options: UploadOptionsSchema,
})

export const DownloadChunkMessageSchema = z.object({
  type: z.literal("downloadChunk"),
  requestId: z.string(),
  reference: ReferenceSchema,
  options: DownloadOptionsSchema,
})

export const CreatePostageBatchMessageSchema = z.object({
  type: z.literal("createPostageBatch"),
  requestId: z.string(),
  amount: z.string(),
  depth: z.number(),
  options: z
    .object({
      gasPrice: z.string().optional(),
      immutableFlag: z.boolean().optional(),
      label: z.string().optional(),
      waitForUsable: z.boolean().optional(),
      waitForUsableTimeout: z.number().optional(),
    })
    .optional(),
})

export const GetPostageBatchMessageSchema = z.object({
  type: z.literal("getPostageBatch"),
  requestId: z.string(),
  postageBatchId: BatchIdSchema,
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
  CreatePostageBatchMessageSchema,
  GetPostageBatchMessageSchema,
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
export type CreatePostageBatchMessage = z.infer<
  typeof CreatePostageBatchMessageSchema
>
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

export const AuthStatusResponseMessageSchema = z.object({
  type: z.literal("authStatusResponse"),
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

export const CreatePostageBatchResponseMessageSchema = z.object({
  type: z.literal("createPostageBatchResponse"),
  requestId: z.string(),
  batchId: BatchIdSchema,
})

export const GetPostageBatchResponseMessageSchema = z.object({
  type: z.literal("getPostageBatchResponse"),
  requestId: z.string(),
  batch: PostageBatchSchema,
})

export const ErrorMessageSchema = z.object({
  type: z.literal("error"),
  requestId: z.string(),
  error: z.string(),
})

export const IframeToParentMessageSchema = z.discriminatedUnion("type", [
  ProxyReadyMessageSchema,
  AuthStatusResponseMessageSchema,
  AuthSuccessMessageSchema,
  UploadDataResponseMessageSchema,
  DownloadDataResponseMessageSchema,
  UploadFileResponseMessageSchema,
  DownloadFileResponseMessageSchema,
  UploadChunkResponseMessageSchema,
  DownloadChunkResponseMessageSchema,
  CreatePostageBatchResponseMessageSchema,
  GetPostageBatchResponseMessageSchema,
  ErrorMessageSchema,
])

export type ProxyReadyMessage = z.infer<typeof ProxyReadyMessageSchema>
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
export type CreatePostageBatchResponseMessage = z.infer<
  typeof CreatePostageBatchResponseMessageSchema
>
export type GetPostageBatchResponseMessage = z.infer<
  typeof GetPostageBatchResponseMessageSchema
>
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>
export type IframeToParentMessage = z.infer<typeof IframeToParentMessageSchema>

// ============================================================================
// Message Types: Popup → Iframe
// ============================================================================

export const SetSecretMessageSchema = z.object({
  type: z.literal("setSecret"),
  appOrigin: z.string(),
  secret: z.string(),
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
