import {
  serializeIdentity,
  serializeConnectedApp,
  serializePostageStamp,
} from "../utils/storage-managers"
import type { IdentityStateSnapshot } from "./types"

/**
 * Serialize identity state snapshot to JSON bytes
 *
 * @param state - State snapshot to serialize
 * @returns JSON encoded as Uint8Array
 */
export function serializeIdentityState(
  state: IdentityStateSnapshot,
): Uint8Array {
  const json = JSON.stringify({
    version: state.version,
    timestamp: state.timestamp,
    identity: serializeIdentity(state.identity),
    connectedApps: state.connectedApps.map(serializeConnectedApp),
    postageStamps: state.postageStamps.map(serializePostageStamp),
  })

  return new TextEncoder().encode(json)
}

/**
 * Deserialize JSON bytes to identity state snapshot (for future loading)
 *
 * @param _data - JSON bytes to deserialize
 * @returns Identity state snapshot
 */
export function deserializeIdentityState(
  _data: Uint8Array,
): IdentityStateSnapshot {
  // TODO: Implement deserialization when we add loading from Swarm
  // Will need to:
  // 1. Parse JSON
  // 2. Validate with Zod schemas
  // 3. Convert serialized types back to runtime types
  // 4. Return IdentityStateSnapshot
  throw new Error("Deserialization not yet implemented")
}
