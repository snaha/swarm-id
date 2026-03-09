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
  Identity,
  ConnectedApp,
  PostageStamp,
  AccountMetadata,
  AccountStateSnapshot,
} from "../schemas"
import {
  serializeIdentity,
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
 * Serialize account data into a plain object suitable for JSON encoding.
 */
export function serializeAccountStateSnapshot(input: {
  accountId: string
  metadata: AccountMetadata
  identities: Identity[]
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
      createdAt: input.metadata.createdAt,
      lastModified: input.metadata.lastModified,
    },
    identities: input.identities.map(serializeIdentity),
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
