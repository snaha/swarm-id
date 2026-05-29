// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
  | {
      // Sync upload + feed update completed, but a post-upload read-back of
      // the root chunk failed. The reference was written, but the chunks may
      // not be retrievable from this Bee node — likely a storage issue.
      status: "success-unverified"
      reference: string
      timestamp: bigint
      chunkAddresses: Uint8Array[]
      warning: string
    }
  | { status: "error"; error: string }
