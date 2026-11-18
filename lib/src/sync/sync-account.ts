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
  BACKUP_KEY_LABEL,
} from "../utils/key-derivation"
import { hexToUint8Array } from "../utils/hex"
import {
  updateAfterWrite,
  calculateUtilization,
  UtilizationAwareStamper,
} from "../utils/batch-utilization"
import type { UtilizationStoreDB } from "../storage/utilization-store"
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
import type { BusLanes } from "./bus-lease"
import { accountStateToDeviceView, publishDeviceState } from "./device-state"
import { rosterRetryDelayMs } from "./device-roster"
import { getOrCreateDeviceId, detectDeviceName } from "../utils/device-id"

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

  /**
   * This context's lanes on the account bus. A batch split into partitions
   * is written only by the context that holds one of its lanes, and a lane
   * is taken by asking over the bus: without this the sync skips.
   */
  lanes?: () => BusLanes | undefined
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
  const { bee, accountsStore, postageStampsStore, utilizationStore, lanes } =
    options

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

    // Count the chunks locally, for the usage the UI shows. The counters
    // themselves travel as the lane's published state.
    const { state: utilizationState } = await updateAfterWrite(
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

  // Pending roster-append retries per account (#920), see the partial branch.
  const rosterRetries = new Map<
    string,
    { attempt: number; timer: ReturnType<typeof setTimeout> }
  >()

  // One sync per account at a time: two publishes of one account contend for
  // the same partition lease, and the loser fails (`PartitionLeaseLostError`).
  // A call made while one runs waits for it, then publishes the account as it
  // is by then; every call made in that wait shares that one later publish.
  const running = new Map<string, Promise<SyncResult | undefined>>()
  const queued = new Map<string, Promise<SyncResult | undefined>>()

  function start(accountId: string): Promise<SyncResult | undefined> {
    const run = syncAccountNow(accountId)
    running.set(accountId, run)
    const forget = () => {
      if (running.get(accountId) === run) running.delete(accountId)
    }
    run.then(forget, forget)
    return run
  }

  function syncAccount(accountId: string): Promise<SyncResult | undefined> {
    const waiting = queued.get(accountId)
    if (waiting) return waiting
    const current = running.get(accountId)
    if (!current) return start(accountId)
    const next = current
      .catch(() => undefined)
      .then(() => {
        queued.delete(accountId)
        return start(accountId)
      })
    queued.set(accountId, next)
    return next
  }

  async function syncAccountNow(
    accountId: string,
  ): Promise<SyncResult | undefined> {
    const startTime = performance.now()
    const timestamp = () => new Date().toISOString()
    // Any sync re-runs the append, so a pending retry would only duplicate it.
    const pending = rosterRetries.get(accountId)
    if (pending) clearTimeout(pending.timer)

    // Capture state snapshot (derives encryption key from derivation key).
    const snapshotResult = await getAccountStateSnapshot(accountId)
    if (!snapshotResult) {
      return undefined
    }

    const { snapshot: state, encryptionKey, defaultStamp } = snapshotResult
    const partitionCount = state.metadata.partitionCount ?? 1

    // Derive the account feed key (also the owner of a lane's published
    // state) + owner.
    const backupKeyHex = await deriveSecret(encryptionKey, BACKUP_KEY_LABEL)
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
    // lane protocol the proxy uses). One-off mode: `wait: "skip"` waits only
    // as long as a context alone in the room needs and throws
    // `PartitionContendedError` when no lane could be taken, so we skip rather
    // than wait. The lane is given up as soon as the sync is done.
    const coordinator = new BatchWriteCoordinator({
      bee,
      batchId: defaultStamp.batchID.toHex(),
      stamper,
      deviceId: getOrCreateDeviceId(),
      accountId,
      lanes: lanes?.(),
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
      if (result.status === "partial") {
        // The roster append was skipped on an inconclusive scan (#920). Nothing
        // else re-runs it until the user edits the account, so retry here with
        // backoff; a mutation-triggered sync in between supersedes the timer.
        const attempt = rosterRetries.get(accountId)?.attempt ?? 0
        const delay = rosterRetryDelayMs(attempt)
        console.warn(
          `[SyncCoordinator ${timestamp()}] ${result.warning}; retrying in ${delay}ms`,
        )
        rosterRetries.set(accountId, {
          attempt: attempt + 1,
          timer: setTimeout(() => void syncAccount(accountId), delay),
        })
      } else {
        rosterRetries.delete(accountId)
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
    } finally {
      // The coordinator lives for this one sync: give its lane up, so a
      // context that asks for it is answered at once.
      coordinator.teardown()
    }
  }

  return syncAccount
}
