import type {
  ClientOptions,
  AuthStatus,
  ConnectionInfo,
  UploadResult,
  FileData,
  UploadOptions,
  DownloadOptions,
  Reference,
  ParentToIframeMessage,
  IframeToParentMessage,
  AppMetadata,
  ButtonConfig,
} from "./types"
import {
  IframeToParentMessageSchema,
  ParentToIframeMessageSchema,
  AppMetadataSchema,
} from "./types"
import { buildAuthUrl } from "./utils/url"

/**
 * Main client library for integrating Swarm ID authentication and storage capabilities
 * into web applications.
 *
 * SwarmIdClient enables parent windows to interact with a Swarm ID iframe proxy,
 * providing secure authentication, identity management, and data upload/download
 * functionality to the Swarm decentralized storage network.
 *
 * @example
 * ```typescript
 * const client = new SwarmIdClient({
 *   iframeOrigin: 'https://swarm-id.example.com',
 *   metadata: {
 *     name: 'My App',
 *     description: 'A decentralized application'
 *   },
 *   onAuthChange: (authenticated) => {
 *     console.log('Auth status changed:', authenticated)
 *   }
 * })
 *
 * await client.initialize()
 *
 * const status = await client.checkAuthStatus()
 * if (status.authenticated) {
 *   const result = await client.uploadData(new Uint8Array([1, 2, 3]))
 *   console.log('Uploaded with reference:', result.reference)
 * }
 * ```
 */
export class SwarmIdClient {
  private iframe: HTMLIFrameElement | undefined
  private iframeOrigin: string
  private iframePath: string
  private timeout: number
  private onAuthChange?: (authenticated: boolean) => void
  private popupMode: "popup" | "window"
  private metadata: AppMetadata
  private buttonConfig?: ButtonConfig
  private containerId?: string
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

  /**
   * Creates a new SwarmIdClient instance.
   *
   * @param options - Configuration options for the client
   * @param options.iframeOrigin - The origin URL where the Swarm ID proxy iframe is hosted
   * @param options.iframePath - The path to the proxy iframe (defaults to "/proxy")
   * @param options.timeout - Request timeout in milliseconds (defaults to 30000)
   * @param options.onAuthChange - Callback function invoked when authentication status changes
   * @param options.popupMode - How to display the authentication popup: "popup" or "window" (defaults to "window")
   * @param options.metadata - Application metadata shown to users during authentication
   * @param options.metadata.name - Application name (1-100 characters)
   * @param options.metadata.description - Optional application description (max 500 characters)
   * @param options.metadata.icon - Optional application icon as a data URL (SVG or PNG, max 4KB)
   * @param options.buttonConfig - Button configuration for the authentication UI (optional)
   * @param options.buttonConfig.connectText - Text for the connect button (optional)
   * @param options.buttonConfig.disconnectText - Text for the disconnect button (optional)
   * @param options.buttonConfig.loadingText - Text shown during loading (optional)
   * @param options.buttonConfig.backgroundColor - Background color for buttons (optional)
   * @param options.buttonConfig.color - Text color for buttons (optional)
   * @param options.buttonConfig.borderRadius - Border radius for buttons and iframe (optional)
   * @param options.containerId - ID of container element to place iframe in (optional)
   * @throws {Error} If the provided app metadata is invalid
   */
  constructor(options: ClientOptions) {
    this.iframeOrigin = options.iframeOrigin
    this.iframePath = options.iframePath || "/proxy"
    this.timeout = options.timeout || 30000 // 30 seconds default
    this.onAuthChange = options.onAuthChange
    this.popupMode = options.popupMode || "window"
    this.metadata = options.metadata
    this.buttonConfig = options.buttonConfig
    this.containerId = options.containerId

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
      }, 30000)
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
      }, 30000)
    })

    this.setupMessageListener()
  }

  /**
   * Initializes the client by creating and embedding the proxy iframe.
   *
   * This method must be called before using any other client methods.
   * It creates a hidden iframe, waits for the proxy to initialize,
   * identifies the parent application to the proxy, and waits for
   * the proxy to signal readiness.
   *
   * @returns A promise that resolves when the client is fully initialized
   * @throws {Error} If the client is already initialized
   * @throws {Error} If the iframe fails to load
   * @throws {Error} If the proxy does not respond within the timeout period (10 seconds)
   * @throws {Error} If origin validation fails on the proxy side
   *
   * @example
   * ```typescript
   * const client = new SwarmIdClient({ ... })
   * try {
   *   await client.initialize()
   *   console.log('Client ready')
   * } catch (error) {
   *   console.error('Failed to initialize:', error)
   * }
   * ```
   */
  async initialize(): Promise<void> {
    if (this.iframe) {
      throw new Error("SwarmIdClient already initialized")
    }

    // Create iframe for proxy
    this.iframe = document.createElement("iframe")
    this.iframe.src = `${this.iframeOrigin}${this.iframePath}`
    console.log("[SwarmIdClient] Creating iframe with src:", this.iframe.src)
    console.log("[SwarmIdClient] iframeOrigin:", this.iframeOrigin)
    console.log("[SwarmIdClient] iframePath:", this.iframePath)

    // Common iframe styles
    this.iframe.style.border = "none"
    this.iframe.style.backgroundColor = "transparent"
    this.iframe.style.borderRadius = this.buttonConfig?.borderRadius || "0"

    // Determine where to place the iframe
    let containerElement: HTMLElement | undefined
    if (this.containerId) {
      containerElement = document.getElementById(this.containerId) || undefined
      if (!containerElement) {
        throw new Error(
          `Container element with ID "${this.containerId}" not found`,
        )
      }
      console.log("[SwarmIdClient] Using container element:", this.containerId)

      // Fill the container
      this.iframe.style.width = "100%"
      this.iframe.style.height = "100%"
      this.iframe.style.display = "block"
    } else {
      // Default: fixed position in bottom-right corner (hidden by default)
      this.iframe.style.display = "none"
      this.iframe.style.position = "fixed"
      this.iframe.style.bottom = "20px"
      this.iframe.style.right = "20px"
      this.iframe.style.width = "300px"
      this.iframe.style.height = "50px"
      this.iframe.style.zIndex = "999999"
    }

    // Wait for iframe to load
    await new Promise<void>((resolve, reject) => {
      this.iframe!.onload = () => resolve()
      this.iframe!.onerror = () =>
        reject(new Error("Failed to load Swarm ID iframe"))

      // Append to container or body
      if (containerElement) {
        containerElement.appendChild(this.iframe!)
      } else {
        document.body.appendChild(this.iframe!)
      }
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
      popupMode: this.popupMode,
      metadata: this.metadata,
      buttonConfig: this.buttonConfig,
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

      // Validate origin (extract just origin part, ignoring any path in iframeOrigin)
      const expectedOrigin = new URL(this.iframeOrigin).origin
      if (event.origin !== expectedOrigin) {
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
   * Returns the authentication iframe element.
   *
   * The iframe displays authentication UI based on the current auth status:
   * - If not authenticated: shows a "Connect" button
   * - If authenticated: shows identity info and a "Disconnect" button
   *
   * The iframe is positioned fixed in the bottom-right corner of the viewport.
   *
   * @returns The iframe element displaying the authentication UI
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the iframe is not available
   *
   * @example
   * ```typescript
   * const iframe = client.getAuthIframe()
   * // The iframe is already displayed; this returns a reference to it
   * ```
   */
  getAuthIframe(): HTMLIFrameElement {
    this.ensureReady()

    if (!this.iframe) {
      throw new Error("Iframe not initialized")
    }

    return this.iframe
  }

  /**
   * Checks the current authentication status with the Swarm ID proxy.
   *
   * @returns A promise resolving to the authentication status object
   * @returns return.authenticated - Whether the user is currently authenticated
   * @returns return.origin - The origin that authenticated (if authenticated)
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const status = await client.checkAuthStatus()
   * if (status.authenticated) {
   *   console.log('Authenticated from:', status.origin)
   * }
   * ```
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
   * Disconnects the current session and clears authentication data.
   *
   * After disconnection, the user will need to re-authenticate to perform
   * uploads or access identity-related features. The {@link onAuthChange}
   * callback will be invoked with `false`.
   *
   * @returns A promise that resolves when disconnection is complete
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the disconnect operation fails
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * await client.disconnect()
   * console.log('User logged out')
   * ```
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

  /**
   * Opens the Swarm ID authentication page in a new window.
   *
   * This method creates the same authentication URL as used by the iframe
   * proxy and opens it in a new browser window. The user can authenticate
   * with their Swarm ID, and the resulting authentication will be available
   * to the client when they return.
   *
   * @param popupMode - Whether to open as a popup window ("popup") or full window ("window", default)
   * @returns The URL that was opened (useful for testing or reference)
   * @throws {Error} If the client is not initialized
   *
   * @example
   * ```typescript
   * const client = new SwarmIdClient({ ... })
   * await client.initialize()
   *
   * // Open authentication page
   * const url = client.connect()
   * console.log('Authentication opened at:', url)
   *
   * // Open as popup window
   * client.connect("popup")
   * ```
   */
  connect(popupMode: "window" | "popup" = "window"): string {
    this.ensureReady()

    const authUrl = buildAuthUrl(
      this.iframeOrigin,
      window.location.origin,
      this.metadata,
    )

    // Open as popup or full window based on popupMode
    if (popupMode === "popup") {
      window.open(authUrl, "_blank", "width=500,height=600")
    } else {
      window.open(authUrl, "_blank")
    }

    return authUrl
  }

  /**
   * Retrieves connection information including upload capability and identity details.
   *
   * Use this method to check if the user can upload data and to get
   * information about the currently connected identity.
   *
   * @returns A promise resolving to the connection info object
   * @returns return.canUpload - Whether the user can upload data (has valid postage stamp)
   * @returns return.identity - The connected identity details (if authenticated)
   * @returns return.identity.id - Unique identifier for the identity
   * @returns return.identity.name - Display name of the identity
   * @returns return.identity.address - Ethereum address associated with the identity
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const info = await client.getConnectionInfo()
   * if (info.canUpload) {
   *   console.log('Ready to upload as:', info.identity?.name)
   * } else {
   *   console.log('No postage stamp available')
   * }
   * ```
   */
  async getConnectionInfo(): Promise<ConnectionInfo> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "connectionInfoResponse"
      requestId: string
      canUpload: boolean
      identity?: { id: string; name: string; address: string }
    }>({
      type: "getConnectionInfo",
      requestId,
    })

    return {
      canUpload: response.canUpload,
      identity: response.identity,
    }
  }

  // ============================================================================
  // Data Upload/Download Methods
  // ============================================================================

  /**
   * Uploads raw binary data to the Swarm network.
   *
   * The data is uploaded using the authenticated user's postage stamp.
   * Progress can be tracked via the optional callback.
   *
   * @param data - The binary data to upload as a Uint8Array
   * @param options - Optional upload configuration
   * @param options.pin - Whether to pin the data locally (defaults to false)
   * @param options.encrypt - Whether to encrypt the data (defaults to false)
   * @param options.tag - Tag ID for tracking upload progress
   * @param options.deferred - Whether to use deferred upload (defaults to false)
   * @param options.redundancyLevel - Redundancy level from 0-4 for data availability
   * @param onProgress - Optional callback for tracking upload progress
   * @returns A promise resolving to the upload result
   * @returns return.reference - The Swarm reference (hash) of the uploaded data
   * @returns return.tagUid - The tag UID if a tag was created
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the user is not authenticated or cannot upload
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const data = new TextEncoder().encode('Hello, Swarm!')
   * const result = await client.uploadData(data, { encrypt: true }, (progress) => {
   *   console.log(`Progress: ${progress.processed}/${progress.total}`)
   * })
   * console.log('Reference:', result.reference)
   * ```
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
        if (event.origin !== new URL(this.iframeOrigin).origin) return

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
   * Downloads raw binary data from the Swarm network.
   *
   * @param reference - The Swarm reference (hash) of the data to download.
   *                    Can be 64 hex chars (32 bytes) or 128 hex chars (64 bytes for encrypted)
   * @param options - Optional download configuration
   * @param options.redundancyStrategy - Strategy for handling redundancy (0-3)
   * @param options.fallback - Whether to use fallback retrieval
   * @param options.timeoutMs - Download timeout in milliseconds
   * @param options.actPublisher - ACT publisher for encrypted content
   * @param options.actHistoryAddress - ACT history address for encrypted content
   * @param options.actTimestamp - ACT timestamp for encrypted content
   * @returns A promise resolving to the downloaded data as a Uint8Array
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the reference is not found
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const data = await client.downloadData('a1b2c3...') // 64 char hex reference
   * const text = new TextDecoder().decode(data)
   * console.log('Downloaded:', text)
   * ```
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
   * Uploads a file to the Swarm network.
   *
   * Accepts either a File object (from file input) or raw Uint8Array data.
   * When using a File object, the filename is automatically extracted unless
   * explicitly overridden.
   *
   * @param file - The file to upload (File object or Uint8Array)
   * @param name - Optional filename (extracted from File object if not provided)
   * @param options - Optional upload configuration
   * @param options.pin - Whether to pin the file locally (defaults to false)
   * @param options.encrypt - Whether to encrypt the file (defaults to false)
   * @param options.tag - Tag ID for tracking upload progress
   * @param options.deferred - Whether to use deferred upload (defaults to false)
   * @param options.redundancyLevel - Redundancy level from 0-4 for data availability
   * @returns A promise resolving to the upload result
   * @returns return.reference - The Swarm reference (hash) of the uploaded file
   * @returns return.tagUid - The tag UID if a tag was created
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the user is not authenticated or cannot upload
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * // From file input
   * const fileInput = document.querySelector('input[type="file"]')
   * const file = fileInput.files[0]
   * const result = await client.uploadFile(file)
   *
   * // From Uint8Array with custom name
   * const data = new Uint8Array([...])
   * const result = await client.uploadFile(data, 'document.pdf')
   * ```
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
   * Downloads a file from the Swarm network.
   *
   * Returns both the file data and its original filename (if available).
   * For manifest references, an optional path can be specified to retrieve
   * a specific file from the manifest.
   *
   * @param reference - The Swarm reference (hash) of the file to download
   * @param path - Optional path within a manifest to retrieve a specific file
   * @param options - Optional download configuration
   * @param options.redundancyStrategy - Strategy for handling redundancy (0-3)
   * @param options.fallback - Whether to use fallback retrieval
   * @param options.timeoutMs - Download timeout in milliseconds
   * @param options.actPublisher - ACT publisher for encrypted content
   * @param options.actHistoryAddress - ACT history address for encrypted content
   * @param options.actTimestamp - ACT timestamp for encrypted content
   * @returns A promise resolving to the file data object
   * @returns return.name - The filename
   * @returns return.data - The file contents as a Uint8Array
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the reference is not found
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const file = await client.downloadFile('a1b2c3...')
   * console.log('Filename:', file.name)
   *
   * // Create download link
   * const blob = new Blob([file.data])
   * const url = URL.createObjectURL(blob)
   * ```
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
   * Uploads a single chunk to the Swarm network.
   *
   * Chunks are the fundamental unit of storage in Swarm (4KB each).
   * This method is useful for low-level operations or when implementing
   * custom chunking strategies.
   *
   * @param data - The chunk data to upload (should be exactly 4KB for optimal storage)
   * @param options - Optional upload configuration
   * @param options.pin - Whether to pin the chunk locally (defaults to false)
   * @param options.encrypt - Whether to encrypt the chunk (defaults to false)
   * @param options.tag - Tag ID for tracking upload progress
   * @param options.deferred - Whether to use deferred upload (defaults to false)
   * @param options.redundancyLevel - Redundancy level from 0-4 for data availability
   * @returns A promise resolving to the upload result
   * @returns return.reference - The Swarm reference (hash) of the uploaded chunk
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the user is not authenticated or cannot upload
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const chunk = new Uint8Array(4096) // 4KB chunk
   * chunk.fill(0x42) // Fill with data
   * const result = await client.uploadChunk(chunk)
   * console.log('Chunk reference:', result.reference)
   * ```
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
   * Downloads a single chunk from the Swarm network.
   *
   * Retrieves a chunk by its reference hash. This method is useful for
   * low-level operations or when implementing custom retrieval strategies.
   *
   * @param reference - The Swarm reference (hash) of the chunk to download
   * @param options - Optional download configuration
   * @param options.redundancyStrategy - Strategy for handling redundancy (0-3)
   * @param options.fallback - Whether to use fallback retrieval
   * @param options.timeoutMs - Download timeout in milliseconds
   * @param options.actPublisher - ACT publisher for encrypted content
   * @param options.actHistoryAddress - ACT history address for encrypted content
   * @param options.actTimestamp - ACT timestamp for encrypted content
   * @returns A promise resolving to the chunk data as a Uint8Array
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the reference is not found
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const chunk = await client.downloadChunk('a1b2c3...')
   * console.log('Chunk size:', chunk.length)
   * ```
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
   * Destroys the client and releases all resources.
   *
   * This method should be called when the client is no longer needed.
   * It performs the following cleanup:
   * - Cancels all pending requests with an error
   * - Removes the message event listener
   * - Removes the iframe from the DOM
   * - Resets the client to an uninitialized state
   *
   * After calling destroy(), the client instance cannot be reused.
   * Create a new instance if you need to reconnect.
   *
   * @example
   * ```typescript
   * // Clean up when component unmounts
   * useEffect(() => {
   *   const client = new SwarmIdClient({ ... })
   *   client.initialize()
   *
   *   return () => {
   *     client.destroy()
   *   }
   * }, [])
   * ```
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
