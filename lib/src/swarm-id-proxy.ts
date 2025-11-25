import type {
  ProxyOptions,
  ParentToIframeMessage,
  IframeToParentMessage,
  PopupToIframeMessage,
  ButtonStyles,
  RequestAuthMessage,
  SetSecretMessage,
  UploadDataMessage,
  DownloadDataMessage,
  UploadFileMessage,
  DownloadFileMessage,
  UploadChunkMessage,
  DownloadChunkMessage,
} from "./types"
import {
  ParentToIframeMessageSchema,
  PopupToIframeMessageSchema,
} from "./types"
import { Bee, Stamper, makeContentAddressedChunk } from "@ethersphere/bee-js"
import { uploadDataWithSigning } from "./proxy/upload-data"
import { uploadEncryptedDataWithSigning } from "./proxy/upload-encrypted-data"
import { downloadDataWithChunkAPI } from "./proxy/download-data"
import type { UploadContext, UploadProgress } from "./proxy/types"

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
  private appSecret: string | undefined
  private postageBatchId: string | undefined
  private signerKey: string | undefined
  private stamper: any | undefined  // Stamper from bee-js
  private stamperDepth: number = 23  // Default depth
  private beeApiUrl: string
  private defaultBeeApiUrl: string
  private allowedOrigins: string[]
  private authButtonContainer: HTMLElement | undefined
  private currentStyles: ButtonStyles | undefined
  private popupMode: "popup" | "window" = "window"
  private bee: Bee

  constructor(options: ProxyOptions) {
    this.defaultBeeApiUrl = options.beeApiUrl
    this.beeApiUrl = options.beeApiUrl
    this.allowedOrigins = options.allowedOrigins || []
    this.bee = new Bee(this.beeApiUrl)
    this.setupMessageListener()
    console.log(
      "[Proxy] Proxy initialized with default Bee API:",
      this.defaultBeeApiUrl,
    )
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
   */
  private initializeStamper(): void {
    if (!this.signerKey || !this.postageBatchId) {
      console.warn("[Proxy] Cannot initialize stamper: missing signer key or batch ID")
      return
    }

    try {
      // Try to load existing bucket state from localStorage
      const bucketState = this.loadStamperState()

      if (bucketState) {
        // Restore from saved state
        this.stamper = Stamper.fromState(
          this.signerKey,
          this.postageBatchId,
          bucketState,
          this.stamperDepth
        )
        console.log("[Proxy] Stamper restored from saved state")
      } else {
        // Create new blank stamper
        this.stamper = Stamper.fromBlank(
          this.signerKey,
          this.postageBatchId,
          this.stamperDepth
        )
        console.log("[Proxy] Stamper initialized fresh with depth:", this.stamperDepth)
      }
    } catch (error) {
      console.error("[Proxy] Failed to initialize stamper:", error)
      this.stamper = undefined
    }
  }

  /**
   * Save stamper bucket state to localStorage (sparse representation)
   * Only saves non-zero buckets to minimize storage and serialization time
   */
  private saveStamperState(): void {
    if (!this.stamper || !this.parentOrigin || !this.postageBatchId) {
      return
    }

    try {
      const buckets = this.stamper.getState()
      const storageKey = `swarm-stamper-${this.parentOrigin}-${this.postageBatchId}`

      // Save only non-zero buckets as sparse array: [[index, value], [index, value], ...]
      const sparse: Array<[number, number]> = []
      for (let i = 0; i < buckets.length; i++) {
        if (buckets[i] !== 0) {
          sparse.push([i, buckets[i]])
        }
      }

      localStorage.setItem(storageKey, JSON.stringify(sparse))
    } catch (error) {
      console.error("[Proxy] Failed to save stamper state:", error)
    }
  }

  /**
   * Load stamper bucket state from localStorage (sparse representation)
   */
  private loadStamperState(): Uint32Array | undefined {
    if (!this.parentOrigin || !this.postageBatchId) {
      return undefined
    }

    try {
      const storageKey = `swarm-stamper-${this.parentOrigin}-${this.postageBatchId}`
      const stored = localStorage.getItem(storageKey)

      if (stored) {
        const sparse: Array<[number, number]> = JSON.parse(stored)
        const buckets = new Uint32Array(65536)

        // Restore non-zero buckets from sparse representation
        for (const [index, value] of sparse) {
          buckets[index] = value
        }

        return buckets
      }
    } catch (error) {
      console.error("[Proxy] Failed to load stamper state:", error)
    }

    return undefined
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
        this.handleParentIdentify(event)
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
            console.warn("[Proxy] Invalid popup message:", error)
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
  private handleParentIdentify(event: MessageEvent): void {
    // Prevent parent from changing after first identification
    if (this.parentIdentified) {
      console.error("[Proxy] Parent already identified! Ignoring duplicate.")
      return
    }

    // Parse the message to get optional parameters
    const message = event.data
    const parentBeeApiUrl = message.beeApiUrl
    const parentPopupMode = message.popupMode

    // Trust event.origin - this is browser-enforced and cannot be spoofed
    this.parentOrigin = event.origin
    this.parentIdentified = true

    console.log("[Proxy] Parent identified via postMessage:", this.parentOrigin)
    console.log("[Proxy] Parent locked in - cannot be changed")

    // Validate parent is in allowlist (if allowlist is configured)
    if (
      this.allowedOrigins.length > 0 &&
      !this.isAllowedOrigin(this.parentOrigin)
    ) {
      const errorMsg = `Origin validation failed! Expected one of: ${this.allowedOrigins.join(", ")}, but received: ${this.parentOrigin}`
      console.error("[Proxy]", errorMsg)

      // Send error to parent so it doesn't hang
      if (event.source) {
        ;(event.source as WindowProxy).postMessage(
          {
            type: "initError",
            error: errorMsg,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        )
      }
      return
    }

    // Use parent's Bee API URL if provided, otherwise use default
    if (parentBeeApiUrl) {
      this.beeApiUrl = parentBeeApiUrl
      this.bee = new Bee(this.beeApiUrl)
      console.log("[Proxy] Using Bee API URL from parent:", this.beeApiUrl)
    } else {
      console.log("[Proxy] Using default Bee API URL:", this.beeApiUrl)
    }

    // Use parent's popup mode if provided
    if (parentPopupMode) {
      this.popupMode = parentPopupMode
      console.log("[Proxy] Using popup mode from parent:", this.popupMode)
    }

    // Load existing secret if available
    this.loadAuthData()

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
        this.handleCheckAuth(event)
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
   * Check if origin is allowed
   */
  private isAllowedOrigin(origin: string): boolean {
    if (this.allowedOrigins.length === 0) {
      return true // If no allowlist, allow all
    }
    return this.allowedOrigins.includes(origin)
  }

  /**
   * Load secret from localStorage
   */
  private loadAuthData(): void {
    if (!this.parentOrigin) {
      console.log("[Proxy] No parent origin, cannot load auth data")
      return
    }

    const storageKey = `swarm-secret-${this.parentOrigin}`
    const storedData = localStorage.getItem(storageKey)

    if (storedData) {
      try {
        const data = JSON.parse(storedData)
        console.log(
          "[Proxy] Auth data loaded from localStorage for:",
          this.parentOrigin,
        )
        this.appSecret = data.secret
        this.postageBatchId = data.postageBatchId
        this.signerKey = data.signerKey
        this.authenticated = true
        this.hideAuthButton()

        // Initialize stamper if we have signer key and batch ID
        // (both are required for client-side signing)
        if (this.signerKey && this.postageBatchId) {
          this.initializeStamper()
        }
      } catch (error) {
        console.error("[Proxy] Failed to parse auth data:", error)
        this.showAuthButton()
      }
    } else {
      console.log("[Proxy] No auth data found for:", this.parentOrigin)
      this.showAuthButton()
    }
  }

  /**
   * Update authentication status and show/hide button accordingly
   */
  private updateAuthStatus(authenticated: boolean): void {
    this.authenticated = authenticated
    if (authenticated) {
      this.hideAuthButton()
    } else {
      this.showAuthButton()
    }
  }

  /**
   * Save secret to localStorage
   */
  private saveAuthData(origin: string, data: { secret: string; postageBatchId?: string; signerKey?: string }): void {
    const storageKey = `swarm-secret-${origin}`
    localStorage.setItem(storageKey, JSON.stringify(data))
    console.log("[Proxy] Auth data saved to localStorage for:", origin)
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

  private handleCheckAuth(event: MessageEvent): void {
    console.log("[Proxy] Checking authentication status...")

    if (event.source) {
      ;(event.source as WindowProxy).postMessage(
        {
          type: "authStatusResponse",
          authenticated: this.authenticated,
          origin: this.authenticated ? this.parentOrigin : undefined,
        } satisfies IframeToParentMessage,
        { targetOrigin: event.origin },
      )
    }

    console.log("[Proxy] Authentication status:", this.authenticated)
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

    // Clear existing content
    this.authButtonContainer.innerHTML = ""

    // Create button
    const button = document.createElement("button")
    button.textContent = "🔐 Login with Swarm ID"

    // Apply styles
    const styles = this.currentStyles || {}
    button.style.backgroundColor = styles.backgroundColor || "#dd7200"
    button.style.color = styles.color || "white"
    button.style.border = styles.border || "none"
    button.style.borderRadius = styles.borderRadius || "6px"
    button.style.padding = styles.padding || "12px 24px"
    button.style.fontSize = styles.fontSize || "14px"
    button.style.fontWeight = styles.fontWeight || "600"
    button.style.cursor = styles.cursor || "pointer"
    button.style.transition = "all 0.2s"
    button.style.boxShadow = "0 2px 8px rgba(221, 114, 0, 0.3)"

    // Hover effect
    button.addEventListener("mouseenter", () => {
      button.style.transform = "translateY(-1px)"
      button.style.boxShadow = "0 4px 12px rgba(221, 114, 0, 0.5)"
    })
    button.addEventListener("mouseleave", () => {
      button.style.transform = "translateY(0)"
      button.style.boxShadow = "0 2px 8px rgba(221, 114, 0, 0.3)"
    })

    // Click handler - open auth popup or window
    button.addEventListener("click", () => {
      if (!this.parentOrigin) {
        console.error("[Proxy] Cannot open auth window - parent origin not set")
        return
      }
      console.log(
        "[Proxy] Opening authentication window for parent:",
        this.parentOrigin,
      )

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

      const authUrl = `${window.location.origin}/connect?origin=${encodeURIComponent(this.parentOrigin)}`

      // Open as popup or full window based on popupMode
      if (this.popupMode === "popup") {
        window.open(authUrl, "_blank", "width=500,height=600")
      } else {
        window.open(authUrl, "_blank")
      }
    })

    this.authButtonContainer.appendChild(button)
    console.log("[Proxy] Auth button shown")
  }

  /**
   * Hide authentication button
   */
  private hideAuthButton(): void {
    if (!this.authButtonContainer) {
      return
    }

    // Clear the button
    this.authButtonContainer.innerHTML = ""
    console.log("[Proxy] Auth button hidden")
  }

  /**
   * Set container element for auth button
   */
  setAuthButtonContainer(container: HTMLElement): void {
    this.authButtonContainer = container
    console.log("[Proxy] Auth button container set")
    // Don't show button here - let loadAuthData() handle it after checking auth status
  }

  private async handleSetSecret(
    message: SetSecretMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { appOrigin, data } = message

    console.log("[Proxy] Received auth data for app:", appOrigin)

    // Validate that appOrigin matches parent origin
    if (appOrigin !== this.parentOrigin) {
      console.warn(
        "[Proxy] App origin mismatch:",
        appOrigin,
        "vs",
        this.parentOrigin,
      )
      // Still save it, but log warning
    }

    // Save auth data to partitioned localStorage
    this.saveAuthData(appOrigin, data)
    this.appSecret = data.secret
    this.postageBatchId = data.postageBatchId
    this.signerKey = data.signerKey
    this.updateAuthStatus(true)

    // Initialize stamper if we have signer key
    if (this.signerKey && this.postageBatchId) {
      this.initializeStamper()
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
    const {
      requestId,
      data,
      options,
      enableProgress,
    } = message

    console.log("[Proxy] Upload data request, size:", data ? data.length : 0)
    if (!this.authenticated || !this.appSecret) {
      throw new Error("Not authenticated. Please login first.")
    }

    try {
      // Prepare upload context
      const context: UploadContext = {
        bee: this.bee,
        stamper: this.stamper,
        postageBatchId: this.postageBatchId,
        signerKey: this.signerKey,
      }

      // Progress callback (if enabled)
      const onProgress = enableProgress ? (progress: UploadProgress) => {
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
      } : undefined

      // Use new module for signing, or fallback to bee.uploadData
      let uploadResult

      if (this.signerKey) {
        // Client-side chunking and signing
        if (options?.encrypt) {
          console.log("[Proxy] Using client-side signing with encryption for uploadData")
          uploadResult = await uploadEncryptedDataWithSigning(context, data, options, onProgress)
        } else {
          console.log("[Proxy] Using client-side signing for uploadData")
          uploadResult = await uploadDataWithSigning(context, data, options, onProgress)
        }
      } else if (this.postageBatchId) {
        // Fallback to bee.uploadData (node-side stamping)
        if (options?.encrypt) {
          console.log("[Proxy] Using node-side stamping with encryption for uploadData")
          const result = await this.bee.uploadData(this.postageBatchId, data, options)
          uploadResult = {
            reference: result.reference.toHex(),
            tagUid: result.tagUid,
          }
        } else {
          console.log("[Proxy] Using node-side stamping for uploadData")
          const result = await this.bee.uploadData(this.postageBatchId, data, options)
          uploadResult = {
            reference: result.reference.toHex(),
            tagUid: result.tagUid,
          }
        }
      } else {
        throw new Error("No authentication method available")
      }

      // Save stamper state after successful upload (if using client-side signing)
      if (this.signerKey && this.stamper) {
        this.saveStamperState()
      }

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
    const {
      requestId,
      data,
      name,
      options,
    } = message

    console.log(
      "[Proxy] Upload file request, name:",
      name,
      "size:",
      data ? data.length : 0,
    )
    if (!this.authenticated || !this.appSecret) {
      throw new Error("Not authenticated. Please login first.")
    }

    // Check if only signer is available (no batch ID)
    if (this.signerKey && !this.postageBatchId) {
      this.sendErrorToParent(
        event,
        requestId,
        "Signed uploads for files not yet implemented. Please use uploadChunk for signed uploads, or provide a postage batch ID for automatic chunking."
      )
      return
    }

    if (!this.postageBatchId) {
      throw new Error("No postage batch ID available. Please authenticate with a valid batch ID.")
    }

    try {
      console.log("[Proxy] Uploading file to Bee at:", this.beeApiUrl, "with batch:", this.postageBatchId)

      // Upload file using bee-js
      const uploadResult = await this.bee.uploadFile(this.postageBatchId, data, name, options)

      console.log("[Proxy] File upload successful, reference:", uploadResult.reference.toHex())

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

      console.log("[Proxy] File download successful, data size:", fileData.data.toUint8Array().length)

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
    const {
      requestId,
      data,
      options,
    } = message

    console.log("[Proxy] Upload chunk request, size:", data ? data.length : 0)
    if (!this.authenticated || !this.appSecret) {
      throw new Error("Not authenticated. Please login first.")
    }

    // Check authentication method (prefer signer over batch ID)
    if (!this.signerKey && !this.postageBatchId) {
      throw new Error("No postage batch ID or signer key available. Please authenticate.")
    }

    try {
      // Validate chunk size (must be between 1 and 4096 bytes)
      if (data.length < 1 || data.length > 4096) {
        throw new Error(`Invalid chunk size: ${data.length} bytes. Chunks must be between 1 and 4096 bytes.`)
      }

      let uploadResult

      // Use signer if available (takes priority)
      if (this.signerKey) {
        if (!this.stamper) {
          this.initializeStamper()
        }

        if (!this.stamper) {
          throw new Error("Failed to initialize stamper for signing")
        }

        console.log("[Proxy] Signing and uploading chunk with signer key")

        // Create content-addressed chunk
        const chunk = makeContentAddressedChunk(data)

        // Sign the chunk to create envelope
        const envelope = this.stamper.stamp(chunk)

        // Force deferred mode for faster uploads (pinning incompatible with deferred)
        const uploadOptions = { ...options, deferred: true, pin: false }

        // Upload with envelope signature
        uploadResult = await this.bee.uploadChunk(envelope, chunk.data, uploadOptions)
      } else if (this.postageBatchId) {
        // Use batch ID (Bee node will stamp it)
        console.log("[Proxy] Uploading chunk to Bee at:", this.beeApiUrl, "with batch:", this.postageBatchId)

        // Force deferred mode for faster uploads (pinning incompatible with deferred)
        const uploadOptions = { ...options, deferred: true, pin: false }

        uploadResult = await this.bee.uploadChunk(this.postageBatchId, data, uploadOptions)
      } else {
        throw new Error("No authentication method available")
      }

      console.log("[Proxy] Chunk upload successful, reference:", uploadResult.reference.toHex())

      // Save stamper state after successful upload (if using client-side signing)
      if (this.signerKey && this.stamper) {
        this.saveStamperState()
      }

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
export function initProxy(options: ProxyOptions): SwarmIdProxy {
  return new SwarmIdProxy(options)
}
