// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-configured Storage Managers for Entity Types
 *
 * The account is the single nested document of record: it owns its connected
 * apps and postage stamps inline (no separate per-collection storage keys).
 * Only the accounts document and the network-settings singleton are persisted.
 */

import { z } from "zod"
import {
  VersionedStorageManager,
  createLocalStorageManager,
  type VersionParser,
} from "./versioned-storage"
import type { Account, ConnectedApp, PostageStamp } from "../types"
import { STORAGE_KEY_ACCOUNTS, STORAGE_KEY_NETWORK_SETTINGS } from "../types"
import {
  AccountSchemaV1,
  NetworkSettingsSchemaV1,
  type NetworkSettings,
} from "../schemas"
import { PARTITION_COUNT } from "./batch-utilization"

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

  return result.data.map((account) => {
    if (account.partitionCount === undefined && account.devices.length > 0) {
      return {
        ...account,
        partitionCount: PARTITION_COUNT,
      }
    }
    return account
  })
}

// ============================================================================
// Serializers
// ============================================================================

/**
 * Serialize Account for storage (nested: includes its connected apps and
 * postage stamps inline).
 */
export function serializeAccount(account: Account): Record<string, unknown> {
  const common = {
    id: account.id.toString(),
    name: account.name,
    createdAt: account.createdAt,
    type: account.type,
    derivationKey: account.derivationKey,
    publicKey: account.publicKey,
    defaultPostageStampBatchID: account.defaultPostageStampBatchID?.toString(),
    devices: account.devices,
    connectedApps: account.connectedApps.map(serializeConnectedApp),
    postageStamps: account.postageStamps.map(serializePostageStamp),
    settings: account.settings,
    lastModified: account.lastModified,
    partitionCount: account.partitionCount,
  }

  if (account.type === "passkey") {
    return { ...common, credentialId: account.credentialId }
  } else if (account.type === "ethereum") {
    return {
      ...common,
      ethereumAddress: account.ethereumAddress.toString(),
      encryptedMasterKey: Array.from(account.encryptedMasterKey.toUint8Array()),
      encryptionSalt: Array.from(account.encryptionSalt.toUint8Array()),
      encryptedSecretSeed: Array.from(
        account.encryptedSecretSeed.toUint8Array(),
      ),
    }
  } else if (account.type === "local") {
    // `access` is plain JSON (no byte classes); persist it and the seed as-is.
    return {
      ...common,
      access: account.access,
      encryptedSeed: account.encryptedSeed,
    }
  } else {
    return common
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
    appIcon: app.appIcon,
    appDescription: app.appDescription,
    connectedUntil: app.connectedUntil,
    appSecret: app.appSecret,
    postageStampBatchID: app.postageStampBatchID?.toString(),
    updatedAt: app.updatedAt,
    revokedAt: app.revokedAt,
  }
}

/**
 * Serialize PostageStamp for storage
 */
export function serializePostageStamp(
  stamp: PostageStamp,
): Record<string, unknown> {
  return {
    batchID: stamp.batchID.toString(),
    signerKey: stamp.signerKey.toString(),
    utilization: stamp.utilization,
    usable: stamp.usable,
    depth: stamp.depth,
    amount: stamp.amount.toString(), // Convert bigint to string for JSON
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
    key: STORAGE_KEY_ACCOUNTS,
    currentVersion: 1,
    parsers: {
      1: parseAccountsV1,
    },
    serializer: serializeAccount,
    loggerName: "AccountsStorage",
  })
}

// ============================================================================
// Network Settings Storage (Singleton)
// ============================================================================

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

      const raw = localStorage.getItem(STORAGE_KEY_NETWORK_SETTINGS)
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
        STORAGE_KEY_NETWORK_SETTINGS,
        JSON.stringify(serialized),
      )
    },

    clear(): void {
      if (typeof localStorage === "undefined") {
        return
      }

      localStorage.removeItem(STORAGE_KEY_NETWORK_SETTINGS)
    },
  }
}
