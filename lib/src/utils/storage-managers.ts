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
import type {
  Account,
  SyncedAccount,
  ConnectedApp,
  PostageStamp,
} from "../types"
import { STORAGE_KEY_ACCOUNTS, STORAGE_KEY_NETWORK_SETTINGS } from "../types"
import {
  LocalAccountSchemaV1,
  NetworkSettingsSchemaV1,
  isSignedOutAccount,
  type NetworkSettings,
} from "../schemas"
import { PARTITION_COUNT } from "./batch-utilization"

// ============================================================================
// Parsers (Zod transforms handle primitive → bee-js conversion)
// ============================================================================

/**
 * Parse accounts - Zod transforms handle type conversion.
 *
 * Records are validated one by one: an invalid record is skipped (logged), not
 * allowed to fail the whole document. Dropping every account for one bad record
 * would present an empty list, and the next save would erase the document for
 * real.
 */
const parseAccountsV1: VersionParser<Account> = (data: unknown) => {
  const records = z.array(z.unknown()).safeParse(data)

  if (!records.success) {
    console.error("Parse failed:", records.error.format())
    return []
  }

  const accounts: Account[] = []
  for (const record of records.data) {
    const result = LocalAccountSchemaV1.safeParse(record)
    if (!result.success) {
      console.error("Skipping invalid account record:", result.error.format())
      continue
    }
    accounts.push(result.data)
  }

  return accounts.map((account) => {
    if (
      !isSignedOutAccount(account) &&
      account.partitionCount === undefined &&
      account.devices.length > 0
    ) {
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
 * Serialize the portable projection of an account (`SyncedAccount`) — what
 * backup files and the sync feed carry off the device. Beyond the schema-level
 * absence of the seed vault, it strips the live per-app session material:
 * `appSecret` (the secret the dApp proxy authenticates from, re-derivable from
 * the master key on the next connect) and `connectedUntil` (meaningless without
 * the secret — keeping it would show a "Connected" app that can no longer
 * authenticate).
 */
export function serializeSyncedAccount(
  data: SyncedAccount,
): Record<string, unknown> {
  return {
    id: data.id.toString(),
    name: data.name,
    createdAt: data.createdAt,
    derivationKey: data.derivationKey,
    publicKey: data.publicKey,
    defaultPostageStampBatchID: data.defaultPostageStampBatchID?.toString(),
    devices: data.devices,
    connectedApps: data.connectedApps.map((app) => {
      const {
        appSecret: _appSecret,
        connectedUntil: _connectedUntil,
        ...portable
      } = serializeConnectedApp(app)
      return portable
    }),
    postageStamps: data.postageStamps.map(serializePostageStamp),
    settings: data.settings,
    accountNameAt: data.accountNameAt,
    defaultStampAt: data.defaultStampAt,
    settingsAt: data.settingsAt,
    lastModified: data.lastModified,
    partitionCount: data.partitionCount,
  }
}

/**
 * Serialize Account for storage (nested: includes its connected apps and
 * postage stamps inline). A signed-out account persists only its minimal
 * remnant — display fields, the encrypted vault, and the encrypted state
 * snapshot — so no synced data (in particular the plaintext `derivationKey`)
 * stays on disk in the clear while signed out.
 */
export function serializeAccount(account: Account): Record<string, unknown> {
  if (isSignedOutAccount(account)) {
    return {
      id: account.id.toString(),
      name: account.name,
      createdAt: account.createdAt,
      access: account.access,
      encryptedSeed: account.encryptedSeed,
      encryptedState: account.encryptedState,
      signedOutAt: account.signedOutAt,
    }
  }
  return {
    ...serializeSyncedAccount(account),
    // Local storage keeps the live per-app session secrets the portable
    // projection strips.
    connectedApps: account.connectedApps.map(serializeConnectedApp),
    // The device-local tail of the record: the seed vault (the account's only
    // secret material — plain JSON, no byte classes). This group stays on the
    // device: the portable copy that backups and the sync feed publish is
    // `SyncedAccount` — the record without it.
    access: account.access,
    encryptedSeed: account.encryptedSeed,
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
    name: stamp.name,
    nameUpdatedAt: stamp.nameUpdatedAt,
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
    updatedAt: stamp.updatedAt,
    deletedAt: stamp.deletedAt,
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
