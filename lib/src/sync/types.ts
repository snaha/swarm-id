import type { Bee, PrivateKey } from "@ethersphere/bee-js"
import type {
  StorageIdentity,
  StorageConnectedApp,
  StoragePostageStamp,
} from "../types"

/**
 * State snapshot for a single identity
 */
export interface IdentityStateSnapshot {
  version: 1
  timestamp: number // milliseconds
  identity: StorageIdentity
  connectedApps: StorageConnectedApp[]
  postageStamps: StoragePostageStamp[]
}

/**
 * Options for StateSyncManager
 */
export interface StateSyncOptions {
  bee: Bee
  getIdentityKey: (identityId: string) => Promise<PrivateKey>
}

/**
 * Result of a sync operation
 */
export type SyncResult =
  | { status: "success"; reference: string; timestamp: bigint }
  | { status: "error"; error: string }
