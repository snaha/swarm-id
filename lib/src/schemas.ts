/**
 * Entity Schemas with Zod
 *
 * Defines Zod schemas for storage entities with transforms to convert
 * serialized primitives to bee-js runtime types. Types are derived using
 * z.infer to guarantee schema/type consistency.
 */

import { z } from "zod"
import { EthAddress, BatchId, Bytes, PrivateKey } from "@ethersphere/bee-js"

// ============================================================================
// Network Settings Constants
// ============================================================================

export const DEFAULT_BEE_NODE_URL = "https://api.gateway.ethswarm.org/"
export const DEFAULT_GNOSIS_RPC_URL = "https://xdai.fairdatasociety.org/"

// ============================================================================
// Primitive → bee-js Type Transforms (internal, for entity schemas)
// ============================================================================

/**
 * Schema for EthAddress - validates 40-char hex string, transforms to EthAddress
 */
const StoredEthAddress = z
  .string()
  .length(40)
  .transform((s) => new EthAddress(s))

/**
 * Schema for BatchId - validates 64-char hex string, transforms to BatchId
 */
const StoredBatchId = z
  .string()
  .length(64)
  .transform((s) => new BatchId(s))

/**
 * Schema for PrivateKey - validates 64-char hex string, transforms to PrivateKey
 */
const StoredPrivateKey = z
  .string()
  .length(64)
  .transform((s) => new PrivateKey(s))

/**
 * Schema for Bytes - validates number array, transforms to Bytes
 */
const StoredBytes = z
  .array(z.number())
  .transform((arr) => new Bytes(new Uint8Array(arr)))

// ============================================================================
// Account Schemas
// ============================================================================

/**
 * Passkey Account Schema V1
 */
export const PasskeyAccountSchemaV1 = z.object({
  id: StoredEthAddress,
  name: z.string(),
  createdAt: z.number(),
  type: z.literal("passkey"),
  credentialId: z.string(),
  swarmEncryptionKey: z.string().length(64), // NEW: derived encryption key for Swarm data (64-char hex)
  defaultPostageStampBatchID: StoredBatchId.optional(), // NEW: account default stamp
})

/**
 * Ethereum Account Schema V1
 */
export const EthereumAccountSchemaV1 = z.object({
  id: StoredEthAddress,
  name: z.string(),
  createdAt: z.number(),
  type: z.literal("ethereum"),
  ethereumAddress: StoredEthAddress,
  encryptedMasterKey: StoredBytes,
  encryptionSalt: StoredBytes,
  encryptedSecretSeed: StoredBytes, // Encrypted secret seed for later retrieval
  swarmEncryptionKey: z.string().length(64), // NEW: derived encryption key for Swarm data (64-char hex)
  defaultPostageStampBatchID: StoredBatchId.optional(), // NEW: account default stamp
})

/**
 * Agent Account Schema V1
 * For automated testing and programmatic use with BIP39 seed phrases
 * Seed phrase is NOT stored - must be re-entered on each authentication (like passkey)
 */
export const AgentAccountSchemaV1 = z.object({
  id: StoredEthAddress,
  name: z.string(),
  createdAt: z.number(),
  type: z.literal("agent"),
  swarmEncryptionKey: z.string().length(64), // derived encryption key for Swarm data (64-char hex)
  defaultPostageStampBatchID: StoredBatchId.optional(),
})

/**
 * Account Schema V1 (discriminated union)
 */
export const AccountSchemaV1 = z.discriminatedUnion("type", [
  PasskeyAccountSchemaV1,
  EthereumAccountSchemaV1,
  AgentAccountSchemaV1,
])

// ============================================================================
// Identity Schema
// ============================================================================

/**
 * Identity Schema V1
 */
export const IdentitySchemaV1 = z.object({
  id: z.string(),
  accountId: StoredEthAddress,
  name: z.string(),
  defaultPostageStampBatchID: StoredBatchId.optional(),
  createdAt: z.number(),
  settings: z
    .object({
      appSessionDuration: z.number().optional(),
    })
    .optional(),
})

// ============================================================================
// Connected App Schema
// ============================================================================

/**
 * Connected App Schema V1 (no transforms needed - all primitives)
 */
export const ConnectedAppSchemaV1 = z.object({
  appUrl: z.string(),
  appName: z.string(),
  lastConnectedAt: z.number(),
  identityId: z.string(),
  appIcon: z.string().optional(),
  appDescription: z.string().optional(),
  connectedUntil: z.number().optional(),
  appSecret: z.string().optional(),
})

// ============================================================================
// Postage Stamp Schema
// ============================================================================

/**
 * Postage Stamp Schema V1
 */
export const PostageStampSchemaV1 = z.object({
  accountId: z.string().length(40), // CHANGED: was identityId
  batchID: StoredBatchId,
  signerKey: StoredPrivateKey,
  utilization: z.number(),
  usable: z.boolean(),
  depth: z.number(),
  amount: z.number(),
  bucketDepth: z.number(),
  blockNumber: z.number(),
  immutableFlag: z.boolean(),
  exists: z.boolean(),
  batchTTL: z.number().optional(),
  createdAt: z.number(),
})

// ============================================================================
// Sync State Snapshot Schemas
// ============================================================================

/**
 * Account Metadata Schema V1
 */
export const AccountMetadataSchemaV1 = z.object({
  defaultPostageStampBatchID: z.string().length(64).optional(), // BatchId hex string
  createdAt: z.number(),
  lastModified: z.number(),
})

/**
 * Account State Snapshot Schema V1
 * Replaces identity-level sync with account-level sync
 */
export const AccountStateSnapshotSchemaV1 = z.object({
  version: z.literal(1),
  timestamp: z.number(),
  accountId: z.string().length(40), // EthAddress hex string
  metadata: AccountMetadataSchemaV1,
  identities: z.array(IdentitySchemaV1),
  connectedApps: z.array(ConnectedAppSchemaV1),
  postageStamps: z.array(PostageStampSchemaV1),
})

// ============================================================================
// Derived Types (guaranteed to match current schema version)
// ============================================================================

export type PasskeyAccount = z.infer<typeof PasskeyAccountSchemaV1>
export type EthereumAccount = z.infer<typeof EthereumAccountSchemaV1>
export type AgentAccount = z.infer<typeof AgentAccountSchemaV1>
export type Account = z.infer<typeof AccountSchemaV1>
export type Identity = z.infer<typeof IdentitySchemaV1>
export type ConnectedApp = z.infer<typeof ConnectedAppSchemaV1>
export type PostageStamp = z.infer<typeof PostageStampSchemaV1>
export type AccountMetadata = z.infer<typeof AccountMetadataSchemaV1>
export type AccountStateSnapshot = z.infer<typeof AccountStateSnapshotSchemaV1>

// ============================================================================
// Network Settings Schema
// ============================================================================

/**
 * Network Settings Schema V1
 * Stores user-configurable network endpoints (Bee node and Gnosis RPC)
 */
export const NetworkSettingsSchemaV1 = z.object({
  beeNodeUrl: z.string().url(),
  gnosisRpcUrl: z.string().url(),
})

export type NetworkSettings = z.infer<typeof NetworkSettingsSchemaV1>
