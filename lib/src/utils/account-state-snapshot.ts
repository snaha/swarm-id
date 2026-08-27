// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Account State Snapshot Module
 *
 * Shared serialization for account state snapshots used by both
 * file export (.swarmid) and Swarm sync flows.
 *
 * appSecret is included in snapshots so that backups preserve app connections.
 * Since the backup is encrypted with the master key (and appSecret is
 * deterministically derivable from it), this doesn't change the threat model.
 */

import type { z } from "zod"
import { AccountStateSnapshotSchemaV1 } from "../schemas"
import type {
  ConnectedApp,
  PostageStamp,
  AccountMetadata,
  AccountStateSnapshot,
  SyncedAccount,
} from "../schemas"
import {
  serializeConnectedApp,
  serializePostageStamp,
} from "./storage-managers"

// Re-export schema and types for consumers
export { AccountStateSnapshotSchemaV1 } from "../schemas"
export type { AccountStateSnapshot } from "../schemas"

// ============================================================================
// Constants
// ============================================================================

const ACCOUNT_STATE_SNAPSHOT_VERSION = 1

// ============================================================================
// Types
// ============================================================================

export type AccountStateSnapshotResult =
  | { success: true; data: AccountStateSnapshot }
  | { success: false; error: z.ZodError }

// ============================================================================
// Serialize
// ============================================================================

/**
 * Read an account record into the snapshot every channel publishes: the Swarm
 * device-state feed, and the account bus.
 *
 * One copy, because the per-field clocks below are easy to get subtly wrong and
 * impossible to notice: an UNEDITED scalar must keep its stable `*At`, never a
 * fresh `lastModified`, or a device editing a different field restamps it and
 * clobbers a peer's genuine concurrent edit under per-field LWW
 * (Account-State.md §9.3). A second copy that forgets that is a data-loss bug
 * with no symptom on the device that causes it.
 *
 * `undefined` when the account has no default drive — there is nothing to
 * publish for an account that cannot pay for a write.
 */
export function accountStateSnapshot(
  account: SyncedAccount,
): AccountStateSnapshot | undefined {
  const defaultStampBatchID = account.defaultPostageStampBatchID
  if (!defaultStampBatchID) return undefined

  return {
    version: 1,
    timestamp: Date.now(),
    accountId: account.id.toHex(),
    metadata: {
      accountName: account.name,
      defaultPostageStampBatchID: defaultStampBatchID.toHex(),
      publicKey: account.publicKey,
      settings: account.settings,
      accountNameAt: account.accountNameAt ?? account.createdAt,
      defaultStampAt: account.defaultStampAt ?? account.createdAt,
      settingsAt: account.settingsAt ?? account.createdAt,
      createdAt: account.createdAt,
      lastModified: Date.now(),
      devices: account.devices,
      partitionCount: account.partitionCount ?? 1,
    },
    connectedApps: account.connectedApps,
    postageStamps: account.postageStamps,
  }
}

/**
 * Serialize account data into a plain object suitable for JSON encoding.
 */
export function serializeAccountStateSnapshot(input: {
  accountId: string
  metadata: AccountMetadata
  connectedApps: ConnectedApp[]
  postageStamps: PostageStamp[]
  timestamp: number
}): Record<string, unknown> {
  return {
    version: ACCOUNT_STATE_SNAPSHOT_VERSION,
    timestamp: input.timestamp,
    accountId: input.accountId,
    metadata: {
      accountName: input.metadata.accountName,
      defaultPostageStampBatchID: input.metadata.defaultPostageStampBatchID,
      publicKey: input.metadata.publicKey,
      settings: input.metadata.settings,
      accountNameAt: input.metadata.accountNameAt,
      defaultStampAt: input.metadata.defaultStampAt,
      settingsAt: input.metadata.settingsAt,
      createdAt: input.metadata.createdAt,
      lastModified: input.metadata.lastModified,
      devices: input.metadata.devices,
      partitionCount: input.metadata.partitionCount,
    },
    connectedApps: input.connectedApps.map(serializeConnectedApp),
    postageStamps: input.postageStamps.map(serializePostageStamp),
  }
}

// ============================================================================
// Deserialize
// ============================================================================

/**
 * Deserialize and validate an account state snapshot.
 * Returns a discriminated union: success with parsed data, or failure with Zod error.
 */
export function deserializeAccountStateSnapshot(
  data: unknown,
): AccountStateSnapshotResult {
  const result = AccountStateSnapshotSchemaV1.safeParse(data)

  if (!result.success) {
    return { success: false, error: result.error }
  }

  return { success: true, data: result.data }
}
