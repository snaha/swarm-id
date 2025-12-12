import type {
  ClientOptions,
  AuthStatus,
  ButtonStyles,
  UploadResult,
  FileData,
  UploadOptions,
  DownloadOptions,
  Reference,
  ParentToIframeMessage,
  IframeToParentMessage,
  AppMetadata,
} from "./types"
import {
  IframeToParentMessageSchema,
  ParentToIframeMessageSchema,
  AppMetadataSchema,
} from "./types"

/**
 * Main client library for parent windows to interact with Swarm ID iframe
 */
export class SwarmIdClient {
  private iframe: HTMLIFrameElement | undefined
  private iframeOrigin: string
  private iframePath: string
  private beeApiUrl: string
  private timeout: number
  private onAuthChange?: (authenticated: boolean) => void
  private popupMode: "popup" | "window"
  private metadata: AppMetadata
  private ready: boolean = false
  private readyPromise: Promise<void>
  private readyResolve?: () => void
  private readyReject?: (error: Error) => void
  private pendingRequests: Map<
    string,
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolve: (value: any) => void
      reject: (error: Error) => void
      timeoutId: NodeJS.Timeout
    }
  > = new Map()
  private requestIdCounter = 0
  private messageListener: ((event: MessageEvent) => void) | undefined
  private proxyInitializedPromise: Promise<void>
  private proxyInitializedResolve?: () => void
  private proxyInitializedReject?: (error: Error) => void

  constructor(options: ClientOptions) {
    this.iframeOrigin = options.iframeOrigin
    this.iframePath = options.iframePath || "/proxy"
    this.beeApiUrl = options.beeApiUrl || "http://localhost:1633"
    this.timeout = options.timeout || 30000 // 30 seconds default
    this.onAuthChange = options.onAuthChange
    this.popupMode = options.popupMode || "window"
    this.metadata = options.metadata

    // Validate metadata
    try {
      AppMetadataSchema.parse(this.metadata)
    } catch (error) {
      throw new Error(`Invalid app metadata: ${error}`)
    }

    // Create promise that resolves when iframe is ready
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject

      // Timeout after 10 seconds if proxy doesn't respond
      setTimeout(() => {
        reject(
          new Error(
            "Proxy initialization timeout - proxy did not respond within 10 seconds",
          ),
        )
      }, 10000)
    })

    // Create promise for proxyInitialized message
    this.proxyInitializedPromise = new Promise<void>((resolve, reject) => {
      this.proxyInitializedResolve = resolve
      this.proxyInitializedReject = reject

      // Timeout if proxy doesn't send proxyInitialized within 10 seconds
      setTimeout(() => {
        if (this.proxyInitializedReject) {
          this.proxyInitializedReject(
            new Error(
              "Proxy initialization timeout - proxy did not signal readiness",
            ),
          )
        }
      }, 10000)
    })

    this.setupMessageListener()
  }

  /**
   * Initialize the client by creating and embedding the iframe
   */
  async initialize(): Promise<void> {
    if (this.iframe) {
      throw new Error("SwarmIdClient already initialized")
    }

    // Create iframe for proxy (hidden by default, shown only if not authenticated)
    this.iframe = document.createElement("iframe")
    this.iframe.src = `${this.iframeOrigin}${this.iframePath}`
    console.log("[SwarmIdClient] Creating iframe with src:", this.iframe.src)
    console.log("[SwarmIdClient] iframeOrigin:", this.iframeOrigin)
    console.log("[SwarmIdClient] iframePath:", this.iframePath)
    this.iframe.style.display = "none"
    this.iframe.style.position = "fixed"
    this.iframe.style.bottom = "20px"
    this.iframe.style.right = "20px"
    this.iframe.style.width = "300px"
    this.iframe.style.height = "80px"
    this.iframe.style.border = "1px solid #ddd"
    this.iframe.style.borderRadius = "8px"
    this.iframe.style.boxShadow = "0 4px 12px rgba(0,0,0,0.15)"
    this.iframe.style.zIndex = "999999"
    this.iframe.style.backgroundColor = "white"

    // Wait for iframe to load
    await new Promise<void>((resolve, reject) => {
      this.iframe!.onload = () => resolve()
      this.iframe!.onerror = () =>
        reject(new Error("Failed to load Swarm ID iframe"))
      document.body.appendChild(this.iframe!)
    })

    console.log(
      "[SwarmIdClient] Iframe loaded, waiting for proxy initialization...",
    )

    // Wait for proxy to signal it's ready
    await this.proxyInitializedPromise
    console.log("[SwarmIdClient] Proxy initialized and ready")

    // Identify ourselves to the iframe
    console.log(
      "[SwarmIdClient] Sending parentIdentify to iframe at origin:",
      this.iframeOrigin,
    )
    this.sendMessage({
      type: "parentIdentify",
      beeApiUrl: this.beeApiUrl,
      popupMode: this.popupMode,
      metadata: this.metadata,
    })
    console.log("[SwarmIdClient] parentIdentify sent")

    // Wait for iframe to be ready
    await this.readyPromise
  }

  /**
   * Setup message listener for iframe responses
   */
  private setupMessageListener(): void {
    this.messageListener = (event: MessageEvent) => {
      // Handle proxyInitialized BEFORE any validation to avoid race condition
      // This message is sent immediately when iframe loads and uses wildcard origin
      if (event.data?.type === "proxyInitialized") {
        // Security: Verify message is from OUR iframe (not another window/iframe)
        if (this.iframe && event.source === this.iframe.contentWindow) {
          console.log("[SwarmIdClient] Received proxyInitialized from iframe")
          if (this.proxyInitializedResolve) {
            this.proxyInitializedResolve()
            this.proxyInitializedResolve = undefined // Prevent double resolution
          }
        } else {
          console.warn(
            "[SwarmIdClient] Rejected proxyInitialized from unknown source",
          )
        }
        return
      }

      // Validate origin
      if (event.origin !== this.iframeOrigin) {
        console.warn(
          "[SwarmIdClient] Rejected message from unauthorized origin:",
          event.origin,
        )
        return
      }

      // Parse and validate message
      let message: IframeToParentMessage
      try {
        message = IframeToParentMessageSchema.parse(event.data)
      } catch (error) {
        console.warn(
          "[SwarmIdClient] Invalid message format:",
          event.data,
          error,
        )
        return
      }

      this.handleIframeMessage(message)
    }

    window.addEventListener("message", this.messageListener)
  }

  /**
   * Handle messages from iframe
   */
  private handleIframeMessage(message: IframeToParentMessage): void {
    switch (message.type) {
      case "proxyReady":
        this.ready = true
        if (this.readyResolve) {
          this.readyResolve()
        }
        // Always show iframe - it will display login or disconnect button
        if (this.iframe) {
          this.iframe.style.display = "block"
        }
        if (this.onAuthChange) {
          this.onAuthChange(message.authenticated)
        }
        break

      case "authStatusResponse":
        // Always show iframe - it will display login or disconnect button
        if (this.iframe) {
          this.iframe.style.display = "block"
        }
        if (this.onAuthChange) {
          this.onAuthChange(message.authenticated)
        }
        // Handle as response if there's a matching request
        if ("requestId" in message) {
          const pending = this.pendingRequests.get(message.requestId)
          if (pending) {
            clearTimeout(pending.timeoutId)
            this.pendingRequests.delete(message.requestId)
            pending.resolve(message)
          }
        }
        break

      case "authSuccess":
        // Keep iframe visible - it will now show disconnect button
        if (this.iframe) {
          this.iframe.style.display = "block"
        }
        if (this.onAuthChange) {
          this.onAuthChange(true)
        }
        break

      case "initError":
        // Initialization error from proxy (e.g., origin validation failed)
        console.error(
          "[SwarmIdClient] Proxy initialization error:",
          message.error,
        )
        if (this.readyReject) {
          this.readyReject(new Error(message.error))
        }
        break

      case "disconnectResponse":
        // Handle disconnect response
        if (this.onAuthChange) {
          this.onAuthChange(false)
        }
        // Handle as response if there's a matching request
        if ("requestId" in message) {
          const pending = this.pendingRequests.get(message.requestId)
          if (pending) {
            clearTimeout(pending.timeoutId)
            this.pendingRequests.delete(message.requestId)
            pending.resolve(message)
          }
        }
        break

      case "error": {
        const pending = this.pendingRequests.get(message.requestId)
        if (pending) {
          clearTimeout(pending.timeoutId)
          this.pendingRequests.delete(message.requestId)
          pending.reject(new Error(message.error))
        }
        break
      }

      default:
        // Handle response messages with requestId
        if ("requestId" in message) {
          const pending = this.pendingRequests.get(message.requestId)
          if (pending) {
            clearTimeout(pending.timeoutId)
            this.pendingRequests.delete(message.requestId)
            pending.resolve(message)
          }
        }
    }
  }

  /**
   * Send message to iframe
   */
  private sendMessage(message: ParentToIframeMessage): void {
    if (!this.iframe || !this.iframe.contentWindow) {
      throw new Error("Iframe not initialized")
    }

    // Validate message before sending
    try {
      ParentToIframeMessageSchema.parse(message)
    } catch (error) {
      throw new Error(`Invalid message format: ${error}`)
    }

    this.iframe.contentWindow.postMessage(message, this.iframeOrigin)
  }

  /**
   * Send request and wait for response
   */
  private async sendRequest<T>(
    message: ParentToIframeMessage & { requestId: string },
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(message.requestId)
        reject(new Error(`Request timeout after ${this.timeout}ms`))
      }, this.timeout)

      this.pendingRequests.set(message.requestId, {
        resolve,
        reject,
        timeoutId,
      })

      this.sendMessage(message)
    })
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `req-${++this.requestIdCounter}-${Date.now()}`
  }

  /**
   * Ensure client is initialized
   */
  private ensureReady(): void {
    if (!this.ready) {
      throw new Error("SwarmIdClient not initialized. Call initialize() first.")
    }
  }

  // ============================================================================
  // Authentication Methods
  // ============================================================================

  /**
   * Show the authentication iframe in the specified container
   * The iframe itself will decide whether to show the button based on auth status
   */
  createAuthButton(
    _container: HTMLElement,
    _styles?: ButtonStyles,
  ): HTMLIFrameElement {
    this.ensureReady()

    if (!this.iframe) {
      throw new Error("Iframe not initialized")
    }

    // DON'T move the iframe - keep it where it is in body
    // The proxy will automatically show/hide the button based on auth status

    return this.iframe
  }

  /**
   * Check authentication status
   */
  async checkAuthStatus(): Promise<AuthStatus> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "authStatusResponse"
      requestId: string
      authenticated: boolean
      origin?: string
    }>({
      type: "checkAuth",
      requestId,
    })

    return {
      authenticated: response.authenticated,
      origin: response.origin,
    }
  }

  /**
   * Check if user is authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    const status = await this.checkAuthStatus()
    return status.authenticated
  }

  /**
   * Disconnect and clear authentication data
   */
  async disconnect(): Promise<void> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "disconnectResponse"
      requestId: string
      success: boolean
    }>({
      type: "disconnect",
      requestId,
    })

    if (!response.success) {
      throw new Error("Failed to disconnect")
    }

    // Notify via auth change callback
    if (this.onAuthChange) {
      this.onAuthChange(false)
    }
  }

  // ============================================================================
  // Data Upload/Download Methods
  // ============================================================================

  /**
   * Upload data to Swarm
   */
  async uploadData(
    data: Uint8Array,
    options?: UploadOptions,
    onProgress?: (progress: { total: number; processed: number }) => void,
  ): Promise<UploadResult> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    // Setup progress listener if callback provided
    let progressListener: ((event: MessageEvent) => void) | undefined
    if (onProgress) {
      progressListener = (event: MessageEvent) => {
        if (event.origin !== this.iframeOrigin) return

        try {
          const message = IframeToParentMessageSchema.parse(event.data)
          if (
            message.type === "uploadProgress" &&
            message.requestId === requestId
          ) {
            onProgress({
              total: message.total,
              processed: message.processed,
            })
          }
        } catch {
          // Ignore invalid messages
        }
      }
      window.addEventListener("message", progressListener)
    }

    try {
      const response = await this.sendRequest<{
        type: "uploadDataResponse"
        requestId: string
        reference: Reference
        tagUid?: number
      }>({
        type: "uploadData",
        requestId,
        data: new Uint8Array(data),
        options,
        enableProgress: !!onProgress,
      })

      return {
        reference: response.reference,
        tagUid: response.tagUid,
      }
    } finally {
      // Clean up progress listener
      if (progressListener) {
        window.removeEventListener("message", progressListener)
      }
    }
  }

  /**
   * Download data from Swarm
   */
  async downloadData(
    reference: Reference,
    options?: DownloadOptions,
  ): Promise<Uint8Array> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "downloadDataResponse"
      requestId: string
      data: Uint8Array
    }>({
      type: "downloadData",
      requestId,
      reference,
      options,
    })

    return response.data
  }

  // ============================================================================
  // File Upload/Download Methods
  // ============================================================================

  /**
   * Upload file to Swarm
   */
  async uploadFile(
    file: File | Uint8Array,
    name?: string,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    let data: Uint8Array<ArrayBuffer>
    let fileName: string | undefined = name

    if (file instanceof File) {
      const buffer = await file.arrayBuffer()
      data = new Uint8Array(buffer)
      fileName = fileName || file.name
    } else {
      data = new Uint8Array(
        file.buffer.slice(0),
        file.byteOffset,
        file.byteLength,
      )
    }

    const response = await this.sendRequest<{
      type: "uploadFileResponse"
      requestId: string
      reference: Reference
      tagUid?: number
    }>({
      type: "uploadFile",
      requestId,
      data,
      name: fileName,
      options,
    })

    return {
      reference: response.reference,
      tagUid: response.tagUid,
    }
  }

  /**
   * Download file from Swarm
   */
  async downloadFile(
    reference: Reference,
    path?: string,
    options?: DownloadOptions,
  ): Promise<FileData> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "downloadFileResponse"
      requestId: string
      name: string
      data: number[]
    }>({
      type: "downloadFile",
      requestId,
      reference,
      path,
      options,
    })

    return {
      name: response.name,
      data: new Uint8Array(response.data),
    }
  }

  // ============================================================================
  // Chunk Upload/Download Methods
  // ============================================================================

  /**
   * Upload chunk to Swarm
   */
  async uploadChunk(
    data: Uint8Array,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "uploadChunkResponse"
      requestId: string
      reference: Reference
    }>({
      type: "uploadChunk",
      requestId,
      data: data as Uint8Array,
      options,
    })

    return {
      reference: response.reference,
    }
  }

  /**
   * Download chunk from Swarm
   */
  async downloadChunk(
    reference: Reference,
    options?: DownloadOptions,
  ): Promise<Uint8Array> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "downloadChunkResponse"
      requestId: string
      data: number[]
    }>({
      type: "downloadChunk",
      requestId,
      reference,
      options,
    })

    return new Uint8Array(response.data)
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Destroy the client and clean up resources
   */
  destroy(): void {
    // Clear pending requests
    this.pendingRequests.forEach((pending) => {
      clearTimeout(pending.timeoutId)
      pending.reject(new Error("Client destroyed"))
    })
    this.pendingRequests.clear()

    // Remove message listener
    if (this.messageListener) {
      window.removeEventListener("message", this.messageListener)
      this.messageListener = undefined
    }

    // Remove iframe
    if (this.iframe && this.iframe.parentNode) {
      this.iframe.parentNode.removeChild(this.iframe)
      this.iframe = undefined
    }

    this.ready = false
  }
}
