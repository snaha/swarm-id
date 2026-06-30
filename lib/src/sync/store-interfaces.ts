// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Store Interfaces for Sync Coordinator
 *
 * These interfaces define the minimal contract that stores must implement
 * to be used with the sync coordinator. This allows the coordinator to be
 * used with different store implementations (Svelte stores, plain objects, etc.)
 */

import type { EthAddress, BatchId, Stamper } from "@ethersphere/bee-js"
import type { Account, PostageStamp } from "../schemas"

/**
 * Options for creating a stamper with utilization tracking
 */
export interface StamperOptions {
  owner: EthAddress
  encryptionKey: Uint8Array
}

/**
 * Extended stamper interface with optional flush capability
 *
 * Some stampers (like UtilizationAwareStamper) support flushing
 * dirty bucket state to cache and binding to a multi-device partition.
 */
export interface FlushableStamper extends Stamper {
  flush?(): Promise<void>
  bindPartition?(opts: {
    partition: number
    partitionCount: number
    localCounter: Uint32Array
  }): void
  buildLeaseLocalCounter?(): Uint32Array
}

/**
 * Interface for accessing account data. The account is the aggregate root and
 * owns its connected apps and postage stamps inline.
 */
export interface AccountsStoreInterface {
  get(id: EthAddress): Account | undefined
}

/**
 * Interface for accessing and managing postage stamp data
 */
export interface PostageStampsStoreInterface {
  getStamp(batchID: BatchId): PostageStamp | undefined
  getStamper(
    batchID: BatchId,
    options?: StamperOptions,
  ): Promise<FlushableStamper | undefined>
  updateStampUtilization(batchID: BatchId, utilization: number): void
}
