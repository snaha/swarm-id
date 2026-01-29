/**
 * Store Interfaces for Sync Coordinator
 *
 * These interfaces define the minimal contract that stores must implement
 * to be used with the sync coordinator. This allows the coordinator to be
 * used with different store implementations (Svelte stores, plain objects, etc.)
 */

import type { EthAddress, BatchId, Stamper } from "@ethersphere/bee-js"
import type { Account, Identity, ConnectedApp, PostageStamp } from "../schemas"

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
 * dirty bucket state to cache.
 */
export interface FlushableStamper extends Stamper {
  flush?(): Promise<void>
}

/**
 * Interface for accessing account data
 */
export interface AccountsStoreInterface {
  getAccount(id: EthAddress): Account | undefined
}

/**
 * Interface for accessing identity data
 */
export interface IdentitiesStoreInterface {
  getIdentitiesByAccount(accountId: EthAddress): Identity[]
}

/**
 * Interface for accessing connected app data
 */
export interface ConnectedAppsStoreInterface {
  getAppsByIdentityId(identityId: string): ConnectedApp[]
}

/**
 * Interface for accessing and managing postage stamp data
 */
export interface PostageStampsStoreInterface {
  getStamp(batchID: BatchId): PostageStamp | undefined
  getStampsByAccount(accountId: string): PostageStamp[]
  getStamper(
    batchID: BatchId,
    options?: StamperOptions,
  ): Promise<FlushableStamper | undefined>
  updateStampUtilization(batchID: BatchId, utilization: number): void
}
