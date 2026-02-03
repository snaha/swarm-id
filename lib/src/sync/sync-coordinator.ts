import { BroadcastChannel, createLeaderElection } from "broadcast-channel"
import { Bee, BatchId } from "@ethersphere/bee-js"
import type { EnvelopeWithBatchId } from "@ethersphere/bee-js"
import type { Chunk as CafeChunk } from "cafe-utility"
import { UtilizationStoreDB } from "../storage/utilization-store"
import { DebouncedUtilizationUploader } from "../storage/debounced-uploader"
import { createSyncAccount, type SyncAccountFunction } from "./sync-account"
import {
  createStorageBackedAccountsStore,
  createStorageBackedIdentitiesStore,
  createStorageBackedConnectedAppsStore,
  createStorageBackedPostageStampsStore,
} from "./storage-backed-stores"
import { createNetworkSettingsStorageManager } from "../utils/storage-managers"
import { DEFAULT_BEE_NODE_URL } from "../schemas"
import { hexToUint8Array, uint8ArrayToHex } from "../utils/key-derivation"
import { UtilizationAwareStamper } from "../utils/batch-utilization"

const CHANNEL_NAME = "swarm-id:sync"
const REQUEST_TIMEOUT_MS = 60000
const LEADER_ELECTION_SETTLE_MS = 200
const DEBOUNCE_MS = 2000
const STAMP_REQUEST_TIMEOUT_MS = 30000

// ============================================================================
// Message Types
// ============================================================================

interface SyncRequest {
  type: "sync-request"
  accountId: string
  requestId: string
}

interface SyncResponse {
  type: "sync-response"
  requestId: string
  success: boolean
  error?: string
}

interface StampRequest {
  type: "stamp-request"
  requestId: string
  chunkHash: string
  batchId: string
  signerKey: string
  depth: number
}

interface StampResponse {
  type: "stamp-response"
  requestId: string
  issuer: string
  index: string
  timestamp: string
  signature: string
  batchId: string
}

interface StampErrorMsg {
  type: "stamp-error"
  requestId: string
  error: string
}

interface FlushStamperRequest {
  type: "flush-stamper-request"
  requestId: string
  batchId: string
}

interface FlushStamperResponse {
  type: "flush-stamper-response"
  requestId: string
}

type ChannelMessage =
  | SyncRequest
  | SyncResponse
  | StampRequest
  | StampResponse
  | StampErrorMsg
  | FlushStamperRequest
  | FlushStamperResponse

// ============================================================================
// SyncCoordinator
// ============================================================================

class SyncCoordinator {
  private channel: BroadcastChannel<ChannelMessage>
  private elector: ReturnType<typeof createLeaderElection> | undefined
  private isLeader = false
  private readyPromise: Promise<void>
  private syncHandler: SyncAccountFunction | undefined
  private lastBeeUrl: string | undefined
  private pendingRequests = new Map<
    string,
    { resolve: () => void; reject: (e: Error) => void }
  >()
  private inFlight = new Map<string, Promise<void>>()
  private pendingRetry = new Set<string>()
  private syncTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // Stamper management (leader only)
  private stampers = new Map<string, UtilizationAwareStamper>()
  private stamperCreationPromises = new Map<string, Promise<UtilizationAwareStamper>>()
  private stamperUtilizationStore: UtilizationStoreDB | undefined

  // Pending stamp/flush requests (follower only)
  private pendingStampRequests = new Map<string, {
    resolve: (envelope: EnvelopeWithBatchId) => void
    reject: (error: Error) => void
  }>()
  private pendingFlushRequests = new Map<string, {
    resolve: () => void
    reject: (error: Error) => void
  }>()

  constructor() {
    this.channel = new BroadcastChannel<ChannelMessage>(CHANNEL_NAME)
    this.channel.onmessage = (msg) => this.handleMessage(msg)

    this.elector = createLeaderElection(this.channel)

    const leadershipClaimed = this.elector.awaitLeadership().then(() => {
      this.isLeader = true
      console.log("[SyncCoordinator] This tab is now the leader")
    })

    // Allow a brief window for instant leadership, then mark ready for follower operation
    this.readyPromise = Promise.race([
      leadershipClaimed,
      new Promise<void>((resolve) =>
        setTimeout(resolve, LEADER_ELECTION_SETTLE_MS),
      ),
    ]).then(() => {
      if (!this.isLeader) {
        console.log("[SyncCoordinator] This tab is a follower")
      }
    })
  }

  private createSyncHandler(beeUrl: string): SyncAccountFunction {
    console.log(`[SyncCoordinator] Creating Bee client with URL: ${beeUrl}`)
    const bee = new Bee(beeUrl)
    const utilizationStore = new UtilizationStoreDB()
    const utilizationUploader = new DebouncedUtilizationUploader()

    return createSyncAccount({
      bee,
      accountsStore: createStorageBackedAccountsStore(),
      identitiesStore: createStorageBackedIdentitiesStore(),
      connectedAppsStore: createStorageBackedConnectedAppsStore(),
      postageStampsStore: createStorageBackedPostageStampsStore(utilizationStore),
      utilizationStore,
      utilizationUploader,
    })
  }

  private getSyncHandler(): SyncAccountFunction {
    const networkSettings = createNetworkSettingsStorageManager().load()
    const currentBeeUrl = networkSettings?.beeNodeUrl ?? DEFAULT_BEE_NODE_URL

    if (!this.syncHandler || currentBeeUrl !== this.lastBeeUrl) {
      this.lastBeeUrl = currentBeeUrl
      this.syncHandler = this.createSyncHandler(currentBeeUrl)
    }
    return this.syncHandler
  }

  triggerSync(accountId: string): void {
    const existingTimer = this.syncTimers.get(accountId)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    const timer = setTimeout(() => {
      this.requestSync(accountId)
      this.syncTimers.delete(accountId)
    }, DEBOUNCE_MS)

    this.syncTimers.set(accountId, timer)
  }

  async requestSync(accountId: string): Promise<void> {
    await this.readyPromise

    if (this.isLeader) {
      console.log(
        `[SyncCoordinator] Leader executing sync for account ${accountId}`,
      )
      return this.executeSync(accountId)
    }

    console.log(
      `[SyncCoordinator] Follower forwarding sync request for account ${accountId} to leader`,
    )
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject })
      this.channel.postMessage({
        type: "sync-request",
        accountId,
        requestId,
      })
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId)
          reject(new Error("Sync request timed out"))
        }
      }, REQUEST_TIMEOUT_MS)
    })
  }

  // ============================================================================
  // Stamp Coordination
  // ============================================================================

  private async getOrCreateStamper(
    batchId: string,
    signerKey: string,
    depth: number,
  ): Promise<UtilizationAwareStamper> {
    // Check in-memory cache first
    const existing = this.stampers.get(batchId)
    if (existing) {
      return existing
    }

    // Deduplicate concurrent creation requests
    const inProgress = this.stamperCreationPromises.get(batchId)
    if (inProgress) {
      return inProgress
    }

    // Create new stamper
    const creationPromise = (async () => {
      if (!this.stamperUtilizationStore) {
        this.stamperUtilizationStore = new UtilizationStoreDB()
      }

      console.log(
        `[SyncCoordinator] Creating stamper for batch ${batchId.substring(0, 16)}...`,
      )

      const stamper = await UtilizationAwareStamper.create(
        signerKey,
        new BatchId(batchId),
        depth,
        this.stamperUtilizationStore,
      )

      this.stampers.set(batchId, stamper)
      this.stamperCreationPromises.delete(batchId)

      console.log(
        `[SyncCoordinator] Stamper ready for batch ${batchId.substring(0, 16)}...`,
      )

      return stamper
    })()

    this.stamperCreationPromises.set(batchId, creationPromise)
    return creationPromise
  }

  private stampLocally(
    chunkHash: Uint8Array,
    stamper: UtilizationAwareStamper,
  ): EnvelopeWithBatchId {
    // Create minimal CafeChunk adapter - only hash() is used by stamper.stamp()
    const adapter: CafeChunk = {
      hash: () => chunkHash,
      build: () => new Uint8Array(0),
      span: 0n,
      writer: { cursor: 0, buffer: new Uint8Array(0), write: () => 0, max: () => 0 },
    }

    return stamper.stamp(adapter)
  }

  async requestStamp(params: {
    chunkHash: Uint8Array
    batchId: string
    signerKey: string
    depth: number
  }): Promise<EnvelopeWithBatchId> {
    await this.readyPromise

    if (this.isLeader) {
      const stamper = await this.getOrCreateStamper(
        params.batchId,
        params.signerKey,
        params.depth,
      )
      return this.stampLocally(params.chunkHash, stamper)
    }

    // Follower: send stamp request to leader via BroadcastChannel
    console.log(
      `[SyncCoordinator] Follower requesting stamp for batch ${params.batchId.substring(0, 16)}...`,
    )

    const requestId = crypto.randomUUID()

    return new Promise<EnvelopeWithBatchId>((resolve, reject) => {
      this.pendingStampRequests.set(requestId, { resolve, reject })

      this.channel.postMessage({
        type: "stamp-request",
        requestId,
        chunkHash: uint8ArrayToHex(params.chunkHash),
        batchId: params.batchId,
        signerKey: params.signerKey,
        depth: params.depth,
      })

      setTimeout(() => {
        if (this.pendingStampRequests.has(requestId)) {
          this.pendingStampRequests.delete(requestId)
          reject(new Error("Stamp request timed out"))
        }
      }, STAMP_REQUEST_TIMEOUT_MS)
    })
  }

  async flushStamper(batchId: string): Promise<void> {
    await this.readyPromise

    if (this.isLeader) {
      const stamper = this.stampers.get(batchId)
      if (stamper) {
        await stamper.flush()
      }
      return
    }

    // Follower: send flush request to leader
    const requestId = crypto.randomUUID()

    return new Promise<void>((resolve, reject) => {
      this.pendingFlushRequests.set(requestId, { resolve, reject })

      this.channel.postMessage({
        type: "flush-stamper-request",
        requestId,
        batchId,
      })

      setTimeout(() => {
        if (this.pendingFlushRequests.has(requestId)) {
          this.pendingFlushRequests.delete(requestId)
          reject(new Error("Flush stamper request timed out"))
        }
      }, STAMP_REQUEST_TIMEOUT_MS)
    })
  }

  // ============================================================================
  // Internal Sync Logic
  // ============================================================================

  private async executeSync(accountId: string): Promise<void> {
    if (this.inFlight.has(accountId)) {
      this.pendingRetry.add(accountId)
      return this.inFlight.get(accountId)!
    }

    const promise = this.runSync(accountId)
    this.inFlight.set(accountId, promise)
    try {
      await promise
    } finally {
      this.inFlight.delete(accountId)
      if (this.pendingRetry.has(accountId)) {
        this.pendingRetry.delete(accountId)
        this.executeSync(accountId)
      }
    }
  }

  private async runSync(accountId: string): Promise<void> {
    const handler = this.getSyncHandler()
    await handler(accountId)
  }

  // ============================================================================
  // Message Handling
  // ============================================================================

  private async handleMessage(msg: ChannelMessage): Promise<void> {
    // --- Sync messages ---
    if (msg.type === "sync-request" && this.isLeader) {
      console.log(
        `[SyncCoordinator] Leader received sync request from follower for account ${msg.accountId}`,
      )
      try {
        await this.executeSync(msg.accountId)
        this.channel.postMessage({
          type: "sync-response",
          requestId: msg.requestId,
          success: true,
        })
      } catch (error) {
        this.channel.postMessage({
          type: "sync-response",
          requestId: msg.requestId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    if (msg.type === "sync-response") {
      const pending = this.pendingRequests.get(msg.requestId)
      if (pending) {
        this.pendingRequests.delete(msg.requestId)
        if (msg.success) {
          pending.resolve()
        } else {
          pending.reject(new Error(msg.error ?? "Sync failed"))
        }
      }
    }

    // --- Stamp messages ---
    if (msg.type === "stamp-request" && this.isLeader) {
      console.log(
        `[SyncCoordinator] Leader stamping chunk for batch ${msg.batchId.substring(0, 16)}...`,
      )
      try {
        const stamper = await this.getOrCreateStamper(
          msg.batchId,
          msg.signerKey,
          msg.depth,
        )
        const chunkHash = hexToUint8Array(msg.chunkHash)
        const envelope = this.stampLocally(chunkHash, stamper)

        this.channel.postMessage({
          type: "stamp-response",
          requestId: msg.requestId,
          issuer: uint8ArrayToHex(envelope.issuer),
          index: uint8ArrayToHex(envelope.index),
          timestamp: uint8ArrayToHex(envelope.timestamp),
          signature: uint8ArrayToHex(envelope.signature),
          batchId: envelope.batchId.toHex(),
        })
      } catch (error) {
        this.channel.postMessage({
          type: "stamp-error",
          requestId: msg.requestId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    if (msg.type === "stamp-response") {
      const pending = this.pendingStampRequests.get(msg.requestId)
      if (pending) {
        this.pendingStampRequests.delete(msg.requestId)
        const envelope: EnvelopeWithBatchId = {
          issuer: hexToUint8Array(msg.issuer),
          index: hexToUint8Array(msg.index),
          timestamp: hexToUint8Array(msg.timestamp),
          signature: hexToUint8Array(msg.signature),
          batchId: new BatchId(msg.batchId),
        }
        pending.resolve(envelope)
      }
    }

    if (msg.type === "stamp-error") {
      const pending = this.pendingStampRequests.get(msg.requestId)
      if (pending) {
        this.pendingStampRequests.delete(msg.requestId)
        pending.reject(new Error(msg.error))
      }
    }

    // --- Flush messages ---
    if (msg.type === "flush-stamper-request" && this.isLeader) {
      try {
        const stamper = this.stampers.get(msg.batchId)
        if (stamper) {
          await stamper.flush()
        }
        this.channel.postMessage({
          type: "flush-stamper-response",
          requestId: msg.requestId,
        })
      } catch (error) {
        // Still respond so follower doesn't hang
        this.channel.postMessage({
          type: "flush-stamper-response",
          requestId: msg.requestId,
        })
        console.error("[SyncCoordinator] Failed to flush stamper:", error)
      }
    }

    if (msg.type === "flush-stamper-response") {
      const pending = this.pendingFlushRequests.get(msg.requestId)
      if (pending) {
        this.pendingFlushRequests.delete(msg.requestId)
        pending.resolve()
      }
    }
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  async destroy(): Promise<void> {
    for (const timer of this.syncTimers.values()) {
      clearTimeout(timer)
    }
    this.syncTimers.clear()

    // Flush all stampers before closing
    for (const [batchId, stamper] of this.stampers) {
      try {
        await stamper.flush()
      } catch (error) {
        console.error(
          `[SyncCoordinator] Failed to flush stamper for batch ${batchId.substring(0, 16)}:`,
          error,
        )
      }
    }
    this.stampers.clear()
    this.stamperCreationPromises.clear()

    // Reject pending stamp requests
    for (const [, pending] of this.pendingStampRequests) {
      pending.reject(new Error("SyncCoordinator destroyed"))
    }
    this.pendingStampRequests.clear()

    // Reject pending flush requests
    for (const [, pending] of this.pendingFlushRequests) {
      pending.reject(new Error("SyncCoordinator destroyed"))
    }
    this.pendingFlushRequests.clear()

    if (this.elector) await this.elector.die()
    await this.channel.close()
  }
}

// ============================================================================
// Module-Level Singleton
// ============================================================================

let coordinator: SyncCoordinator | undefined

export function initSyncCoordinator(): void {
  if (typeof window === "undefined" || !window.localStorage) return
  if (coordinator) return
  coordinator = new SyncCoordinator()
}

export function triggerSync(accountId: string): void {
  coordinator?.triggerSync(accountId)
}

export async function requestSync(accountId: string): Promise<void> {
  if (!coordinator) return
  await coordinator.requestSync(accountId)
}

export async function destroySyncCoordinator(): Promise<void> {
  if (coordinator) {
    await coordinator.destroy()
    coordinator = undefined
  }
}

export async function requestStamp(params: {
  chunkHash: Uint8Array
  batchId: string
  signerKey: string
  depth: number
}): Promise<EnvelopeWithBatchId> {
  if (!coordinator) throw new Error("SyncCoordinator not initialized")
  return coordinator.requestStamp(params)
}

export async function flushCoordinatorStamper(batchId: string): Promise<void> {
  if (!coordinator) return
  return coordinator.flushStamper(batchId)
}
