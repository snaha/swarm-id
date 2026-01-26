import type {
  ParentToIframeMessage,
  IframeToParentMessage,
  PopupToIframeMessage,
  ButtonStyles,
  ButtonConfig,
  RequestAuthMessage,
  SetSecretMessage,
  UploadDataMessage,
  DownloadDataMessage,
  UploadFileMessage,
  DownloadFileMessage,
  UploadChunkMessage,
  DownloadChunkMessage,
  GetConnectionInfoMessage,
  AppMetadata,
  PostageStamp,
  ConnectedApp,
} from "./types"
import {
  ParentToIframeMessageSchema,
  PopupToIframeMessageSchema,
} from "./types"
import { Bee, makeContentAddressedChunk, BatchId } from "@ethersphere/bee-js"
import { uploadDataWithSigning } from "./proxy/upload-data"
import { uploadEncryptedDataWithSigning } from "./proxy/upload-encrypted-data"
import { downloadDataWithChunkAPI } from "./proxy/download-data"
import type { UploadContext, UploadProgress } from "./proxy/types"
import { UtilizationAwareStamper } from "./utils/batch-utilization"
import { UtilizationCacheDB } from "./storage/utilization-cache"
import {
  createConnectedAppsStorageManager,
  createIdentitiesStorageManager,
  createPostageStampsStorageManager,
  createNetworkSettingsStorageManager,
} from "./utils/storage-managers"
import { DEFAULT_BEE_NODE_URL } from "./schemas"
import { buildAuthUrl } from "./utils/url"

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
  private stamperDepth: number = 23 // Default depth
  private utilizationCache: UtilizationCacheDB | undefined
  private beeApiUrl: string
  private authButtonContainer: HTMLElement | undefined
  private currentStyles: ButtonStyles | undefined
  private buttonConfig: ButtonConfig | undefined
  private popupMode: "popup" | "window" = "window"
  private appMetadata: AppMetadata | undefined
  private bee: Bee
  private unsubscribeConnectedApps: (() => void) | undefined
  private isConnecting: boolean = false
  private hasStorageAccess: boolean = false

  constructor() {
    // Load Bee API URL from network settings, falling back to default
    const networkSettings = createNetworkSettingsStorageManager().load()
    this.beeApiUrl = networkSettings?.beeNodeUrl || DEFAULT_BEE_NODE_URL
    this.bee = new Bee(this.beeApiUrl)
    this.setupMessageListener()
    this.setupConnectedAppsListener()
    console.log(
      "[Proxy] Proxy initialized with Bee API from network settings:",
      this.beeApiUrl,
    )

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
      console.log("[Proxy] Already subscribed to connected apps storage")
      return
    }

    const connectedAppsManager = createConnectedAppsStorageManager()
    this.unsubscribeConnectedApps = connectedAppsManager.subscribe(
      (connectedApps) => {
        this.handleConnectedAppsChange(connectedApps)
      },
    )
    console.log("[Proxy] Subscribed to connected apps storage changes")
  }

  /**
   * Handle changes to connected apps storage (triggered by storage events from other windows)
   * Handles both new connections and disconnections.
   */
  private async handleConnectedAppsChange(
    connectedApps: ConnectedApp[],
  ): Promise<void> {
    // Skip if parent not identified yet
    if (!this.parentOrigin) {
      return
    }

    console.log(
      "[Proxy] Connected apps storage changed, checking connection for:",
      this.parentOrigin,
    )

    // Look for a valid connection for this parent origin
    const connectedApp = connectedApps.find(
      (app) => app.appUrl === this.parentOrigin,
    )

    const hasValidConnection =
      connectedApp && this.isConnectionValid(connectedApp)

    if (hasValidConnection && !this.authenticated) {
      // New connection detected
      console.log(
        "[Proxy] Found new valid connection via storage event for:",
        this.parentOrigin,
      )

      // Set auth data
      this.appSecret = connectedApp.appSecret
      this.authenticated = true
      this.authLoading = false

      // Look up postage stamp from shared storage
      const stamp = this.lookupPostageStampForApp()
      if (stamp) {
        this.postageBatchId = stamp.batchID.toHex()
        this.signerKey = stamp.signerKey.toHex()
        await this.initializeStamper()
      } else {
        console.log("[Proxy] No postage stamp found for connected identity")
        this.postageBatchId = undefined
        this.signerKey = undefined
      }

      // Update button
      this.showAuthButton()

      // Notify parent dApp
      this.sendToParent({
        type: "authSuccess",
        origin: this.parentOrigin,
      })

      console.log(
        "[Proxy] Notified parent of successful authentication (via storage event)",
      )
    } else if (!hasValidConnection && this.authenticated) {
      // Connection removed or invalidated - disconnect
      console.log(
        "[Proxy] Connection removed or expired via storage event for:",
        this.parentOrigin,
      )

      // Clear auth data
      this.clearAuthData()

      // Notify parent about disconnection
      this.sendToParent({
        type: "disconnectResponse",
        requestId: "storage-event",
        success: true,
      })

      console.log("[Proxy] Notified parent of disconnection (via storage event)")
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
      console.log("[Proxy] Unsubscribed from connected apps storage changes")
    }
  }

  /**
   * Announce that proxy is ready to receive messages
   * Broadcasts to parent with wildcard origin since we don't know parent origin yet
   */
  private announceReady(): void {
    if (window.parent && window.parent !== window) {
      console.log("[Proxy] Announcing readiness to parent window")
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

    try {
      // Initialize utilization cache if not already done
      if (!this.utilizationCache) {
        this.utilizationCache = new UtilizationCacheDB()
      }

      // Create utilization-aware stamper
      // Note: owner and encryptionKey are optional - not provided here since
      // the proxy doesn't have access to them. The stamper will still track
      // bucket usage locally in IndexedDB.
      this.stamper = await UtilizationAwareStamper.create(
        this.signerKey,
        new BatchId(this.postageBatchId),
        this.stamperDepth,
        this.utilizationCache,
      )

      console.log(
        "[Proxy] Utilization-aware stamper initialized with depth:",
        this.stamperDepth,
      )
    } catch (error) {
      console.error("[Proxy] Failed to initialize stamper:", error)
      this.stamper = undefined
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
      await this.stamper.flush()
    } catch (error) {
      console.error("[Proxy] Failed to save stamper state:", error)
    }
  }

  /**
   * Setup message listener for parent and popup messages
   */
  private setupMessageListener(): void {
    window.addEventListener("message", async (event: MessageEvent) => {
      console.log(
        "[Proxy] Message received:",
        event.data.type,
        "from:",
        event.origin,
      )

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

      // Validate origin
      const isPopup = event.origin === window.location.origin
      const isParent = event.origin === this.parentOrigin

      // Handle setButtonStyles message (UI-only, not in schema)
      if (type === "setButtonStyles" && isParent) {
        this.currentStyles = event.data.styles
        console.log("[Proxy] Button styles updated")
        // Re-render button if not authenticated
        if (!this.authenticated && this.authButtonContainer) {
          this.showAuthButton()
        }
        return
      }

      if (!isPopup && !isParent) {
        console.warn(
          "[Proxy] Rejected message from unauthorized origin:",
          event.origin,
        )
        return
      }

      try {
        // Try to parse as parent message first
        if (isParent) {
          try {
            const message = ParentToIframeMessageSchema.parse(event.data)
            await this.handleParentMessage(message, event)
            return
          } catch (error) {
            console.warn("[Proxy] Invalid parent message:", error)
          }
        }

        // Try to parse as popup message
        if (isPopup) {
          try {
            const message = PopupToIframeMessageSchema.parse(event.data)
            await this.handlePopupMessage(message, event)
            return
          } catch (error) {
            // Avoid excessive logging with Metamask
            if (event.data.target !== "metamask-inpage") {
              console.warn("[Proxy] Invalid popup message:", error, event.data)
            }
          }
        }

        // Unknown message type
        console.warn("[Proxy] Unknown message type:", type)
        this.sendErrorToParent(
          event,
          event.data.requestId,
          `Unknown message type: ${type}`,
        )
      } catch (error) {
        console.error("[Proxy] Error handling message:", error)
        this.sendErrorToParent(
          event,
          event.data.requestId,
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

    console.log("[Proxy] Parent identified via postMessage:", this.parentOrigin)
    console.log("[Proxy] Parent locked in - cannot be changed")
    console.log(
      "[Proxy] Using Bee API URL from network settings:",
      this.beeApiUrl,
    )

    // Use parent's popup mode if provided
    if (parentPopupMode) {
      this.popupMode = parentPopupMode
      console.log("[Proxy] Using popup mode from parent:", this.popupMode)
    }

    // Store metadata from parent
    if (parentMetadata) {
      this.appMetadata = parentMetadata
      console.log(
        "[Proxy] Received app metadata from parent:",
        parentMetadata.name,
      )
    }

    // Store button config from parent
    if (parentButtonConfig) {
      this.buttonConfig = parentButtonConfig
      console.log("[Proxy] Received button config from parent")
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

      default:
        // TypeScript should ensure this is never reached
        const exhaustiveCheck: never = message
        console.warn("[Proxy] Unhandled message type:", exhaustiveCheck)
    }
  }

  /**
   * Handle messages from popup window
   */
  private async handlePopupMessage(
    message: PopupToIframeMessage,
    event: MessageEvent,
  ): Promise<void> {
    switch (message.type) {
      case "setSecret":
        await this.handleSetSecret(message, event)
        break
    }
  }

  /**
   * Check if Storage Access API is available
   */
  private hasStorageAccessAPI(): boolean {
    return (
      typeof document.hasStorageAccess === "function" &&
      typeof document.requestStorageAccess === "function"
    )
  }

  /**
   * Request unpartitioned storage access using the Storage Access API.
   * This allows the iframe to access the same localStorage as the top-level context.
   * Must be called from a user gesture (click handler).
   * @returns true if access was granted, false otherwise
   */
  private async requestStorageAccess(): Promise<boolean> {
    if (!this.hasStorageAccessAPI()) {
      console.log("[Proxy] Storage Access API not available")
      return false
    }

    try {
      // Check if we already have access
      const hasAccess = await document.hasStorageAccess()
      if (hasAccess) {
        console.log("[Proxy] Already have storage access")
        this.hasStorageAccess = true
        return true
      }

      // Request access - must be called from user gesture
      console.log("[Proxy] Requesting storage access...")
      await document.requestStorageAccess()
      console.log("[Proxy] Storage access granted!")
      this.hasStorageAccess = true

      return true
    } catch (error) {
      console.log("[Proxy] Storage access denied or failed:", error)
      this.hasStorageAccess = false
      return false
    }
  }

  /**
   * Check if we should use shared storage (either not in iframe, have storage access, or dev mode)
   */
  private canUseSharedStorage(): boolean {
    return this.hasStorageAccess || !this.isInIframe()
  }

  /**
   * Check if running inside an iframe
   */
  private isInIframe(): boolean {
    try {
      return window.self !== window.top
    } catch {
      // Cross-origin iframes throw an error
      return true
    }
  }

  /**
   * Load authentication data.
   * - If shared storage is accessible: reads from shared storage (ConnectedApp records)
   * - If partitioned (iframe without Storage Access): uses in-memory values (set by handleSetSecret)
   */
  private async loadAuthData(): Promise<void> {
    if (!this.parentOrigin) {
      console.log("[Proxy] No parent origin, cannot load auth data")
      this.authLoading = false
      return
    }

    // Try to restore Storage Access permission if in iframe
    // This allows auth to persist across page reloads
    if (this.isInIframe() && this.hasStorageAccessAPI()) {
      try {
        const hasAccess = await document.hasStorageAccess()
        if (hasAccess) {
          this.hasStorageAccess = true
          console.log("[Proxy] Storage access restored from previous grant")
        }
      } catch {
        // Ignore - will fall back to showing login button
      }
    }

    if (!this.canUseSharedStorage()) {
      // Storage is partitioned - we can't read shared storage.
      // User must authenticate, which will either:
      // 1. Request Storage Access API and then read shared storage, or
      // 2. Receive auth data via postMessage from the popup
      console.log(
        "[Proxy] Storage partitioned - shared storage not accessible, requires auth for:",
        this.parentOrigin,
      )
      this.authLoading = false
      this.showAuthButton()
    } else {
      // We have access to shared storage (not in iframe, or Storage Access granted)
      const sharedData = this.lookupAppSecretFromSharedStorage()

      if (sharedData) {
        console.log(
          "[Proxy] Auth data loaded from shared storage for:",
          this.parentOrigin,
        )
        this.appSecret = sharedData.secret
        this.authenticated = true
        this.authLoading = false
        this.showAuthButton()

        // Look up postage stamp from shared storage based on connected identity
        const stamp = this.lookupPostageStampForApp()
        if (stamp) {
          this.postageBatchId = stamp.batchID.toHex()
          this.signerKey = stamp.signerKey.toHex()
          await this.initializeStamper()
        } else {
          console.log("[Proxy] No postage stamp found for connected identity")
          this.postageBatchId = undefined
          this.signerKey = undefined
        }
      } else {
        console.log(
          "[Proxy] No valid auth data found in shared storage for:",
          this.parentOrigin,
        )
        this.authLoading = false
        this.showAuthButton()
      }
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
      const connectedApp = connectedApps.find(
        (app) => app.appUrl === this.parentOrigin,
      )

      if (!connectedApp) {
        console.log("[Proxy] No connected app found for:", this.parentOrigin)
        return undefined
      }

      // Load identities to find the account for this identity
      const identitiesManager = createIdentitiesStorageManager()
      const identities = identitiesManager.load()
      const identity = identities.find((i) => i.id === connectedApp.identityId)

      if (!identity) {
        console.log("[Proxy] Identity not found:", connectedApp.identityId)
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
        console.log(
          "[Proxy] Found postage stamp for identity:",
          stamp.batchID.toHex(),
        )
      }

      return stamp
    } catch (error) {
      console.error("[Proxy] Error looking up postage stamp:", error)
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
      const connectedApp = connectedApps.find(
        (app) => app.appUrl === this.parentOrigin,
      )

      if (!connectedApp) {
        console.log(
          "[Proxy] No connected app found in shared storage for:",
          this.parentOrigin,
        )
        return undefined
      }

      // Check if connection is still valid
      if (!this.isConnectionValid(connectedApp)) {
        console.log(
          "[Proxy] Connection expired for:",
          this.parentOrigin,
          "connectedUntil:",
          connectedApp.connectedUntil,
        )
        return undefined
      }

      if (!connectedApp.appSecret) {
        console.log(
          "[Proxy] No appSecret in connected app record for:",
          this.parentOrigin,
        )
        return undefined
      }

      console.log(
        "[Proxy] Found valid app secret in shared storage for:",
        this.parentOrigin,
      )
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
   * Update authentication status and update button accordingly
   */
  private updateAuthStatus(authenticated: boolean): void {
    this.authenticated = authenticated
    this.authLoading = false
    this.isConnecting = false
    // Always show button - it will display as login or disconnect based on auth status
    this.showAuthButton()
  }

  /**
   * Clear authentication data
   */
  private clearAuthData(): void {
    if (!this.parentOrigin) {
      console.log("[Proxy] No parent origin, cannot clear auth data")
      return
    }

    console.log("[Proxy] Clearing auth data for:", this.parentOrigin)

    // Clear stamper state from localStorage
    const stamperKey = `swarm-stamper-${this.parentOrigin}-${this.postageBatchId}`
    localStorage.removeItem(stamperKey)

    // Reset auth state
    this.authenticated = false
    this.authLoading = false
    this.appSecret = undefined
    this.postageBatchId = undefined
    this.signerKey = undefined
    this.stamper = undefined

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

  /**
   * Send message to parent
   */
  private sendToParent(message: IframeToParentMessage): void {
    if (!this.parentOrigin || !window.parent || window.parent === window.self) {
      console.warn("[Proxy] Cannot send message to parent - no parent window")
      return
    }

    window.parent.postMessage(message, this.parentOrigin)
  }

  // ============================================================================
  // Message Handlers
  // ============================================================================

  private handleCheckAuth(
    message: { type: "checkAuth"; requestId: string },
    event: MessageEvent,
  ): void {
    console.log("[Proxy] Checking authentication status...")

    if (event.source) {
      ;(event.source as WindowProxy).postMessage(
        {
          type: "authStatusResponse",
          requestId: message.requestId,
          authenticated: this.authenticated,
          origin: this.authenticated ? this.parentOrigin : undefined,
        } satisfies IframeToParentMessage,
        { targetOrigin: event.origin },
      )
    }

    console.log("[Proxy] Authentication status:", this.authenticated)
  }

  private handleGetConnectionInfo(
    message: GetConnectionInfoMessage,
    event: MessageEvent,
  ): void {
    console.log("[Proxy] Getting connection info...")

    let identity: { id: string; name: string; address: string } | undefined =
      undefined

    // Look up identity info if authenticated
    if (this.authenticated && this.parentOrigin) {
      try {
        const connectedAppsManager = createConnectedAppsStorageManager()
        const connectedApps = connectedAppsManager.load()
        const connectedApp = connectedApps.find(
          (app) => app.appUrl === this.parentOrigin,
        )

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
              address: foundIdentity.accountId.toHex(),
            }
          }
        }
      } catch (error) {
        console.error("[Proxy] Error looking up identity:", error)
      }
    }

    // canUpload is true if we have both a postage batch ID and signer key
    const canUpload = !!(this.postageBatchId && this.signerKey)

    if (event.source) {
      ;(event.source as WindowProxy).postMessage(
        {
          type: "connectionInfoResponse",
          requestId: message.requestId,
          canUpload,
          identity,
        } satisfies IframeToParentMessage,
        { targetOrigin: event.origin },
      )
    }

    console.log("[Proxy] Connection info:", { canUpload, identity })
  }

  private handleDisconnect(
    message: { type: "disconnect"; requestId: string },
    event: MessageEvent,
  ): void {
    console.log("[Proxy] Disconnect requested...")

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

    console.log("[Proxy] Disconnected successfully")
  }

  private handleRequestAuth(
    message: RequestAuthMessage,
    _event: MessageEvent,
  ): void {
    console.log(
      "[Proxy] Request to show auth button for parent:",
      this.parentOrigin,
    )

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
    if (!this.authButtonContainer) {
      console.log("[Proxy] No auth button container set yet")
      return
    }

    if (this.isConnecting) {
      console.log("[Proxy] Skipping button render - auth popup is open")
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
    console.log(
      "[Proxy] Auth button shown (authenticated:",
      isAuthenticated,
      ")",
    )
  }

  /**
   * Open the authentication popup window.
   * Returns true if popup was opened, false if parent origin is not set.
   */
  private openAuthPopup(): boolean {
    if (!this.parentOrigin) {
      console.error("[Proxy] Cannot open auth window - parent origin not set")
      return false
    }

    console.log(
      "[Proxy] Opening authentication window for parent:",
      this.parentOrigin,
    )

    // Build authentication URL using shared utility
    // proxyMode=true: popup was opened from proxy iframe, so we validate
    // same-origin opener and send setSecret via postMessage
    // Get base path from current location (e.g., /id/pr-140/proxy -> /id/pr-140)
    const basePath = window.location.pathname.replace(/\/proxy$/, "")
    const authUrl = buildAuthUrl(
      window.location.origin + basePath,
      this.parentOrigin,
      this.appMetadata,
      true, // proxyMode - enables same-origin validation and setSecret message
    )

    // Open as popup or full window based on popupMode
    if (this.popupMode === "popup") {
      window.open(authUrl, "_blank", "width=500,height=600")
    } else {
      window.open(authUrl, "_blank")
    }

    return true
  }

  /**
   * Handle login button click
   */
  private async handleLoginClick(button: HTMLButtonElement): Promise<void> {
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

    // Request storage access (must be done during user gesture)
    // This allows the iframe to access unpartitioned localStorage
    if (!this.hasStorageAccess && this.isInIframe()) {
      await this.requestStorageAccess()
    }

    this.openAuthPopup()
  }

  /**
   * Handle disconnect button click
   */
  private handleDisconnectClick(): void {
    console.log("[Proxy] Disconnecting for parent:", this.parentOrigin)

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
    console.log("[Proxy] Auth button container set")
    // Show button now that container is available
    // (loadAuthData may have already run and set authenticated status)
    this.showAuthButton()
  }

  private async handleSetSecret(
    message: SetSecretMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { appOrigin, data } = message

    console.log("[Proxy] Received auth data for app:", appOrigin, data)

    // Validate that appOrigin matches parent origin
    if (appOrigin !== this.parentOrigin) {
      console.warn(
        "[Proxy] App origin mismatch:",
        appOrigin,
        "vs",
        this.parentOrigin,
      )
    }

    if (!this.canUseSharedStorage()) {
      // Storage is partitioned - we receive stamps and settings in the message
      console.log("[Proxy] Using auth data from message (partitioned storage)")
      this.appSecret = data.secret
      this.postageBatchId = data.postageBatchId
      this.signerKey = data.signerKey

      // Use network settings from message if provided
      if (data.networkSettings) {
        this.beeApiUrl = data.networkSettings.beeNodeUrl
        this.bee = new Bee(this.beeApiUrl)
        console.log("[Proxy] Using Bee API URL from message:", this.beeApiUrl)
      }
    } else {
      // We have access to shared storage - data is already there (set by auth popup)
      // Just update local state
      console.log(
        "[Proxy] Auth data stored in shared storage, updating local state",
      )
      this.appSecret = data.secret

      // Look up postage stamp from shared storage
      const stamp = this.lookupPostageStampForApp()
      if (stamp) {
        this.postageBatchId = stamp.batchID.toHex()
        this.signerKey = stamp.signerKey.toHex()
      }
    }

    this.updateAuthStatus(true)

    // Initialize stamper if we have signer key
    if (this.signerKey && this.postageBatchId) {
      await this.initializeStamper()
    }

    // Notify parent dApp
    this.sendToParent({
      type: "authSuccess",
      origin: appOrigin,
    })

    console.log("[Proxy] Notified parent of successful authentication")

    // Respond to popup (if still open)
    if (event.source && !(event.source as Window).closed) {
      ;(event.source as WindowProxy).postMessage(
        {
          type: "secretReceived",
          success: true,
        },
        { targetOrigin: event.origin },
      )
    }
  }

  private async handleUploadData(
    message: UploadDataMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, data, options, enableProgress } = message

    console.log("[Proxy] Upload data request, size:", data ? data.length : 0)

    try {
      if (!this.authenticated || !this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }

      if (!this.signerKey || !this.postageBatchId) {
        throw new Error(
          "Signer key and postage batch ID required. Please login first.",
        )
      }

      if (!this.stamper) {
        throw new Error("Stamper not initialized. Please login first.")
      }
      // Prepare upload context
      const context: UploadContext = {
        bee: this.bee,
        stamper: this.stamper,
      }

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

      // Client-side chunking and signing
      let uploadResult
      if (options?.encrypt) {
        console.log(
          "[Proxy] Using client-side signing with encryption for uploadData",
        )
        uploadResult = await uploadEncryptedDataWithSigning(
          context,
          data,
          undefined, // encryption key (auto-generated)
          options,
          onProgress,
        )
      } else {
        console.log("[Proxy] Using client-side signing for uploadData")
        uploadResult = await uploadDataWithSigning(
          context,
          data,
          options,
          onProgress,
        )
      }

      // Save stamper state after successful upload
      await this.saveStamperState()

      // Send final response
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

      console.log("[Proxy] Data uploaded:", uploadResult.reference)
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
    const { requestId, reference, options } = message

    console.log("[Proxy] Download data request, reference:", reference)
    if (!this.authenticated || !this.appSecret) {
      throw new Error("Not authenticated. Please login first.")
    }

    try {
      console.log("[Proxy] Downloading from Bee at:", this.beeApiUrl)

      // Download data using chunk API only (supports both regular and encrypted references)
      const data = await downloadDataWithChunkAPI(this.bee, reference, options)

      console.log("[Proxy] Download successful, data size:", data.length)

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

      console.log("[Proxy] Data downloaded:", reference)
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
    const { requestId, data, name, options } = message

    console.log(
      "[Proxy] Upload file request, name:",
      name,
      "size:",
      data ? data.length : 0,
    )

    try {
      if (!this.authenticated || !this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }

      // Check if only signer is available (no batch ID)
      if (this.signerKey && !this.postageBatchId) {
        throw new Error(
          "Signed uploads for files not yet implemented. Please use uploadChunk for signed uploads, or provide a postage batch ID for automatic chunking.",
        )
      }

      if (!this.postageBatchId) {
        throw new Error(
          "No postage batch ID available. Please authenticate with a valid batch ID.",
        )
      }
      console.log(
        "[Proxy] Uploading file to Bee at:",
        this.beeApiUrl,
        "with batch:",
        this.postageBatchId,
      )

      // Upload file using bee-js
      const uploadResult = await this.bee.uploadFile(
        this.postageBatchId,
        data,
        name,
        options,
      )

      console.log(
        "[Proxy] File upload successful, reference:",
        uploadResult.reference.toHex(),
      )

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "uploadFileResponse",
            requestId,
            reference: uploadResult.reference.toHex(),
            tagUid: uploadResult.tagUid,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }

      console.log("[Proxy] File uploaded:", uploadResult.reference.toHex())
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
    const { requestId, reference, path, options } = message

    console.log(
      "[Proxy] Download file request, reference:",
      reference,
      "path:",
      path,
    )
    if (!this.authenticated || !this.appSecret) {
      throw new Error("Not authenticated. Please login first.")
    }

    try {
      console.log("[Proxy] Downloading file from Bee at:", this.beeApiUrl)

      // Download file using bee-js
      const fileData = await this.bee.downloadFile(reference, path, options)

      console.log(
        "[Proxy] File download successful, data size:",
        fileData.data.toUint8Array().length,
      )

      // Convert Bytes to Uint8Array for postMessage
      const data = fileData.data.toUint8Array()

      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "downloadFileResponse",
            requestId,
            name: fileData.name || "file",
            data: data as Uint8Array,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }

      console.log("[Proxy] File downloaded:", reference)
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
    const { requestId, data, options } = message

    console.log("[Proxy] Upload chunk request, size:", data ? data.length : 0)

    try {
      if (!this.authenticated || !this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }

      if (!this.signerKey || !this.postageBatchId) {
        throw new Error(
          "Signer key and postage batch ID required. Please authenticate.",
        )
      }
      // Validate chunk size (must be between 1 and 4096 bytes)
      if (data.length < 1 || data.length > 4096) {
        throw new Error(
          `Invalid chunk size: ${data.length} bytes. Chunks must be between 1 and 4096 bytes.`,
        )
      }

      if (!this.stamper) {
        await this.initializeStamper()
      }

      if (!this.stamper) {
        throw new Error("Failed to initialize stamper for signing")
      }

      console.log("[Proxy] Signing and uploading chunk with signer key")

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
      const envelope = this.stamper.stamp(chunkAdapter)

      // Use non-deferred mode for faster uploads (returns immediately)
      const uploadOptions = { ...options, deferred: false, pin: false }

      // Upload with envelope signature
      const uploadResult = await this.bee.uploadChunk(
        envelope,
        chunk.data,
        uploadOptions,
      )

      console.log(
        "[Proxy] Chunk upload successful, reference:",
        uploadResult.reference.toHex(),
      )

      // Save stamper state after successful upload
      await this.saveStamperState()

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

      console.log("[Proxy] Chunk uploaded:", uploadResult.reference.toHex())
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
    const { requestId, reference, options } = message

    console.log("[Proxy] Download chunk request, reference:", reference)
    if (!this.authenticated || !this.appSecret) {
      throw new Error("Not authenticated. Please login first.")
    }

    try {
      console.log("[Proxy] Downloading chunk from Bee at:", this.beeApiUrl)

      // Download chunk using bee-js (returns Uint8Array directly)
      const data = await this.bee.downloadChunk(reference, options)

      console.log("[Proxy] Chunk download successful, data size:", data.length)

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

      console.log("[Proxy] Chunk downloaded:", reference)
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "Download failed",
      )
    }
  }
}

/**
 * Initialize the proxy (called from HTML page)
 */
export function initProxy(): SwarmIdProxy {
  return new SwarmIdProxy()
}
