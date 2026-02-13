import type { AccountStateSnapshot } from './types';
/**
 * Serialize account state snapshot to JSON bytes
 *
 * @param state - Account state snapshot to serialize
 * @returns JSON encoded as Uint8Array
 */
export declare function serializeAccountState(state: AccountStateSnapshot): Uint8Array;
/**
 * Deserialize JSON bytes to account state snapshot
 *
 * @param data - JSON bytes to deserialize
 * @returns Account state snapshot
 */
export declare function deserializeAccountState(data: Uint8Array): AccountStateSnapshot;
//# sourceMappingURL=serialization.d.ts.map