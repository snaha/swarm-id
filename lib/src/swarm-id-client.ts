import type {
  ClientOptions,
  ConnectOptions,
  AuthStatus,
  ConnectionInfo,
  UploadResult,
  FileData,
  UploadOptions,
  ActUploadOptions,
  DownloadOptions,
  RequestOptions,
  Reference,
  SOCReader,
  SOCWriter,
  SingleOwnerChunk,
  SocRawUploadResult,
  SocRawUploadResponseMessage,
  SocRawUploadMessage,
  SocGetOwnerMessage,
  SocGetOwnerResponseMessage,
  FeedReaderOptions,
  FeedWriterOptions,
  FeedReader,
  FeedWriter,
  EpochFeedDownloadReferenceMessage,
  EpochFeedDownloadReferenceResponseMessage,
  EpochFeedUploadReferenceMessage,
  EpochFeedUploadReferenceResponseMessage,
  FeedGetOwnerMessage,
  FeedGetOwnerResponseMessage,
  EpochFeedDownloadOptions,
  EpochFeedDownloadPayloadResult,
  EpochFeedDownloadReferenceResult,
  EpochFeedUploadOptions,
  EpochFeedUploadResult,
  SequentialFeedReaderOptions,
  SequentialFeedWriterOptions,
  SequentialFeedUpdateOptions,
  SequentialFeedUploadOptions,
  SequentialFeedDownloadRawOptions,
  SequentialFeedUploadRawOptions,
  SequentialFeedPayloadResult,
  SequentialFeedReferenceResult,
  SequentialFeedUploadResult,
  SequentialFeedReader,
  SequentialFeedWriter,
  SequentialFeedGetOwnerMessage,
  SequentialFeedGetOwnerResponseMessage,
  SequentialFeedDownloadPayloadMessage,
  SequentialFeedDownloadPayloadResponseMessage,
  SequentialFeedDownloadRawPayloadMessage,
  SequentialFeedDownloadRawPayloadResponseMessage,
  SequentialFeedDownloadReferenceMessage,
  SequentialFeedDownloadReferenceResponseMessage,
  SequentialFeedUploadPayloadMessage,
  SequentialFeedUploadPayloadResponseMessage,
  SequentialFeedUploadRawPayloadMessage,
  SequentialFeedUploadRawPayloadResponseMessage,
  SequentialFeedUploadReferenceMessage,
  SequentialFeedUploadReferenceResponseMessage,
  CreateFeedManifestMessage,
  CreateFeedManifestResponseMessage,
  SocDownloadMessage,
  SocDownloadResponseMessage,
  SocRawDownloadMessage,
  SocRawDownloadResponseMessage,
  SocUploadResult,
  SocUploadResponseMessage,
  SocUploadMessage,
  ParentToIframeMessage,
  IframeToParentMessage,
  AppMetadata,
  ButtonConfig,
  PostageBatch,
} from "./types"
import {
  IframeToParentMessageSchema,
  ParentToIframeMessageSchema,
  AppMetadataSchema,
} from "./types"
import { buildAuthUrl } from "./utils/url"
import { EthAddress, Identifier, PrivateKey, Topic } from "@ethersphere/bee-js"
import { uint8ArrayToHex } from "./utils/key-derivation"

const DEFAULT_TIMEOUT_MS = 30000
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 30000

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
  private initializationTimeout: number
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
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS
    this.initializationTimeout =
      options.initializationTimeout ?? DEFAULT_INITIALIZATION_TIMEOUT_MS
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

      // Timeout if proxy doesn't respond
      setTimeout(() => {
        reject(
          new Error(
            `Proxy initialization timeout - proxy did not respond within ${this.initializationTimeout}ms`,
          ),
        )
      }, this.initializationTimeout)
    })

    // Create promise for proxyInitialized message
    this.proxyInitializedPromise = new Promise<void>((resolve, reject) => {
      this.proxyInitializedResolve = resolve
      this.proxyInitializedReject = reject

      // Timeout if proxy doesn't send proxyInitialized
      setTimeout(() => {
        if (this.proxyInitializedReject) {
          this.proxyInitializedReject(
            new Error(
              `Proxy initialization timeout - proxy did not signal readiness within ${this.initializationTimeout}ms`,
            ),
          )
        }
      }, this.initializationTimeout)
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
   * @throws {Error} If the proxy does not respond within the timeout period (30 seconds)
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
  private async sendRequest<
    TResponse,
    TRequest extends ParentToIframeMessage & { requestId: string } =
      ParentToIframeMessage & {
        requestId: string
      },
  >(message: TRequest): Promise<TResponse> {
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

  private normalizeSocIdentifier(
    identifier: Identifier | Uint8Array | string,
  ): string {
    if (identifier instanceof Identifier) {
      return identifier.toHex()
    }
    if (identifier instanceof Uint8Array) {
      return uint8ArrayToHex(identifier)
    }
    return identifier
  }

  private normalizeSocKey(key: Uint8Array | string): string {
    if (key instanceof Uint8Array) {
      return uint8ArrayToHex(key)
    }
    return key
  }

  private normalizeFeedTopic(
    topic: Topic | Identifier | Uint8Array | string,
  ): string {
    if (topic instanceof Topic) {
      return uint8ArrayToHex(topic.toUint8Array())
    }
    if (topic instanceof Identifier) {
      return topic.toHex()
    }
    if (topic instanceof Uint8Array) {
      return uint8ArrayToHex(topic)
    }
    return topic
  }

  private normalizeReference(reference: Uint8Array | string): string {
    if (reference instanceof Uint8Array) {
      return uint8ArrayToHex(reference)
    }
    return reference
  }

  private normalizeFeedTimestamp(value: bigint | number | string): string {
    if (typeof value === "bigint") {
      return value.toString()
    }
    if (typeof value === "number") {
      return BigInt(Math.floor(value)).toString()
    }
    return value
  }

  private normalizeFeedIndex(value: bigint | number | string): string {
    if (typeof value === "bigint") {
      return value.toString()
    }
    if (typeof value === "number") {
      return BigInt(Math.floor(value)).toString()
    }
    return value
  }

  private normalizePayload(data: Uint8Array | string): Uint8Array {
    if (data instanceof Uint8Array) {
      return data
    }
    return new TextEncoder().encode(data)
  }

  private socChunkFromResponse(response: {
    data: Uint8Array
    identifier: string
    signature: string
    span: number
    payload: Uint8Array
    address: Reference
    owner: string
  }): SingleOwnerChunk {
    return {
      data: response.data,
      identifier: response.identifier,
      signature: response.signature,
      span: response.span,
      payload: response.payload,
      address: response.address,
      owner: response.owner,
    }
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
   * Gets the current postage batch for the authenticated identity.
   *
   * Returns information about the postage stamp associated with the
   * connected identity, including batch ID, utilization, depth, and TTL.
   *
   * @returns A promise resolving to the PostageBatch or undefined if none is configured
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const batch = await client.getPostageBatch()
   * if (batch) {
   *   console.log('Batch ID:', batch.batchID)
   *   console.log('Utilization:', batch.utilization)
   *   console.log('Depth:', batch.depth)
   *   console.log('TTL:', batch.batchTTL)
   * } else {
   *   console.log('No postage batch configured')
   * }
   * ```
   */
  async getPostageBatch(): Promise<PostageBatch | undefined> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "getPostageBatchResponse"
      requestId: string
      postageBatch?: PostageBatch
      error?: string
    }>({
      type: "getPostageBatch",
      requestId,
    })

    if (response.error) {
      throw new Error(response.error)
    }

    return response.postageBatch
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
   * **Browser Compatibility:**
   * - Production (Chrome/Firefox): Works immediately
   * - Localhost (Chrome/Firefox): Works after iframe button grants Storage Access
   * - Safari (any, including private mode): Requires disabling cross-site tracking prevention in settings. Private mode sessions are ephemeral (lost when the private window closes).
   *
   * For localhost development with Chrome/Firefox, click the iframe button first
   * to grant Storage Access. For Safari, see https://github.com/snaha/swarm-id/issues/167
   *
   * @param options - Configuration options for the connect flow
   * @param options.popupMode - Whether to open as a popup window ("popup") or full window ("window", default)
   * @param options.agent - When true, shows the agent sign-up option on the connect page
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
   * client.connect({ popupMode: "popup" })
   *
   * // Open with agent sign-up option visible
   * client.connect({ agent: true })
   * ```
   */
  connect(options: ConnectOptions = {}): string {
    this.ensureReady()

    const { popupMode = "window", agent } = options

    const authUrl = buildAuthUrl(
      this.iframeOrigin,
      window.location.origin,
      this.metadata,
      { agent },
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
  // Bee Connectivity Methods
  // ============================================================================

  /**
   * Checks whether the Bee node is reachable.
   *
   * This method never throws an exception. If the client is not initialized,
   * the request times out, or any other error occurs, it returns `false`.
   *
   * @returns A promise resolving to `true` if the Bee node is reachable, `false` otherwise
   *
   * @example
   * ```typescript
   * const connected = await client.isBeeConnected()
   * if (connected) {
   *   console.log('Bee node is online')
   * } else {
   *   console.log('Bee node is offline')
   * }
   * ```
   */
  async isBeeConnected(): Promise<boolean> {
    try {
      this.ensureReady()
      const requestId = this.generateRequestId()

      const response = await this.sendRequest<{
        type: "isConnectedResponse"
        requestId: string
        connected: boolean
      }>({
        type: "isConnected",
        requestId,
      })

      return response.connected
    } catch {
      return false
    }
  }

  /**
   * Gets information about the Bee node configuration.
   *
   * This method retrieves the current Bee node's operating mode and feature flags.
   * Use this to determine if deferred uploads are required (dev mode) or if direct
   * uploads are available (production modes).
   *
   * @returns A promise resolving to the node info object
   * @returns return.beeMode - The Bee node operating mode ("dev", "light", "full", "ultra-light")
   * @returns return.chequebookEnabled - Whether the chequebook is enabled
   * @returns return.swapEnabled - Whether SWAP is enabled
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the Bee node is not reachable
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const nodeInfo = await client.getNodeInfo()
   * if (nodeInfo.beeMode === 'dev') {
   *   // Dev mode requires deferred uploads
   *   await client.uploadData(data, { deferred: true })
   * } else {
   *   // Production modes can use direct uploads
   *   await client.uploadData(data, { deferred: false })
   * }
   * ```
   */
  async getNodeInfo(): Promise<{
    beeMode: string
    chequebookEnabled: boolean
    swapEnabled: boolean
  }> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "getNodeInfoResponse"
      requestId: string
      beeMode: string
      chequebookEnabled: boolean
      swapEnabled: boolean
    }>({
      type: "getNodeInfo",
      requestId,
    })

    return {
      beeMode: response.beeMode,
      chequebookEnabled: response.chequebookEnabled,
      swapEnabled: response.swapEnabled,
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
   * @param options.onProgress - Optional callback for tracking upload progress
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry)
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
   * const result = await client.uploadData(data, {
   *   encrypt: true,
   *   onProgress: (progress) => {
   *     console.log(`Progress: ${progress.processed}/${progress.total}`)
   *   },
   * })
   * console.log('Reference:', result.reference)
   * ```
   */
  async uploadData(
    data: Uint8Array,
    options?: UploadOptions,
    requestOptions?: RequestOptions,
  ): Promise<UploadResult> {
    this.ensureReady()
    const requestId = this.generateRequestId()
    const { onProgress, ...serializableOptions } = options ?? {}

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
        options: serializableOptions,
        requestOptions,
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
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry)
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
    requestOptions?: RequestOptions,
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
      requestOptions,
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
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry)
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
    requestOptions?: RequestOptions,
  ): Promise<UploadResult> {
    this.ensureReady()
    const requestId = this.generateRequestId()
    const { onProgress: _onProgress, ...serializableOptions } = options ?? {}

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
      options: serializableOptions,
      requestOptions,
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
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry)
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
    requestOptions?: RequestOptions,
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
      requestOptions,
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
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry)
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
    requestOptions?: RequestOptions,
  ): Promise<UploadResult> {
    this.ensureReady()
    const requestId = this.generateRequestId()
    const { onProgress: _onProgress, ...serializableOptions } = options ?? {}

    const response = await this.sendRequest<{
      type: "uploadChunkResponse"
      requestId: string
      reference: Reference
    }>({
      type: "uploadChunk",
      requestId,
      data: data as Uint8Array,
      options: serializableOptions,
      requestOptions,
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
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry)
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
    requestOptions?: RequestOptions,
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
      requestOptions,
    })

    return new Uint8Array(response.data)
  }

  // ============================================================================
  // SOC (Single Owner Chunk) Methods
  // ============================================================================

  /**
   * Returns an object for reading single owner chunks (SOC).
   *
   * @param ownerAddress - Ethereum address of the SOC owner
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry)
   * @returns SOCReader with `download` (encrypted) and `rawDownload` (unencrypted)
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const reader = client.makeSOCReader(owner)
   * const soc = await reader.download(identifier, encryptionKey)
   * console.log('Payload:', new TextDecoder().decode(soc.payload))
   * ```
   */
  makeSOCReader(
    ownerAddress: EthAddress | Uint8Array | string,
    requestOptions?: RequestOptions,
  ): SOCReader {
    this.ensureReady()
    const owner = new EthAddress(ownerAddress).toHex()

    const sendSocDownload = async (
      identifier: Identifier | Uint8Array | string,
      encryptionKey: Uint8Array | string,
    ): Promise<SingleOwnerChunk> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SocDownloadResponseMessage,
        SocDownloadMessage
      >({
        type: "socDownload",
        requestId,
        owner,
        identifier: this.normalizeSocIdentifier(identifier),
        encryptionKey: this.normalizeSocKey(encryptionKey),
        requestOptions,
      })

      return this.socChunkFromResponse(response)
    }

    const sendRawSocDownload = async (
      identifier: Identifier | Uint8Array | string,
      encryptionKey?: Uint8Array | string,
    ): Promise<SingleOwnerChunk> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SocRawDownloadResponseMessage,
        SocRawDownloadMessage
      >({
        type: "socRawDownload",
        requestId,
        owner,
        identifier: this.normalizeSocIdentifier(identifier),
        encryptionKey: encryptionKey
          ? this.normalizeSocKey(encryptionKey)
          : undefined,
        requestOptions,
      })

      return this.socChunkFromResponse(response)
    }

    return {
      getOwner: async () => owner,
      rawDownload: (identifier, encryptionKey) =>
        sendRawSocDownload(identifier, encryptionKey),
      download: (identifier, encryptionKey) =>
        sendSocDownload(identifier, encryptionKey),
    }
  }

  /**
   * Returns an object for reading and writing single owner chunks (SOC).
   *
   * Uploads are encrypted by default. Use `rawUpload` for unencrypted SOCs.
   *
   * @param signer - Optional SOC signer private key. If omitted, the proxy uses the app signer.
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry)
   * @returns SOCWriter with `upload`, `rawUpload`, `download`, and `rawDownload`
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const writer = client.makeSOCWriter()
   * const upload = await writer.upload(identifier, payload)
   * const soc = await writer.download(identifier, upload.encryptionKey)
   * ```
   */
  makeSOCWriter(
    signer?: PrivateKey | Uint8Array | string,
    requestOptions?: RequestOptions,
  ): SOCWriter {
    this.ensureReady()
    const signerObj = signer ? new PrivateKey(signer) : undefined
    const signerKey = signerObj ? signerObj.toHex() : undefined
    let owner: string | undefined = signerObj
      ? signerObj.publicKey().address().toHex()
      : undefined

    const resolveOwner = async (): Promise<string> => {
      if (owner) {
        return owner
      }

      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SocGetOwnerResponseMessage,
        SocGetOwnerMessage
      >({
        type: "socGetOwner",
        requestId,
      })

      owner = response.owner
      return owner
    }

    const sendSocDownload = async (
      identifier: Identifier | Uint8Array | string,
      encryptionKey: Uint8Array | string,
    ): Promise<SingleOwnerChunk> => {
      const requestId = this.generateRequestId()

      const response = await this.sendRequest<
        SocDownloadResponseMessage,
        SocDownloadMessage
      >({
        type: "socDownload",
        requestId,
        owner,
        identifier: this.normalizeSocIdentifier(identifier),
        encryptionKey: this.normalizeSocKey(encryptionKey),
        requestOptions,
      })

      return this.socChunkFromResponse(response)
    }

    const sendRawSocDownload = async (
      identifier: Identifier | Uint8Array | string,
      encryptionKey?: Uint8Array | string,
    ): Promise<SingleOwnerChunk> => {
      const requestId = this.generateRequestId()

      const response = await this.sendRequest<
        SocRawDownloadResponseMessage,
        SocRawDownloadMessage
      >({
        type: "socRawDownload",
        requestId,
        owner,
        identifier: this.normalizeSocIdentifier(identifier),
        encryptionKey: encryptionKey
          ? this.normalizeSocKey(encryptionKey)
          : undefined,
        requestOptions,
      })

      return this.socChunkFromResponse(response)
    }

    const sendSocUpload = async (
      identifier: Identifier | Uint8Array | string,
      data: Uint8Array,
      options?: UploadOptions,
    ): Promise<SocUploadResult> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SocUploadResponseMessage,
        SocUploadMessage
      >({
        type: "socUpload",
        requestId,
        identifier: this.normalizeSocIdentifier(identifier),
        data: new Uint8Array(data),
        signer: signerKey,
        options,
        requestOptions,
      })

      owner = response.owner

      return {
        reference: response.reference,
        tagUid: response.tagUid,
        encryptionKey: response.encryptionKey,
        owner: response.owner,
      }
    }

    const sendRawSocUpload = async (
      identifier: Identifier | Uint8Array | string,
      data: Uint8Array,
      options?: UploadOptions,
    ): Promise<SocRawUploadResult> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SocRawUploadResponseMessage,
        SocRawUploadMessage
      >({
        type: "socRawUpload",
        requestId,
        identifier: this.normalizeSocIdentifier(identifier),
        data: new Uint8Array(data),
        signer: signerKey,
        options,
        requestOptions,
      })

      owner = response.owner

      return {
        reference: response.reference,
        tagUid: response.tagUid,
        encryptionKey: response.encryptionKey,
        owner: response.owner,
      }
    }

    return {
      getOwner: resolveOwner,
      rawDownload: (identifier, encryptionKey) =>
        sendRawSocDownload(identifier, encryptionKey),
      download: (identifier, encryptionKey) =>
        sendSocDownload(identifier, encryptionKey),
      upload: (identifier, data, options) =>
        sendSocUpload(identifier, data, options),
      rawUpload: (identifier, data, options) =>
        sendRawSocUpload(identifier, data, options),
    }
  }

  /**
   * Returns an object for reading epoch-based feeds.
   *
   * @param options - Feed reader options
   * @param options.topic - Feed topic (32 bytes)
   * @param options.owner - Optional feed owner address
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry)
   * @returns FeedReader with `getOwner`, `downloadReference`, and `downloadPayload`
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the request times out
   */
  makeEpochFeedReader(
    options: FeedReaderOptions,
    requestOptions?: RequestOptions,
  ): FeedReader {
    this.ensureReady()
    const topic = this.normalizeFeedTopic(options.topic)
    let owner: string | undefined = options.owner
      ? new EthAddress(options.owner).toHex()
      : undefined

    const resolveOwner = async (): Promise<string> => {
      if (owner) {
        return owner
      }

      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        FeedGetOwnerResponseMessage,
        FeedGetOwnerMessage
      >({
        type: "feedGetOwner",
        requestId,
      })

      owner = response.owner
      return owner
    }

    const downloadReference = async (
      options?: EpochFeedDownloadOptions,
    ): Promise<EpochFeedDownloadReferenceResult> => {
      const atValue =
        options?.at !== undefined
          ? options.at
          : BigInt(Math.floor(Date.now() / 1000))
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        EpochFeedDownloadReferenceResponseMessage,
        EpochFeedDownloadReferenceMessage
      >({
        type: "epochFeedDownloadReference",
        requestId,
        topic,
        owner,
        at: this.normalizeFeedTimestamp(atValue),
        after:
          options?.after !== undefined
            ? this.normalizeFeedTimestamp(options.after)
            : undefined,
        encryptionKey:
          options?.encryptionKey !== undefined
            ? this.normalizeSocKey(options.encryptionKey)
            : undefined,
        requestOptions,
      })
      const reference = response.reference
      const cleanRef =
        reference && reference.startsWith("0x") ? reference.slice(2) : reference
      const encryptionKey =
        cleanRef && cleanRef.length === 128 ? cleanRef.slice(64) : undefined
      return { reference, encryptionKey }
    }

    const downloadPayload = async (
      options?: EpochFeedDownloadOptions,
    ): Promise<EpochFeedDownloadPayloadResult> => {
      const result = await downloadReference(options)
      if (!result.reference) {
        return {
          reference: undefined,
          payload: undefined,
          encryptionKey: undefined,
        }
      }
      const payload = await this.downloadData(
        result.reference,
        undefined,
        requestOptions,
      )
      return {
        reference: result.reference,
        payload,
        encryptionKey: result.encryptionKey,
      }
    }

    const downloadRawReference = async (
      options?: Omit<EpochFeedDownloadOptions, "encryptionKey">,
    ): Promise<EpochFeedDownloadReferenceResult> => {
      const atValue =
        options?.at !== undefined
          ? options.at
          : BigInt(Math.floor(Date.now() / 1000))
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        EpochFeedDownloadReferenceResponseMessage,
        EpochFeedDownloadReferenceMessage
      >({
        type: "epochFeedDownloadReference",
        requestId,
        topic,
        owner,
        at: this.normalizeFeedTimestamp(atValue),
        after:
          options?.after !== undefined
            ? this.normalizeFeedTimestamp(options.after)
            : undefined,
        encryptionKey: undefined, // No encryption for raw download
        requestOptions,
      })
      const reference = response.reference
      return { reference, encryptionKey: undefined }
    }

    const downloadRawPayload = async (
      options?: Omit<EpochFeedDownloadOptions, "encryptionKey">,
    ): Promise<EpochFeedDownloadPayloadResult> => {
      const result = await downloadRawReference(options)
      if (!result.reference) {
        return {
          reference: undefined,
          payload: undefined,
          encryptionKey: undefined,
        }
      }
      const payload = await this.downloadData(
        result.reference,
        undefined,
        requestOptions,
      )
      return {
        reference: result.reference,
        payload,
        encryptionKey: undefined,
      }
    }

    return {
      getOwner: resolveOwner,
      downloadReference,
      downloadPayload,
      downloadRawReference,
      downloadRawPayload,
    }
  }

  /**
   * Returns an object for reading and writing epoch-based feeds.
   *
   * @param options - Feed writer options
   * @param options.topic - Feed topic (32 bytes)
   * @param options.signer - Optional feed signer private key. If omitted, the proxy uses the app signer.
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry)
   * @returns FeedWriter with `getOwner`, `downloadReference`, `downloadPayload`, `uploadPayload`, and `uploadReference`
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the request times out
   */
  makeEpochFeedWriter(
    options: FeedWriterOptions,
    requestOptions?: RequestOptions,
  ): FeedWriter {
    this.ensureReady()
    const topic = this.normalizeFeedTopic(options.topic)
    const signerObj = options.signer
      ? new PrivateKey(options.signer)
      : undefined
    const signerKey = signerObj ? signerObj.toHex() : undefined
    let owner: string | undefined = signerObj
      ? signerObj.publicKey().address().toHex()
      : undefined

    const resolveOwner = async (): Promise<string> => {
      if (owner) {
        return owner
      }

      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        FeedGetOwnerResponseMessage,
        FeedGetOwnerMessage
      >({
        type: "feedGetOwner",
        requestId,
      })

      owner = response.owner
      return owner
    }

    const downloadReference = async (
      options?: EpochFeedDownloadOptions,
    ): Promise<EpochFeedDownloadReferenceResult> => {
      const atValue =
        options?.at !== undefined
          ? options.at
          : BigInt(Math.floor(Date.now() / 1000))
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        EpochFeedDownloadReferenceResponseMessage,
        EpochFeedDownloadReferenceMessage
      >({
        type: "epochFeedDownloadReference",
        requestId,
        topic,
        owner,
        at: this.normalizeFeedTimestamp(atValue),
        after:
          options?.after !== undefined
            ? this.normalizeFeedTimestamp(options.after)
            : undefined,
        encryptionKey:
          options?.encryptionKey !== undefined
            ? this.normalizeSocKey(options.encryptionKey)
            : undefined,
        requestOptions,
      })
      const reference = response.reference
      const cleanRef =
        reference && reference.startsWith("0x") ? reference.slice(2) : reference
      const encryptionKey =
        cleanRef && cleanRef.length === 128 ? cleanRef.slice(64) : undefined
      return { reference, encryptionKey }
    }

    const downloadPayload = async (
      options?: EpochFeedDownloadOptions,
    ): Promise<EpochFeedDownloadPayloadResult> => {
      const result = await downloadReference(options)
      if (!result.reference) {
        return {
          reference: undefined,
          payload: undefined,
          encryptionKey: undefined,
        }
      }
      const payload = await this.downloadData(
        result.reference,
        undefined,
        requestOptions,
      )
      return {
        reference: result.reference,
        payload,
        encryptionKey: result.encryptionKey,
      }
    }

    const uploadReference = async (
      reference: Uint8Array | string,
      options?: EpochFeedUploadOptions,
    ): Promise<EpochFeedUploadResult> => {
      const atValue =
        options?.at !== undefined
          ? options.at
          : BigInt(Math.floor(Date.now() / 1000))
      const normalizedRef = this.normalizeReference(reference)
      const cleanRef = normalizedRef.startsWith("0x")
        ? normalizedRef.slice(2)
        : normalizedRef
      const derivedKey =
        cleanRef.length === 128 ? cleanRef.slice(64) : undefined
      const feedKey = options?.encryptionKey ?? derivedKey
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        EpochFeedUploadReferenceResponseMessage,
        EpochFeedUploadReferenceMessage
      >({
        type: "epochFeedUploadReference",
        requestId,
        topic,
        signer: signerKey,
        at: this.normalizeFeedTimestamp(atValue),
        reference: normalizedRef,
        encryptionKey:
          feedKey !== undefined ? this.normalizeSocKey(feedKey) : undefined,
        hints: options?.hints,
        requestOptions,
      })
      const socAddress = response.socAddress
      const encryptionKey = derivedKey
      return {
        socAddress,
        reference: normalizedRef,
        encryptionKey,
        epoch: response.epoch,
        timestamp: response.timestamp,
      }
    }

    const uploadPayload = async (
      data: Uint8Array | string,
      options?: EpochFeedUploadOptions,
    ): Promise<EpochFeedUploadResult> => {
      const atValue =
        options?.at !== undefined
          ? options.at
          : BigInt(Math.floor(Date.now() / 1000))
      const encrypt = options?.encrypt !== false
      const uploadResult = await this.uploadData(
        this.normalizePayload(data),
        { ...options?.uploadOptions, encrypt },
        requestOptions,
      )
      const cleanRef = uploadResult.reference.startsWith("0x")
        ? uploadResult.reference.slice(2)
        : uploadResult.reference
      const derivedKey =
        cleanRef.length === 128 ? cleanRef.slice(64) : undefined
      const feedKey = options?.encryptionKey ?? derivedKey
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        EpochFeedUploadReferenceResponseMessage,
        EpochFeedUploadReferenceMessage
      >({
        type: "epochFeedUploadReference",
        requestId,
        topic,
        signer: signerKey,
        at: this.normalizeFeedTimestamp(atValue),
        reference: uploadResult.reference,
        encryptionKey:
          feedKey !== undefined ? this.normalizeSocKey(feedKey) : undefined,
        hints: options?.hints,
        requestOptions,
      })
      const socAddress = response.socAddress
      const encryptionKey = derivedKey
      return {
        socAddress,
        reference: uploadResult.reference,
        encryptionKey,
        epoch: response.epoch,
        timestamp: response.timestamp,
      }
    }

    const downloadRawReference = async (
      options?: Omit<EpochFeedDownloadOptions, "encryptionKey">,
    ): Promise<EpochFeedDownloadReferenceResult> => {
      const atValue =
        options?.at !== undefined
          ? options.at
          : BigInt(Math.floor(Date.now() / 1000))
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        EpochFeedDownloadReferenceResponseMessage,
        EpochFeedDownloadReferenceMessage
      >({
        type: "epochFeedDownloadReference",
        requestId,
        topic,
        owner,
        at: this.normalizeFeedTimestamp(atValue),
        after:
          options?.after !== undefined
            ? this.normalizeFeedTimestamp(options.after)
            : undefined,
        encryptionKey: undefined, // No encryption for raw download
        requestOptions,
      })
      const reference = response.reference
      return { reference, encryptionKey: undefined }
    }

    const downloadRawPayload = async (
      options?: Omit<EpochFeedDownloadOptions, "encryptionKey">,
    ): Promise<EpochFeedDownloadPayloadResult> => {
      const result = await downloadRawReference(options)
      if (!result.reference) {
        return {
          reference: undefined,
          payload: undefined,
          encryptionKey: undefined,
        }
      }
      const payload = await this.downloadData(
        result.reference,
        undefined,
        requestOptions,
      )
      return {
        reference: result.reference,
        payload,
        encryptionKey: undefined,
      }
    }

    const uploadRawReference = async (
      reference: Uint8Array | string,
      options?: Omit<EpochFeedUploadOptions, "encryptionKey">,
    ): Promise<EpochFeedUploadResult> => {
      const atValue =
        options?.at !== undefined
          ? options.at
          : BigInt(Math.floor(Date.now() / 1000))
      const normalizedRef = this.normalizeReference(reference)
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        EpochFeedUploadReferenceResponseMessage,
        EpochFeedUploadReferenceMessage
      >({
        type: "epochFeedUploadReference",
        requestId,
        topic,
        signer: signerKey,
        at: this.normalizeFeedTimestamp(atValue),
        reference: normalizedRef,
        encryptionKey: undefined, // No encryption for raw upload
        hints: options?.hints,
        requestOptions,
      })
      const socAddress = response.socAddress
      return {
        socAddress,
        reference: normalizedRef,
        encryptionKey: undefined,
        epoch: response.epoch,
        timestamp: response.timestamp,
      }
    }

    const uploadRawPayload = async (
      data: Uint8Array | string,
      options?: Omit<EpochFeedUploadOptions, "encryptionKey" | "encrypt">,
    ): Promise<EpochFeedUploadResult> => {
      const atValue =
        options?.at !== undefined
          ? options.at
          : BigInt(Math.floor(Date.now() / 1000))
      // Upload with encrypt: false for raw payload
      const uploadResult = await this.uploadData(
        this.normalizePayload(data),
        { ...options?.uploadOptions, encrypt: false },
        requestOptions,
      )
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        EpochFeedUploadReferenceResponseMessage,
        EpochFeedUploadReferenceMessage
      >({
        type: "epochFeedUploadReference",
        requestId,
        topic,
        signer: signerKey,
        at: this.normalizeFeedTimestamp(atValue),
        reference: uploadResult.reference,
        encryptionKey: undefined, // No encryption for raw upload
        hints: options?.hints,
        requestOptions,
      })
      const socAddress = response.socAddress
      return {
        socAddress,
        reference: uploadResult.reference,
        encryptionKey: undefined,
        epoch: response.epoch,
        timestamp: response.timestamp,
      }
    }

    return {
      getOwner: resolveOwner,
      downloadReference,
      downloadPayload,
      downloadRawReference,
      downloadRawPayload,
      uploadReference,
      uploadPayload,
      uploadRawReference,
      uploadRawPayload,
    }
  }

  /**
   * Returns a sequential feed reader (chunk API only).
   *
   * @param options - Sequential feed reader options
   * @param options.topic - Feed topic (32 bytes)
   * @param options.owner - Optional feed owner address
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry)
   * @returns SequentialFeedReader with payload/reference download helpers
   */
  makeSequentialFeedReader(
    options: SequentialFeedReaderOptions,
    requestOptions?: RequestOptions,
  ): SequentialFeedReader {
    this.ensureReady()
    const topic = this.normalizeFeedTopic(options.topic)
    let owner: string | undefined = options.owner
      ? new EthAddress(options.owner).toHex()
      : undefined

    const resolveOwner = async (): Promise<string> => {
      if (owner) {
        return owner
      }
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SequentialFeedGetOwnerResponseMessage,
        SequentialFeedGetOwnerMessage
      >({
        type: "seqFeedGetOwner",
        requestId,
      })
      owner = response.owner
      return owner
    }

    const downloadPayload = async (
      encryptionKey: Uint8Array | string,
      options?: SequentialFeedUpdateOptions,
    ): Promise<SequentialFeedPayloadResult> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SequentialFeedDownloadPayloadResponseMessage,
        SequentialFeedDownloadPayloadMessage
      >({
        type: "seqFeedDownloadPayload",
        requestId,
        topic,
        owner,
        index:
          options?.index !== undefined
            ? this.normalizeFeedIndex(options.index as bigint | number | string)
            : undefined,
        at:
          options?.at !== undefined
            ? this.normalizeFeedTimestamp(
                options.at as bigint | number | string,
              )
            : undefined,
        hasTimestamp: options?.hasTimestamp,
        lookupTimeoutMs: options?.lookupTimeoutMs,
        encryptionKey: this.normalizeSocKey(encryptionKey),
        requestOptions,
      })

      return {
        payload: response.payload,
        timestamp: response.timestamp,
        feedIndex: response.feedIndex,
        feedIndexNext: response.feedIndexNext,
      }
    }

    const downloadRawPayload = async (
      options?: SequentialFeedDownloadRawOptions,
    ): Promise<SequentialFeedPayloadResult> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SequentialFeedDownloadRawPayloadResponseMessage,
        SequentialFeedDownloadRawPayloadMessage
      >({
        type: "seqFeedDownloadRawPayload",
        requestId,
        topic,
        owner,
        index:
          options?.index !== undefined
            ? this.normalizeFeedIndex(options.index as bigint | number | string)
            : undefined,
        at:
          options?.at !== undefined
            ? this.normalizeFeedTimestamp(
                options.at as bigint | number | string,
              )
            : undefined,
        hasTimestamp: options?.hasTimestamp,
        lookupTimeoutMs: options?.lookupTimeoutMs,
        encryptionKey: options?.encryptionKey
          ? this.normalizeSocKey(options.encryptionKey)
          : undefined,
        requestOptions,
      })

      return {
        payload: response.payload,
        timestamp: response.timestamp,
        feedIndex: response.feedIndex,
        feedIndexNext: response.feedIndexNext,
      }
    }

    const downloadReference = async (
      encryptionKey: Uint8Array | string,
      options?: SequentialFeedUpdateOptions,
    ): Promise<SequentialFeedReferenceResult> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SequentialFeedDownloadReferenceResponseMessage,
        SequentialFeedDownloadReferenceMessage
      >({
        type: "seqFeedDownloadReference",
        requestId,
        topic,
        owner,
        index:
          options?.index !== undefined
            ? this.normalizeFeedIndex(options.index as bigint | number | string)
            : undefined,
        at:
          options?.at !== undefined
            ? this.normalizeFeedTimestamp(
                options.at as bigint | number | string,
              )
            : undefined,
        hasTimestamp: options?.hasTimestamp,
        lookupTimeoutMs: options?.lookupTimeoutMs,
        encryptionKey: this.normalizeSocKey(encryptionKey),
        requestOptions,
      })

      return {
        reference: response.reference,
        feedIndex: response.feedIndex,
        feedIndexNext: response.feedIndexNext,
      }
    }

    return {
      getOwner: resolveOwner,
      downloadPayload,
      downloadRawPayload,
      downloadReference,
    }
  }

  /**
   * Returns a sequential feed writer (chunk API only).
   *
   * @param options - Sequential feed writer options
   * @param options.topic - Feed topic (32 bytes)
   * @param options.signer - Optional signer private key. If omitted, proxy uses app signer.
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry)
   * @returns SequentialFeedWriter with payload/reference upload helpers
   */
  makeSequentialFeedWriter(
    options: SequentialFeedWriterOptions,
    requestOptions?: RequestOptions,
  ): SequentialFeedWriter {
    this.ensureReady()
    const topic = this.normalizeFeedTopic(options.topic)
    const signerObj = options.signer
      ? new PrivateKey(options.signer)
      : undefined
    const signerKey = signerObj ? signerObj.toHex() : undefined
    let owner: string | undefined = signerObj
      ? signerObj.publicKey().address().toHex()
      : undefined

    const resolveOwner = async (): Promise<string> => {
      if (owner) {
        return owner
      }
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SequentialFeedGetOwnerResponseMessage,
        SequentialFeedGetOwnerMessage
      >({
        type: "seqFeedGetOwner",
        requestId,
      })
      owner = response.owner
      return owner
    }

    const downloadPayload = async (
      encryptionKey: Uint8Array | string,
      options?: SequentialFeedUpdateOptions,
    ): Promise<SequentialFeedPayloadResult> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SequentialFeedDownloadPayloadResponseMessage,
        SequentialFeedDownloadPayloadMessage
      >({
        type: "seqFeedDownloadPayload",
        requestId,
        topic,
        owner,
        index:
          options?.index !== undefined
            ? this.normalizeFeedIndex(options.index as bigint | number | string)
            : undefined,
        at:
          options?.at !== undefined
            ? this.normalizeFeedTimestamp(
                options.at as bigint | number | string,
              )
            : undefined,
        hasTimestamp: options?.hasTimestamp,
        encryptionKey: this.normalizeSocKey(encryptionKey),
        requestOptions,
      })

      return {
        payload: response.payload,
        timestamp: response.timestamp,
        feedIndex: response.feedIndex,
        feedIndexNext: response.feedIndexNext,
      }
    }

    const downloadRawPayload = async (
      options?: SequentialFeedDownloadRawOptions,
    ): Promise<SequentialFeedPayloadResult> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SequentialFeedDownloadRawPayloadResponseMessage,
        SequentialFeedDownloadRawPayloadMessage
      >({
        type: "seqFeedDownloadRawPayload",
        requestId,
        topic,
        owner,
        index:
          options?.index !== undefined
            ? this.normalizeFeedIndex(options.index as bigint | number | string)
            : undefined,
        at:
          options?.at !== undefined
            ? this.normalizeFeedTimestamp(
                options.at as bigint | number | string,
              )
            : undefined,
        hasTimestamp: options?.hasTimestamp,
        encryptionKey: options?.encryptionKey
          ? this.normalizeSocKey(options.encryptionKey)
          : undefined,
        requestOptions,
      })

      return {
        payload: response.payload,
        timestamp: response.timestamp,
        feedIndex: response.feedIndex,
        feedIndexNext: response.feedIndexNext,
      }
    }

    const downloadReference = async (
      encryptionKey: Uint8Array | string,
      options?: SequentialFeedUpdateOptions,
    ): Promise<SequentialFeedReferenceResult> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SequentialFeedDownloadReferenceResponseMessage,
        SequentialFeedDownloadReferenceMessage
      >({
        type: "seqFeedDownloadReference",
        requestId,
        topic,
        owner,
        index:
          options?.index !== undefined
            ? this.normalizeFeedIndex(options.index as bigint | number | string)
            : undefined,
        at:
          options?.at !== undefined
            ? this.normalizeFeedTimestamp(
                options.at as bigint | number | string,
              )
            : undefined,
        hasTimestamp: options?.hasTimestamp,
        encryptionKey: this.normalizeSocKey(encryptionKey),
        requestOptions,
      })

      return {
        reference: response.reference,
        feedIndex: response.feedIndex,
        feedIndexNext: response.feedIndexNext,
      }
    }

    const uploadPayload = async (
      data: Uint8Array | string,
      options?: SequentialFeedUploadOptions,
    ): Promise<SequentialFeedUploadResult> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SequentialFeedUploadPayloadResponseMessage,
        SequentialFeedUploadPayloadMessage
      >({
        type: "seqFeedUploadPayload",
        requestId,
        topic,
        signer: signerKey,
        data: this.normalizePayload(data),
        index:
          options?.index !== undefined
            ? this.normalizeFeedIndex(options.index as bigint | number | string)
            : undefined,
        at:
          options?.at !== undefined
            ? this.normalizeFeedTimestamp(
                options.at as bigint | number | string,
              )
            : undefined,
        hasTimestamp: options?.hasTimestamp,
        lookupTimeoutMs: options?.lookupTimeoutMs,
        options,
        requestOptions,
      })

      owner = response.owner

      return {
        reference: response.reference,
        feedIndex: response.feedIndex,
        owner: response.owner,
        encryptionKey: response.encryptionKey,
        tagUid: response.tagUid,
      }
    }

    const uploadRawPayload = async (
      data: Uint8Array | string,
      options?: SequentialFeedUploadRawOptions,
    ): Promise<SequentialFeedUploadResult> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SequentialFeedUploadRawPayloadResponseMessage,
        SequentialFeedUploadRawPayloadMessage
      >({
        type: "seqFeedUploadRawPayload",
        requestId,
        topic,
        signer: signerKey,
        data: this.normalizePayload(data),
        index:
          options?.index !== undefined
            ? this.normalizeFeedIndex(options.index as bigint | number | string)
            : undefined,
        at:
          options?.at !== undefined
            ? this.normalizeFeedTimestamp(
                options.at as bigint | number | string,
              )
            : undefined,
        hasTimestamp: options?.hasTimestamp,
        lookupTimeoutMs: options?.lookupTimeoutMs,
        encryptionKey: options?.encryptionKey
          ? this.normalizeSocKey(options.encryptionKey)
          : undefined,
        options,
        requestOptions,
      })

      owner = response.owner

      return {
        reference: response.reference,
        feedIndex: response.feedIndex,
        owner: response.owner,
        encryptionKey: response.encryptionKey,
        tagUid: response.tagUid,
      }
    }

    const uploadReference = async (
      reference: Uint8Array | string,
      options?: SequentialFeedUploadOptions,
    ): Promise<SequentialFeedUploadResult> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SequentialFeedUploadReferenceResponseMessage,
        SequentialFeedUploadReferenceMessage
      >({
        type: "seqFeedUploadReference",
        requestId,
        topic,
        signer: signerKey,
        reference: this.normalizeReference(reference),
        index:
          options?.index !== undefined
            ? this.normalizeFeedIndex(options.index as bigint | number | string)
            : undefined,
        at:
          options?.at !== undefined
            ? this.normalizeFeedTimestamp(
                options.at as bigint | number | string,
              )
            : undefined,
        hasTimestamp: options?.hasTimestamp,
        lookupTimeoutMs: options?.lookupTimeoutMs,
        options,
        requestOptions,
      })

      owner = response.owner

      return {
        reference: response.reference,
        feedIndex: response.feedIndex,
        owner: response.owner,
        encryptionKey: response.encryptionKey,
        tagUid: response.tagUid,
      }
    }

    return {
      getOwner: resolveOwner,
      downloadPayload,
      downloadRawPayload,
      downloadReference,
      uploadPayload,
      uploadRawPayload,
      uploadReference,
    }
  }

  // ============================================================================
  // Feed Manifest Methods
  // ============================================================================

  /**
   * Creates a feed manifest for accessing feed content via URL.
   *
   * A feed manifest enables accessing the latest feed content via a URL path
   * (e.g., `/bzz/{manifest-reference}/`). The manifest stores metadata about
   * the feed including owner, topic, and type.
   *
   * @param topic - Feed topic (32-byte hex string)
   * @param options - Optional configuration
   * @param options.owner - Feed owner address; if omitted, uses app signer
   * @param options.uploadOptions - Upload configuration (pin, deferred, etc.)
   * @param requestOptions - Request configuration (timeout, headers)
   * @returns Promise resolving to the manifest reference
   * @throws {Error} If the client is not initialized
   * @throws {Error} If no owner is provided and no app signer is available
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * // Create manifest for a feed (uses app signer as owner)
   * const manifestRef = await client.createFeedManifest(topic)
   * console.log('Feed accessible at /bzz/' + manifestRef)
   *
   * // Create manifest with explicit owner
   * const manifestRef = await client.createFeedManifest(topic, {
   *   owner: '0x1234...',
   *   uploadOptions: { pin: true }
   * })
   * ```
   */
  async createFeedManifest(
    topic: string,
    options?: {
      owner?: string
      /** Feed type: "Sequence" for sequential feeds, "Epoch" for epoch feeds. Default: "Sequence" */
      feedType?: "Sequence" | "Epoch"
      uploadOptions?: UploadOptions
    },
    requestOptions?: RequestOptions,
  ): Promise<string> {
    this.ensureReady()
    const normalizedTopic = this.normalizeFeedTopic(topic)
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<
      CreateFeedManifestResponseMessage,
      CreateFeedManifestMessage
    >({
      type: "createFeedManifest",
      requestId,
      topic: normalizedTopic,
      owner: options?.owner,
      feedType: options?.feedType,
      uploadOptions: options?.uploadOptions,
      requestOptions,
    })

    return response.reference
  }

  // ============================================================================
  // GSOC Methods
  // ============================================================================

  /**
   * Mines a private key whose SOC address is proximate to a target overlay.
   *
   * This is a synchronous, pure computation that does not require authentication.
   * The mined signer can be used with {@link gsocSend} to send GSOC messages
   * that route to the target overlay node.
   *
   * @param targetOverlay - The target overlay address to mine proximity for
   * @param identifier - The GSOC identifier
   * @param proximity - Optional proximity depth (defaults to 12 in bee-js)
   * @returns A promise resolving to the mined signer as a hex string (private key)
   * @throws {Error} If the client is not initialized
   * @throws {Error} If no valid signer can be mined
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const signer = await client.gsocMine(targetOverlay, identifier)
   * // Use signer with gsocSend
   * await client.gsocSend(signer, identifier, data)
   * ```
   */
  async gsocMine(
    targetOverlay: string,
    identifier: string,
    proximity?: number,
  ): Promise<string> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "gsocMineResponse"
      requestId: string
      signer: string
    }>({
      type: "gsocMine",
      requestId,
      targetOverlay,
      identifier,
      proximity,
    })

    return response.signer
  }

  /**
   * Sends a GSOC (Global Single Owner Chunk) message using a mined signer.
   *
   * The signer should be obtained from {@link gsocMine}. The message is sent
   * using the proxy's stored postage batch ID.
   *
   * @param signer - The mined signer as a hex string (from gsocMine)
   * @param identifier - The GSOC identifier
   * @param data - The message data to send
   * @param options - Optional upload configuration
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry)
   * @returns A promise resolving to the upload result with reference and optional tagUid
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the user is not authenticated
   * @throws {Error} If no postage batch ID is available
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const signer = await client.gsocMine(targetOverlay, identifier)
   * const result = await client.gsocSend(signer, identifier, new TextEncoder().encode('Hello!'))
   * console.log('GSOC reference:', result.reference)
   * ```
   */
  async gsocSend(
    signer: string,
    identifier: string,
    data: Uint8Array,
    options?: UploadOptions,
    requestOptions?: RequestOptions,
  ): Promise<UploadResult> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "gsocSendResponse"
      requestId: string
      reference: Reference
      tagUid?: number
    }>({
      type: "gsocSend",
      requestId,
      signer,
      identifier,
      data: new Uint8Array(data),
      options,
      requestOptions,
    })

    return {
      reference: response.reference,
      tagUid: response.tagUid,
    }
  }

  // ============================================================================
  // ACT (Access Control Tries) Methods
  // ============================================================================

  /**
   * Uploads data with ACT (Access Control Tries) protection.
   *
   * This method encrypts the data and creates an ACT that controls who can decrypt it.
   * Only the specified grantees (and the publisher) can decrypt and access the data.
   *
   * @param data - The binary data to upload as a Uint8Array
   * @param grantees - Array of grantee public keys as compressed hex strings (33 bytes = 66 hex chars)
   * @param options - Optional upload configuration
   * @param options.pin - Whether to pin the data locally (defaults to false)
   * @param options.tag - Tag ID for tracking upload progress
   * @param options.deferred - Whether to use deferred upload (defaults to false)
   * @param options.redundancyLevel - Redundancy level from 0-4 for data availability
   * @param options.onProgress - Optional callback for tracking upload progress
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry)
   * @returns A promise resolving to the ACT upload result
   * @returns return.encryptedReference - The encrypted reference that must be stored with the ACT
   * @returns return.actReference - The Swarm reference (hash) of the ACT manifest
   * @returns return.historyReference - The Swarm reference of the history manifest (use for future operations)
   * @returns return.granteeListReference - The Swarm reference of the encrypted grantee list
   * @returns return.publisherPubKey - The publisher's compressed public key (share with grantees)
   * @returns return.tagUid - The tag UID if a tag was created
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the user is not authenticated or cannot upload
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const data = new TextEncoder().encode('Secret message')
   * const grantees = ['03a1b2c3...'] // Compressed public keys of allowed readers
   * const result = await client.actUploadData(data, grantees, {
   *   onProgress: (progress) => {
   *     console.log(`Progress: ${progress.processed}/${progress.total}`)
   *   },
   * })
   * console.log('History Reference:', result.historyReference)
   * console.log('Encrypted Reference:', result.encryptedReference)
   * console.log('Publisher Public Key:', result.publisherPubKey)
   * ```
   */
  async actUploadData(
    data: Uint8Array,
    grantees: string[],
    options?: ActUploadOptions,
    requestOptions?: RequestOptions,
  ): Promise<{
    encryptedReference: string
    historyReference: string
    granteeListReference: string
    publisherPubKey: string
    actReference: string
    tagUid?: number
  }> {
    this.ensureReady()
    const requestId = this.generateRequestId()
    const { onProgress, ...serializableOptions } = options ?? {}

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
        type: "actUploadDataResponse"
        requestId: string
        encryptedReference: string
        historyReference: string
        granteeListReference: string
        publisherPubKey: string
        actReference: string
        tagUid?: number
      }>({
        type: "actUploadData",
        requestId,
        data: new Uint8Array(data),
        grantees,
        options: serializableOptions,
        requestOptions,
        enableProgress: !!onProgress,
      })

      return {
        encryptedReference: response.encryptedReference,
        historyReference: response.historyReference,
        granteeListReference: response.granteeListReference,
        publisherPubKey: response.publisherPubKey,
        actReference: response.actReference,
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
   * Downloads ACT-protected data from the Swarm network.
   *
   * This method decrypts the ACT to recover the content reference,
   * then downloads and returns the decrypted data. Only authorized
   * grantees (including the publisher) can successfully decrypt.
   *
   * @param encryptedReference - The encrypted reference from actUploadData
   * @param historyReference - The history reference from actUploadData
   * @param publisherPubKey - The publisher's compressed public key from actUploadData
   * @param timestamp - Optional timestamp to look up a specific ACT version
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry)
   * @returns A promise resolving to the decrypted data as a Uint8Array
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the user is not authorized to decrypt the ACT
   * @throws {Error} If the references are not found
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * // Using the references from actUploadData
   * const data = await client.actDownloadData(
   *   encryptedReference,
   *   historyReference,
   *   publisherPubKey
   * )
   * const text = new TextDecoder().decode(data)
   * console.log('Decrypted:', text)
   * ```
   */
  async actDownloadData(
    encryptedReference: string,
    historyReference: string,
    publisherPubKey: string,
    timestamp?: number,
    requestOptions?: RequestOptions,
  ): Promise<Uint8Array> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "actDownloadDataResponse"
      requestId: string
      data: Uint8Array
    }>({
      type: "actDownloadData",
      requestId,
      encryptedReference,
      historyReference,
      publisherPubKey,
      timestamp,
      requestOptions,
    })

    return response.data
  }

  /**
   * Adds new grantees to an existing ACT.
   *
   * This method adds new public keys to the ACT's access list.
   * Only the publisher (original uploader) can add grantees.
   * Returns new references since Swarm content is immutable.
   *
   * @param historyReference - The current history reference
   * @param grantees - Array of new grantee public keys as compressed hex strings
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry)
   * @returns A promise resolving to the new references
   * @returns return.historyReference - The new history reference after adding grantees
   * @returns return.granteeListReference - The new grantee list reference
   * @returns return.actReference - The new ACT reference
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the user is not the publisher
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const newGrantees = ['03d4e5f6...'] // New public keys to grant access
   * const result = await client.actAddGrantees(historyReference, newGrantees)
   * console.log('New History Reference:', result.historyReference)
   * // The encrypted reference remains the same
   * ```
   */
  async actAddGrantees(
    historyReference: string,
    grantees: string[],
    requestOptions?: RequestOptions,
  ): Promise<{
    historyReference: string
    granteeListReference: string
    actReference: string
  }> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "actAddGranteesResponse"
      requestId: string
      historyReference: string
      granteeListReference: string
      actReference: string
    }>({
      type: "actAddGrantees",
      requestId,
      historyReference,
      grantees,
      requestOptions,
    })

    return {
      historyReference: response.historyReference,
      granteeListReference: response.granteeListReference,
      actReference: response.actReference,
    }
  }

  /**
   * Revokes grantees from an existing ACT.
   *
   * This method removes public keys from the ACT's access list and performs
   * key rotation to ensure revoked grantees cannot decrypt new versions.
   * Returns new references including a new encrypted reference.
   *
   * IMPORTANT: The original encrypted reference can still be decrypted by
   * revoked grantees if they have cached it. Key rotation only protects
   * access through the new references.
   *
   * @param historyReference - The current history reference
   * @param encryptedReference - The current encrypted reference (needed for key rotation)
   * @param revokeGrantees - Array of grantee public keys to revoke as compressed hex strings
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry)
   * @returns A promise resolving to the new references after revocation
   * @returns return.encryptedReference - The new encrypted reference (key rotated)
   * @returns return.historyReference - The new history reference after revocation
   * @returns return.granteeListReference - The new grantee list reference
   * @returns return.actReference - The new ACT reference after revocation
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the user is not the publisher
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const revokeKeys = ['03a1b2c3...'] // Public keys to revoke
   * const result = await client.actRevokeGrantees(historyReference, encryptedReference, revokeKeys)
   * console.log('New History Reference:', result.historyReference)
   * console.log('New Encrypted Reference:', result.encryptedReference)
   * // All references are new due to key rotation
   * ```
   */
  async actRevokeGrantees(
    historyReference: string,
    encryptedReference: string,
    revokeGrantees: string[],
    requestOptions?: RequestOptions,
  ): Promise<{
    encryptedReference: string
    historyReference: string
    granteeListReference: string
    actReference: string
  }> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "actRevokeGranteesResponse"
      requestId: string
      encryptedReference: string
      historyReference: string
      granteeListReference: string
      actReference: string
    }>({
      type: "actRevokeGrantees",
      requestId,
      historyReference,
      encryptedReference,
      revokeGrantees,
      requestOptions,
    })

    return {
      encryptedReference: response.encryptedReference,
      historyReference: response.historyReference,
      granteeListReference: response.granteeListReference,
      actReference: response.actReference,
    }
  }

  /**
   * Retrieves the list of grantees from an ACT.
   *
   * Only the publisher (original uploader) can view the grantee list,
   * as it is encrypted with the publisher's key.
   *
   * @param historyReference - The history reference
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry)
   * @returns A promise resolving to an array of grantee public keys as compressed hex strings
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the user is not the publisher
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const grantees = await client.actGetGrantees(historyReference)
   * console.log('Current grantees:', grantees.length)
   * grantees.forEach(pubKey => console.log('  -', pubKey))
   * ```
   */
  async actGetGrantees(
    historyReference: string,
    requestOptions?: RequestOptions,
  ): Promise<string[]> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "actGetGranteesResponse"
      requestId: string
      grantees: string[]
    }>({
      type: "actGetGrantees",
      requestId,
      historyReference,
      requestOptions,
    })

    return response.grantees
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
