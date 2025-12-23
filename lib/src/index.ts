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
export { 
  SWARM_SECRET_PREFIX,
} from "./types"
