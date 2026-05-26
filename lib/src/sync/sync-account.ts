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
  Topic,
  Reference,
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
} from "../utils/batch-utilization"
import { collectAccountStampBatchIds } from "../utils/postage-stamp-association"
import type { UtilizationStoreDB } from "../storage/utilization-store"
import type { DebouncedUtilizationUploader } from "../storage/debounced-uploader"
import type {
  AccountsStoreInterface,
  IdentitiesStoreInterface,
  ConnectedAppsStoreInterface,
  PostageStampsStoreInterface,
} from "./store-interfaces"
import { BasicEpochUpdater } from "../proxy/feeds/epochs"
import { uploadData, type UploadTarget } from "../proxy/upload"
import { serializeAccountState } from "./serialization"
import type { SyncResult } from "./types"
import type { AccountStateSnapshot } from "../utils/account-state-snapshot"
import type { PostageStamp } from "../schemas"

// Timeout for utilization upload in milliseconds
const UTILIZATION_UPLOAD_TIMEOUT_MS = 30000

// Timeout for the full sync (upload + feed update) in milliseconds.
// Bee client requests use bare fetch with no timeout, so a non-responding
// node would otherwise hang forever.
const SYNC_TIMEOUT_MS = 60000

// Inner timeout for the post-upload verification probe.
// The probe is a best-effort diagnostic — if it can't answer quickly we
// move on to "success-unverified" rather than letting bee-js retries
// consume the outer SYNC_TIMEOUT_MS budget.
const VERIFY_PROBE_TIMEOUT_MS = 5000

// Topic prefix for sync feeds
export const ACCOUNT_SYNC_TOPIC_PREFIX = "swarm-id-backup-v1:account"

/**
 * Options for creating a sync account function
 */
export interface SyncAccountOptions {
  /** Bee client for Swarm operations */
  bee: Bee

  /** Store providing account data */
  accountsStore: AccountsStoreInterface

  /** Store providing identity data */
  identitiesStore: IdentitiesStoreInterface

  /** Store providing connected app data */
  connectedAppsStore: ConnectedAppsStoreInterface

  /** Store providing postage stamp data */
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
    identitiesStore,
    connectedAppsStore,
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
    const defaultStamp =
      account.defaultPostageStampBatchID ??
      identitiesStore.getIdentitiesByAccount(account.id)[0]
        ?.defaultPostageStampBatchID

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
        bee,
        owner,
        encryptionKey: hexToUint8Array(swarmEncryptionKey),
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
          })

          // Flush stamper bucket state updates to cache (if supported)
          if (stamper.flush) {
            await stamper.flush()
          }
        },
      )

      // Add timeout to prevent hanging
      const timeoutPromise = new Promise<void>((_, reject) => {
        setTimeout(
          () =>
            reject(
              new Error(
                `Utilization upload timeout (${UTILIZATION_UPLOAD_TIMEOUT_MS}ms)`,
              ),
            ),
          UTILIZATION_UPLOAD_TIMEOUT_MS,
        )
      })

      return Promise.race([uploadPromise, timeoutPromise])
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

    // Resolve default stamp (account or first identity)
    const defaultStampBatchID =
      account.defaultPostageStampBatchID ??
      identitiesStore.getIdentitiesByAccount(account.id)[0]
        ?.defaultPostageStampBatchID

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

    // Collect account state
    const identities = identitiesStore.getIdentitiesByAccount(account.id)
    const apps = identities.flatMap((identity) =>
      connectedAppsStore.getAppsByIdentityId(identity.id),
    )
    const stamps = collectAccountStampBatchIds(account, identities)
      .map((batchId) => postageStampsStore.getStamp(batchId))
      .filter((stamp): stamp is PostageStamp => stamp !== undefined)

    const snapshot: AccountStateSnapshot = {
      version: 1,
      timestamp: Date.now(),
      accountId,
      metadata: {
        accountName: account.name,
        defaultPostageStampBatchID: defaultStampBatchID.toHex(),
        createdAt: account.createdAt,
        lastModified: Date.now(),
        devices: account.devices,
        activeDevices: account.activeDevices ?? [],
        partitionCount: account.partitionCount ?? 1,
      },
      identities,
      connectedApps: apps,
      postageStamps: stamps,
    }

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

    // Capture state snapshot (derives encryption key from derivation key)
    const snapshotResult = await getAccountStateSnapshot(accountId)
    if (!snapshotResult) {
      return undefined
    }

    const { snapshot: state, encryptionKey, defaultStamp } = snapshotResult

    console.log(
      `[SyncCoordinator ${timestamp()}] Starting sync for ${accountId} bee.url=${bee.url}`,
    )

    const runSync = async (): Promise<SyncResult> => {
      // 1. Derive account signing key for feed
      const backupKeyHex = await deriveSecret(encryptionKey, "backup-key")
      const accountKey = new PrivateKey(backupKeyHex)
      const owner = accountKey.publicKey().address()

      // 2. Serialize account state
      const jsonData = serializeAccountState(state)

      // 3. Get stamper from store
      const stamper = await postageStampsStore.getStamper(
        defaultStamp.batchID,
        {
          owner,
          encryptionKey: hexToUint8Array(encryptionKey),
        },
      )
      if (!stamper) {
        throw new Error(
          `Cannot create stamper for batch ${defaultStamp.batchID.toHex()}`,
        )
      }

      // 4. Upload encrypted data to Swarm
      const target: UploadTarget = {
        mode: "stamper",
        bee,
        stamper,
      }

      console.log(`[SyncCoordinator ${timestamp()}] Uploading data…`)
      const uploadResult = await uploadData(target, jsonData, {
        encryptionKey: hexToUint8Array(encryptionKey),
      })

      // Collect chunk addresses for utilization tracking
      // chunkAddresses is always present when using encryption
      const allChunkAddresses = uploadResult.chunkAddresses ?? []

      // 5. Handle utilization tracking

      if (allChunkAddresses.length > 0) {
        try {
          await handleUtilizationUpdate(accountId, allChunkAddresses)
        } catch (error) {
          // Don't fail sync if utilization fails - continue with feed update
          console.error(
            `[SyncCoordinator ${timestamp()}] Utilization upload failed (+${(performance.now() - startTime).toFixed(2)}ms):`,
            error,
          )
        }
      }

      // 6. Update epoch feed (after utilization completes)
      const topic = Topic.fromString(
        `${ACCOUNT_SYNC_TOPIC_PREFIX}:${accountId}`,
      )
      const updater = new BasicEpochUpdater(topic, accountKey)
      const feedTimestamp = BigInt(Math.floor(Date.now() / 1000))

      // Convert 128-char hex reference to 64-byte Uint8Array
      const refBytes = new Reference(uploadResult.reference).toUint8Array()

      // Create upload target for epoch feed update
      const feedTarget: UploadTarget = { mode: "stamper", bee, stamper }
      console.log(`[SyncCoordinator ${timestamp()}] Updating feed…`)
      const updateResult = await updater.update(
        feedTimestamp,
        refBytes,
        feedTarget,
      )
      console.log(
        `[SyncCoordinator ${timestamp()}] Feed updated (+${(performance.now() - startTime).toFixed(2)}ms), verifying root chunk…`,
      )

      // Add SOC chunk to tracked addresses
      allChunkAddresses.push(updateResult.socAddress)

      // 7. Verify the root chunk is retrievable immediately after upload.
      // This catches the case where Bee accepts the write but doesn't
      // actually retain the data — the upload reports success, the feed
      // points at a reference, but downstream restores would fail.
      // refBytes is the snapshot reference: 32 bytes (plain) or 64 bytes
      // (encrypted = 32-byte address + 32-byte key). Probe the address only.
      const rootChunkAddress = refBytes.slice(0, 32)
      const rootChunkAddressHex = Array.from(rootChunkAddress)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")

      // Bound the probe with its own timeout + per-request timeout so bee-js
      // can't retry the 500 response indefinitely.
      let probeTimer: ReturnType<typeof setTimeout> | undefined
      const probeTimeoutPromise = new Promise<"timeout">((resolve) => {
        probeTimer = setTimeout(
          () => resolve("timeout"),
          VERIFY_PROBE_TIMEOUT_MS,
        )
      })
      const probePromise = bee
        .downloadChunk(rootChunkAddressHex, undefined, {
          timeout: VERIFY_PROBE_TIMEOUT_MS,
        })
        .then(() => "ok" as const)
        .catch((err) => err as Error)

      let probeOutcome: "ok" | "timeout" | Error
      try {
        probeOutcome = await Promise.race([probePromise, probeTimeoutPromise])
      } finally {
        if (probeTimer !== undefined) clearTimeout(probeTimer)
      }

      if (probeOutcome === "ok") {
        console.log(
          `[SyncCoordinator ${timestamp()}] Verified root chunk retrievable addr=${rootChunkAddressHex}`,
        )
        return {
          status: "success",
          reference: uploadResult.reference,
          timestamp: feedTimestamp,
          chunkAddresses: allChunkAddresses,
        }
      }

      const reason =
        probeOutcome === "timeout"
          ? `probe timed out after ${VERIFY_PROBE_TIMEOUT_MS}ms`
          : probeOutcome instanceof Error
            ? probeOutcome.message
            : String(probeOutcome)
      const warning = `Root chunk ${rootChunkAddressHex} not retrievable immediately after upload from ${bee.url}: ${reason}`
      console.warn(`[SyncCoordinator ${timestamp()}] ${warning}`)
      return {
        status: "success-unverified",
        reference: uploadResult.reference,
        timestamp: feedTimestamp,
        chunkAddresses: allChunkAddresses,
        warning,
      }
    }

    // Race the sync against a timeout. Bee client requests have no built-in
    // timeout, so a non-responding node would otherwise hang the UI forever.
    // Note: this surfaces the timeout to the caller but does NOT cancel the
    // underlying fetch (would require AbortSignal propagation through bee-js).
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<SyncResult>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          status: "error",
          error: `Sync timed out after ${SYNC_TIMEOUT_MS}ms`,
        })
      }, SYNC_TIMEOUT_MS)
    })

    try {
      const result = await Promise.race([runSync(), timeoutPromise])
      if (result.status === "error") {
        console.error(
          `[SyncCoordinator ${timestamp()}] Sync failed (+${(performance.now() - startTime).toFixed(2)}ms):`,
          result.error,
        )
      }
      return result
    } catch (error) {
      console.error(
        `[SyncCoordinator ${timestamp()}] Sync failed (+${(performance.now() - startTime).toFixed(2)}ms):`,
        error,
      )
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
