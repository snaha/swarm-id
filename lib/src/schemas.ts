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
  PrivateKey as BeePrivateKey,
} from "@ethersphere/bee-js"
import { isHttpUrl } from "./utils/url"

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

// ============================================================================
// Device Schema
// ============================================================================

/**
 * Device Schema V1
 * Tracks devices that have accessed an account for multi-device support.
 */
// Adding a field here? `DEVICE_COMPARED_FIELDS` (`utils/device-id.ts`) is typed
// over `keyof Device` and will refuse to compile until the new field is
// classified as one the registry-persist guard compares.
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
  // User-given label shown in the UI (a "drive"). Optional: stamps created before
  // naming existed — and those bought outside the app — have none, and callers
  // fall back to a batch-ID-derived label.
  name: z.string().optional(),
  // Rename clock. The name merges on its own last-writer-wins clock, separate
  // from the node-state clock below: a rename made over a stale copy must not
  // carry old batch fields past a concurrent dilute/top-up, nor resurrect a
  // tombstone. Optional: unnamed/never-renamed stamps have none.
  nameUpdatedAt: z.number().optional(),
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
  // Node-state edit clock (dilute / top-up: depth, amount, batchTTL). Doubles
  // as the instant `batchTTL` was measured, so the UI can age the countdown.
  // Optional: stamps written before the field existed have none and fall back
  // to `createdAt` in the merge. Without it, an edited copy would tie with a
  // stale remote copy and the edit would never propagate across devices.
  updatedAt: z.number().optional(),
  // Tombstone marker. A deleted stamp is kept in the snapshot (so the removal
  // propagates to other devices) but hidden from the UI and unusable for
  // uploads. `deletedAt`/`updatedAt`/`createdAt` compete as one last-writer-wins
  // clock in the merge, so the newest NODE action on the batch wins (renames
  // ride `nameUpdatedAt` instead).
  deletedAt: z.number().optional(),
})

// ============================================================================
// Account Schemas
// ============================================================================

/**
 * Access Method Schema V1
 *
 * Every account is a BIP-39 seed account; the access method is simply HOW that
 * seed is protected/encrypted at rest on this device (and thus how it is
 * unlocked). Fields are device-local crypto material (plain hex / numbers) —
 * never bee-js byte classes — so they round-trip as-is. Paired with
 * `encryptedSeed` on the account.
 *
 * The eth-wallet method stores only the encryption salt — NOT the wallet
 * address: a wrong wallet simply fails to decrypt the seed, and the account's
 * own `id` is already the address of its (BIP-39) key, so a separate wallet
 * address would be redundant.
 */
export const AccessMethodSchemaV1 = z.discriminatedUnion("type", [
  z.object({ type: z.literal("passkey"), credentialId: z.string() }),
  z.object({
    type: z.literal("eth-wallet"),
    encryptionSalt: z.string(),
  }),
  z.object({
    type: z.literal("password"),
    kdfSalt: z.string(),
    kdfIterations: z.number(),
  }),
])

/**
 * Local Vault Schema V1
 *
 * The device-local seed vault. Every account is a BIP-39 seed account: `access`
 * records how the seed is protected/unlocked on THIS device (passkey /
 * eth-wallet / password) and `encryptedSeed` is that seed encrypted at rest
 * under the key the access method derives (hex: IV || ciphertext — width varies
 * with the seed size: 12-word seed → 88 chars, 24-word → 120, so no fixed
 * length). The vault never leaves the device: `SyncedAccountSchemaV1` has no
 * vault fields. A sign-out RETAINS the vault (it is encrypted at rest) while
 * stripping the synced data, so signing back in only takes the access method.
 */
export const LocalVaultSchemaV1 = z.object({
  access: AccessMethodSchemaV1,
  encryptedSeed: z.string().regex(/^([0-9a-f]{2})+$/),
})

/**
 * Synced Account Schema V1
 *
 * The single, unified account model. There is exactly one kind of account: a
 * BIP-39 seed account. What used to be distinct `type`s (passkey / ethereum /
 * agent) were really just different ways of protecting the seed — now expressed
 * uniformly by the device-local vault (`LocalVaultSchemaV1`). No `type`
 * discriminant remains.
 *
 * This is the portable projection of the account — every field that may travel
 * off the device, and nothing device-local. Backup files serialize/parse it
 * directly and the sync feed carries the same shape (serialize with
 * `serializeSyncedAccount`, which additionally strips the live per-app session
 * material). What localStorage holds is `LocalAccountSchemaV1` = this plus the
 * device-local tail.
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
export const SyncedAccountSchemaV1 = z.object({
  id: StoredEthAddress,
  name: z.string(),
  createdAt: z.number(),
  derivationKey: z.string().length(64), // derived key for deterministic sub-key generation (64-char hex)
  // App-facing public key (compressed secp256k1). Surfaced to dApps as the
  // identity public key in ConnectionInfo. Was previously on the identity.
  publicKey: CompressedPublicKeySchema,
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
  // Per-field LWW clocks for the scalar account fields, so a concurrent change to
  // a *different* scalar on another device is not dropped wholesale, and a peer's
  // change propagates on refresh. Absent → fall back to `lastModified`/`createdAt`.
  accountNameAt: z.number().optional(),
  defaultStampAt: z.number().optional(),
  settingsAt: z.number().optional(),
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
 * Signed-in variant: the synced data plus the device vault. `signedOutAt` is
 * declared undefined-only (not merely omitted) so a record carrying BOTH a
 * vault and a sign-out marker fails this variant — and the signed-out one —
 * and is quarantined at load, instead of silently parsing as signed-in and
 * dropping the marker.
 */
const SignedInAccountSchemaV1 = SyncedAccountSchemaV1.extend({
  ...LocalVaultSchemaV1.shape,
  signedOutAt: z.undefined().optional(),
})

/**
 * Signed-out variant: the minimal remnant of a sign-out. The vault SURVIVES
 * (it is encrypted at rest, so retaining it matches the sign-out security
 * posture) and lets the user sign back in with the existing access method —
 * no recovery phrase. The synced state (collections, settings, clocks, and
 * the secret `derivationKey`) is stripped from disk as PLAINTEXT but kept as
 * `encryptedState`: an AES-GCM snapshot keyed off the derivation-key chain,
 * decrypted and restored on sign-back-in so a sign-out can never lose data —
 * even offline or when the Swarm copy is gone. Required: a signed-out record
 * without the snapshot is malformed and quarantined at load. The display
 * fields (`name`, `createdAt`) stay so the account chooser can list the row.
 * Being a plain object (not a `SyncedAccountSchemaV1` extension), parsing a
 * pre-shrink record under this arm strips its plaintext synced fields.
 */
const SignedOutAccountSchemaV1 = z.object({
  id: StoredEthAddress,
  name: z.string(),
  createdAt: z.number(),
  ...LocalVaultSchemaV1.shape,
  encryptedState: z.string(),
  // Storage-warning remnant, captured at sign-out (the stamps themselves are
  // only in the encrypted snapshot): whether any drive already needed
  // attention, and the soonest estimated drive expiry (epoch ms) so the
  // "expires soon" warning can keep developing while signed out.
  storageWarning: z.boolean().optional(),
  soonestDriveExpiry: z.number().optional(),
  signedOutAt: z.number(),
})

/**
 * Local Account Schema V1 — parse entrypoint for stored account records (what
 * localStorage holds), modeled as a union so the signed-in/signed-out states
 * are encoded in the data itself: a signed-in account is the synced projection
 * plus the vault and no `signedOutAt`; a signed-out one is the minimal remnant
 * (display fields + vault) with `signedOutAt` set. Both carry the vault —
 * `signedOutAt` presence alone discriminates; vault-less records (the
 * pre-retention sign-out shape) fail both arms and are quarantined.
 *
 * This only validates at parse (load) time — the accounts loader SKIPS a
 * violating record rather than failing the document — but unlike a refinement
 * the union also carries into the TYPE system: `Account` is a discriminated
 * union (discriminate on `signedOutAt` presence, or narrow with
 * `isSignedOutAccount`), so writers can't produce a half-signed-out record
 * without a type error.
 */
export const LocalAccountSchemaV1 = z.union([
  SignedInAccountSchemaV1,
  SignedOutAccountSchemaV1,
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
  publicKey: CompressedPublicKeySchema,
  // Per-account settings (was identity.settings).
  settings: z
    .object({
      appSessionDuration: z.number().optional(),
    })
    .optional(),
  // Per-field LWW clocks for the scalar fields (see `SyncedAccountSchemaV1`).
  accountNameAt: z.number().optional(),
  defaultStampAt: z.number().optional(),
  settingsAt: z.number().optional(),
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
export type AccessMethod = z.infer<typeof AccessMethodSchemaV1>
export type LocalVault = z.infer<typeof LocalVaultSchemaV1>
export type SyncedAccount = z.infer<typeof SyncedAccountSchemaV1>
export type SignedInAccount = z.infer<typeof SignedInAccountSchemaV1>
export type SignedOutAccount = z.infer<typeof SignedOutAccountSchemaV1>
/** The local (on-device) account record: `SignedInAccount | SignedOutAccount`. */
export type Account = z.infer<typeof LocalAccountSchemaV1>
export type ConnectedApp = z.infer<typeof ConnectedAppSchemaV1>
export type PostageStamp = z.infer<typeof PostageStampSchemaV1>
export type AccountMetadata = z.infer<typeof AccountMetadataSchemaV1>
export type AccountStateSnapshot = z.infer<typeof AccountStateSnapshotSchemaV1>

// ============================================================================
// Account Predicates
// ============================================================================

/**
 * An account is "local" when its default drive (`defaultPostageStampBatchID`) is
 * not a usable postage batch — it cannot pay for uploads, so it is effectively
 * view-only and has nothing to sync. "Local" is purely this runtime predicate;
 * it is NOT a stored field or account `type`.
 *
 * The default batch counts as a valid drive when it is set, `exists` on-chain,
 * is `usable` (synced enough to upload against), and is not tombstoned. An
 * account with no default, or whose default is freshly-purchased-but-not-yet-
 * usable, therefore reads as local.
 */
export function isLocalAccount(account: SignedInAccount): boolean {
  const batchID = account.defaultPostageStampBatchID
  if (batchID === undefined) return true
  const stamp = account.postageStamps.find((s) => s.batchID.equals(batchID))
  return !(
    stamp !== undefined &&
    stamp.exists &&
    stamp.usable &&
    stamp.deletedAt === undefined
  )
}

/**
 * An account is "signed out" on this device when `signedOutAt` is set: the
 * synced data was stripped from disk, but the encrypted vault survives, so the
 * user signs back in with the existing access method (which re-derives and
 * re-folds the rest). Narrows: the true branch exposes `signedOutAt` as a
 * number; the vault fields are non-optional on BOTH branches.
 */
export function isSignedOutAccount(
  account: Account,
): account is SignedOutAccount {
  return account.signedOutAt !== undefined
}

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
  // `.refine(isHttpUrl)` (not `.url()`) so a scheme-less paste like `localhost:1633`
  // — which `new URL`/zod `.url()` accept as protocol `localhost:` — can't persist
  // as a broken endpoint. Same validator the settings dialog uses.
  beeNodeUrl: z.string().refine(isHttpUrl, "Must be an http(s) URL"),
  gnosisRpcUrl: z.string().refine(isHttpUrl, "Must be an http(s) URL"),
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
 * Utilization update broadcast on the account bus after a write.
 *
 * `buckets` carry the writer's PER-PARTITION counter `j`, not an absolute slot
 * — the physical slot is `partitionCount + partition + partitionCount·j`
 * (`dataSlot`, `utils/batch-utilization.ts`). So a delta is only foldable by a
 * context bound to the SAME lane, and the lane travels with the message: the
 * bus reaches other devices, which hold other partitions of the same batch, and
 * folding their `j` in would skip the receiver past its own unused slots.
 * Legacy single-partition writers publish `partition: 0, partitionCount: 1`.
 */
export const UtilizationUpdateMessageSchema = z.object({
  type: z.literal("utilization-updated"),
  batchId: z.string().length(64),
  partition: z.number().int().min(0),
  partitionCount: z.number().int().min(1),
  buckets: z.array(BucketUpdateSchema),
})

export type BucketUpdate = z.infer<typeof BucketUpdateSchema>
export type UtilizationUpdateMessage = z.infer<
  typeof UtilizationUpdateMessageSchema
>
