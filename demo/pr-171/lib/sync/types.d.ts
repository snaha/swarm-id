import type { AccountStateSnapshot, AccountMetadata } from '../schemas';
export type { AccountStateSnapshot, AccountMetadata };
/**
 * Result of a sync operation
 */
export type SyncResult = {
    status: 'success';
    reference: string;
    timestamp: bigint;
    chunkAddresses: Uint8Array[];
} | {
    status: 'error';
    error: string;
};
//# sourceMappingURL=types.d.ts.map