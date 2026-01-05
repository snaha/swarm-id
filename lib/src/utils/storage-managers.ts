/**
 * Pre-configured Storage Managers for Entity Types
 *
 * Provides ready-to-use storage managers for accounts, identities,
 * connected apps, and postage stamps with versioning support.
 */

import { z } from "zod"
import { EthAddress, BatchId, Bytes } from "@ethersphere/bee-js"
import {
  VersionedStorageManager,
  createLocalStorageManager,
  type VersionParser,
} from "./versioned-storage"
import type {
  StorageAccount,
  StorageIdentity,
  StorageConnectedApp,
  StoragePostageStamp,
} from "../types"

// ============================================================================
// Zod Schemas for Serialized Data (JSON format)
// ============================================================================

/**
 * Passkey Account Schema (serialized)
 */
const PasskeyAccountSchemaV1 = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  type: z.literal("passkey"),
  credentialId: z.string(),
})

/**
 * Ethereum Account Schema (serialized)
 */
const EthereumAccountSchemaV1 = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  type: z.literal("ethereum"),
  ethereumAddress: z.string(),
  encryptedMasterKey: z.array(z.number()),
  encryptionSalt: z.array(z.number()),
})

/**
 * Account Schema (discriminated union, serialized)
 */
const AccountSchemaV1 = z.discriminatedUnion("type", [
  PasskeyAccountSchemaV1,
  EthereumAccountSchemaV1,
])

/**
 * Identity Schema (serialized)
 */
const IdentitySchemaV1 = z.object({
  id: z.string(),
  accountId: z.string(),
  name: z.string(),
  defaultPostageStampBatchID: z.string().optional(),
  createdAt: z.number(),
  settings: z
    .object({
      appSessionDuration: z.number().optional(),
    })
    .optional(),
})

/**
 * Connected App Schema (serialized)
 */
const ConnectedAppSchemaV1 = z.object({
  appUrl: z.string(),
  appName: z.string(),
  lastConnectedAt: z.number(),
  identityId: z.string(),
  appIcon: z.string().optional(),
  appDescription: z.string().optional(),
  connectedUntil: z.number().optional(),
})

/**
 * Postage Stamp Schema (serialized)
 */
const PostageStampSchemaV1 = z.object({
  identityId: z.string(),
  batchID: z.string(),
  utilization: z.number(),
  usable: z.boolean(),
  depth: z.number(),
  amount: z.string(),
  bucketDepth: z.number(),
  blockNumber: z.number(),
  immutableFlag: z.boolean(),
  exists: z.boolean(),
  batchTTL: z.number().optional(),
  createdAt: z.number(),
})

// ============================================================================
// Custom Parsers (convert JSON format to runtime types)
// ============================================================================

/**
 * Parse accounts and convert to runtime types
 */
const parseAccountsV1: VersionParser<StorageAccount> = (data: unknown) => {
  const result = z.array(AccountSchemaV1).safeParse(data)

  if (!result.success) {
    console.error("Parse failed:", result.error.format())
    return []
  }

  return result.data.map((account) => {
    if (account.type === "passkey") {
      return {
        id: new EthAddress(account.id),
        name: account.name,
        createdAt: account.createdAt,
        type: "passkey" as const,
        credentialId: account.credentialId,
      }
    } else {
      return {
        id: new EthAddress(account.id),
        name: account.name,
        createdAt: account.createdAt,
        type: "ethereum" as const,
        ethereumAddress: new EthAddress(account.ethereumAddress),
        encryptedMasterKey: new Bytes(
          new Uint8Array(account.encryptedMasterKey),
        ),
        encryptionSalt: new Bytes(new Uint8Array(account.encryptionSalt)),
      }
    }
  })
}

/**
 * Parse identities and convert to runtime types
 */
const parseIdentitiesV1: VersionParser<StorageIdentity> = (data: unknown) => {
  const result = z.array(IdentitySchemaV1).safeParse(data)

  if (!result.success) {
    console.error("Parse failed:", result.error.format())
    return []
  }

  return result.data.map((identity) => ({
    id: identity.id,
    accountId: new EthAddress(identity.accountId),
    name: identity.name,
    defaultPostageStampBatchID: identity.defaultPostageStampBatchID
      ? new BatchId(identity.defaultPostageStampBatchID)
      : undefined,
    createdAt: identity.createdAt,
    settings: identity.settings,
  }))
}

/**
 * Parse connected apps (no conversion needed)
 */
const parseConnectedAppsV1: VersionParser<StorageConnectedApp> = (
  data: unknown,
) => {
  const result = z.array(ConnectedAppSchemaV1).safeParse(data)

  if (!result.success) {
    console.error("Parse failed:", result.error.format())
    return []
  }

  return result.data
}

/**
 * Parse postage stamps and convert to runtime types
 */
const parsePostageStampsV1: VersionParser<StoragePostageStamp> = (
  data: unknown,
) => {
  const result = z.array(PostageStampSchemaV1).safeParse(data)

  if (!result.success) {
    console.error("Parse failed:", result.error.format())
    return []
  }

  return result.data.map((stamp) => ({
    identityId: stamp.identityId,
    batchID: new BatchId(stamp.batchID),
    utilization: stamp.utilization,
    usable: stamp.usable,
    depth: stamp.depth,
    amount: stamp.amount,
    bucketDepth: stamp.bucketDepth,
    blockNumber: stamp.blockNumber,
    immutableFlag: stamp.immutableFlag,
    exists: stamp.exists,
    batchTTL: stamp.batchTTL,
    createdAt: stamp.createdAt,
  }))
}

// ============================================================================
// Serializers
// ============================================================================

/**
 * Serialize Account for storage
 */
export function serializeAccount(
  account: StorageAccount,
): Record<string, unknown> {
  if (account.type === "passkey") {
    return {
      id: account.id.toString(),
      name: account.name,
      createdAt: account.createdAt,
      type: account.type,
      credentialId: account.credentialId,
    }
  } else {
    return {
      id: account.id.toString(),
      name: account.name,
      createdAt: account.createdAt,
      type: account.type,
      ethereumAddress: account.ethereumAddress.toString(),
      encryptedMasterKey: Array.from(account.encryptedMasterKey.toUint8Array()),
      encryptionSalt: Array.from(account.encryptionSalt.toUint8Array()),
    }
  }
}

/**
 * Serialize Identity for storage
 */
export function serializeIdentity(
  identity: StorageIdentity,
): Record<string, unknown> {
  return {
    id: identity.id,
    accountId: identity.accountId.toString(),
    name: identity.name,
    defaultPostageStampBatchID: identity.defaultPostageStampBatchID?.toString(),
    createdAt: identity.createdAt,
    settings: identity.settings,
  }
}

/**
 * Serialize ConnectedApp for storage
 */
export function serializeConnectedApp(
  app: StorageConnectedApp,
): Record<string, unknown> {
  return {
    appUrl: app.appUrl,
    appName: app.appName,
    lastConnectedAt: app.lastConnectedAt,
    identityId: app.identityId,
    appIcon: app.appIcon,
    appDescription: app.appDescription,
    connectedUntil: app.connectedUntil,
  }
}

/**
 * Serialize PostageStamp for storage
 */
export function serializePostageStamp(
  stamp: StoragePostageStamp,
): Record<string, unknown> {
  return {
    identityId: stamp.identityId,
    batchID: stamp.batchID.toString(),
    utilization: stamp.utilization,
    usable: stamp.usable,
    depth: stamp.depth,
    amount: stamp.amount,
    bucketDepth: stamp.bucketDepth,
    blockNumber: stamp.blockNumber,
    immutableFlag: stamp.immutableFlag,
    exists: stamp.exists,
    batchTTL: stamp.batchTTL,
    createdAt: stamp.createdAt,
  }
}

// ============================================================================
// Storage Manager Factories
// ============================================================================

/**
 * Create storage manager for accounts
 */
export function createAccountsStorageManager(): VersionedStorageManager<StorageAccount> {
  return createLocalStorageManager<StorageAccount>({
    key: "swarm-id-accounts",
    currentVersion: 1,
    parsers: {
      1: parseAccountsV1,
    },
    serializer: serializeAccount,
    loggerName: "AccountsStorage",
  })
}

/**
 * Create storage manager for identities
 */
export function createIdentitiesStorageManager(): VersionedStorageManager<StorageIdentity> {
  return createLocalStorageManager<StorageIdentity>({
    key: "swarm-id-identities",
    currentVersion: 1,
    parsers: {
      1: parseIdentitiesV1,
    },
    serializer: serializeIdentity,
    loggerName: "IdentitiesStorage",
  })
}

/**
 * Create storage manager for connected apps
 */
export function createConnectedAppsStorageManager(): VersionedStorageManager<StorageConnectedApp> {
  return createLocalStorageManager<StorageConnectedApp>({
    key: "swarm-id-connected-apps",
    currentVersion: 1,
    parsers: {
      1: parseConnectedAppsV1,
    },
    serializer: serializeConnectedApp,
    loggerName: "ConnectedAppsStorage",
  })
}

/**
 * Create storage manager for postage stamps
 */
export function createPostageStampsStorageManager(): VersionedStorageManager<StoragePostageStamp> {
  return createLocalStorageManager<StoragePostageStamp>({
    key: "swarm-id-postage-stamps",
    currentVersion: 1,
    parsers: {
      1: parsePostageStampsV1,
    },
    serializer: serializePostageStamp,
    loggerName: "PostageStampsStorage",
  })
}
