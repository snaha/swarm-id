// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Account State Snapshot Module
 *
 * The in-memory account-state snapshot: what sync captures before building a
 * device view, and what the account bus carries as an `account-delta`.
 * `serializeAccountStateSnapshot` is the delta's wire form; the receiver
 * validates it with `AccountStateSnapshotSchemaV1` (`bus/messages.ts`).
 */

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

export type { AccountStateSnapshot } from "../schemas"

// ============================================================================
// Constants
// ============================================================================

const ACCOUNT_STATE_SNAPSHOT_VERSION = 1

// ============================================================================
// Build
// ============================================================================

/**
 * The account record as an account-state snapshot — the ONE assembly every
 * publisher shares (the sync coordinator's feed write, the proxy's feed write,
 * the proxy's `account-delta`, and the fold that consumes one).
 *
 * `timestamp` is the caller's clock for this snapshot, used for both the
 * envelope and `metadata.lastModified`: a publisher passes `Date.now()`, a
 * caller re-reading a record it did not just change passes that record's own
 * `lastModified` rather than restamping it.
 *
 * Every never-edited scalar clock falls back to the account's STABLE
 * `createdAt`, NEVER a fresh `Date.now()`: re-stamping an unchanged name /
 * default-stamp / settings on every publish would let a device that never
 * touched the field clobber a peer's genuine concurrent edit under per-field
 * LWW (docs/Account-State.md, "Convergence rules"). `createdAt` is identical
 * across devices and predates every edit,
 * so any real change still wins.
 *
 * `defaultPostageStampBatchID` may be absent: an account with no drives is a
 * supported state, and only the feed write (which needs a stamp to pay for
 * itself) may treat that as a reason not to publish.
 */
export function accountToStateSnapshot(
  account: SyncedAccount,
  accountId: string,
  timestamp: number,
): AccountStateSnapshot {
  return {
    version: ACCOUNT_STATE_SNAPSHOT_VERSION,
    timestamp,
    accountId,
    metadata: {
      accountName: account.name,
      defaultPostageStampBatchID: account.defaultPostageStampBatchID?.toHex(),
      publicKey: account.publicKey,
      settings: account.settings,
      accountNameAt: account.accountNameAt ?? account.createdAt,
      defaultStampAt: account.defaultStampAt ?? account.createdAt,
      settingsAt: account.settingsAt ?? account.createdAt,
      createdAt: account.createdAt,
      lastModified: timestamp,
      devices: account.devices,
      partitionCount: account.partitionCount ?? 1,
    },
    connectedApps: account.connectedApps,
    postageStamps: account.postageStamps,
  }
}

// ============================================================================
// Serialize
// ============================================================================

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
