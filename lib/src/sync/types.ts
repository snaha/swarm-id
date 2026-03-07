/**
 * Result of a sync operation
 */
export type SyncResult =
  | {
      status: "success"
      reference: string
      timestamp: bigint
      chunkAddresses: Uint8Array[] // All chunks uploaded during sync
    }
  | { status: "error"; error: string }
