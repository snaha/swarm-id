// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sync Account
 *
 * Factory function that creates a sync function for syncing account state
 * to Swarm. This integrates store access, key derivation, and utilization
 * tracking.
 */

import {
  Bee,
  PrivateKey,
  BatchId,
  EthAddress,
  type Chunk,
} from "@ethersphere/bee-js"
import {
  deriveSecret,
  deriveSwarmEncryptionKey,
  hexToUint8Array,
} from "../utils/key-derivation"
import {
  updateAfterWrite,
  saveUtilizationState,
  calculateUtilization,
  UtilizationAwareStamper,
} from "../utils/batch-utilization"
import type { UtilizationStoreDB } from "../storage/utilization-store"
import type { DebouncedUtilizationUploader } from "../storage/debounced-uploader"
import type {
  AccountsStoreInterface,
  PostageStampsStoreInterface,
} from "./store-interfaces"
import type { SyncResult } from "./types"
import { accountToStateSnapshot } from "../utils/account-state-snapshot"
import type { AccountStateSnapshot } from "../utils/account-state-snapshot"
import { withTimeout } from "../utils/promise"
import type { PostageStamp } from "../schemas"
import {
  BatchWriteCoordinator,
  PartitionContendedError,
} from "./batch-write-coordinator"
import { accountStateToDeviceView, publishDeviceState } from "./device-state"
import { getOrCreateDeviceId, detectDeviceName } from "../utils/device-id"

// Re-exported from its new home so existing importers of `./sync-account`
// (the legacy shared-feed topic, retained for the cutover invariant test) keep
// working.
export { ACCOUNT_SYNC_TOPIC_PREFIX } from "./publish-account-state"

// Timeout for utilization upload in milliseconds
const UTILIZATION_UPLOAD_TIMEOUT_MS = 30000

// Timeout for the full sync (upload + feed update) in milliseconds.
// Bee client requests use bare fetch with no timeout, so a non-responding
// node would otherwise hang forever.
const SYNC_TIMEOUT_MS = 60000

/**
 * Options for creating a sync account function
 */
export interface SyncAccountOptions {
  /** Bee client for Swarm operations */
  bee: Bee

  /** Store providing account data (the account owns its apps + stamps) */
  accountsStore: AccountsStoreInterface

  /** Store providing postage stamp runtime access (stamper/utilization) */
  postageStampsStore: PostageStampsStoreInterface

  /** Utilization store for browser-based utilization tracking */
  utilizationStore: UtilizationStoreDB

  /** Debounced uploader for batch utilization state */
  utilizationUploader: DebouncedUtilizationUploader
}

/**
 * Sync account function type
 */
export type SyncAccountFunction = (
  accountId: string,
) => Promise<SyncResult | undefined>

/**
 * Convert chunk addresses to Chunk objects for utilization tracking
 *
 * Creates minimal chunk objects with just the address property
 * needed for bucket calculation. We don't need actual chunk data
 * since we're only tracking which buckets/slots were used.
 */
function createChunksFromAddresses(addresses: Uint8Array[]): Chunk[] {
  return addresses.map((address) => {
    return {
      address: {
        toUint8Array: () => address,
        toHex: () =>
          Array.from(address)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(""),
      },
      data: new Uint8Array(0), // Not used for utilization tracking
    } as Chunk
  })
}

/**
 * Create a sync account function with dependency-injected stores
 *
 * @param options - Configuration options including stores and optional utilization tracking
 * @returns Function that syncs an account to Swarm
 */
export function createSyncAccount(
  options: SyncAccountOptions,
): SyncAccountFunction {
  const {
    bee,
    accountsStore,
    postageStampsStore,
    utilizationStore,
    utilizationUploader,
  } = options

  /**
   * Handle utilization tracking after chunk upload
   */
  async function handleUtilizationUpdate(
    accountId: string,
    chunkAddresses: Uint8Array[],
  ): Promise<void> {
    // Get account
    const account = accountsStore.getAccount(new EthAddress(accountId))
    if (!account) {
      console.warn("[SyncCoordinator] Account not found for utilization update")
      return
    }

    // Resolve default stamp
    const defaultStamp = account.defaultPostageStampBatchID

    if (!defaultStamp) {
      console.warn("[SyncCoordinator] No default stamp, skipping utilization")
      return
    }

    const batchID = new BatchId(defaultStamp)
    const stamp = postageStampsStore.getStamp(batchID)

    if (!stamp) {
      console.warn("[SyncCoordinator] Stamp not found, skipping utilization")
      return
    }

    // Convert chunk addresses to Chunks
    const chunks = createChunksFromAddresses(chunkAddresses)

    // Derive swarm encryption key from derivation key
    const swarmEncryptionKey = await deriveSwarmEncryptionKey(
      account.derivationKey,
    )

    // Derive owner address from backup key
    const backupKeyHex = await deriveSecret(swarmEncryptionKey, "backup-key")
    const backupKey = new PrivateKey(backupKeyHex)
    const owner = backupKey.publicKey().address()

    // Update utilization state
    const { state: utilizationState, tracker } = await updateAfterWrite(
      batchID,
      chunks,
      stamp.depth,
      {
        cache: utilizationStore,
      },
    )

    // Calculate new utilization fraction
    const newUtilization = calculateUtilization(utilizationState, stamp.depth)

    // Update stamp in store (without triggering sync)
    postageStampsStore.updateStampUtilization(batchID, newUtilization)

    // Schedule debounced upload of dirty chunks and WAIT for it
    if (tracker.hasDirtyChunks()) {
      // Get stamper for signing chunks (with loaded bucket state)
      const stamper = await postageStampsStore.getStamper(batchID, {
        owner,
        encryptionKey: hexToUint8Array(swarmEncryptionKey),
      })
      if (!stamper) {
        console.warn("[SyncCoordinator] Cannot create stamper, skipping upload")
        return
      }

      const uploadPromise = utilizationUploader.scheduleUpload(
        batchID.toHex(),
        tracker,
        async () => {
          await saveUtilizationState(utilizationState, {
            bee,
            stamper,
            encryptionKey: hexToUint8Array(swarmEncryptionKey),
            cache: utilizationStore,
            tracker,
            reservedBuckets:
              stamper instanceof UtilizationAwareStamper
                ? stamper.getProtectedBuckets()
                : undefined,
          })

          // Flush stamper bucket state updates to cache (if supported)
          if (stamper.flush) {
            await stamper.flush()
          }
        },
      )

      return withTimeout(
        uploadPromise,
        UTILIZATION_UPLOAD_TIMEOUT_MS,
        `Utilization upload timeout (${UTILIZATION_UPLOAD_TIMEOUT_MS}ms)`,
      )
    }
  }

  /**
   * Capture a consistent snapshot of account state for syncing.
   * Must be called before any async operations to ensure consistency.
   *
   * @param accountId - Account ID (hex address)
   * @returns Snapshot and sync context, or undefined if account/stamp not found
   */
  async function getAccountStateSnapshot(accountId: string): Promise<
    | {
        snapshot: AccountStateSnapshot
        encryptionKey: string
        defaultStamp: PostageStamp
      }
    | undefined
  > {
    // Get account
    const account = accountsStore.getAccount(new EthAddress(accountId))
    if (!account) {
      console.warn("[SyncCoordinator] Account not found", accountId)
      return undefined
    }

    // Resolve default stamp (account-scoped)
    const defaultStampBatchID = account.defaultPostageStampBatchID

    if (!defaultStampBatchID) {
      console.warn("[SyncCoordinator] No default stamp for account", accountId)
      return undefined
    }

    const defaultStamp = postageStampsStore.getStamp(defaultStampBatchID)
    if (!defaultStamp) {
      console.warn("[SyncCoordinator] Default stamp not found")
      return undefined
    }

    // Derive swarm encryption key from stored derivation key
    const encryptionKey = await deriveSwarmEncryptionKey(account.derivationKey)

    // Account state is read straight off the nested account document, by the
    // one builder every publisher shares (the per-field clock rules live there).
    const snapshot = accountToStateSnapshot(account, accountId, Date.now())

    return {
      snapshot,
      encryptionKey,
      defaultStamp,
    }
  }

  return async function syncAccount(
    accountId: string,
  ): Promise<SyncResult | undefined> {
    const startTime = performance.now()
    const timestamp = () => new Date().toISOString()

    // Capture state snapshot (derives encryption key from derivation key).
    const snapshotResult = await getAccountStateSnapshot(accountId)
    if (!snapshotResult) {
      return undefined
    }

    const { snapshot: state, encryptionKey, defaultStamp } = snapshotResult
    const partitionCount = state.metadata.partitionCount ?? 1

    // Derive the account feed key (also the lock-SOC backup signer) + owner.
    const backupKeyHex = await deriveSecret(encryptionKey, "backup-key")
    const accountKey = new PrivateKey(backupKeyHex)
    const owner = accountKey.publicKey().address()

    // Build the stamper for the default batch. The coordinator binds the held
    // partition on it and drives the lease circuit-breaker, so it needs the
    // full UtilizationAwareStamper surface — the store interface only promises
    // a FlushableStamper, so narrow at runtime instead of casting past the
    // contract.
    const stamper = await postageStampsStore.getStamper(defaultStamp.batchID, {
      owner,
      encryptionKey: hexToUint8Array(encryptionKey),
    })
    if (!stamper) {
      const error = `Cannot create stamper for batch ${defaultStamp.batchID.toHex()}`
      console.error(`[SyncCoordinator ${timestamp()}] ${error}`)
      return { status: "error", error }
    }
    if (!(stamper instanceof UtilizationAwareStamper)) {
      const error = `Stamper for batch ${defaultStamp.batchID.toHex()} does not support coordinated writes (expected a UtilizationAwareStamper)`
      console.error(`[SyncCoordinator ${timestamp()}] ${error}`)
      return { status: "error", error }
    }

    // Route the publish through the shared coordinator (same Web Lock + same
    // partition acquire the proxy uses). One-off mode: no refresh timer — the
    // lease lapses by TTL. `wait: "skip"` claims a free/expired partition once
    // and throws `PartitionContendedError` when every partition is held by a
    // live foreign device, so we skip rather than wait.
    const coordinator = new BatchWriteCoordinator({
      bee,
      batchId: defaultStamp.batchID.toHex(),
      stamper,
      deviceId: getOrCreateDeviceId(),
      accountId,
      // Read fresh so the presence/intent rounds see the current device
      // registry — without this the background-sync acquire has no rivals to
      // check and can collide with a live holder on another device.
      knownDeviceIds: () =>
        accountsStore
          .getAccount(new EthAddress(accountId))
          ?.devices.map((d) => d.deviceId) ?? [],
      backupSigner: accountKey,
      swarmEncryptionKey: hexToUint8Array(encryptionKey),
      partitionCount,
      mode: "oneshot",
    })

    console.log(
      `[SyncCoordinator ${timestamp()}] Starting sync for ${accountId} bee.url=${bee.url}`,
    )

    // Build this device's view + registry seed from the captured snapshot. The
    // per-field scalar clocks (incl. the stable-`createdAt` fallback for a
    // never-edited field) are derived by `accountStateToDeviceView`.
    const deviceId = getOrCreateDeviceId()
    const thisDevice = state.metadata.devices.find(
      (d) => d.deviceId === deviceId,
    ) ?? {
      deviceId,
      name: detectDeviceName(),
      createdAt: Date.now(),
      lastSignedInAt: Date.now(),
    }
    const view = accountStateToDeviceView(state)

    try {
      // Time-bound the publish: Bee client requests have no built-in timeout,
      // so a non-responding node would otherwise hang the UI forever. This
      // surfaces the timeout to the caller but does NOT cancel the underlying
      // fetch (that would need AbortSignal propagation through bee-js). The
      // TimeoutError lands in the catch below, which returns it as a
      // `status: "error"` SyncResult — same shape and message as before.
      const result = await withTimeout(
        coordinator.withWrite(
          (target) =>
            publishDeviceState({
              bee,
              accountId,
              device: thisDevice,
              accountKey,
              owner,
              encryptionKey,
              view,
              target,
              onChunksUploaded: (addresses) =>
                handleUtilizationUpdate(accountId, addresses),
            }),
          { wait: "skip" },
        ),
        SYNC_TIMEOUT_MS,
        `Sync timed out after ${SYNC_TIMEOUT_MS}ms`,
      )
      if (result.status === "error") {
        console.error(
          `[SyncCoordinator ${timestamp()}] Sync failed (+${(performance.now() - startTime).toFixed(2)}ms):`,
          result.error,
        )
      }
      return result
    } catch (error) {
      // Genuine contention (every partition held by a live foreign device):
      // skip quietly — a peer (or the proxy) publishes instead.
      if (error instanceof PartitionContendedError) {
        console.warn(
          `[SyncCoordinator] Skipping sync ${accountId}: all partitions are held by other devices.`,
        )
        return undefined
      }
      // Operational failure (stamp/SOC/lock error) — log as an error, distinct
      // from contention.
      console.error(
        `[SyncCoordinator ${timestamp()}] Sync failed (+${(performance.now() - startTime).toFixed(2)}ms):`,
        error,
      )
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
