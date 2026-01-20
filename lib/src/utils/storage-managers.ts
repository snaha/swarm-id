/**
 * Pre-configured Storage Managers for Entity Types
 *
 * Provides ready-to-use storage managers for accounts, identities,
 * connected apps, and postage stamps with versioning support.
 */

import { z } from "zod"
import {
  VersionedStorageManager,
  createLocalStorageManager,
  type VersionParser,
} from "./versioned-storage"
import type { Account, Identity, ConnectedApp, PostageStamp } from "../types"
import {
  AccountSchemaV1,
  IdentitySchemaV1,
  ConnectedAppSchemaV1,
  PostageStampSchemaV1,
  NetworkSettingsSchemaV1,
  type NetworkSettings,
} from "../schemas"

// ============================================================================
// Parsers (Zod transforms handle primitive → bee-js conversion)
// ============================================================================

/**
 * Parse accounts - Zod transforms handle type conversion
 */
const parseAccountsV1: VersionParser<Account> = (data: unknown) => {
  const result = z.array(AccountSchemaV1).safeParse(data)

  if (!result.success) {
    console.error("Parse failed:", result.error.format())
    return []
  }

  return result.data
}

/**
 * Parse identities - Zod transforms handle type conversion
 */
const parseIdentitiesV1: VersionParser<Identity> = (data: unknown) => {
  const result = z.array(IdentitySchemaV1).safeParse(data)

  if (!result.success) {
    console.error("Parse failed:", result.error.format())
    return []
  }

  return result.data
}

/**
 * Parse connected apps
 */
const parseConnectedAppsV1: VersionParser<ConnectedApp> = (data: unknown) => {
  const result = z.array(ConnectedAppSchemaV1).safeParse(data)

  if (!result.success) {
    console.error("Parse failed:", result.error.format())
    return []
  }

  return result.data
}

/**
 * Parse postage stamps - Zod transforms handle type conversion
 */
const parsePostageStampsV1: VersionParser<PostageStamp> = (data: unknown) => {
  const result = z.array(PostageStampSchemaV1).safeParse(data)

  if (!result.success) {
    console.error("Parse failed:", result.error.format())
    return []
  }

  return result.data
}

// ============================================================================
// Serializers
// ============================================================================

/**
 * Serialize Account for storage
 */
export function serializeAccount(account: Account): Record<string, unknown> {
  if (account.type === "passkey") {
    return {
      id: account.id.toString(),
      name: account.name,
      createdAt: account.createdAt,
      type: account.type,
      credentialId: account.credentialId,
      swarmEncryptionKey: account.swarmEncryptionKey,
      defaultPostageStampBatchID:
        account.defaultPostageStampBatchID?.toString(),
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
      encryptedSecretSeed: Array.from(
        account.encryptedSecretSeed.toUint8Array(),
      ),
      swarmEncryptionKey: account.swarmEncryptionKey,
      defaultPostageStampBatchID:
        account.defaultPostageStampBatchID?.toString(),
    }
  }
}

/**
 * Serialize Identity for storage
 */
export function serializeIdentity(identity: Identity): Record<string, unknown> {
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
  app: ConnectedApp,
): Record<string, unknown> {
  return {
    appUrl: app.appUrl,
    appName: app.appName,
    lastConnectedAt: app.lastConnectedAt,
    identityId: app.identityId,
    appIcon: app.appIcon,
    appDescription: app.appDescription,
    connectedUntil: app.connectedUntil,
    appSecret: app.appSecret,
  }
}

/**
 * Serialize PostageStamp for storage
 */
export function serializePostageStamp(
  stamp: PostageStamp,
): Record<string, unknown> {
  return {
    accountId: stamp.accountId,
    batchID: stamp.batchID.toString(),
    signerKey: stamp.signerKey.toString(),
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
export function createAccountsStorageManager(): VersionedStorageManager<Account> {
  return createLocalStorageManager<Account>({
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
export function createIdentitiesStorageManager(): VersionedStorageManager<Identity> {
  return createLocalStorageManager<Identity>({
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
export function createConnectedAppsStorageManager(): VersionedStorageManager<ConnectedApp> {
  return createLocalStorageManager<ConnectedApp>({
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
export function createPostageStampsStorageManager(): VersionedStorageManager<PostageStamp> {
  return createLocalStorageManager<PostageStamp>({
    key: "swarm-id-postage-stamps",
    currentVersion: 1,
    parsers: {
      1: parsePostageStampsV1,
    },
    serializer: serializePostageStamp,
    loggerName: "PostageStampsStorage",
  })
}

// ============================================================================
// Network Settings Storage (Singleton)
// ============================================================================

const NETWORK_SETTINGS_STORAGE_KEY = "swarm-id-network-settings"

/**
 * Parse network settings - Zod validates URL format
 */
function parseNetworkSettingsV1(data: unknown): NetworkSettings | undefined {
  const result = NetworkSettingsSchemaV1.safeParse(data)

  if (!result.success) {
    console.error(
      "[NetworkSettingsStorage] Parse failed:",
      result.error.format(),
    )
    return undefined
  }

  return result.data
}

/**
 * Serialize NetworkSettings for storage
 */
export function serializeNetworkSettings(
  settings: NetworkSettings,
): Record<string, unknown> {
  return {
    beeNodeUrl: settings.beeNodeUrl,
    gnosisRpcUrl: settings.gnosisRpcUrl,
  }
}

/**
 * Singleton storage manager interface for network settings
 */
export interface NetworkSettingsStorageManager {
  load(): NetworkSettings | undefined
  save(settings: NetworkSettings): void
  clear(): void
}

/**
 * Create storage manager for network settings (singleton)
 * Unlike other storage managers, this stores a single object, not an array
 */
export function createNetworkSettingsStorageManager(): NetworkSettingsStorageManager {
  return {
    load(): NetworkSettings | undefined {
      if (typeof localStorage === "undefined") {
        return undefined
      }

      const raw = localStorage.getItem(NETWORK_SETTINGS_STORAGE_KEY)
      if (!raw) {
        return undefined
      }

      try {
        const parsed = JSON.parse(raw)
        return parseNetworkSettingsV1(parsed)
      } catch (e) {
        console.error(
          "[NetworkSettingsStorage] Failed to parse stored data:",
          e,
        )
        return undefined
      }
    },

    save(settings: NetworkSettings): void {
      if (typeof localStorage === "undefined") {
        console.warn("[NetworkSettingsStorage] localStorage not available")
        return
      }

      const serialized = serializeNetworkSettings(settings)
      localStorage.setItem(
        NETWORK_SETTINGS_STORAGE_KEY,
        JSON.stringify(serialized),
      )
    },

    clear(): void {
      if (typeof localStorage === "undefined") {
        return
      }

      localStorage.removeItem(NETWORK_SETTINGS_STORAGE_KEY)
    },
  }
}
