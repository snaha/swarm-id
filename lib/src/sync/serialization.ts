import {
  serializeIdentity,
  serializeConnectedApp,
  serializePostageStamp,
} from "../utils/storage-managers"
import { AccountStateSnapshotSchemaV1 } from "../schemas"
import type { AccountStateSnapshot } from "./types"

/**
 * Serialize account state snapshot to JSON bytes
 *
 * @param state - Account state snapshot to serialize
 * @returns JSON encoded as Uint8Array
 */
export function serializeAccountState(state: AccountStateSnapshot): Uint8Array {
  const json = JSON.stringify({
    version: state.version,
    timestamp: state.timestamp,
    accountId: state.accountId,
    metadata: {
      defaultPostageStampBatchID: state.metadata.defaultPostageStampBatchID,
      createdAt: state.metadata.createdAt,
      lastModified: state.metadata.lastModified,
    },
    identities: state.identities.map(serializeIdentity),
    connectedApps: state.connectedApps.map(serializeConnectedApp),
    postageStamps: state.postageStamps.map(serializePostageStamp),
  })

  return new TextEncoder().encode(json)
}

/**
 * Deserialize JSON bytes to account state snapshot
 *
 * @param data - JSON bytes to deserialize
 * @returns Account state snapshot
 */
export function deserializeAccountState(
  data: Uint8Array,
): AccountStateSnapshot {
  const json = new TextDecoder().decode(data)
  const parsed = JSON.parse(json)
  return AccountStateSnapshotSchemaV1.parse(parsed)
}
