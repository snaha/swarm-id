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
  | { status: "error"; error: string }
