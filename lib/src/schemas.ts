// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Entity Schemas with Zod
 *
 * Defines Zod schemas for storage entities with transforms to convert
 * serialized primitives to bee-js runtime types. Types are derived using
 * z.infer to guarantee schema/type consistency.
 */

import { z } from "zod"
import {
  EthAddress,
  BatchId as BeeBatchId,
  Bytes,
  PrivateKey as BeePrivateKey,
} from "@ethersphere/bee-js"

// ============================================================================
// Network Settings Constants
// ============================================================================

export const DEFAULT_BEE_NODE_URL = "https://api.gateway.ethswarm.org/"
export const DEFAULT_GNOSIS_RPC_URL = "https://xdai.fairdatasociety.org/"

// ============================================================================
// Base Validation Schemas (hex strings, no transforms)
// ============================================================================

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
export const CompressedPublicKeySchema = hexString(66) // 33 bytes compressed secp256k1
export const EncryptionKeySchema = hexString(64) // 32 bytes symmetric key
export const IdentifierSchema = hexString(64) // 32 bytes
export const SignatureSchema = hexString(130) // 65 bytes
export const TimestampSchema = z.preprocess(
  (val) => (typeof val === "bigint" ? val.toString() : val),
  z.union([z.number(), z.string()]),
)
export const FeedIndexSchema = z.preprocess(
  (val) => (typeof val === "bigint" ? val.toString() : val),
  z.union([z.number(), z.string()]),
)

export type Reference = z.infer<typeof ReferenceSchema>
export type BatchId = z.infer<typeof BatchIdSchema>
export type Address = z.infer<typeof AddressSchema>
export type PrivateKey = z.infer<typeof PrivateKeySchema>
export type CompressedPublicKey = z.infer<typeof CompressedPublicKeySchema>
export type Identifier = z.infer<typeof IdentifierSchema>
export type Signature = z.infer<typeof SignatureSchema>
export type Timestamp = z.infer<typeof TimestampSchema>
export type FeedIndex = z.infer<typeof FeedIndexSchema>

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
  .transform((s) => new BeeBatchId(s))

/**
 * Schema for PrivateKey - validates 64-char hex string, transforms to PrivateKey
 */
const StoredPrivateKey = z
  .string()
  .length(64)
  .transform((s) => new BeePrivateKey(s))

/**
 * Schema for Bytes - validates number array, transforms to Bytes
 */
const StoredBytes = z
  .array(z.number())
  .transform((arr) => new Bytes(new Uint8Array(arr)))

// ============================================================================
// Device Schema
// ============================================================================

/**
 * Device Schema V1
 * Tracks devices that have accessed an account for multi-device support.
 */
export const DeviceSchemaV1 = z.object({
  deviceId: z.string(),
  createdAt: z.number(),
  lastSignedInAt: z.number(),
  name: z.string().optional(),
  // Tombstone marker. A removed device is kept in the snapshot (so the removal
  // propagates to other devices) but hidden from the UI. A later sign-in with a
  // larger `lastSignedInAt` re-activates it (the merge clock is the max of the
  // two), mirroring app reconnect-after-revoke.
  removedAt: z.number().optional(),
})

// ============================================================================
// Connected App Schema
// ============================================================================

/**
 * Connected App Schema V1.
 *
 * Account-owned: keyed by `appUrl` within its owning account (the `identityId`
 * pointer was removed when the identity tier was collapsed into the account).
 */
export const ConnectedAppSchemaV1 = z.object({
  appUrl: z.string(),
  appName: z.string(),
  lastConnectedAt: z.number(),
  appIcon: z.string().optional(),
  appDescription: z.string().optional(),
  connectedUntil: z.number().optional(),
  appSecret: z.string().optional(),
  // Optional per-app postage-batch override. Absent → the account default
  // (`account.defaultPostageStampBatchID`) pays for this app's uploads.
  postageStampBatchID: StoredBatchId.optional(),
  // Last-writer-wins clock for cross-device merge (set on any change). Absent
  // on pre-existing records → merge falls back to `lastConnectedAt`.
  updatedAt: z.number().optional(),
  // Tombstone marker. A revoked app is kept in the snapshot (so the removal
  // propagates to other devices) but hidden from the UI and invalid for auth.
  revokedAt: z.number().optional(),
})

// ============================================================================
// Postage Stamp Schema
// ============================================================================

/**
 * Postage Stamp Schema V1
 */
export const PostageStampSchemaV1 = z.object({
  batchID: StoredBatchId,
  signerKey: StoredPrivateKey,
  utilization: z.number(),
  usable: z.boolean(),
  depth: z.number(),
  amount: z.string().transform((val) => BigInt(val)),
  bucketDepth: z.number(),
  blockNumber: z.number(),
  immutableFlag: z.boolean(),
  exists: z.boolean(),
  batchTTL: z.number().optional(),
  createdAt: z.number(),
  // Tombstone marker. A deleted stamp is kept in the snapshot (so the removal
  // propagates to other devices) but hidden from the UI and unusable for
  // uploads. A `batchID` is immutable and stamps are never edited in place, so
  // `deletedAt` always supersedes the original `createdAt` in the merge.
  deletedAt: z.number().optional(),
})

// ============================================================================
// Account Schemas
// ============================================================================

/**
 * Common fields shared by all account types.
 *
 * The account is the single-level aggregate root (the identity tier was
 * collapsed into it). It is the app-facing identity: `id` is the address apps
 * connect to and `publicKey` is surfaced to dApps. Apps receive a per-app
 * DERIVED key (`deriveSecret(masterKey, appOrigin)` → app key) — never the
 * account private key, which is the mnemonic-equivalent root and is exposed only
 * after an explicit permission/signing request. The account OWNS its connected
 * apps and postage stamps as nested collections rather than via foreign-key
 * pointers.
 */
const CommonAccountSchemaV1 = z.object({
  id: StoredEthAddress,
  name: z.string(),
  createdAt: z.number(),
  derivationKey: z.string().length(64), // derived key for deterministic sub-key generation (64-char hex)
  // App-facing public key (compressed secp256k1). Surfaced to dApps as the
  // identity public key in ConnectionInfo. Was previously on the identity.
  publicKey: CompressedPublicKeySchema.optional(),
  defaultPostageStampBatchID: StoredBatchId.optional(),
  devices: z.array(DeviceSchemaV1).default([]),
  // Account-owned nested collections (replace the old flat identities/apps/
  // stamps stores joined by accountId/identityId pointers).
  connectedApps: z.array(ConnectedAppSchemaV1).default([]),
  postageStamps: z.array(PostageStampSchemaV1).default([]),
  // Per-account settings (was identity.settings).
  settings: z
    .object({
      appSessionDuration: z.number().optional(),
    })
    .optional(),
  // Last-writer-wins clock for cross-device metadata merge (set on any change).
  lastModified: z.number().optional(),
  /**
   * Number of partitions the postage-batch slot space is divided into.
   * Optional on the local account record (omitted → `1` = single-device
   * legacy behaviour). New accounts set this to `PARTITION_COUNT` at
   * creation time.
   */
  partitionCount: z.number().int().min(1).optional(),
})

/**
 * Passkey Account Schema V1
 */
export const PasskeyAccountSchemaV1 = CommonAccountSchemaV1.extend({
  type: z.literal("passkey"),
  credentialId: z.string(),
})

/**
 * Ethereum Account Schema V1
 */
export const EthereumAccountSchemaV1 = CommonAccountSchemaV1.extend({
  type: z.literal("ethereum"),
  ethereumAddress: StoredEthAddress,
  encryptedMasterKey: StoredBytes,
  encryptionSalt: StoredBytes,
  encryptedSecretSeed: StoredBytes,
})

/**
 * Agent Account Schema V1
 * For automated testing and programmatic use with BIP39 seed phrases
 * Seed phrase is NOT stored - must be re-entered on each authentication (like passkey)
 */
export const AgentAccountSchemaV1 = CommonAccountSchemaV1.extend({
  type: z.literal("agent"),
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
// Sync State Snapshot Schemas
// ============================================================================

/**
 * Account Metadata Schema V1
 */
export const AccountMetadataSchemaV1 = z.object({
  accountName: z.string(),
  defaultPostageStampBatchID: z.string().length(64).optional(), // BatchId hex string
  // App-facing public key (compressed secp256k1 hex). Mirrors account.publicKey.
  publicKey: CompressedPublicKeySchema.optional(),
  // Per-account settings (was identity.settings).
  settings: z
    .object({
      appSessionDuration: z.number().optional(),
    })
    .optional(),
  createdAt: z.number(),
  lastModified: z.number(),
  devices: z.array(DeviceSchemaV1).default([]),
  /**
   * Number of partitions the postage-batch slot space is divided into.
   * `1` means "no partitioning, single-device behaviour" — this is the
   * default for snapshots from before the partition-lease shipped. New
   * accounts write the current `PARTITION_COUNT` (2) here.
   */
  partitionCount: z.number().int().min(1).default(1),
})

const ACCOUNT_STATE_SNAPSHOT_VERSION = 1

/**
 * Unified account state snapshot schema used by both file export and Swarm sync.
 *
 * Wire/export projection of the nested account: metadata (non-secret account
 * fields) plus the account-owned `connectedApps` and `postageStamps`. Account
 * secrets (`derivationKey`, `credentialId`, ethereum encrypted fields) are
 * deliberately excluded — only `metadata` + the nested collections travel.
 */
export const AccountStateSnapshotSchemaV1 = z.object({
  version: z.literal(ACCOUNT_STATE_SNAPSHOT_VERSION),
  timestamp: z.number(),
  accountId: z.string().length(40),
  metadata: AccountMetadataSchemaV1,
  connectedApps: z.array(ConnectedAppSchemaV1),
  postageStamps: z.array(PostageStampSchemaV1),
})

// ============================================================================
// Derived Types (guaranteed to match current schema version)
// ============================================================================

export type Device = z.infer<typeof DeviceSchemaV1>
export type PasskeyAccount = z.infer<typeof PasskeyAccountSchemaV1>
export type EthereumAccount = z.infer<typeof EthereumAccountSchemaV1>
export type AgentAccount = z.infer<typeof AgentAccountSchemaV1>
export type Account = z.infer<typeof AccountSchemaV1>
export type ConnectedApp = z.infer<typeof ConnectedAppSchemaV1>
export type PostageStamp = z.infer<typeof PostageStampSchemaV1>
export type AccountMetadata = z.infer<typeof AccountMetadataSchemaV1>
export type AccountStateSnapshot = z.infer<typeof AccountStateSnapshotSchemaV1>

// ============================================================================
// Partition-Lease Wire Formats
// ============================================================================

/**
 * Fencing token for the partition lock. Two writers with equal `timestampMs`
 * are ordered by `tiebreaker` (hex of the first 8 bytes of
 * `keccak256(deviceId)`).
 */
export const PartitionLockGenerationSchemaV1 = z.object({
  timestampMs: z.number().int().nonnegative(),
  tiebreaker: z.string().regex(/^[0-9a-f]{16}$/),
})

/**
 * Payload stored (as encrypted JSON) in a partition-lock SOC. The format is
 * versioned by the SOC identifier domain (`swarm-id-partition-lock-v1`), so no
 * in-payload version field is needed. `holderDeviceId` is `""` for the
 * `NO_HOLDER_DEVICE_ID` sentinel (e.g. after an explicit release).
 */
export const PartitionLockPayloadSchemaV1 = z.object({
  holderDeviceId: z.string(),
  generation: PartitionLockGenerationSchemaV1,
  acquiredAt: z.number().int().nonnegative(),
  leasedUntil: z.number().int().nonnegative(),
})

export type PartitionLockGeneration = z.infer<
  typeof PartitionLockGenerationSchemaV1
>
export type PartitionLockPayload = z.infer<typeof PartitionLockPayloadSchemaV1>

/**
 * Payload stored (as encrypted JSON) in a per-device partition-INTENT SOC,
 * which doubles as a holder PRESENCE BEACON. Written before a fresh claim so
 * rival contenders agree on a single winner by `generation`, AND re-published
 * by the holder on every refresh tick so a later joiner can detect the live
 * holder — both via a fresh per-epoch address that forces a network retrieval
 * (bypassing the gateway's frozen lock-SOC cache). `deviceId` is carried for
 * diagnostics (the address already encodes it). `leasedUntil` is present on a
 * heartbeat so a reader can apply the same `leasedUntil > now` liveness test
 * the lock SOC uses; it is omitted on a legacy pre-claim intent (then the
 * reader falls back to epoch-bucket freshness).
 */
export const PartitionIntentPayloadSchemaV1 = z.object({
  deviceId: z.string(),
  generation: PartitionLockGenerationSchemaV1,
  leasedUntil: z.number().int().nonnegative().optional(),
})

export type PartitionIntentPayload = z.infer<
  typeof PartitionIntentPayloadSchemaV1
>

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

// ============================================================================
// BroadcastChannel Message Schemas
// ============================================================================

/**
 * Bucket update entry for cross-tab synchronization
 */
export const BucketUpdateSchema = z.object({
  index: z.number().int().min(0).max(65535),
  value: z.number().int().min(0),
})

/**
 * Utilization update message sent via BroadcastChannel
 */
export const UtilizationUpdateMessageSchema = z.object({
  type: z.literal("utilization-updated"),
  batchId: z.string().length(64),
  buckets: z.array(BucketUpdateSchema),
})

export type BucketUpdate = z.infer<typeof BucketUpdateSchema>
export type UtilizationUpdateMessage = z.infer<
  typeof UtilizationUpdateMessageSchema
>
