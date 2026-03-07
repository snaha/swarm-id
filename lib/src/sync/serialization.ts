import {
  serializeAccountStateSnapshot,
  deserializeAccountStateSnapshot,
} from "../utils/account-state-snapshot"
import type { AccountStateSnapshot } from "../utils/account-state-snapshot"

/**
 * Serialize account state to JSON bytes
 *
 * @param state - Account payload to serialize
 * @returns JSON encoded as Uint8Array
 */
export function serializeAccountState(state: AccountStateSnapshot): Uint8Array {
  const json = JSON.stringify(serializeAccountStateSnapshot(state))

  return new TextEncoder().encode(json)
}

/**
 * Deserialize JSON bytes to account payload
 *
 * @param data - JSON bytes to deserialize
 * @returns Account payload
 */
export function deserializeAccountState(
  data: Uint8Array,
): AccountStateSnapshot {
  const json = new TextDecoder().decode(data)
  const parsed = JSON.parse(json)
  const result = deserializeAccountStateSnapshot(parsed)

  if (!result.success) {
    throw new Error(
      `Failed to deserialize account state: ${result.error.message}`,
    )
  }

  return result.data
}
