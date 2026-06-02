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
  UtilizationAwareStamper,
  LEASE_TTL_MS,
} from "../utils/batch-utilization"
import { withBatchWriteLock } from "../utils/batch-write-lock"
import { collectAccountStampBatchIds } from "../utils/postage-stamp-association"
import type { UtilizationStoreDB } from "../storage/utilization-store"
import type { DebouncedUtilizationUploader } from "../storage/debounced-uploader"
import type {
  AccountsStoreInterface,
  IdentitiesStoreInterface,
  ConnectedAppsStoreInterface,
  PostageStampsStoreInterface,
} from "./store-interfaces"
import { AsyncEpochFinder, BasicEpochUpdater } from "../proxy/feeds/epochs"
import { uploadData, type UploadTarget } from "../proxy/upload"
import { downloadDataWithChunkAPI } from "../proxy/download-data"
import { serializeAccountState, deserializeAccountState } from "./serialization"
import type { SyncResult } from "./types"
import type { AccountStateSnapshot } from "../utils/account-state-snapshot"
import { rejectAfter } from "../utils/promise"
import type { PostageStamp } from "../schemas"
import { mergeSnapshotWithRemote } from "./merge-snapshot"
import {
  readPartitionLock,
  acquirePartitionLock,
  NO_HOLDER_DEVICE_ID,
} from "./partition-lock"
import { PARTITION_LOCK_GUARD_MS } from "./partition-lease"
import { getOrCreateDeviceId } from "../utils/device-id"

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
 * Read the latest on-Swarm snapshot for an account's sync feed, returning
 * `undefined` when the feed is empty or the chunks aren't retrievable.
 *
 * Best-effort: the caller treats `undefined` as "no remote, use local only".
 * Errors propagate so the caller's catch can log them.
 */
async function tryFetchLatestSnapshot(opts: {
  bee: Bee
  topic: Topic
  owner: EthAddress
}): Promise<AccountStateSnapshot | undefined> {
  const { bee, topic, owner } = opts
  // Feed SOCs are uploaded unencrypted (no encryptionKey passed to
  // updater.update below); the finder must not use one either.
  const finder = new AsyncEpochFinder(bee, topic, owner)
  const now = BigInt(Math.floor(Date.now() / 1000))
  const refBytes = await finder.findAt(now)
  if (!refBytes) return undefined

  const reference = new Reference(refBytes)
  const data = await downloadDataWithChunkAPI(bee, reference.toHex())
  return deserializeAccountState(data)
}

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
            reservedBuckets:
              stamper instanceof UtilizationAwareStamper
                ? stamper.getLockSocBuckets()
                : undefined,
          })

          // Flush stamper bucket state updates to cache (if supported)
          if (stamper.flush) {
            await stamper.flush()
          }
        },
      )

      return Promise.race([
        uploadPromise,
        rejectAfter(
          UTILIZATION_UPLOAD_TIMEOUT_MS,
          `Utilization upload timeout (${UTILIZATION_UPLOAD_TIMEOUT_MS}ms)`,
        ),
      ])
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
    const partitionCount = state.metadata.partitionCount ?? 1

    // Safety gate: a device may only write to the shared batch when it
    // actually holds a partition. The lock SOC is the single source of
    // truth (no `activeDevices` mirror). Read it directly — this device's
    // backup signer owns the lock SOCs. Inactive devices skip the publish;
    // the proxy publishes under its own held lease.
    let heldPartition: number | undefined
    if (partitionCount > 1) {
      const selfDeviceId = getOrCreateDeviceId()
      const gateBackupKeyHex = await deriveSecret(encryptionKey, "backup-key")
      const gateBackupSigner = new PrivateKey(gateBackupKeyHex)
      const gateSwarmKey = hexToUint8Array(encryptionKey)
      const now = Date.now()
      let freePartition: number | undefined
      for (let p = 0; p < partitionCount; p++) {
        const lock = await readPartitionLock({
          bee,
          backupSigner: gateBackupSigner,
          swarmEncryptionKey: gateSwarmKey,
          partition: p,
        })
        if (
          lock &&
          lock.holderDeviceId === selfDeviceId &&
          lock.leasedUntil > now
        ) {
          heldPartition = p
          break
        }
        if (
          freePartition === undefined &&
          (!lock ||
            lock.holderDeviceId === NO_HOLDER_DEVICE_ID ||
            lock.leasedUntil <= now)
        ) {
          freePartition = p
        }
      }
      // The SwarmID UI must be able to publish its own account-state changes
      // (the proxy is not the only writer). If we don't already hold a
      // partition, claim a free/expired one so the publish can proceed. The
      // lock-SOC protocol (generation fencing) makes the claim safe without the
      // write lock. Skip only when every partition is held by a live foreign
      // device — then a peer (or the proxy) publishes instead.
      if (heldPartition === undefined && freePartition !== undefined) {
        const gateStamper = await postageStampsStore.getStamper(
          defaultStamp.batchID,
          {
            owner: gateBackupSigner.publicKey().address(),
            encryptionKey: gateSwarmKey,
          },
        )
        if (gateStamper) {
          try {
            const claim = await acquirePartitionLock({
              bee,
              stamper: gateStamper,
              backupSigner: gateBackupSigner,
              swarmEncryptionKey: gateSwarmKey,
              partition: freePartition,
              deviceId: selfDeviceId,
              ttlMs: LEASE_TTL_MS,
              guardMs: PARTITION_LOCK_GUARD_MS,
            })
            if (claim.outcome === "acquired") {
              heldPartition = freePartition
            }
          } catch (err) {
            // A transient claim failure must not crash the sync — skip the
            // publish; a later trigger (or the proxy) retries.
            console.warn(
              `[SyncCoordinator] Partition claim for ${accountId} failed; skipping publish:`,
              err,
            )
          }
        }
      }
      if (heldPartition === undefined) {
        console.warn(
          `[SyncCoordinator] Skipping sync ${accountId}: all partitions are held by other devices.`,
        )
        return undefined
      }
    }

    console.log(
      `[SyncCoordinator ${timestamp()}] Starting sync for ${accountId} bee.url=${bee.url}`,
    )

    const runSync = async (): Promise<SyncResult> => {
      // 1. Derive account signing key for feed
      const backupKeyHex = await deriveSecret(encryptionKey, "backup-key")
      const accountKey = new PrivateKey(backupKeyHex)
      const owner = accountKey.publicKey().address()
      const topic = Topic.fromString(
        `${ACCOUNT_SYNC_TOPIC_PREFIX}:${accountId}`,
      )

      // 1a. Fetch the latest on-Swarm snapshot (best effort) and merge
      // it with our local state. This prevents the local-write-stomps-peer
      // race: a device writing here doesn't lose other devices' additions
      // that were published since our last refresh.
      let mergedState = state
      try {
        const latestRemote = await tryFetchLatestSnapshot({
          bee,
          topic,
          owner,
        })
        if (latestRemote) {
          mergedState = mergeSnapshotWithRemote(state, latestRemote)
          console.log(
            `[SyncCoordinator ${timestamp()}] Merged remote snapshot (remote devices=${latestRemote.metadata.devices.length}, merged devices=${mergedState.metadata.devices.length})`,
          )
        }
      } catch (err) {
        console.warn(
          `[SyncCoordinator ${timestamp()}] Pre-write remote-snapshot fetch failed; proceeding with local state only:`,
          err,
        )
      }

      // 2. Serialize merged state
      const jsonData = serializeAccountState(mergedState)

      // 3. Get stamper from store
      const stamper = await postageStampsStore.getStamper(
        defaultStamp.batchID,
        {
          owner,
          encryptionKey: hexToUint8Array(encryptionKey),
        },
      )
      if (
        stamper &&
        heldPartition !== undefined &&
        partitionCount > 1 &&
        stamper.bindPartition &&
        stamper.buildLeaseLocalCounter
      ) {
        // Bind the stamper to the partition this device holds (per the lock
        // SOC) so chunk-stamping picks slots from our slice instead of the
        // "any" pool — prevents collisions with peers sharing the batch.
        stamper.bindPartition({
          partition: heldPartition,
          partitionCount,
          localCounter: stamper.buildLeaseLocalCounter(),
        })
      }
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
      // `topic` already declared above with the same construction.
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
      // Serialize the publish against every other writer on this batch (proxy
      // iframes and the SwarmID UI) via the shared cross-tab Web Lock, so the
      // snapshot chunks never collide with a concurrent partition write.
      const result = await Promise.race([
        withBatchWriteLock(defaultStamp.batchID.toHex(), runSync),
        timeoutPromise,
      ])
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
