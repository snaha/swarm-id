// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ParentToIframeMessage,
  IframeToParentMessage,
  ButtonStyles,
  ButtonConfig,
  RequestAuthMessage,
  UploadDataMessage,
  DownloadDataMessage,
  UploadFileMessage,
  DownloadFileMessage,
  UploadChunkMessage,
  DownloadChunkMessage,
  GetConnectionInfoMessage,
  IsConnectedMessage,
  GetNodeInfoMessage,
  GsocMineMessage,
  GsocSendMessage,
  SocUploadMessage,
  SocRawUploadMessage,
  SocDownloadMessage,
  SocRawDownloadMessage,
  SocGetOwnerMessage,
  EpochFeedDownloadReferenceMessage,
  EpochFeedUploadReferenceMessage,
  FeedGetOwnerMessage,
  SequentialFeedGetOwnerMessage,
  SequentialFeedDownloadPayloadMessage,
  SequentialFeedDownloadRawPayloadMessage,
  SequentialFeedDownloadReferenceMessage,
  SequentialFeedUploadPayloadMessage,
  SequentialFeedUploadRawPayloadMessage,
  SequentialFeedUploadReferenceMessage,
  ActUploadDataMessage,
  ActDownloadDataMessage,
  ActAddGranteesMessage,
  ActRevokeGranteesMessage,
  ActGetGranteesMessage,
  GetPostageBatchMessage,
  CreateFeedManifestMessage,
  AppMetadata,
  PostageStamp,
  PostageBatch,
  ConnectedApp,
} from "./types"
import {
  ParentToIframeMessageSchema,
  PopupToIframeMessageSchema,
  STORAGE_CHALLENGE_KEY,
} from "./types"
import type { PopupToIframeMessage } from "./types"
import {
  Bee,
  BatchId,
  EthAddress,
  PrivateKey,
  Identifier,
  Topic,
  MantarayNode,
  NULL_ADDRESS,
} from "@ethersphere/bee-js"
import {
  makeContentAddressedChunk,
  makeEncryptedContentAddressedChunk,
} from "./chunk"
import type { BeeRequestOptions } from "@ethersphere/bee-js"
import {
  uploadData,
  uploadSOC,
  uploadChunk,
  type UploadTarget,
} from "./proxy/upload"
import {
  downloadDataWithChunkAPI,
  downloadSOC,
  downloadEncryptedSOC,
} from "./proxy/download-data"
import type { UploadProgress } from "./proxy/types"
import { StampWorkerPool } from "./proxy/stamp-worker-pool"
import {
  loadMantarayTreeWithChunkAPI,
  saveMantarayTreeRecursively,
} from "./proxy/mantaray"
import { saveMantarayTreeRecursivelyEncrypted } from "./proxy/mantaray-encrypted"
import { createFeedManifestDirect } from "./proxy/feed-manifest"
import { UtilizationAwareStamper } from "./utils/batch-utilization"
import { UtilizationStoreDB } from "./storage/utilization-store"
import {
  createConnectedAppsStorageManager,
  createIdentitiesStorageManager,
  createPostageStampsStorageManager,
  createNetworkSettingsStorageManager,
  createAccountsStorageManager,
  disconnectApp,
} from "./utils/storage-managers"
import {
  hexToUint8Array,
  uint8ArrayToHex,
  deriveSwarmEncryptionKey,
} from "./utils/key-derivation"
import {
  createAsyncEpochFinder,
  createEpochUpdater,
  EpochIndex,
  MAX_LEVEL,
  AsyncEpochFinder,
} from "./proxy/feeds/epochs"
import { createAsyncSequentialFinder } from "./proxy/feeds/sequence"
import { Binary } from "cafe-utility"
import { calculateTTLSeconds, fetchSwarmPrice } from "./utils/ttl"
import { tryCreateTag } from "./utils/tag"
import { DEFAULT_BEE_NODE_URL, UtilizationUpdateMessageSchema } from "./schemas"
import { buildAuthUrl } from "./utils/url"
import {
  createActForContent,
  decryptActReference,
  addGranteesToAct,
  revokeGranteesFromAct,
  getGranteesFromAct,
  parseCompressedPublicKey,
  publicKeyFromPrivate,
  compressPublicKey,
  type ActUploadConfig,
} from "./proxy/act"

const DEFAULT_ACT_FILENAME = "index.bin"
const DEFAULT_ACT_CONTENT_TYPE = "application/octet-stream"
const SEQUENTIAL_INDEX_LOOKUP_TIMEOUT_MS = 2000

/**
 * Swarm ID Proxy - Runs inside the iframe
 *
 * Responsibilities:
 * - Receive app-specific secrets from auth popup
 * - Store secrets in partitioned localStorage
 * - Proxy Bee API calls from parent dApp
 * - Augment requests with authentication
 * - Return responses to parent dApp
 */
export class SwarmIdProxy {
  private parentOrigin: string | undefined
  private parentIdentified: boolean = false
  private authenticated: boolean = false
  private authLoading: boolean = true // Start in loading state
  private appSecret: string | undefined
  private postageBatchId: string | undefined
  private signerKey: string | undefined
  private stamper: UtilizationAwareStamper | undefined
  private stampWorkerPool: StampWorkerPool | undefined
  private stamperDepth: number = 23 // Default depth
  private storagePartitioned: boolean = false
  private pendingChallenge: string | undefined
  private storagePartitionedIdentity:
    | { id: string; name: string; address: string; publicKey?: string }
    | undefined
  private utilizationStore: UtilizationStoreDB | undefined
  private beeApiUrl: string
  private authButtonContainer: HTMLElement | undefined
  private currentStyles: ButtonStyles | undefined
  private buttonConfig: ButtonConfig | undefined
  private popupMode: "popup" | "window" = "window"
  private appMetadata: AppMetadata | undefined
  private bee: Bee
  private unsubscribeConnectedApps: (() => void) | undefined
  private isConnecting: boolean = false
  private parentWindow: WindowProxy | undefined
  private utilizationChannel: BroadcastChannel
  private subsidisedGatewayUrl: string | undefined

  constructor() {
    // Load Bee API URL from network settings, falling back to default
    const networkSettings = createNetworkSettingsStorageManager().load()
    this.beeApiUrl = networkSettings?.beeNodeUrl || DEFAULT_BEE_NODE_URL
    this.bee = new Bee(this.beeApiUrl)
    this.setupMessageListener()
    this.setupConnectedAppsListener()

    // Initialize multi-tab coordination via BroadcastChannel
    this.utilizationChannel = new BroadcastChannel("swarm-id-utilization")
    this.setupUtilizationListener()

    // Announce readiness to parent window immediately
    // This signals that our message listener is ready to receive parentIdentify
    this.announceReady()
  }

  /**
   * Subscribe to connected apps storage changes for direct mode authentication.
   * When a user completes authentication in the /connect popup (direct mode),
   * the popup writes to localStorage. This storage event notifies the proxy
   * to check for a new valid connection and send authSuccess to the parent.
   * Also handles disconnection when the connection is removed or invalidated.
   *
   * Note: We always set up this listener, even when storage might be partitioned.
   * In some browsers/configurations (like localhost development), storage events
   * work between same-origin windows even in iframes. If storage IS partitioned,
   * the listener simply won't fire, and we fall back to postMessage from the popup.
   */
  private setupConnectedAppsListener(): void {
    // Avoid duplicate subscriptions
    if (this.unsubscribeConnectedApps) {
      return
    }

    const connectedAppsManager = createConnectedAppsStorageManager()
    this.unsubscribeConnectedApps = connectedAppsManager.subscribe(
      (connectedApps) => {
        this.handleConnectedAppsChange(connectedApps)
      },
    )
  }

  /**
   * Handle changes to connected apps storage (triggered by storage events from other windows).
   * Handles new connections, identity changes, and disconnections.
   */
  private async handleConnectedAppsChange(
    connectedApps: ConnectedApp[],
  ): Promise<void> {
    if (!this.parentOrigin) {
      return
    }

    const connectedApp = this.findMostRecentConnection(connectedApps)

    if (connectedApp) {
      if (!this.authenticated) {
        // New connection
        await this.authenticateFromStorage(connectedApp)
      } else if (connectedApp.appSecret !== this.appSecret) {
        // Identity changed - update to new identity
        await this.authenticateFromStorage(connectedApp)
      }
      // If already authenticated with same secret, nothing to do
    } else if (this.authenticated && !this.storagePartitioned) {
      // No valid connection in storage, but we're authenticated - disconnect.
      // Skip when storage is partitioned: the iframe
      // can't see connected apps, but auth was established via postMessage.
      this.clearAuthData()
      this.sendToParent({
        type: "disconnectResponse",
        requestId: "storage-event",
        success: true,
      })
    }
  }

  /**
   * Authenticate using data from connected apps storage
   */
  private async authenticateFromStorage(
    connectedApp: ConnectedApp,
  ): Promise<void> {
    this.appSecret = connectedApp.appSecret
    this.authenticated = true
    this.storagePartitioned = false
    this.storagePartitionedIdentity = undefined
    this.authLoading = false
    this.isConnecting = false

    // Look up postage stamp
    const stamp = this.lookupPostageStampForApp()
    if (stamp) {
      this.postageBatchId = stamp.batchID.toHex()
      this.signerKey = stamp.signerKey.toHex()
      this.stamperDepth = stamp.depth
      await this.initializeStamper()
    }

    this.showAuthButton()
    this.sendToParent({
      type: "authSuccess",
      origin: this.parentOrigin!,
    })
  }

  /**
   * Handle messages from the auth popup (same-origin postMessage).
   * Used as storage partitioning fallback when storage events don't fire due to partitioning.
   */
  private async handlePopupMessage(
    message: PopupToIframeMessage,
  ): Promise<void> {
    if (message.type === "setSecret") {
      // Validate the appOrigin matches our parent
      if (message.appOrigin !== this.parentOrigin) {
        console.warn(
          "[Proxy] setSecret appOrigin mismatch:",
          message.appOrigin,
          "!==",
          this.parentOrigin,
        )
        return
      }

      // Verify challenge matches what we generated in openAuthPopup()
      if (
        !this.pendingChallenge ||
        message.challenge !== this.pendingChallenge
      ) {
        console.warn("[Proxy] setSecret challenge mismatch — ignoring")
        return
      }

      // Clean up challenge
      this.pendingChallenge = undefined
      localStorage.removeItem(STORAGE_CHALLENGE_KEY)

      // Authenticate in storage-partitioned mode (no stamps available via postMessage)
      this.appSecret = message.data.secret
      this.authenticated = true
      this.storagePartitioned = true
      this.authLoading = false
      this.isConnecting = false

      // Store identity info from message (can't read from partitioned localStorage)
      if (
        message.data.identityId &&
        message.data.identityName &&
        message.data.identityAddress
      ) {
        this.storagePartitionedIdentity = {
          id: message.data.identityId,
          name: message.data.identityName,
          address: message.data.identityAddress,
          publicKey: message.data.identityPublicKey,
        }
      }

      // No stamp lookup — localStorage is partitioned, stamps not accessible
      this.postageBatchId = undefined
      this.signerKey = undefined

      this.showAuthButton()
      this.sendToParent({
        type: "authSuccess",
        origin: this.parentOrigin!,
      })
    }
  }

  /**
   * Clean up resources when the proxy is destroyed.
   * Call this method when the proxy iframe is being unloaded.
   */
  destroy(): void {
    if (this.unsubscribeConnectedApps) {
      this.unsubscribeConnectedApps()
      this.unsubscribeConnectedApps = undefined
    }

    // Clean up utilization channel
    this.utilizationChannel.close()
  }

  /**
   * Setup listener for utilization updates from other tabs.
   * When another tab completes a write, it broadcasts an update.
   * This tab applies the delta update directly from the message.
   */
  private setupUtilizationListener(): void {
    this.utilizationChannel.onmessage = (event) => {
      try {
        const result = UtilizationUpdateMessageSchema.safeParse(event.data)
        if (
          result.success &&
          result.data.batchId === this.postageBatchId &&
          this.stamper
        ) {
          // Apply delta update directly - no IndexedDB read needed
          this.stamper.applyUtilizationUpdate(result.data.buckets)
        }
      } catch (error) {
        console.error("[Proxy] Failed to apply utilization update:", error)
      }
    }
  }

  /**
   * Execute a write operation with an exclusive lock across all tabs.
   * Uses Web Locks API to ensure only one write happens at a time.
   * Lock is scoped to the batch ID to allow different batches to write concurrently.
   */
  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockName = `swarm-write-${this.postageBatchId}`
    return navigator.locks.request(
      lockName,
      { mode: "exclusive" },
      async () => {
        try {
          return await operation()
        } finally {
        }
      },
    )
  }

  /**
   * Announce that proxy is ready to receive messages
   * Broadcasts to parent with wildcard origin since we don't know parent origin yet
   */
  private announceReady(): void {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(
        { type: "proxyInitialized" },
        "*", // Wildcard since we don't know parent origin yet
      )
    }
  }

  /**
   * Get the stored postage batch ID
   */
  getPostageBatchId(): string | undefined {
    return this.postageBatchId
  }

  /**
   * Get the stored signer key
   */
  getSignerKey(): string | undefined {
    return this.signerKey
  }

  /**
   * Initialize the Stamper for client-side signing
   * Uses UtilizationAwareStamper to track bucket usage
   */
  private async initializeStamper(): Promise<void> {
    if (!this.signerKey || !this.postageBatchId) {
      console.warn(
        "[Proxy] Cannot initialize stamper: missing signer key or batch ID",
      )
      return
    }

    // Look up account info for utilization tracking
    const accountInfo = await this.lookupAccountForApp()
    if (!accountInfo) {
      console.warn("[Proxy] Cannot initialize stamper: account not found")
      return
    }

    try {
      // Initialize utilization cache if not already done
      if (!this.utilizationStore) {
        this.utilizationStore = new UtilizationStoreDB()
      }

      // Create utilization-aware stamper with owner and encryption key
      // This enables proper utilization tracking and persistence
      this.stamper = await UtilizationAwareStamper.create(
        this.signerKey,
        new BatchId(this.postageBatchId),
        this.stamperDepth,
        this.utilizationStore,
        accountInfo.owner,
        accountInfo.encryptionKey,
      )
    } catch (error) {
      console.error("[Proxy] Failed to initialize stamper:", error)
      this.stamper = undefined
    }
  }

  /**
   * Get or create a StampWorkerPool for parallel signing.
   * Lazy-initialized on first use and reused across uploads.
   * If requestedCount differs from the current pool size, the pool is recreated.
   */
  private async getOrCreateWorkerPool(
    requestedCount?: number,
  ): Promise<StampWorkerPool | undefined> {
    const desiredCount =
      requestedCount ??
      (typeof navigator !== "undefined" && navigator.hardwareConcurrency
        ? Math.min(navigator.hardwareConcurrency, 8)
        : 4)

    if (this.stampWorkerPool && this.stampWorkerPool.size === desiredCount) {
      return this.stampWorkerPool
    }

    // Terminate old pool if count changed
    if (this.stampWorkerPool) {
      this.stampWorkerPool.terminate()
      this.stampWorkerPool = undefined
    }

    if (!this.signerKey || !this.stamper) return undefined

    try {
      this.stampWorkerPool = await StampWorkerPool.create(
        this.signerKey,
        this.stamper,
        desiredCount,
      )
      return this.stampWorkerPool
    } catch (error) {
      console.warn("[Proxy] Failed to create StampWorkerPool:", error)
      return undefined
    }
  }

  /**
   * Save stamper bucket state to IndexedDB
   * Utilization-aware stamper persists bucket state automatically
   */
  private async saveStamperState(): Promise<void> {
    if (!this.stamper) {
      return
    }

    try {
      // Capture bucket updates BEFORE flush clears dirtyBuckets
      const buckets = this.stamper.getBucketUpdatesForBroadcast()

      await this.stamper.flush()

      // Broadcast utilization update to other tabs with pre-captured buckets
      if (this.postageBatchId && buckets.length > 0) {
        this.utilizationChannel.postMessage({
          type: "utilization-updated",
          batchId: this.postageBatchId,
          buckets,
        })
      }
    } catch (error) {
      console.error("[Proxy] Failed to save stamper state:", error)
    }
  }

  /**
   * Build mode-appropriate upload target.
   * Encapsulates mode detection and validation logic.
   */
  private async getUploadTarget(options?: {
    useWorkers?: boolean
    workerCount?: number
  }): Promise<UploadTarget> {
    if (this.isSubsidisedModeActive()) {
      return {
        mode: "subsidised",
        gatewayUrl: this.subsidisedGatewayUrl!,
      }
    }

    // Validate user-stamp mode requirements
    if (!this.signerKey || !this.postageBatchId) {
      throw new Error(
        "Signer key and postage batch ID required. Please login first.",
      )
    }
    if (!this.stamper) {
      throw new Error("Stamper not initialized. Please login first.")
    }

    const workerPool = options?.useWorkers
      ? await this.getOrCreateWorkerPool(options.workerCount)
      : undefined

    return {
      mode: "stamper",
      bee: this.bee,
      stamper: this.stamper,
      workerPool,
    }
  }

  /**
   * Execute operation with write lock only in stamper mode.
   * In subsidised mode, skip locking (no local stamp state to protect).
   */
  private async withModeAwareWriteLock<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.isSubsidisedModeActive()) {
      return operation()
    }
    return this.withWriteLock(operation)
  }

  /**
   * Save stamper state only in stamper mode.
   * In subsidised mode, there's no local stamp state to persist.
   */
  private async saveStamperStateIfNeeded(): Promise<void> {
    if (!this.isSubsidisedModeActive()) {
      await this.saveStamperState()
    }
  }

  /**
   * Upload a manifest chunk with mode-appropriate stamping.
   * Used by handleUploadFile for manifest tree uploads.
   */
  private async uploadManifestChunk(
    target: UploadTarget,
    chunkData: Uint8Array,
    options?: { pin?: boolean; deferred?: boolean; tag?: number },
    requestOptions?: BeeRequestOptions,
  ): Promise<{ reference: string }> {
    const chunk = makeContentAddressedChunk(chunkData)

    await uploadChunk(target, chunk.data, {
      pin: options?.pin,
      deferred: options?.deferred,
      tag: options?.tag,
      requestOptions,
    })

    return { reference: chunk.address.toHex() }
  }

  /**
   * Setup message listener for parent and popup messages
   */
  private setupMessageListener(): void {
    window.addEventListener("message", async (event: MessageEvent) => {
      const { type } = event.data

      // Handle parent identification (must come first)
      if (type === "parentIdentify") {
        await this.handleParentIdentify(event)
        return
      }

      // All other messages require parent to be identified first
      if (!this.parentIdentified) {
        console.warn("[Proxy] Ignoring message - parent not identified yet")
        return
      }

      // Handle same-origin popup messages (storage partitioning postMessage fallback)
      if (event.origin === window.location.origin && type === "setSecret") {
        const popupResult = PopupToIframeMessageSchema.safeParse(event.data)
        if (popupResult.success) {
          await this.handlePopupMessage(popupResult.data)
          return
        }
      }

      // Validate origin - only accept messages from parent
      if (event.origin !== this.parentOrigin) {
        console.warn(
          "[Proxy] Rejected message from unauthorized origin:",
          event.origin,
        )
        return
      }

      // Handle setButtonStyles message (UI-only, not in schema)
      if (type === "setButtonStyles") {
        this.currentStyles = event.data.styles
        // Re-render button if not authenticated
        if (!this.authenticated && this.authButtonContainer) {
          this.showAuthButton()
        }
        return
      }

      let message: ParentToIframeMessage
      try {
        message = ParentToIframeMessageSchema.parse(event.data)
      } catch (error) {
        console.warn("[Proxy] Invalid parent message:", error)
        return
      }

      try {
        await this.handleParentMessage(message, event)
      } catch (error) {
        console.error("[Proxy] Error handling parent message:", error)
        this.sendErrorToParent(
          event,
          (message as { requestId?: string }).requestId,
          error instanceof Error ? error.message : "Unknown error",
        )
      }
    })
  }

  /**
   * Handle parent identification
   */
  private async handleParentIdentify(event: MessageEvent): Promise<void> {
    // Prevent parent from changing after first identification
    if (this.parentIdentified) {
      console.error("[Proxy] Parent already identified! Ignoring duplicate.")
      return
    }

    // Parse the message to get optional parameters
    const message = event.data
    const parentPopupMode = message.popupMode
    const parentMetadata = message.metadata
    const parentButtonConfig = message.buttonConfig

    // Trust event.origin - this is browser-enforced and cannot be spoofed
    this.parentOrigin = event.origin
    this.parentIdentified = true
    // Store reference to parent window for later postMessage calls
    if (event.source) {
      this.parentWindow = event.source as WindowProxy
    }

    // Use parent's popup mode if provided
    if (parentPopupMode) {
      this.popupMode = parentPopupMode
    }

    // Store metadata from parent
    if (parentMetadata) {
      this.appMetadata = parentMetadata
    }

    // Store button config from parent
    if (parentButtonConfig) {
      this.buttonConfig = parentButtonConfig
    }

    // Store subsidised gateway URL from parent
    const parentSubsidisedGatewayUrl = message.subsidisedGatewayUrl
    if (parentSubsidisedGatewayUrl) {
      this.subsidisedGatewayUrl = parentSubsidisedGatewayUrl
    }

    // Override: disable subsidised gateway when using custom Bee API URL
    if (this.beeApiUrl !== DEFAULT_BEE_NODE_URL && this.subsidisedGatewayUrl) {
      this.subsidisedGatewayUrl = undefined
    }

    // Load existing secret if available
    await this.loadAuthData()

    // Acknowledge receipt
    if (event.source) {
      ;(event.source as WindowProxy).postMessage(
        {
          type: "proxyReady",
          authenticated: this.authenticated,
          parentOrigin: this.parentOrigin,
        } satisfies IframeToParentMessage,
        { targetOrigin: event.origin },
      )
    }
  }

  /**
   * Handle messages from parent window
   */
  private async handleParentMessage(
    message: ParentToIframeMessage,
    event: MessageEvent,
  ): Promise<void> {
    switch (message.type) {
      case "parentIdentify":
        // Already handled above
        break

      case "checkAuth":
        this.handleCheckAuth(message, event)
        break

      case "disconnect":
        this.handleDisconnect(message, event)
        break

      case "requestAuth":
        this.handleRequestAuth(message, event)
        break

      case "uploadData":
        await this.handleUploadData(message, event)
        break

      case "downloadData":
        await this.handleDownloadData(message, event)
        break

      case "uploadFile":
        await this.handleUploadFile(message, event)
        break

      case "downloadFile":
        await this.handleDownloadFile(message, event)
        break

      case "uploadChunk":
        await this.handleUploadChunk(message, event)
        break

      case "downloadChunk":
        await this.handleDownloadChunk(message, event)
        break

      case "getConnectionInfo":
        this.handleGetConnectionInfo(message, event)
        break

      case "isConnected":
        await this.handleIsConnected(message, event)
        break

      case "getNodeInfo":
        await this.handleGetNodeInfo(message, event)
        break

      case "gsocMine":
        this.handleGsocMine(message, event)
        break

      case "gsocSend":
        await this.handleGsocSend(message, event)
        break
      case "socUpload":
        await this.handleSocUpload(message, event)
        break
      case "socRawUpload":
        await this.handleSocRawUpload(message, event)
        break
      case "socDownload":
        await this.handleSocDownload(message, event)
        break
      case "socRawDownload":
        await this.handleSocRawDownload(message, event)
        break
      case "socGetOwner":
        await this.handleSocGetOwner(message, event)
        break
      case "epochFeedDownloadReference":
        await this.handleEpochFeedDownloadReference(message, event)
        break
      case "epochFeedUploadReference":
        await this.handleEpochFeedUploadReference(message, event)
        break
      case "feedGetOwner":
        await this.handleFeedGetOwner(message, event)
        break
      case "seqFeedGetOwner":
        await this.handleSequentialFeedGetOwner(message, event)
        break
      case "seqFeedDownloadPayload":
        await this.handleSequentialFeedDownloadPayload(message, event)
        break
      case "seqFeedDownloadRawPayload":
        await this.handleSequentialFeedDownloadRawPayload(message, event)
        break
      case "seqFeedDownloadReference":
        await this.handleSequentialFeedDownloadReference(message, event)
        break
      case "seqFeedUploadPayload":
        await this.handleSequentialFeedUploadPayload(message, event)
        break
      case "seqFeedUploadRawPayload":
        await this.handleSequentialFeedUploadRawPayload(message, event)
        break
      case "seqFeedUploadReference":
        await this.handleSequentialFeedUploadReference(message, event)
        break

      case "actUploadData":
        await this.handleActUploadData(message, event)
        break

      case "actDownloadData":
        await this.handleActDownloadData(message, event)
        break

      case "actAddGrantees":
        await this.handleActAddGrantees(message, event)
        break

      case "actRevokeGrantees":
        await this.handleActRevokeGrantees(message, event)
        break

      case "actGetGrantees":
        await this.handleActGetGrantees(message, event)
        break

      case "getPostageBatch":
        await this.handleGetPostageBatch(message, event)
        break

      case "createFeedManifest":
        await this.handleCreateFeedManifest(message, event)
        break

      case "connect":
        this.handleConnect(message, event)
        break

      default:
        // TypeScript should ensure this is never reached
        const exhaustiveCheck: never = message
        console.warn("[Proxy] Unhandled message type:", exhaustiveCheck)
    }
  }

  /**
   * Load authentication data from shared storage (ConnectedApp records).
   */
  private async loadAuthData(): Promise<void> {
    if (!this.parentOrigin) {
      this.authLoading = false
      return
    }

    const sharedData = this.lookupAppSecretFromSharedStorage()

    if (sharedData) {
      this.appSecret = sharedData.secret
      this.authenticated = true
      this.authLoading = false
      this.showAuthButton()

      // Look up postage stamp from shared storage based on connected identity
      const stamp = this.lookupPostageStampForApp()
      if (stamp) {
        this.postageBatchId = stamp.batchID.toHex()
        this.signerKey = stamp.signerKey.toHex()
        this.stamperDepth = stamp.depth
        await this.initializeStamper()
      } else {
        this.postageBatchId = undefined
        this.signerKey = undefined
      }
    } else {
      this.authLoading = false
      this.showAuthButton()
    }
  }

  /**
   * Look up the postage stamp for the currently connected app's identity
   * by reading from shared localStorage stores.
   */
  private lookupPostageStampForApp(): PostageStamp | undefined {
    if (!this.parentOrigin) {
      return undefined
    }

    try {
      // Load connected apps to find which identity is connected to this app
      const connectedAppsManager = createConnectedAppsStorageManager()
      const connectedApps = connectedAppsManager.load()
      const connectedApp = this.findMostRecentConnection(connectedApps)

      if (!connectedApp) {
        return undefined
      }

      // Load identities to find the account for this identity
      const identitiesManager = createIdentitiesStorageManager()
      const identities = identitiesManager.load()
      const identity = identities.find((i) => i.id === connectedApp.identityId)

      if (!identity) {
        return undefined
      }

      // Load postage stamps and find one for this account
      const postageStampsManager = createPostageStampsStorageManager()
      const stamps = postageStampsManager.load()

      // First try identity's default stamp, then fall back to any account stamp
      let stamp: PostageStamp | undefined
      if (identity.defaultPostageStampBatchID) {
        stamp = stamps.find((s) =>
          s.batchID.equals(identity.defaultPostageStampBatchID!),
        )
      }

      if (!stamp) {
        stamp = stamps.find((s) => s.accountId === identity.accountId.toHex())
      }

      if (stamp) {
      }

      return stamp
    } catch (error) {
      console.error("[Proxy] Error looking up postage stamp:", error)
      return undefined
    }
  }

  /**
   * Look up the account for the currently connected app's identity
   * by reading from shared localStorage stores.
   *
   * @returns Account info with owner address and encryption key, or undefined if not found
   */
  private async lookupAccountForApp(): Promise<
    { owner: EthAddress; encryptionKey: Uint8Array } | undefined
  > {
    if (!this.parentOrigin) {
      return undefined
    }

    try {
      // Load connected apps to find which identity is connected to this app
      const connectedAppsManager = createConnectedAppsStorageManager()
      const connectedApps = connectedAppsManager.load()
      const connectedApp = this.findMostRecentConnection(connectedApps)

      if (!connectedApp) {
        return undefined
      }

      // Load identities to find the account for this identity
      const identitiesManager = createIdentitiesStorageManager()
      const identities = identitiesManager.load()
      const identity = identities.find((i) => i.id === connectedApp.identityId)

      if (!identity) {
        return undefined
      }

      // Load accounts and find the one for this identity
      const accountsManager = createAccountsStorageManager()
      const accounts = accountsManager.load()
      const account = accounts.find((a) => a.id.equals(identity.accountId))

      if (!account) {
        return undefined
      }

      // Derive swarm encryption key from stored derivation key
      const swarmEncryptionKey = await deriveSwarmEncryptionKey(
        account.derivationKey,
      )

      return {
        owner: account.id,
        encryptionKey: hexToUint8Array(swarmEncryptionKey),
      }
    } catch (error) {
      console.error("[Proxy] Error looking up account:", error)
      return undefined
    }
  }

  /**
   * Check if a connection is still valid based on connectedUntil timestamp
   */
  private isConnectionValid(connectedApp: ConnectedApp): boolean {
    if (!connectedApp.connectedUntil) return false
    return connectedApp.connectedUntil > Date.now()
  }

  /**
   * Find the most recently connected valid entry for the current parent origin.
   * Resolves ambiguity when multiple identities are connected to the same app
   * by sorting by lastConnectedAt descending and returning the first valid one.
   */
  private findMostRecentConnection(
    connectedApps: ConnectedApp[],
  ): ConnectedApp | undefined {
    return connectedApps
      .filter(
        (app) =>
          app.appUrl === this.parentOrigin && this.isConnectionValid(app),
      )
      .sort((a, b) => b.lastConnectedAt - a.lastConnectedAt)[0]
  }

  /**
   * Look up the app secret from shared storage for the current parent origin.
   * Returns the secret and identityId if found and connection is valid.
   */
  private lookupAppSecretFromSharedStorage():
    | { secret: string; identityId: string }
    | undefined {
    if (!this.parentOrigin) {
      return undefined
    }

    try {
      const connectedAppsManager = createConnectedAppsStorageManager()
      const connectedApps = connectedAppsManager.load()
      const connectedApp = this.findMostRecentConnection(connectedApps)

      if (!connectedApp) {
        return undefined
      }

      if (!connectedApp.appSecret) {
        return undefined
      }

      return {
        secret: connectedApp.appSecret,
        identityId: connectedApp.identityId,
      }
    } catch (error) {
      console.error(
        "[Proxy] Error looking up app secret from shared storage:",
        error,
      )
      return undefined
    }
  }

  /**
   * Clear authentication data
   */
  private clearAuthData(): void {
    if (!this.parentOrigin) {
      return
    }

    // Clear stamper state from localStorage
    const stamperKey = `swarm-stamper-${this.parentOrigin}-${this.postageBatchId}`
    localStorage.removeItem(stamperKey)

    // Invalidate connected app entries in shared storage so reconnect doesn't happen on refresh
    try {
      disconnectApp(this.parentOrigin)
    } catch (error) {
      console.error(
        "[Proxy] Error invalidating connected app in shared storage:",
        error,
      )
    }

    // Reset auth state
    this.authenticated = false
    this.authLoading = false
    this.appSecret = undefined
    this.postageBatchId = undefined
    this.signerKey = undefined
    this.stamper = undefined
    this.storagePartitioned = false
    this.storagePartitionedIdentity = undefined
    this.pendingChallenge = undefined

    // Show login button
    this.showAuthButton()
  }

  /**
   * Send error message to parent
   */
  private sendErrorToParent(
    event: MessageEvent,
    requestId: string | undefined,
    error: string,
  ): void {
    if (event.source && requestId) {
      ;(event.source as WindowProxy).postMessage(
        {
          type: "error",
          requestId,
          error,
        } satisfies IframeToParentMessage,
        { targetOrigin: event.origin },
      )
    }
  }

  private ensureCanUpload(): void {
    // Allow uploads if subsidised mode is active (gateway handles stamping)
    if (this.isSubsidisedModeActive()) {
      return
    }
    if (this.storagePartitioned) {
      throw new Error(
        "Uploads are unavailable in download-only mode due to browser storage partitioning.",
      )
    }
  }

  /**
   * Check if subsidised upload mode is active.
   * Subsidised mode is active when:
   * - User has no postage stamp OR no signer key, OR storage is partitioned
   *   (can't access stamp when partitioned)
   * - AND a subsidised gateway URL is configured
   */
  private isSubsidisedModeActive(): boolean {
    return (
      (!this.postageBatchId || !this.signerKey || this.storagePartitioned) &&
      !!this.subsidisedGatewayUrl
    )
  }

  /**
   * Send message to parent
   */
  private sendToParent(message: IframeToParentMessage): void {
    if (!this.parentOrigin || !this.parentWindow) {
      console.warn(
        "[Proxy] Cannot send message to parent - no parent window reference",
      )
      return
    }

    this.parentWindow.postMessage(message, this.parentOrigin)
  }

  // ============================================================================
  // Message Handlers
  // ============================================================================

  private handleCheckAuth(
    message: { type: "checkAuth"; requestId: string },
    event: MessageEvent,
  ): void {
    if (event.source) {
      ;(event.source as WindowProxy).postMessage(
        {
          type: "authStatusResponse",
          requestId: message.requestId,
          authenticated: this.authenticated,
          origin: this.authenticated ? this.parentOrigin : undefined,
          beeApiUrl: this.beeApiUrl,
        } satisfies IframeToParentMessage,
        { targetOrigin: event.origin },
      )
    }
  }

  private handleGetConnectionInfo(
    message: GetConnectionInfoMessage,
    event: MessageEvent,
  ): void {
    let identity:
      | { id: string; name: string; address: string; publicKey?: string }
      | undefined = undefined

    // Look up identity info if authenticated
    if (this.authenticated && this.parentOrigin) {
      if (this.storagePartitioned && this.storagePartitionedIdentity) {
        // Storage is partitioned, use identity info from the setSecret message
        // (localStorage is partitioned, can't read connected apps)
        identity = this.storagePartitionedIdentity
      } else {
        try {
          const connectedAppsManager = createConnectedAppsStorageManager()
          const connectedApps = connectedAppsManager.load()
          const connectedApp = this.findMostRecentConnection(connectedApps)

          if (connectedApp) {
            const identitiesManager = createIdentitiesStorageManager()
            const identities = identitiesManager.load()
            const foundIdentity = identities.find(
              (i) => i.id === connectedApp.identityId,
            )

            if (foundIdentity) {
              identity = {
                id: foundIdentity.id,
                name: foundIdentity.name,
                address: foundIdentity.id,
                publicKey: foundIdentity.publicKey,
              }
            }
          }
        } catch (error) {
          console.error("[Proxy] Error looking up identity:", error)
        }
      }
    }

    // Derive app-specific key from appSecret when authenticated
    let appKey: { address: string; publicKey: string } | undefined = undefined

    if (this.authenticated && this.appSecret) {
      const privKeyBytes = hexToUint8Array(this.appSecret)
      const { x, y } = publicKeyFromPrivate(privKeyBytes)
      const compressed = compressPublicKey(x, y)
      appKey = {
        address: new PrivateKey(this.appSecret).publicKey().address().toHex(),
        publicKey: uint8ArrayToHex(compressed),
      }
    }

    // Determine upload mode
    // User-stamp mode only available when storage is NOT partitioned (can access stamp)
    // Subsidised mode takes precedence when storage is partitioned (can't access stamp)
    let uploadMode: "user-stamp" | "subsidised" | "unavailable" = "unavailable"
    if (this.postageBatchId && this.signerKey && !this.storagePartitioned) {
      uploadMode = "user-stamp"
    } else if (this.subsidisedGatewayUrl) {
      uploadMode = "subsidised"
    }

    // canUpload is true if user has stamps, or subsidised gateway is configured
    const canUpload = uploadMode !== "unavailable"

    if (event.source) {
      ;(event.source as WindowProxy).postMessage(
        {
          type: "connectionInfoResponse",
          requestId: message.requestId,
          canUpload,
          storagePartitioned: this.storagePartitioned || undefined,
          uploadMode,
          identity,
          appKey,
        } satisfies IframeToParentMessage,
        { targetOrigin: event.origin },
      )
    }
  }

  private async handleIsConnected(
    message: IsConnectedMessage,
    event: MessageEvent,
  ): Promise<void> {
    const connected = await this.bee.isConnected()

    if (event.source) {
      ;(event.source as WindowProxy).postMessage(
        {
          type: "isConnectedResponse",
          requestId: message.requestId,
          connected,
        } satisfies IframeToParentMessage,
        { targetOrigin: event.origin },
      )
    }
  }

  private async handleGetNodeInfo(
    message: GetNodeInfoMessage,
    event: MessageEvent,
  ): Promise<void> {
    try {
      const nodeInfo = await this.bee.getNodeInfo()

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "getNodeInfoResponse",
            requestId: message.requestId,
            beeMode: nodeInfo.beeMode,
            chequebookEnabled: nodeInfo.chequebookEnabled,
            swapEnabled: nodeInfo.swapEnabled,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        message.requestId,
        error instanceof Error ? error.message : "Failed to get node info",
      )
    }
  }

  private handleDisconnect(
    message: { type: "disconnect"; requestId: string },
    event: MessageEvent,
  ): void {
    // Clear auth data
    this.clearAuthData()

    // Send response
    if (event.source) {
      ;(event.source as WindowProxy).postMessage(
        {
          type: "disconnectResponse",
          requestId: message.requestId,
          success: true,
        } satisfies IframeToParentMessage,
        { targetOrigin: event.origin },
      )
    }
  }

  private handleRequestAuth(
    message: RequestAuthMessage,
    _event: MessageEvent,
  ): void {
    // Store styles for button creation
    this.currentStyles = message.styles

    // If container is set, show the button
    if (this.authButtonContainer) {
      this.showAuthButton()
    }
  }

  /**
   * Show authentication button in the UI
   */
  private showAuthButton(): void {
    if (!this.authButtonContainer || this.isConnecting) {
      return
    }

    // Clear existing content
    this.authButtonContainer.innerHTML = ""

    // Create button based on authentication status
    const button = document.createElement("button")
    const isAuthenticated = this.authenticated
    const isLoading = this.authLoading

    // Get text from buttonConfig or use defaults
    const config = this.buttonConfig || {}
    const loadingText = config.loadingText || "⏳ Loading..."
    const disconnectText =
      config.disconnectText || "🔓 Disconnect from Swarm ID"
    const connectText = config.connectText || "🔐 Login with Swarm ID"

    if (isLoading) {
      button.textContent = loadingText
      button.disabled = true
    } else if (isAuthenticated) {
      button.textContent = disconnectText
    } else {
      button.textContent = connectText
    }

    // Apply styles from currentStyles (for backward compat) and buttonConfig
    const styles = this.currentStyles || {}

    // Make button fill container
    button.style.width = "100%"
    button.style.height = "100%"
    button.style.display = "flex"
    button.style.alignItems = "center"
    button.style.justifyContent = "center"

    if (isLoading) {
      button.style.backgroundColor = "#999"
      button.style.cursor = "default"
    } else if (isAuthenticated) {
      // Different color for disconnect button (use default gray unless overridden)
      button.style.backgroundColor = "#666"
      button.style.cursor = styles.cursor || "pointer"
    } else {
      // Use buttonConfig colors, then fall back to currentStyles, then defaults
      button.style.backgroundColor =
        config.backgroundColor || styles.backgroundColor || "#dd7200"
      button.style.cursor = styles.cursor || "pointer"
    }
    button.style.color = config.color || styles.color || "white"
    button.style.border = styles.border || "none"
    button.style.borderRadius =
      config.borderRadius || styles.borderRadius || "0"
    button.style.padding = styles.padding || "0"
    button.style.fontSize = styles.fontSize || "14px"
    button.style.fontWeight = styles.fontWeight || "600"

    // Click handler
    button.addEventListener("click", () => {
      if (isAuthenticated) {
        // Handle disconnect
        this.handleDisconnectClick()
      } else {
        // Handle login
        this.handleLoginClick(button)
      }
    })

    this.authButtonContainer.appendChild(button)
  }

  private handleConnect(
    message: {
      type: "connect"
      requestId: string
      agent?: boolean
      popupMode?: "popup" | "window"
    },
    event: MessageEvent,
  ): void {
    const success = this.openAuthPopup({
      agent: message.agent,
      popupMode: message.popupMode,
    })
    ;(event.source as WindowProxy).postMessage(
      {
        type: "connectResponse",
        requestId: message.requestId,
        success,
      },
      { targetOrigin: event.origin },
    )
  }

  /**
   * Open the authentication popup window.
   * Returns true if popup was opened, false if parent origin is not set.
   */
  private openAuthPopup(options?: {
    agent?: boolean
    popupMode?: "popup" | "window"
  }): boolean {
    if (!this.parentOrigin) {
      console.error("[Proxy] Cannot open auth window - parent origin not set")
      return false
    }

    // Build authentication URL using shared utility
    // challenge: used for storage partitioning detection — popup checks if it can read this from localStorage
    const challenge = crypto.randomUUID()
    this.pendingChallenge = challenge
    localStorage.setItem(STORAGE_CHALLENGE_KEY, challenge)

    // Get base path from current location (e.g., /id/pr-140/proxy -> /id/pr-140)
    const basePath = window.location.pathname.replace(/\/proxy$/, "")
    const authUrl = buildAuthUrl(
      window.location.origin + basePath,
      this.parentOrigin,
      this.appMetadata,
      { challenge, agent: options?.agent },
    )

    // Open as popup or full window based on popupMode (per-call override takes precedence)
    const effectivePopupMode = options?.popupMode ?? this.popupMode
    let popup: Window | null = null
    if (effectivePopupMode === "popup") {
      popup = window.open(authUrl, "_blank", "width=500,height=600")
    } else {
      popup = window.open(authUrl, "_blank")
    }

    // Check if popup was blocked (common on mobile Safari)
    if (!popup) {
      console.warn("[Proxy] Popup was blocked or failed to open")
      this.isConnecting = false
      this.showAuthButton()
      return false
    }

    // Monitor popup closure to handle user closing without completing auth
    // Note: We delay the start of monitoring because on Safari, popup.closed can
    // return true immediately for new tabs before they're fully initialized
    const POPUP_MONITOR_START_DELAY_MS = 2000
    const POPUP_CLOSE_CHECK_INTERVAL_MS = 500
    const POPUP_MONITOR_TIMEOUT_MS = 300000 // 5 minutes

    setTimeout(() => {
      const checkPopupClosed = setInterval(() => {
        if (popup?.closed) {
          clearInterval(checkPopupClosed)
          // Only process if we're still in connecting state (auth didn't complete via storage event)
          if (this.isConnecting && !this.authenticated) {
            this.isConnecting = false
            this.showAuthButton()
          }
        }
      }, POPUP_CLOSE_CHECK_INTERVAL_MS)

      // Clear interval to prevent memory leak
      setTimeout(() => {
        clearInterval(checkPopupClosed)
      }, POPUP_MONITOR_TIMEOUT_MS)
    }, POPUP_MONITOR_START_DELAY_MS)

    return true
  }

  /**
   * Handle login button click
   */
  private handleLoginClick(button: HTMLButtonElement): void {
    this.isConnecting = true
    // Disable button and show spinner
    button.disabled = true
    button.innerHTML =
      '<span style="display: inline-block; width: 16px; height: 16px; border: 2px solid rgba(255,255,255,.3); border-radius: 50%; border-top-color: white; animation: spin 1s linear infinite;"></span>'

    // Add spinner animation
    if (!document.getElementById("swarm-id-spinner-style")) {
      const style = document.createElement("style")
      style.id = "swarm-id-spinner-style"
      style.textContent =
        "@keyframes spin { to { transform: rotate(360deg); } }"
      document.head.appendChild(style)
    }

    // Open auth popup
    this.openAuthPopup()
  }

  /**
   * Handle disconnect button click
   */
  private handleDisconnectClick(): void {
    // Clear auth data
    this.clearAuthData()

    // Notify parent about auth status change
    this.sendToParent({
      type: "authStatusResponse",
      requestId: "disconnect",
      authenticated: false,
      origin: undefined,
    })
  }

  /**
   * Set container element for auth button
   */
  setAuthButtonContainer(container: HTMLElement): void {
    this.authButtonContainer = container
    // Show button now that container is available
    // (loadAuthData may have already run and set authenticated status)
    this.showAuthButton()
  }

  private async handleUploadData(
    message: UploadDataMessage,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      data,
      options,
      requestOptions,
      enableProgress,
      useWebSocket,
      useWorkers,
      workerCount,
      concurrency,
    } = message

    try {
      if (!this.authenticated || !this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }
      this.ensureCanUpload()

      // Get mode-appropriate upload target
      const target = await this.getUploadTarget({ useWorkers, workerCount })

      // Create progress callback if enabled (works in both modes)
      const onProgress = enableProgress
        ? (progress: UploadProgress) => {
            if (event.source) {
              ;(event.source as WindowProxy).postMessage(
                {
                  type: "uploadProgress",
                  requestId,
                  total: progress.total,
                  processed: progress.processed,
                } satisfies IframeToParentMessage,
                { targetOrigin: event.origin },
              )
            }
          }
        : undefined

      // Execute upload with mode-aware locking
      const uploadResult = await this.withModeAwareWriteLock(async () => {
        const result = await uploadData(target, data, {
          encryptionKey: options?.encrypt ? true : undefined,
          pin: options?.pin,
          deferred: options?.deferred,
          tag: options?.tag,
          webSocket: useWebSocket ? { concurrency } : undefined,
          httpConcurrency: concurrency,
          onProgress,
          requestOptions,
        })
        await this.saveStamperStateIfNeeded()
        return result
      })

      // Send response
      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "uploadDataResponse",
            requestId,
            reference: uploadResult.reference,
            tagUid: uploadResult.tagUid,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "Upload failed",
      )
    }
  }

  private async handleDownloadData(
    message: DownloadDataMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, reference, options, requestOptions } = message

    if (!this.authenticated || !this.appSecret) {
      throw new Error("Not authenticated. Please login first.")
    }

    try {
      // Download data using chunk API only (supports both regular and encrypted references)
      const data = await downloadDataWithChunkAPI(
        this.bee,
        reference,
        options,
        undefined,
        requestOptions,
      )

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "downloadDataResponse",
            requestId,
            data: data as Uint8Array,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "Download failed",
      )
    }
  }

  private async handleUploadFile(
    message: UploadFileMessage,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      data,
      name,
      options,
      requestOptions,
      enableProgress,
      useWebSocket,
      useWorkers,
      workerCount,
      concurrency,
    } = message
    const fileName = name || "index.bin"

    try {
      if (!this.authenticated || !this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }
      this.ensureCanUpload()

      // Get mode-appropriate upload target
      const target = await this.getUploadTarget({ useWorkers, workerCount })

      // Create progress callback if enabled
      const onProgress = enableProgress
        ? (progress: UploadProgress) => {
            if (event.source) {
              ;(event.source as WindowProxy).postMessage(
                {
                  type: "uploadProgress",
                  requestId,
                  total: progress.total,
                  processed: progress.processed,
                } satisfies IframeToParentMessage,
                { targetOrigin: event.origin },
              )
            }
          }
        : undefined

      // Execute upload with mode-aware locking
      const manifestResult = await this.withModeAwareWriteLock(async () => {
        // Create or use provided tag for the entire upload operation
        const uploadTag = options?.tag ?? (await tryCreateTag(this.bee))

        // Step 1: Upload file content
        // Encrypted by default (unless encrypt=false) - encryption is client-side
        const shouldEncryptContent = options?.encrypt !== false

        const contentUpload = await uploadData(target, data, {
          encryptionKey: shouldEncryptContent ? true : undefined,
          pin: options?.pin,
          deferred: options?.deferred,
          tag: uploadTag,
          webSocket: useWebSocket ? { concurrency } : undefined,
          httpConcurrency: concurrency,
          onProgress,
          requestOptions,
        })

        // Step 2: Build manifest
        const manifest = new MantarayNode()
        const contentReferenceBytes = hexToUint8Array(contentUpload.reference)

        manifest.addFork(fileName, contentReferenceBytes, {
          "Content-Type": "application/octet-stream",
          Filename: fileName,
        })
        manifest.addFork("/", NULL_ADDRESS, {
          "website-index-document": fileName,
        })

        // Step 3: Upload manifest tree
        let result: { rootReference: string; tagUid?: number }

        const shouldEncryptManifest = options?.encryptManifest === true

        if (shouldEncryptManifest) {
          result = await saveMantarayTreeRecursivelyEncrypted(
            manifest,
            async (encryptedData, _address, isRoot) => {
              await uploadChunk(target, encryptedData, {
                pin: options?.pin,
                deferred: options?.deferred,
                tag: uploadTag,
                requestOptions,
              })
              return {
                tagUid: isRoot ? uploadTag : undefined,
              }
            },
          )
        } else {
          // Use uploadManifestChunk helper for non-encrypted manifest
          result = await saveMantarayTreeRecursively(
            manifest,
            async (nodeData) => {
              const uploadResult = await this.uploadManifestChunk(
                target,
                nodeData,
                { ...options, tag: uploadTag },
                requestOptions,
              )
              return { reference: uploadResult.reference }
            },
          )
          if (uploadTag !== undefined) {
            result = { ...result, tagUid: uploadTag }
          }
        }

        await this.saveStamperStateIfNeeded()
        return result
      })

      // Send response
      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "uploadFileResponse",
            requestId,
            reference: manifestResult.rootReference,
            tagUid: manifestResult.tagUid,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "Upload failed",
      )
    }
  }

  private async handleDownloadFile(
    message: DownloadFileMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, reference, path, options, requestOptions } = message

    if (!this.authenticated || !this.appSecret) {
      throw new Error("Not authenticated. Please login first.")
    }

    try {
      // Always load the manifest first - file uploads create manifests
      const manifest = await loadMantarayTreeWithChunkAPI(
        this.bee,
        reference,
        requestOptions,
      )

      let targetPath: string
      if (path) {
        // Use provided path
        targetPath = path
      } else {
        // No path: get index document from manifest metadata
        const { indexDocument } = manifest.getDocsMetadata()
        if (!indexDocument) {
          throw new Error(
            "Manifest does not contain an index document reference",
          )
        }
        targetPath = indexDocument
      }

      // Find the content node at the target path
      const contentNode = manifest.find(targetPath)
      if (!contentNode) {
        throw new Error(`Path not found in manifest: ${targetPath}`)
      }
      if (!contentNode.targetAddress) {
        throw new Error(`Path "${targetPath}" does not have a target address`)
      }

      // Get filename from metadata or use the path
      const name =
        contentNode.metadata?.["Filename"] ||
        targetPath.split("/").pop() ||
        "file"

      // Download actual content from the target address
      const targetRef = uint8ArrayToHex(contentNode.targetAddress)

      const data = await downloadDataWithChunkAPI(
        this.bee,
        targetRef,
        options,
        undefined,
        requestOptions,
      )

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "downloadFileResponse",
            requestId,
            name,
            data,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "Download failed",
      )
    }
  }

  private async handleUploadChunk(
    message: UploadChunkMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, data, options, requestOptions } = message

    try {
      if (!this.authenticated || !this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }

      this.ensureCanUpload()

      // Validate chunk size (must be between 1 and 4096 bytes)
      if (data.length < 1 || data.length > 4096) {
        throw new Error(
          `Invalid chunk size: ${data.length} bytes. Chunks must be between 1 and 4096 bytes.`,
        )
      }

      // Handle subsidised gateway mode - gateway handles stamping server-side
      if (this.isSubsidisedModeActive()) {
        // Create content-addressed chunk to get the reference
        const chunk = makeContentAddressedChunk(data)

        const subsidisedTarget: UploadTarget = {
          mode: "subsidised",
          gatewayUrl: this.subsidisedGatewayUrl!,
        }

        // Upload chunk directly via /chunks endpoint - gateway stamps it
        await uploadChunk(subsidisedTarget, chunk.data, {
          pin: options?.pin,
          deferred: options?.deferred,
        })

        if (event.source) {
          ;(event.source as WindowProxy).postMessage(
            {
              type: "uploadChunkResponse",
              requestId,
              reference: chunk.address.toHex(),
            } satisfies IframeToParentMessage,
            { targetOrigin: event.origin },
          )
        }
        return
      }

      // User stamp mode - validate stamp and signer are available
      if (!this.signerKey || !this.postageBatchId) {
        throw new Error(
          "Signer key and postage batch ID required. Please authenticate.",
        )
      }

      if (!this.stamper) {
        await this.initializeStamper()
      }

      if (!this.stamper) {
        throw new Error("Failed to initialize stamper for signing")
      }

      // Serialize write through Web Locks API to prevent concurrent uploads
      const uploadResult = await this.withWriteLock(async () => {
        // Create content-addressed chunk
        const chunk = makeContentAddressedChunk(data)

        // Create adapter for cafe-utility Chunk interface
        const chunkAdapter = {
          hash: () => chunk.address.toUint8Array(),
          build: () => chunk.data,
          span: 0n, // not used by stamper.stamp
          writer: undefined as any, // not used by stamper.stamp
        }

        // Sign the chunk to create envelope
        const envelope = this.stamper!.stamp(chunkAdapter)

        // Create a tag if not provided (required for dev mode)
        const tag = options?.tag ?? (await tryCreateTag(this.bee))

        // Use non-deferred mode for faster uploads (returns immediately)
        const uploadOptions = { ...options, tag, deferred: false }

        // Upload with envelope signature
        const result = await this.bee.uploadChunk(
          envelope,
          chunk.data,
          uploadOptions,
          requestOptions,
        )

        // Save stamper state after successful upload
        await this.saveStamperState()

        return result
      })

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "uploadChunkResponse",
            requestId,
            reference: uploadResult.reference.toHex(),
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "Upload failed",
      )
    }
  }

  private async handleDownloadChunk(
    message: DownloadChunkMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, reference, options, requestOptions } = message

    if (!this.authenticated || !this.appSecret) {
      throw new Error("Not authenticated. Please login first.")
    }

    try {
      // Download chunk using bee-js (returns Uint8Array directly)
      const data = await this.bee.downloadChunk(
        reference,
        options,
        requestOptions,
      )

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "downloadChunkResponse",
            requestId,
            data: data as Uint8Array,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "Download failed",
      )
    }
  }

  private handleGsocMine(message: GsocMineMessage, event: MessageEvent): void {
    const { requestId, targetOverlay, identifier, proximity } = message

    try {
      const signer = this.bee.gsocMine(targetOverlay, identifier, proximity)

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "gsocMineResponse",
            requestId,
            signer: signer.toHex(),
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "GSOC mine failed",
      )
    }
  }

  private async handleGsocSend(
    message: GsocSendMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, signer, identifier, data, options } = message

    try {
      if (!this.authenticated || !this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }

      this.ensureCanUpload()

      const signerKey = new PrivateKey(signer)
      const id = new Identifier(identifier)

      // Handle subsidised gateway mode - gateway handles stamping server-side
      if (this.isSubsidisedModeActive()) {
        const subsidisedTarget: UploadTarget = {
          mode: "subsidised",
          gatewayUrl: this.subsidisedGatewayUrl!,
        }

        const result = await uploadSOC(subsidisedTarget, signerKey, id, data, {
          pin: options?.pin,
          deferred: options?.deferred,
        })

        if (event.source) {
          ;(event.source as WindowProxy).postMessage(
            {
              type: "gsocSendResponse",
              requestId,
              reference: uint8ArrayToHex(result.socAddress),
              tagUid: result.tagUid,
            } satisfies IframeToParentMessage,
            { targetOrigin: event.origin },
          )
        }
        return
      }

      // User stamp mode - validate stamp and stamper
      if (!this.postageBatchId || !this.stamper) {
        throw new Error(
          "Postage batch ID and stamper required. Please login first.",
        )
      }

      // Serialize write through Web Locks API to prevent concurrent uploads
      // Use client-side SOC upload (same as handleSocRawUpload) to work with gateways
      const result = await this.withWriteLock(async () => {
        const stamperTarget: UploadTarget = {
          mode: "stamper",
          bee: this.bee,
          stamper: this.stamper!,
        }

        const uploadResult = await uploadSOC(
          stamperTarget,
          signerKey,
          id,
          data,
          {
            pin: options?.pin,
            deferred: options?.deferred,
            tag: options?.tag,
          },
        )

        await this.saveStamperState()

        return uploadResult
      })

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "gsocSendResponse",
            requestId,
            reference: uint8ArrayToHex(result.socAddress),
            tagUid: result.tagUid,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "GSOC send failed",
      )
    }
  }

  // ============================================================================
  // SOC (Single Owner Chunk) Handlers
  // ============================================================================

  private async handleSocUpload(
    message: SocUploadMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, identifier, data, signer, options } = message

    try {
      if (!this.authenticated || !this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }

      this.ensureCanUpload()

      const signerKey = signer ?? this.appSecret
      const signerKeyObj = new PrivateKey(signerKey)
      const id = new Identifier(identifier)

      // Handle subsidised gateway mode - gateway handles stamping server-side
      if (this.isSubsidisedModeActive()) {
        const subsidisedTarget: UploadTarget = {
          mode: "subsidised",
          gatewayUrl: this.subsidisedGatewayUrl!,
        }

        // Upload encrypted SOC with auto-generated key
        const result = await uploadSOC(
          subsidisedTarget,
          signerKeyObj,
          id,
          data,
          {
            encryptionKey: true,
            pin: options?.pin,
            deferred: options?.deferred,
          },
        )

        const encKeyHex = uint8ArrayToHex(result.encryptionKey!)

        if (event.source) {
          ;(event.source as WindowProxy).postMessage(
            {
              type: "socUploadResponse",
              requestId,
              reference: uint8ArrayToHex(result.socAddress),
              tagUid: result.tagUid,
              // encryptionKey always present when using encryptionKey: true
              encryptionKey: encKeyHex,
              owner: signerKeyObj.publicKey().address().toHex(),
            } satisfies IframeToParentMessage,
            { targetOrigin: event.origin },
          )
        }
        return
      }

      // User stamp mode - validate stamp and stamper
      if (!this.postageBatchId || !this.stamper) {
        throw new Error(
          "Postage batch ID and stamper required. Please login first.",
        )
      }

      // Serialize write through Web Locks API to prevent concurrent uploads
      const result = await this.withWriteLock(async () => {
        const stamperTarget: UploadTarget = {
          mode: "stamper",
          bee: this.bee,
          stamper: this.stamper!,
        }

        // Upload encrypted SOC with auto-generated key
        const uploadResult = await uploadSOC(
          stamperTarget,
          signerKeyObj,
          id,
          data,
          {
            encryptionKey: true,
            pin: options?.pin,
            deferred: options?.deferred,
            tag: options?.tag,
          },
        )

        await this.saveStamperState()

        return uploadResult
      })

      const encKeyHex = uint8ArrayToHex(result.encryptionKey!)

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "socUploadResponse",
            requestId,
            reference: uint8ArrayToHex(result.socAddress),
            tagUid: result.tagUid,
            // encryptionKey always present when using encryptionKey: true
            encryptionKey: encKeyHex,
            owner: signerKeyObj.publicKey().address().toHex(),
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "SOC upload failed",
      )
    }
  }

  private async handleSocRawUpload(
    message: SocRawUploadMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, identifier, data, signer, options } = message

    try {
      if (!this.authenticated || !this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }

      this.ensureCanUpload()

      const signerKey = signer ?? this.appSecret
      const signerKeyObj = new PrivateKey(signerKey)
      const id = new Identifier(identifier)

      // Handle subsidised gateway mode - gateway handles stamping server-side
      if (this.isSubsidisedModeActive()) {
        const subsidisedTarget: UploadTarget = {
          mode: "subsidised",
          gatewayUrl: this.subsidisedGatewayUrl!,
        }

        // Upload plain (unencrypted) SOC
        const result = await uploadSOC(
          subsidisedTarget,
          signerKeyObj,
          id,
          data,
          {
            pin: options?.pin,
            deferred: options?.deferred,
          },
        )

        if (event.source) {
          ;(event.source as WindowProxy).postMessage(
            {
              type: "socRawUploadResponse",
              requestId,
              reference: uint8ArrayToHex(result.socAddress),
              tagUid: result.tagUid,
              encryptionKey: undefined,
              owner: signerKeyObj.publicKey().address().toHex(),
            } satisfies IframeToParentMessage,
            { targetOrigin: event.origin },
          )
        }
        return
      }

      // User stamp mode - validate stamp and stamper
      if (!this.postageBatchId || !this.stamper) {
        throw new Error(
          "Postage batch ID and stamper required. Please login first.",
        )
      }

      // Serialize write through Web Locks API to prevent concurrent uploads
      const result = await this.withWriteLock(async () => {
        const stamperTarget: UploadTarget = {
          mode: "stamper",
          bee: this.bee,
          stamper: this.stamper!,
        }

        // Upload plain (unencrypted) SOC
        const uploadResult = await uploadSOC(
          stamperTarget,
          signerKeyObj,
          id,
          data,
          {
            pin: options?.pin,
            deferred: options?.deferred,
            tag: options?.tag,
          },
        )

        await this.saveStamperState()

        return uploadResult
      })

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "socRawUploadResponse",
            requestId,
            reference: uint8ArrayToHex(result.socAddress),
            tagUid: result.tagUid,
            encryptionKey: undefined,
            owner: signerKeyObj.publicKey().address().toHex(),
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "SOC raw upload failed",
      )
    }
  }

  private async handleSocDownload(
    message: SocDownloadMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, owner, identifier, encryptionKey, requestOptions } =
      message

    try {
      let resolvedOwner = owner
      if (!resolvedOwner) {
        if (!this.appSecret) {
          throw new Error("Not authenticated. Please login first.")
        }
        resolvedOwner = new PrivateKey(this.appSecret)
          .publicKey()
          .address()
          .toHex()
      }

      const soc = await downloadEncryptedSOC(
        this.bee,
        resolvedOwner,
        identifier,
        encryptionKey,
        requestOptions,
      )

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "socDownloadResponse",
            requestId,
            data: soc.data,
            identifier: soc.identifier,
            signature: soc.signature,
            span: soc.span,
            payload: soc.payload,
            address: soc.address,
            owner: soc.owner,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "SOC download failed",
      )
    }
  }

  private async handleSocRawDownload(
    message: SocRawDownloadMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, owner, identifier, encryptionKey, requestOptions } =
      message

    try {
      let resolvedOwner = owner
      if (!resolvedOwner) {
        if (!this.appSecret) {
          throw new Error("Not authenticated. Please login first.")
        }
        resolvedOwner = new PrivateKey(this.appSecret)
          .publicKey()
          .address()
          .toHex()
      }

      const soc = encryptionKey
        ? await downloadEncryptedSOC(
            this.bee,
            resolvedOwner,
            identifier,
            encryptionKey,
            requestOptions,
          )
        : await downloadSOC(this.bee, resolvedOwner, identifier, requestOptions)

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "socRawDownloadResponse",
            requestId,
            data: soc.data,
            identifier: soc.identifier,
            signature: soc.signature,
            span: soc.span,
            payload: soc.payload,
            address: soc.address,
            owner: soc.owner,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "SOC raw download failed",
      )
    }
  }

  private async handleSocGetOwner(
    message: SocGetOwnerMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId } = message

    try {
      if (!this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }

      const owner = new PrivateKey(this.appSecret).publicKey().address().toHex()

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "socGetOwnerResponse",
            requestId,
            owner,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "SOC get owner failed",
      )
    }
  }

  private parseFeedTimestamp(value: string | number): bigint {
    if (typeof value === "number") {
      return BigInt(Math.floor(value))
    }
    // Validate string is a valid integer representation
    if (!/^-?\d+$/.test(value)) {
      throw new Error(
        `Invalid timestamp format: "${value}" (expected decimal integer)`,
      )
    }
    return BigInt(value)
  }

  private parseFeedIndex(value: string | number): bigint {
    if (typeof value === "number") {
      return BigInt(Math.floor(value))
    }
    // Validate string is a valid integer representation
    if (!/^-?\d+$/.test(value)) {
      throw new Error(
        `Invalid index format: "${value}" (expected decimal integer)`,
      )
    }
    return BigInt(value)
  }

  private makeSequentialFeedIdentifier(
    topic: Uint8Array,
    index: bigint,
  ): Uint8Array {
    const indexBytes = Binary.numberToUint64(index, "BE")
    return Binary.keccak256(Binary.concatBytes(topic, indexBytes))
  }

  private async findLatestSequentialIndex(
    topic: Uint8Array,
    owner: EthAddress,
    requestOptions?: BeeRequestOptions,
    lookupTimeoutMs?: number,
  ): Promise<bigint | undefined> {
    const lookupOptions: BeeRequestOptions = {
      ...requestOptions,
      timeout: lookupTimeoutMs ?? SEQUENTIAL_INDEX_LOOKUP_TIMEOUT_MS,
    }
    const finder = createAsyncSequentialFinder({
      bee: this.bee,
      topic: new Topic(topic),
      owner,
    })
    const result = await finder.findAt(0n, 0n, lookupOptions)
    return result.current
  }

  private sequentialNextIndex(index: bigint): bigint {
    const max = (1n << 64n) - 1n
    return index === max ? 0n : index + 1n
  }

  private async handleFeedGetOwner(
    message: FeedGetOwnerMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId } = message

    try {
      if (!this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }

      const owner = new PrivateKey(this.appSecret).publicKey().address().toHex()

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "feedGetOwnerResponse",
            requestId,
            owner,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "Feed get owner failed",
      )
    }
  }

  private async handleEpochFeedDownloadReference(
    message: EpochFeedDownloadReferenceMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, topic, owner, at, after, encryptionKey } = message

    try {
      let resolvedOwner = owner
      if (!resolvedOwner) {
        if (!this.appSecret) {
          throw new Error("Not authenticated. Please login first.")
        }
        resolvedOwner = new PrivateKey(this.appSecret)
          .publicKey()
          .address()
          .toHex()
      }

      const topicObj = new Topic(hexToUint8Array(topic))
      const ownerObj = new EthAddress(resolvedOwner)
      const atValue = this.parseFeedTimestamp(at)
      const afterValue =
        after !== undefined ? this.parseFeedTimestamp(after) : 0n
      const epochKeyBytes = encryptionKey
        ? hexToUint8Array(encryptionKey)
        : undefined

      let reference: Uint8Array | undefined
      if (epochKeyBytes) {
        const encryptedFinder = createAsyncEpochFinder({
          bee: this.bee,
          topic: topicObj,
          owner: ownerObj,
          encryptionKey: epochKeyBytes,
        })
        reference = await encryptedFinder.findAt(atValue, afterValue)
      } else {
        const plainFinder = createAsyncEpochFinder({
          bee: this.bee,
          topic: topicObj,
          owner: ownerObj,
        })
        reference = await plainFinder.findAt(atValue, afterValue)
      }

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "epochFeedDownloadReferenceResponse",
            requestId,
            reference: reference ? uint8ArrayToHex(reference) : undefined,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error
          ? error.message
          : "Epoch feed download reference failed",
      )
    }
  }

  private async handleEpochFeedUploadReference(
    message: EpochFeedUploadReferenceMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, topic, signer, at, reference, encryptionKey, hints } =
      message

    try {
      if (!this.authenticated || !this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }

      this.ensureCanUpload()

      const signerKey = signer ?? this.appSecret
      const signerKeyObj = new PrivateKey(signerKey)
      const topicObj = new Topic(hexToUint8Array(topic))
      const ownerHex = signerKeyObj.publicKey().address().toHex()
      const ownerAddress = new EthAddress(ownerHex)
      const atValue = this.parseFeedTimestamp(at)
      const epochEncryptionKey = encryptionKey
        ? hexToUint8Array(encryptionKey)
        : undefined

      // Convert hints from message format to updater format
      const epochHints = hints?.lastEpoch
        ? {
            lastEpoch: {
              start: BigInt(hints.lastEpoch.start),
              level: hints.lastEpoch.level,
            },
            lastTimestamp: hints.lastTimestamp
              ? BigInt(hints.lastTimestamp)
              : undefined,
          }
        : undefined

      // Calculate epoch based on hints or by looking up current state
      const epoch = await this.calculateEpochForUpdate(
        topicObj,
        ownerAddress,
        atValue,
        epochHints,
        epochEncryptionKey,
      )

      // Build identifier: Keccak256(topic || Keccak256(start || level))
      const epochHash = await epoch.marshalBinary()
      const identifier = new Identifier(
        Binary.keccak256(
          Binary.concatBytes(topicObj.toUint8Array(), epochHash),
        ),
      )

      // Build payload: timestamp (8 bytes big-endian) + reference
      const referenceBytes = hexToUint8Array(reference)
      if (referenceBytes.length !== 32 && referenceBytes.length !== 64) {
        throw new Error(
          `Reference must be 32 or 64 bytes, got ${referenceBytes.length}`,
        )
      }
      const timestamp = new Uint8Array(8)
      const tsView = new DataView(timestamp.buffer)
      tsView.setBigUint64(0, atValue, false) // big-endian
      const payload = Binary.concatBytes(timestamp, referenceBytes)

      // Handle subsidised gateway mode - gateway handles stamping server-side
      if (this.isSubsidisedModeActive()) {
        const subsidisedTarget: UploadTarget = {
          mode: "subsidised",
          gatewayUrl: this.subsidisedGatewayUrl!,
        }

        const result = await uploadSOC(
          subsidisedTarget,
          signerKeyObj,
          identifier,
          payload,
          {
            encryptionKey: epochEncryptionKey,
            deferred: false,
          },
        )
        const socAddress = result.socAddress

        // Verify upload with read-back
        const readBackFinder = createAsyncEpochFinder({
          bee: this.bee,
          topic: topicObj,
          owner: ownerAddress,
          encryptionKey: epochEncryptionKey,
        })
        await readBackFinder.findAt(atValue, atValue)

        if (event.source) {
          ;(event.source as WindowProxy).postMessage(
            {
              type: "epochFeedUploadReferenceResponse",
              requestId,
              socAddress: uint8ArrayToHex(socAddress),
              encryptionKey: encryptionKey ? encryptionKey : undefined,
              epoch: {
                start: epoch.start.toString(),
                level: epoch.level,
              },
              timestamp: atValue.toString(),
            } satisfies IframeToParentMessage,
            { targetOrigin: event.origin },
          )
        }
        return
      }

      // User stamp mode - validate stamp and stamper
      if (!this.postageBatchId || !this.stamper) {
        throw new Error(
          "Postage batch ID and stamper required. Please login first.",
        )
      }

      const updater = createEpochUpdater({
        bee: this.bee,
        topic: topicObj,
        owner: ownerAddress,
        signer: signerKeyObj,
      })

      // Serialize write through Web Locks API to prevent concurrent uploads
      const updateResult = await this.withWriteLock(async () => {
        const result = await updater.update(
          atValue,
          referenceBytes,
          this.stamper!,
          epochEncryptionKey,
          epochHints,
        )

        const readBackFinder = createAsyncEpochFinder({
          bee: this.bee,
          topic: topicObj,
          owner: ownerAddress,
          encryptionKey: epochEncryptionKey,
        })
        // Upload read-back should verify the exact timestamp write and avoid
        // broad fallback scans over historical leaves on poisoned networks.
        await readBackFinder.findAt(atValue, atValue)

        await this.saveStamperState()

        return result
      })

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "epochFeedUploadReferenceResponse",
            requestId,
            socAddress: uint8ArrayToHex(updateResult.socAddress),
            encryptionKey: encryptionKey ? encryptionKey : undefined,
            epoch: {
              start: updateResult.epoch.start.toString(),
              level: updateResult.epoch.level,
            },
            timestamp: updateResult.timestamp.toString(),
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error
          ? error.message
          : "Epoch feed upload reference failed",
      )
    }
  }

  /**
   * Calculate epoch for an update based on hints or by looking up current state
   */
  private async calculateEpochForUpdate(
    topic: Topic,
    owner: EthAddress,
    at: bigint,
    hints?: {
      lastEpoch: { start: bigint; level: number }
      lastTimestamp?: bigint
    },
    encryptionKey?: Uint8Array,
  ): Promise<EpochIndex> {
    // Fast path: use provided hints
    if (hints?.lastEpoch && hints.lastTimestamp !== undefined) {
      const prevEpoch = new EpochIndex(
        hints.lastEpoch.start,
        hints.lastEpoch.level,
      )
      return prevEpoch.next(hints.lastTimestamp, at)
    }

    // Slow path: lookup current state using AsyncEpochFinder directly
    // (not the interface) to access findAtWithMetadata
    const finder = new AsyncEpochFinder(this.bee, topic, owner, encryptionKey)

    // Use findAtWithMetadata to get both reference AND epoch info
    const current = await finder.findAtWithMetadata(at)

    if (!current) {
      // First update ever - use root epoch
      return new EpochIndex(0n, MAX_LEVEL)
    }

    // Calculate next epoch based on found state
    return current.epoch.next(current.timestamp, at)
  }

  private async handleSequentialFeedGetOwner(
    message: SequentialFeedGetOwnerMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId } = message

    try {
      if (!this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }

      const owner = new PrivateKey(this.appSecret).publicKey().address().toHex()

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "seqFeedGetOwnerResponse",
            requestId,
            owner,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error
          ? error.message
          : "Sequential feed get owner failed",
      )
    }
  }

  private async resolveSequentialOwner(owner?: string): Promise<string> {
    if (owner) {
      return owner
    }
    if (!this.appSecret) {
      throw new Error("Not authenticated. Please login first.")
    }
    return new PrivateKey(this.appSecret).publicKey().address().toHex()
  }

  private parseSequentialPayload(
    payload: Uint8Array,
    hasTimestamp: boolean,
  ): { payload: Uint8Array; timestamp?: number } {
    if (!hasTimestamp) {
      return { payload }
    }

    if (payload.length < 8) {
      return { payload, timestamp: undefined }
    }

    const view = new DataView(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    )
    const timestamp = Number(view.getBigUint64(0, false))
    return { payload: payload.slice(8), timestamp }
  }

  private async resolveSequentialIndex(
    topicBytes: Uint8Array,
    ownerAddress: EthAddress,
    index?: string | number,
    at?: string | number,
    hasTimestamp: boolean = true,
    requestOptions?: BeeRequestOptions,
    encryptionKey?: string,
    raw: boolean = false,
    lookupTimeoutMs?: number,
  ): Promise<bigint> {
    if (!raw && !encryptionKey) {
      throw new Error("Encryption key is required for encrypted feed lookup")
    }
    if (index !== undefined) {
      return this.parseFeedIndex(index)
    }

    const latest = await this.findLatestSequentialIndex(
      topicBytes,
      ownerAddress,
      requestOptions,
      lookupTimeoutMs,
    )
    if (latest === undefined) {
      throw new Error("Sequential feed has no updates")
    }

    if (at === undefined) {
      return latest
    }

    if (!hasTimestamp) {
      throw new Error("Cannot use 'at' without timestamps")
    }

    const atValue = this.parseFeedTimestamp(at)
    for (let current = latest; current >= 0n; current--) {
      const identifierBytes = this.makeSequentialFeedIdentifier(
        topicBytes,
        current,
      )
      const identifier = new Identifier(identifierBytes)
      const soc = raw
        ? encryptionKey
          ? await downloadEncryptedSOC(
              this.bee,
              ownerAddress,
              identifier,
              encryptionKey,
              requestOptions,
            )
          : await downloadSOC(
              this.bee,
              ownerAddress,
              identifier,
              requestOptions,
            )
        : await downloadEncryptedSOC(
            this.bee,
            ownerAddress,
            identifier,
            encryptionKey ?? "",
            requestOptions,
          )

      const parsed = this.parseSequentialPayload(soc.payload, true)
      if (
        parsed.timestamp !== undefined &&
        BigInt(parsed.timestamp) <= atValue
      ) {
        return current
      }
      if (current === 0n) {
        break
      }
    }

    // If no update matches the timestamp, fall back to latest for sequential feeds.
    return latest
  }

  private async handleSequentialFeedDownloadPayload(
    message: SequentialFeedDownloadPayloadMessage,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      topic,
      owner,
      index,
      at,
      hasTimestamp,
      encryptionKey,
      lookupTimeoutMs,
      requestOptions,
    } = message

    try {
      if (!encryptionKey) {
        throw new Error("Encryption key is required for downloadPayload")
      }

      const resolvedOwner = await this.resolveSequentialOwner(owner)
      const ownerAddress = new EthAddress(resolvedOwner)
      const topicBytes = hexToUint8Array(topic)
      const useTimestamp = hasTimestamp !== false
      const resolvedIndex = await this.resolveSequentialIndex(
        topicBytes,
        ownerAddress,
        index,
        at,
        useTimestamp,
        requestOptions,
        encryptionKey,
        false,
        lookupTimeoutMs,
      )

      const identifierBytes = this.makeSequentialFeedIdentifier(
        topicBytes,
        resolvedIndex,
      )
      const identifier = new Identifier(identifierBytes)
      const soc = await downloadEncryptedSOC(
        this.bee,
        ownerAddress,
        identifier,
        encryptionKey,
        requestOptions,
      )

      const parsed = this.parseSequentialPayload(soc.payload, useTimestamp)
      const nextIndex = this.sequentialNextIndex(resolvedIndex)

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "seqFeedDownloadPayloadResponse",
            requestId,
            payload: parsed.payload,
            timestamp: parsed.timestamp,
            feedIndex: resolvedIndex.toString(),
            feedIndexNext: nextIndex.toString(),
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error
          ? error.message
          : "Sequential feed download payload failed",
      )
    }
  }

  private async handleSequentialFeedDownloadRawPayload(
    message: SequentialFeedDownloadRawPayloadMessage,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      topic,
      owner,
      index,
      at,
      hasTimestamp,
      encryptionKey,
      lookupTimeoutMs,
      requestOptions,
    } = message

    try {
      const resolvedOwner = await this.resolveSequentialOwner(owner)
      const ownerAddress = new EthAddress(resolvedOwner)
      const topicBytes = hexToUint8Array(topic)
      const useTimestamp = hasTimestamp !== false
      const resolvedIndex = await this.resolveSequentialIndex(
        topicBytes,
        ownerAddress,
        index,
        at,
        useTimestamp,
        requestOptions,
        encryptionKey,
        true,
        lookupTimeoutMs,
      )

      const identifierBytes = this.makeSequentialFeedIdentifier(
        topicBytes,
        resolvedIndex,
      )
      const identifier = new Identifier(identifierBytes)
      const soc = encryptionKey
        ? await downloadEncryptedSOC(
            this.bee,
            ownerAddress,
            identifier,
            encryptionKey,
            requestOptions,
          )
        : await downloadSOC(this.bee, ownerAddress, identifier, requestOptions)

      const parsed = this.parseSequentialPayload(soc.payload, useTimestamp)
      const nextIndex = this.sequentialNextIndex(resolvedIndex)

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "seqFeedDownloadRawPayloadResponse",
            requestId,
            payload: parsed.payload,
            timestamp: parsed.timestamp,
            feedIndex: resolvedIndex.toString(),
            feedIndexNext: nextIndex.toString(),
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error
          ? error.message
          : "Sequential feed download raw payload failed",
      )
    }
  }

  private async handleSequentialFeedDownloadReference(
    message: SequentialFeedDownloadReferenceMessage,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      topic,
      owner,
      index,
      at,
      hasTimestamp,
      encryptionKey,
      lookupTimeoutMs,
      requestOptions,
    } = message

    try {
      if (!encryptionKey) {
        throw new Error("Encryption key is required for downloadReference")
      }

      const resolvedOwner = await this.resolveSequentialOwner(owner)
      const ownerAddress = new EthAddress(resolvedOwner)
      const topicBytes = hexToUint8Array(topic)
      const useTimestamp = hasTimestamp !== false
      const resolvedIndex = await this.resolveSequentialIndex(
        topicBytes,
        ownerAddress,
        index,
        at,
        useTimestamp,
        requestOptions,
        encryptionKey,
        false,
        lookupTimeoutMs,
      )

      const identifierBytes = this.makeSequentialFeedIdentifier(
        topicBytes,
        resolvedIndex,
      )
      const identifier = new Identifier(identifierBytes)
      const soc = await downloadEncryptedSOC(
        this.bee,
        ownerAddress,
        identifier,
        encryptionKey,
        requestOptions,
      )

      const parsed = this.parseSequentialPayload(soc.payload, useTimestamp)
      if (parsed.payload.length !== 32 && parsed.payload.length !== 64) {
        throw new Error(
          "Sequential feed update does not contain a reference; use downloadPayload",
        )
      }
      const referenceHex = uint8ArrayToHex(parsed.payload)
      const nextIndex = this.sequentialNextIndex(resolvedIndex)

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "seqFeedDownloadReferenceResponse",
            requestId,
            reference: referenceHex,
            feedIndex: resolvedIndex.toString(),
            feedIndexNext: nextIndex.toString(),
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error
          ? error.message
          : "Sequential feed download reference failed",
      )
    }
  }

  private buildSequentialPayload(
    data: Uint8Array,
    hasTimestamp: boolean,
    at: bigint,
  ): Uint8Array {
    if (!hasTimestamp) {
      return data
    }
    const timestamp = new Uint8Array(8)
    const view = new DataView(timestamp.buffer)
    view.setBigUint64(0, at, false)
    return Binary.concatBytes(timestamp, data)
  }

  private async handleSequentialFeedUploadPayload(
    message: SequentialFeedUploadPayloadMessage,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      topic,
      signer,
      data,
      index,
      at,
      hasTimestamp,
      lookupTimeoutMs,
      options,
      requestOptions,
    } = message

    try {
      if (!this.authenticated || !this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }
      this.ensureCanUpload()

      const signerKey = signer ?? this.appSecret
      const signerKeyObj = new PrivateKey(signerKey)
      const ownerAddress = signerKeyObj.publicKey().address()
      const topicBytes = hexToUint8Array(topic)

      const useTimestamp = hasTimestamp !== false
      const atValue =
        at !== undefined
          ? this.parseFeedTimestamp(at)
          : BigInt(Math.floor(Date.now() / 1000))
      let resolvedIndex: bigint
      if (index !== undefined) {
        resolvedIndex = this.parseFeedIndex(index)
      } else {
        const latest = await this.findLatestSequentialIndex(
          topicBytes,
          ownerAddress,
          requestOptions,
          lookupTimeoutMs,
        )
        resolvedIndex =
          latest === undefined ? 0n : this.sequentialNextIndex(latest)
      }

      const payload = this.buildSequentialPayload(data, useTimestamp, atValue)
      if (payload.length < 1 || payload.length > 4096) {
        throw new Error(
          `Invalid payload length: ${payload.length} (expected 1-4096)`,
        )
      }

      const identifierBytes = this.makeSequentialFeedIdentifier(
        topicBytes,
        resolvedIndex,
      )
      const identifier = new Identifier(identifierBytes)

      // Handle subsidised gateway mode - gateway handles stamping server-side
      if (this.isSubsidisedModeActive()) {
        const subsidisedTarget: UploadTarget = {
          mode: "subsidised",
          gatewayUrl: this.subsidisedGatewayUrl!,
        }

        // Upload encrypted SOC with auto-generated key
        const result = await uploadSOC(
          subsidisedTarget,
          signerKeyObj,
          identifier,
          payload,
          {
            encryptionKey: true,
            pin: options?.pin,
            deferred: options?.deferred,
          },
        )

        if (event.source) {
          ;(event.source as WindowProxy).postMessage(
            {
              type: "seqFeedUploadPayloadResponse",
              requestId,
              reference: uint8ArrayToHex(result.socAddress),
              feedIndex: resolvedIndex.toString(),
              owner: ownerAddress.toHex(),
              encryptionKey: result.encryptionKey
                ? uint8ArrayToHex(result.encryptionKey)
                : undefined,
              tagUid: result.tagUid,
            } satisfies IframeToParentMessage,
            { targetOrigin: event.origin },
          )
        }
        return
      }

      // User stamp mode - validate stamp and stamper
      if (!this.postageBatchId || !this.stamper) {
        throw new Error(
          "Postage batch ID and stamper required. Please login first.",
        )
      }

      // Serialize write through Web Locks API to prevent concurrent uploads
      const result = await this.withWriteLock(async () => {
        const stamperTarget: UploadTarget = {
          mode: "stamper",
          bee: this.bee,
          stamper: this.stamper!,
        }

        // Upload encrypted SOC with auto-generated key
        const uploadResult = await uploadSOC(
          stamperTarget,
          signerKeyObj,
          identifier,
          payload,
          {
            encryptionKey: true,
            pin: options?.pin,
            deferred: options?.deferred,
            tag: options?.tag,
          },
        )

        await this.saveStamperState()

        return uploadResult
      })

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "seqFeedUploadPayloadResponse",
            requestId,
            reference: uint8ArrayToHex(result.socAddress),
            feedIndex: resolvedIndex.toString(),
            owner: ownerAddress.toHex(),
            // encryptionKey always present when using encryptionKey: true
            encryptionKey: uint8ArrayToHex(result.encryptionKey!),
            tagUid: result.tagUid,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error
          ? error.message
          : "Sequential feed upload payload failed",
      )
    }
  }

  private async handleSequentialFeedUploadRawPayload(
    message: SequentialFeedUploadRawPayloadMessage,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      topic,
      signer,
      data,
      index,
      at,
      hasTimestamp,
      encryptionKey,
      lookupTimeoutMs,
      options,
      requestOptions,
    } = message

    try {
      if (!this.authenticated || !this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }
      this.ensureCanUpload()

      const signerKey = signer ?? this.appSecret
      const signerKeyObj = new PrivateKey(signerKey)
      const ownerAddress = signerKeyObj.publicKey().address()
      const topicBytes = hexToUint8Array(topic)

      const useTimestamp = hasTimestamp !== false
      const atValue =
        at !== undefined
          ? this.parseFeedTimestamp(at)
          : BigInt(Math.floor(Date.now() / 1000))
      let resolvedIndex: bigint
      if (index !== undefined) {
        resolvedIndex = this.parseFeedIndex(index)
      } else {
        const latest = await this.findLatestSequentialIndex(
          topicBytes,
          ownerAddress,
          requestOptions,
          lookupTimeoutMs,
        )
        resolvedIndex =
          latest === undefined ? 0n : this.sequentialNextIndex(latest)
      }

      const payload = this.buildSequentialPayload(data, useTimestamp, atValue)
      if (payload.length < 1 || payload.length > 4096) {
        throw new Error(
          `Invalid payload length: ${payload.length} (expected 1-4096)`,
        )
      }

      const identifierBytes = this.makeSequentialFeedIdentifier(
        topicBytes,
        resolvedIndex,
      )
      const identifier = new Identifier(identifierBytes)

      // Handle subsidised gateway mode - gateway handles stamping server-side
      if (this.isSubsidisedModeActive()) {
        const subsidisedTarget: UploadTarget = {
          mode: "subsidised",
          gatewayUrl: this.subsidisedGatewayUrl!,
        }

        const result = await uploadSOC(
          subsidisedTarget,
          signerKeyObj,
          identifier,
          payload,
          {
            encryptionKey: encryptionKey
              ? hexToUint8Array(encryptionKey)
              : undefined,
            pin: options?.pin,
            deferred: options?.deferred,
          },
        )

        if (event.source) {
          ;(event.source as WindowProxy).postMessage(
            {
              type: "seqFeedUploadRawPayloadResponse",
              requestId,
              reference: uint8ArrayToHex(result.socAddress),
              feedIndex: resolvedIndex.toString(),
              owner: ownerAddress.toHex(),
              encryptionKey: encryptionKey ? encryptionKey : undefined,
              tagUid: result.tagUid,
            } satisfies IframeToParentMessage,
            { targetOrigin: event.origin },
          )
        }
        return
      }

      // User stamp mode - validate stamp and stamper
      if (!this.postageBatchId || !this.stamper) {
        throw new Error(
          "Postage batch ID and stamper required. Please login first.",
        )
      }

      // Serialize write through Web Locks API to prevent concurrent uploads
      // Upload SOC - use encryption if key provided, otherwise plain SOC
      // The unified uploadSOC handles /soc endpoint properly for v1 format
      const result = await this.withWriteLock(async () => {
        const stamperTarget: UploadTarget = {
          mode: "stamper",
          bee: this.bee,
          stamper: this.stamper!,
        }

        const uploadResult = await uploadSOC(
          stamperTarget,
          signerKeyObj,
          identifier,
          payload,
          {
            encryptionKey: encryptionKey
              ? hexToUint8Array(encryptionKey)
              : undefined,
            pin: options?.pin,
            deferred: options?.deferred,
            tag: options?.tag,
          },
        )

        await this.saveStamperState()

        return uploadResult
      })

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "seqFeedUploadRawPayloadResponse",
            requestId,
            reference: uint8ArrayToHex(result.socAddress),
            feedIndex: resolvedIndex.toString(),
            owner: ownerAddress.toHex(),
            encryptionKey: encryptionKey ? encryptionKey : undefined,
            tagUid: result.tagUid,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error
          ? error.message
          : "Sequential feed upload raw payload failed",
      )
    }
  }

  private async handleSequentialFeedUploadReference(
    message: SequentialFeedUploadReferenceMessage,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      topic,
      signer,
      reference,
      index,
      at,
      hasTimestamp,
      lookupTimeoutMs,
      options,
      requestOptions,
    } = message

    try {
      if (!this.authenticated || !this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }
      this.ensureCanUpload()

      const signerKey = signer ?? this.appSecret
      const signerKeyObj = new PrivateKey(signerKey)
      const ownerAddress = signerKeyObj.publicKey().address()
      const topicBytes = hexToUint8Array(topic)

      const useTimestamp = hasTimestamp !== false
      const atValue =
        at !== undefined
          ? this.parseFeedTimestamp(at)
          : BigInt(Math.floor(Date.now() / 1000))
      let resolvedIndex: bigint
      if (index !== undefined) {
        resolvedIndex = this.parseFeedIndex(index)
      } else {
        const latest = await this.findLatestSequentialIndex(
          topicBytes,
          ownerAddress,
          requestOptions,
          lookupTimeoutMs,
        )
        resolvedIndex =
          latest === undefined ? 0n : this.sequentialNextIndex(latest)
      }

      const referenceBytes = hexToUint8Array(reference)
      const payload = this.buildSequentialPayload(
        referenceBytes,
        useTimestamp,
        atValue,
      )
      if (payload.length < 1 || payload.length > 4096) {
        throw new Error(
          `Invalid payload length: ${payload.length} (expected 1-4096)`,
        )
      }

      const identifierBytes = this.makeSequentialFeedIdentifier(
        topicBytes,
        resolvedIndex,
      )
      const identifier = new Identifier(identifierBytes)

      // Handle subsidised gateway mode - gateway handles stamping server-side
      if (this.isSubsidisedModeActive()) {
        const subsidisedTarget: UploadTarget = {
          mode: "subsidised",
          gatewayUrl: this.subsidisedGatewayUrl!,
        }

        // uploadReference always uses encryption with auto-generated key
        const result = await uploadSOC(
          subsidisedTarget,
          signerKeyObj,
          identifier,
          payload,
          {
            encryptionKey: true,
            pin: options?.pin,
            deferred: options?.deferred,
          },
        )

        if (event.source) {
          ;(event.source as WindowProxy).postMessage(
            {
              type: "seqFeedUploadReferenceResponse",
              requestId,
              reference: uint8ArrayToHex(result.socAddress),
              feedIndex: resolvedIndex.toString(),
              owner: ownerAddress.toHex(),
              encryptionKey: result.encryptionKey
                ? uint8ArrayToHex(result.encryptionKey)
                : undefined,
              tagUid: result.tagUid,
            } satisfies IframeToParentMessage,
            { targetOrigin: event.origin },
          )
        }
        return
      }

      // User stamp mode - validate stamp and stamper
      if (!this.postageBatchId || !this.stamper) {
        throw new Error(
          "Postage batch ID and stamper required. Please login first.",
        )
      }

      // Serialize write through Web Locks API to prevent concurrent uploads
      const { result, encryptionKeyResult } = await this.withWriteLock(
        async () => {
          const stamperTarget: UploadTarget = {
            mode: "stamper",
            bee: this.bee,
            stamper: this.stamper!,
          }

          // uploadReference always uses encryption with auto-generated key
          const encResult = await uploadSOC(
            stamperTarget,
            signerKeyObj,
            identifier,
            payload,
            {
              encryptionKey: true,
              pin: options?.pin,
              deferred: options?.deferred,
              tag: options?.tag,
            },
          )

          await this.saveStamperState()

          return {
            result: encResult,
            encryptionKeyResult: encResult.encryptionKey
              ? uint8ArrayToHex(encResult.encryptionKey)
              : undefined,
          }
        },
      )

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "seqFeedUploadReferenceResponse",
            requestId,
            reference: uint8ArrayToHex(result.socAddress),
            feedIndex: resolvedIndex.toString(),
            owner: ownerAddress.toHex(),
            encryptionKey: encryptionKeyResult,
            tagUid: result.tagUid,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error
          ? error.message
          : "Sequential feed upload reference failed",
      )
    }
  }

  // ============================================================================
  // ACT (Access Control Tries) Handlers
  // ============================================================================

  private async handleActUploadData(
    message: ActUploadDataMessage,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      data,
      grantees,
      options,
      requestOptions,
      enableProgress,
    } = message

    try {
      if (!this.authenticated || !this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }

      this.ensureCanUpload()

      // Parse grantee public keys from compressed hex
      const granteePublicKeys = grantees.map((hex) =>
        parseCompressedPublicKey(hex),
      )

      // Progress callback (if enabled)
      const onProgress = enableProgress
        ? (progress: UploadProgress) => {
            if (event.source) {
              ;(event.source as WindowProxy).postMessage(
                {
                  type: "uploadProgress",
                  requestId,
                  total: progress.total,
                  processed: progress.processed,
                } satisfies IframeToParentMessage,
                { targetOrigin: event.origin },
              )
            }
          }
        : undefined

      // Use appSecret as publisher private key (user's identity key for this app)
      const publisherPrivateKey = hexToUint8Array(this.appSecret)

      // Handle subsidised gateway mode - gateway handles stamping server-side
      if (this.isSubsidisedModeActive()) {
        const subsidisedGatewayUrl = this.subsidisedGatewayUrl!
        const subsidisedTarget: UploadTarget = {
          mode: "subsidised",
          gatewayUrl: subsidisedGatewayUrl,
        }
        const beeCompatible = options?.beeCompatible === true

        // Step 1: Upload raw content data - ENCRYPTED (64-byte reference)
        const contentUploadResult = await uploadData(subsidisedTarget, data, {
          encryptionKey: true, // generate random encryption key
          pin: options?.pin,
          deferred: options?.deferred,
          onProgress,
        })

        // Step 2: Create Mantaray manifest wrapping the content
        const manifest = new MantarayNode()
        const contentReferenceBytes = hexToUint8Array(
          contentUploadResult.reference,
        ) // 64 bytes
        manifest.addFork(DEFAULT_ACT_FILENAME, contentReferenceBytes, {
          "Content-Type": DEFAULT_ACT_CONTENT_TYPE,
          Filename: DEFAULT_ACT_FILENAME,
        })
        manifest.addFork("/", NULL_ADDRESS, {
          "website-index-document": DEFAULT_ACT_FILENAME,
        })

        // Step 3: Upload the Mantaray manifest via subsidised gateway
        const manifestResult = beeCompatible
          ? await saveMantarayTreeRecursively(manifest, async (chunkData) => {
              const chunk = makeContentAddressedChunk(chunkData)
              await uploadChunk(subsidisedTarget, chunk.data, {
                pin: options?.pin,
                deferred: options?.deferred,
              })
              return { reference: chunk.address.toHex() }
            })
          : await saveMantarayTreeRecursivelyEncrypted(
              manifest,
              async (encryptedData) => {
                await uploadChunk(subsidisedTarget, encryptedData, {
                  pin: options?.pin,
                  deferred: options?.deferred,
                })
                return {}
              },
            )

        // Step 4: Use manifest reference for ACT encryption
        const manifestReferenceBytes = hexToUint8Array(
          manifestResult.rootReference,
        )

        // Build ACT config for subsidised mode
        const actConfig: ActUploadConfig = {
          bee: this.bee,
          subsidisedGatewayUrl,
        }

        // Create ACT for the manifest (which points to the content)
        const actResult = await createActForContent(
          actConfig,
          manifestReferenceBytes,
          publisherPrivateKey,
          granteePublicKeys,
          options,
          requestOptions,
        )

        // Send final response
        if (event.source) {
          ;(event.source as WindowProxy).postMessage(
            {
              type: "actUploadDataResponse",
              requestId,
              encryptedReference: actResult.encryptedReference,
              historyReference: actResult.historyReference,
              granteeListReference: actResult.granteeListReference,
              publisherPubKey: actResult.publisherPubKey,
              actReference: actResult.actReference,
              tagUid: contentUploadResult.tagUid,
            } satisfies IframeToParentMessage,
            { targetOrigin: event.origin },
          )
        }
        return
      }

      // User stamp mode - validate stamp and stamper
      if (!this.signerKey || !this.postageBatchId) {
        throw new Error(
          "Signer key and postage batch ID required. Please login first.",
        )
      }

      if (!this.stamper) {
        throw new Error("Stamper not initialized. Please login first.")
      }

      // Prepare upload target
      const stamperTarget: UploadTarget = {
        mode: "stamper",
        bee: this.bee,
        stamper: this.stamper,
      }

      // Serialize write through Web Locks API to prevent concurrent uploads
      const { actResult, contentUpload } = await this.withWriteLock(
        async () => {
          // Step 1: Upload raw content data - ENCRYPTED (64-byte reference)
          const contentUploadResult = await uploadData(stamperTarget, data, {
            encryptionKey: true, // generate random encryption key
            pin: options?.pin,
            deferred: options?.deferred,
            tag: options?.tag,
            onProgress,
            requestOptions,
          })

          // Step 2: Create Mantaray manifest wrapping the content
          // Content reference is now 64 bytes (encrypted reference: address + encryption key)
          // This is needed because Bee's /bzz/ endpoint expects a default (Mantaray) manifest
          const manifest = new MantarayNode()
          const contentReferenceBytes = hexToUint8Array(
            contentUploadResult.reference,
          ) // 64 bytes
          manifest.addFork(DEFAULT_ACT_FILENAME, contentReferenceBytes, {
            "Content-Type": DEFAULT_ACT_CONTENT_TYPE,
            Filename: DEFAULT_ACT_FILENAME,
          })
          manifest.addFork("/", NULL_ADDRESS, {
            "website-index-document": DEFAULT_ACT_FILENAME,
          })

          // Create a tag for the manifest uploads (required for dev mode)
          const manifestTag = options?.tag ?? (await tryCreateTag(this.bee))

          const beeCompatible = options?.beeCompatible === true

          // Step 3: Upload the Mantaray manifest
          const manifestResult = beeCompatible
            ? await saveMantarayTreeRecursively(
                manifest,
                async (chunkData, isRoot) => {
                  const chunk = makeContentAddressedChunk(chunkData)
                  const envelope = this.stamper!.stamp({
                    hash: () => chunk.address.toUint8Array(),
                    build: () => chunk.data,
                    span: 0n,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    writer: undefined as any,
                  })
                  await this.bee.uploadChunk(
                    envelope,
                    chunk.data,
                    { ...options, tag: manifestTag, deferred: false },
                    requestOptions,
                  )
                  return {
                    reference: chunk.address.toHex(),
                    tagUid: isRoot ? manifestTag : undefined,
                  }
                },
              )
            : await saveMantarayTreeRecursivelyEncrypted(
                manifest,
                async (encryptedData, address, isRoot) => {
                  const envelope = this.stamper!.stamp({
                    hash: () => address,
                    build: () => encryptedData,
                    span: 0n,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    writer: undefined as any,
                  })
                  await this.bee.uploadChunk(
                    envelope,
                    encryptedData,
                    { ...options, tag: manifestTag, deferred: false },
                    requestOptions,
                  )
                  return {
                    tagUid: isRoot ? manifestTag : undefined,
                  }
                },
              )

          // Step 4: Use manifest reference for ACT encryption
          const manifestReferenceBytes = hexToUint8Array(
            manifestResult.rootReference,
          )

          // Create worker pool for parallel stamping
          const workerPool = await this.getOrCreateWorkerPool()
          if (!workerPool) {
            throw new Error("Failed to create stamp worker pool")
          }

          // Build ACT config for stamper mode
          const actConfig: ActUploadConfig = {
            bee: this.bee,
            stamper: this.stamper!,
            workerPool,
          }

          // Create ACT for the manifest (which points to the content)
          const actResultValue = await createActForContent(
            actConfig,
            manifestReferenceBytes,
            publisherPrivateKey,
            granteePublicKeys,
            options,
            requestOptions,
          )

          // Save stamper state after successful upload
          await this.saveStamperState()

          return {
            actResult: actResultValue,
            contentUpload: contentUploadResult,
          }
        },
      )

      // Send final response
      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "actUploadDataResponse",
            requestId,
            encryptedReference: actResult.encryptedReference,
            historyReference: actResult.historyReference,
            granteeListReference: actResult.granteeListReference,
            publisherPubKey: actResult.publisherPubKey,
            actReference: actResult.actReference,
            tagUid: contentUpload.tagUid,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "ACT upload failed",
      )
    }
  }

  private async handleActDownloadData(
    message: ActDownloadDataMessage,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      encryptedReference,
      historyReference,
      publisherPubKey,
      timestamp,
      requestOptions,
    } = message

    try {
      if (!this.authenticated || !this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }

      // appSecret is already checked by authenticated check above
      // Use appSecret as reader private key (user's identity key for this app)
      const readerPrivateKey = hexToUint8Array(this.appSecret)

      // Decrypt the ACT reference to get the content reference
      const contentReference = await decryptActReference(
        this.bee,
        encryptedReference,
        historyReference,
        publisherPubKey,
        readerPrivateKey,
        timestamp,
        requestOptions,
      )

      // Step 1: Download and unmarshal the Mantaray manifest (chunk API only)
      const manifest = await loadMantarayTreeWithChunkAPI(
        this.bee,
        contentReference,
        requestOptions,
      )

      // Step 2: Get the index document path from manifest metadata
      const { indexDocument } = manifest.getDocsMetadata()
      if (!indexDocument) {
        throw new Error("Manifest does not contain an index document reference")
      }

      // Step 3: Find the node at the index document path
      const contentNode = manifest.find(indexDocument)
      if (!contentNode) {
        throw new Error(`Content node "${indexDocument}" not found in manifest`)
      }

      if (!contentNode.targetAddress) {
        throw new Error(
          `Content node "${indexDocument}" does not have a target address`,
        )
      }

      const actualContentRef = uint8ArrayToHex(contentNode.targetAddress)

      // Step 4: Download the actual content
      const data = await downloadDataWithChunkAPI(
        this.bee,
        actualContentRef,
        undefined,
        undefined,
        requestOptions,
      )

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "actDownloadDataResponse",
            requestId,
            data: data as Uint8Array,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "ACT download failed",
      )
    }
  }

  private async handleActAddGrantees(
    message: ActAddGranteesMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, historyReference, grantees, requestOptions } = message

    try {
      if (!this.authenticated || !this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }

      this.ensureCanUpload()

      // Use appSecret as publisher private key (user's identity key for this app)
      const publisherPrivateKey = hexToUint8Array(this.appSecret)

      // Parse grantee public keys from compressed hex
      const newGranteePublicKeys = grantees.map((hex) =>
        parseCompressedPublicKey(hex),
      )

      // Handle subsidised gateway mode - gateway handles stamping server-side
      if (this.isSubsidisedModeActive()) {
        const actConfig: ActUploadConfig = {
          bee: this.bee,
          subsidisedGatewayUrl: this.subsidisedGatewayUrl!,
        }

        // Add grantees to ACT
        const result = await addGranteesToAct(
          actConfig,
          historyReference,
          publisherPrivateKey,
          newGranteePublicKeys,
          undefined,
          requestOptions,
        )

        if (event.source) {
          ;(event.source as WindowProxy).postMessage(
            {
              type: "actAddGranteesResponse",
              requestId,
              historyReference: result.historyReference,
              granteeListReference: result.granteeListReference,
              actReference: result.actReference,
            } satisfies IframeToParentMessage,
            { targetOrigin: event.origin },
          )
        }
        return
      }

      // User stamp mode - validate stamp and stamper
      if (!this.signerKey || !this.postageBatchId) {
        throw new Error(
          "Signer key and postage batch ID required. Please login first.",
        )
      }

      if (!this.stamper) {
        throw new Error("Stamper not initialized. Please login first.")
      }

      // Create worker pool for parallel stamping
      const workerPool = await this.getOrCreateWorkerPool()
      if (!workerPool) {
        throw new Error("Failed to create stamp worker pool")
      }

      // Build ACT config for stamper mode
      const actConfig: ActUploadConfig = {
        bee: this.bee,
        stamper: this.stamper,
        workerPool,
      }

      // Serialize write through Web Locks API to prevent concurrent uploads
      const result = await this.withWriteLock(async () => {
        // Add grantees to ACT
        const addResult = await addGranteesToAct(
          actConfig,
          historyReference,
          publisherPrivateKey,
          newGranteePublicKeys,
          undefined,
          requestOptions,
        )

        // Save stamper state after successful upload
        await this.saveStamperState()

        return addResult
      })

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "actAddGranteesResponse",
            requestId,
            historyReference: result.historyReference,
            granteeListReference: result.granteeListReference,
            actReference: result.actReference,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "ACT add grantees failed",
      )
    }
  }

  private async handleActRevokeGrantees(
    message: ActRevokeGranteesMessage,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      historyReference,
      encryptedReference,
      revokeGrantees,
      requestOptions,
    } = message

    try {
      if (!this.authenticated || !this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }

      this.ensureCanUpload()

      // Use appSecret as publisher private key (user's identity key for this app)
      const publisherPrivateKey = hexToUint8Array(this.appSecret)

      // Parse grantee public keys from compressed hex
      const revokePublicKeys = revokeGrantees.map((hex) =>
        parseCompressedPublicKey(hex),
      )

      // Handle subsidised gateway mode - gateway handles stamping server-side
      if (this.isSubsidisedModeActive()) {
        const actConfig: ActUploadConfig = {
          bee: this.bee,
          subsidisedGatewayUrl: this.subsidisedGatewayUrl!,
        }

        // Revoke grantees from ACT (performs key rotation)
        const result = await revokeGranteesFromAct(
          actConfig,
          historyReference,
          encryptedReference,
          publisherPrivateKey,
          revokePublicKeys,
          undefined,
          requestOptions,
        )

        if (event.source) {
          ;(event.source as WindowProxy).postMessage(
            {
              type: "actRevokeGranteesResponse",
              requestId,
              encryptedReference: result.encryptedReference,
              historyReference: result.historyReference,
              granteeListReference: result.granteeListReference,
              actReference: result.actReference,
            } satisfies IframeToParentMessage,
            { targetOrigin: event.origin },
          )
        }
        return
      }

      // User stamp mode - validate stamp and stamper
      if (!this.signerKey || !this.postageBatchId) {
        throw new Error(
          "Signer key and postage batch ID required. Please login first.",
        )
      }

      if (!this.stamper) {
        throw new Error("Stamper not initialized. Please login first.")
      }

      // Create worker pool for parallel stamping
      const workerPool = await this.getOrCreateWorkerPool()
      if (!workerPool) {
        throw new Error("Failed to create stamp worker pool")
      }

      // Build ACT config for stamper mode
      const actConfig: ActUploadConfig = {
        bee: this.bee,
        stamper: this.stamper,
        workerPool,
      }

      // Serialize write through Web Locks API to prevent concurrent uploads
      const result = await this.withWriteLock(async () => {
        // Revoke grantees from ACT (performs key rotation)
        const revokeResult = await revokeGranteesFromAct(
          actConfig,
          historyReference,
          encryptedReference,
          publisherPrivateKey,
          revokePublicKeys,
          undefined,
          requestOptions,
        )

        // Save stamper state after successful upload
        await this.saveStamperState()

        return revokeResult
      })

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "actRevokeGranteesResponse",
            requestId,
            encryptedReference: result.encryptedReference,
            historyReference: result.historyReference,
            granteeListReference: result.granteeListReference,
            actReference: result.actReference,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "ACT revoke grantees failed",
      )
    }
  }

  private async handleActGetGrantees(
    message: ActGetGranteesMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, historyReference, requestOptions } = message

    try {
      if (!this.authenticated || !this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }

      // appSecret is already checked by authenticated check above
      // Use appSecret as publisher private key (user's identity key for this app)
      const publisherPrivateKey = hexToUint8Array(this.appSecret)

      // Get grantees from ACT
      const grantees = await getGranteesFromAct(
        this.bee,
        historyReference,
        publisherPrivateKey,
        requestOptions,
      )

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "actGetGranteesResponse",
            requestId,
            grantees,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "ACT get grantees failed",
      )
    }
  }

  private async handleGetPostageBatch(
    message: GetPostageBatchMessage,
    event: MessageEvent,
  ): Promise<void> {
    const stamp = this.lookupPostageStampForApp()

    if (!stamp) {
      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "getPostageBatchResponse",
            requestId: message.requestId,
            postageBatch: undefined,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
      return
    }

    // Fetch current price from Swarmscan to calculate TTL
    let batchTTL: number | undefined = stamp.batchTTL
    try {
      const pricePerGBPerMonth = await fetchSwarmPrice()
      batchTTL = calculateTTLSeconds(stamp.amount, pricePerGBPerMonth)
    } catch (error) {
      console.warn("[Proxy] Failed to calculate TTL:", error)
    }

    // Map PostageStamp to public PostageBatch (exclude signerKey, accountId)
    const postageBatch: PostageBatch = {
      batchID: stamp.batchID.toHex(),
      utilization: stamp.utilization,
      usable: stamp.usable,
      label: "", // PostageStamp doesn't store label
      depth: stamp.depth,
      amount: stamp.amount.toString(),
      bucketDepth: stamp.bucketDepth,
      blockNumber: stamp.blockNumber,
      immutableFlag: stamp.immutableFlag,
      exists: stamp.exists,
      batchTTL,
    }

    if (event.source) {
      ;(event.source as WindowProxy).postMessage(
        {
          type: "getPostageBatchResponse",
          requestId: message.requestId,
          postageBatch,
        } satisfies IframeToParentMessage,
        { targetOrigin: event.origin },
      )
    }
  }

  /**
   * Handle createFeedManifest request
   * Creates a feed manifest for accessing feed content via URL
   */
  private async handleCreateFeedManifest(
    message: CreateFeedManifestMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { topic, owner, feedType, uploadOptions, requestOptions } = message

    // Resolve owner - use provided or fall back to app signer
    let resolvedOwner = owner
    if (!resolvedOwner && this.appSecret) {
      const signerKeyObj = new PrivateKey(this.appSecret)
      resolvedOwner = signerKeyObj.publicKey().address().toHex()
    }

    if (!resolvedOwner) {
      this.sendErrorToParent(
        event,
        message.requestId,
        "No owner provided and no app signer available",
      )
      return
    }

    try {
      this.ensureCanUpload()

      // Handle subsidised gateway mode - gateway handles stamping server-side
      if (this.isSubsidisedModeActive()) {
        const reference = await this.createFeedManifestSubsidised(
          topic,
          resolvedOwner,
          feedType,
          uploadOptions?.encrypt !== false, // Default encrypted
        )

        if (event.source) {
          ;(event.source as WindowProxy).postMessage(
            {
              type: "createFeedManifestResponse",
              requestId: message.requestId,
              reference,
            } satisfies IframeToParentMessage,
            { targetOrigin: event.origin },
          )
        }
        return
      }

      // User stamp mode - validate stamp and stamper
      if (!this.postageBatchId) {
        throw new Error("No postage batch configured")
      }

      if (!this.stamper) {
        throw new Error("Stamper not initialized. Please login first.")
      }

      // Serialize write through Web Locks API to prevent concurrent uploads
      const result = await this.withWriteLock(async () => {
        // Use createFeedManifestDirect to build and upload the manifest locally
        // instead of calling bee.createFeedManifest (which uses /feeds endpoint)
        const createResult = await createFeedManifestDirect(
          this.bee,
          this.stamper!,
          topic,
          resolvedOwner,
          {
            encrypt: uploadOptions?.encrypt !== false, // Default encrypted
            feedType: feedType, // "Sequence" or "Epoch"
          },
          uploadOptions,
          requestOptions,
        )

        // Save stamper state after successful upload
        await this.saveStamperState()

        return createResult
      })

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "createFeedManifestResponse",
            requestId: message.requestId,
            reference: result.reference,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
    } catch (error) {
      this.sendErrorToParent(
        event,
        message.requestId,
        error instanceof Error ? error.message : "Create feed manifest failed",
      )
    }
  }

  /**
   * Create a feed manifest via subsidised gateway
   * Builds manifest locally and uploads chunks via /chunks endpoint
   */
  private async createFeedManifestSubsidised(
    topic: string,
    owner: string,
    feedType?: "Sequence" | "Epoch",
    encrypt: boolean = true,
  ): Promise<string> {
    const subsidisedTarget: UploadTarget = {
      mode: "subsidised",
      gatewayUrl: this.subsidisedGatewayUrl!,
    }

    // Normalize owner (remove 0x prefix if present)
    const normalizedOwner = owner.startsWith("0x") ? owner.slice(2) : owner

    // Create root MantarayNode with "/" fork containing feed metadata
    const rootNode = new MantarayNode()
    rootNode.addFork("/", NULL_ADDRESS, {
      "swarm-feed-owner": normalizedOwner,
      "swarm-feed-topic": topic,
      "swarm-feed-type": feedType ?? "Sequence",
    })

    // Get the "/" child node (addFork created it)
    // 47 is ASCII code for '/'
    const slashFork = rootNode.forks.get(47)
    if (!slashFork) {
      throw new Error("Failed to create '/' fork")
    }
    const slashNode = slashFork.node

    // Marshal and upload the "/" child node FIRST (saveRecursively pattern)
    const slashNodeData = await slashNode.marshal()
    const slashChunk = makeContentAddressedChunk(slashNodeData)

    await uploadChunk(subsidisedTarget, slashChunk.data)

    // Set the child's selfAddress to the uploaded chunk address
    slashNode.selfAddress = slashChunk.address.toUint8Array()

    // Marshal the root node
    const rootNodeData = await rootNode.marshal()

    if (encrypt) {
      // Encrypted upload for root
      const encryptedChunk = makeEncryptedContentAddressedChunk(rootNodeData)

      await uploadChunk(subsidisedTarget, encryptedChunk.data)

      // Return 64-byte reference (address + key)
      const ref = new Uint8Array(64)
      ref.set(encryptedChunk.address.toUint8Array(), 0)
      ref.set(encryptedChunk.encryptionKey, 32)
      return uint8ArrayToHex(ref)
    } else {
      // Unencrypted upload for root
      const rootChunk = makeContentAddressedChunk(rootNodeData)

      await uploadChunk(subsidisedTarget, rootChunk.data)

      // Return 32-byte reference
      return rootChunk.address.toHex()
    }
  }
}

/**
 * Initialize the proxy (called from HTML page)
 */
export function initProxy(): SwarmIdProxy {
  return new SwarmIdProxy()
}
