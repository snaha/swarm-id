import type {
  ClientOptions,
  AuthStatus,
  ButtonStyles,
  UploadResult,
  FileData,
  PostageBatch,
  UploadOptions,
  DownloadOptions,
  Reference,
  BatchId,
  ParentToIframeMessage,
  IframeToParentMessage,
} from "./types"
import {
  IframeToParentMessageSchema,
  ParentToIframeMessageSchema,
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
  private ready: boolean = false
  private readyPromise: Promise<void>
  private readyResolve?: () => void
  private pendingRequests: Map<
    string,
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timeoutId: NodeJS.Timeout;
    }
  > = new Map()
  private requestIdCounter = 0
  private messageListener: ((event: MessageEvent) => void) | undefined

  constructor(options: ClientOptions) {
    this.iframeOrigin = options.iframeOrigin
    this.iframePath = options.iframePath || "/demo/proxy.html"
    this.beeApiUrl = options.beeApiUrl || "http://localhost:1633"
    this.timeout = options.timeout || 30000 // 30 seconds default
    this.onAuthChange = options.onAuthChange
    this.popupMode = options.popupMode || "window"

    // Create promise that resolves when iframe is ready
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve
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

    // Identify ourselves to the iframe
    this.sendMessage({
      type: "parentIdentify",
      beeApiUrl: this.beeApiUrl,
      popupMode: this.popupMode,
    })

    // Wait for iframe to be ready
    await this.readyPromise
  }

  /**
   * Setup message listener for iframe responses
   */
  private setupMessageListener(): void {
    this.messageListener = (event: MessageEvent) => {
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
        // Show iframe if not authenticated, hide if authenticated
        if (this.iframe) {
          this.iframe.style.display = message.authenticated ? "none" : "block"
        }
        if (this.onAuthChange) {
          this.onAuthChange(message.authenticated)
        }
        break

      case "authStatusResponse":
        // Show iframe if not authenticated, hide if authenticated
        if (this.iframe) {
          this.iframe.style.display = message.authenticated ? "none" : "block"
        }
        if (this.onAuthChange) {
          this.onAuthChange(message.authenticated)
        }
        break

      case "authSuccess":
        // Hide iframe when authentication succeeds
        if (this.iframe) {
          this.iframe.style.display = "none"
        }
        if (this.onAuthChange) {
          this.onAuthChange(true)
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
      throw new Error(
        "SwarmIdClient not initialized. Call initialize() first.",
      )
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

    // Note: We use a simpler approach by listening for authStatusResponse
    return new Promise((resolve) => {
      const listener = (event: MessageEvent) => {
        if (event.origin !== this.iframeOrigin) return

        try {
          const message = IframeToParentMessageSchema.parse(event.data)
          if (message.type === "authStatusResponse") {
            window.removeEventListener("message", listener)
            resolve({
              authenticated: message.authenticated,
              origin: message.origin,
            })
          }
        } catch {
          // Ignore invalid messages
        }
      }

      window.addEventListener("message", listener)
      this.sendMessage({ type: "checkAuth" })

      // Timeout after 5 seconds
      setTimeout(() => {
        window.removeEventListener("message", listener)
        resolve({ authenticated: false })
      }, 5000)
    })
  }

  /**
   * Check if user is authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    const status = await this.checkAuthStatus()
    return status.authenticated
  }

  // ============================================================================
  // Data Upload/Download Methods
  // ============================================================================

  /**
   * Upload data to Swarm
   */
  async uploadData(
    postageBatchId: BatchId,
    data: Uint8Array,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "uploadDataResponse";
      requestId: string;
      reference: Reference;
      tagUid?: number;
    }>({
      type: "uploadData",
      requestId,
      postageBatchId,
      data: Array.from(data),
      options,
    })

    return {
      reference: response.reference,
      tagUid: response.tagUid,
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
      type: "downloadDataResponse";
      requestId: string;
      data: number[];
    }>({
      type: "downloadData",
      requestId,
      reference,
      options,
    })

    return new Uint8Array(response.data)
  }

  // ============================================================================
  // File Upload/Download Methods
  // ============================================================================

  /**
   * Upload file to Swarm
   */
  async uploadFile(
    postageBatchId: BatchId,
    file: File | Uint8Array,
    name?: string,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    let data: Uint8Array
    let fileName: string | undefined = name

    if (file instanceof File) {
      data = new Uint8Array(await file.arrayBuffer())
      fileName = fileName || file.name
    } else {
      data = file
    }

    const response = await this.sendRequest<{
      type: "uploadFileResponse";
      requestId: string;
      reference: Reference;
      tagUid?: number;
    }>({
      type: "uploadFile",
      requestId,
      postageBatchId,
      data: Array.from(data),
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
      type: "downloadFileResponse";
      requestId: string;
      name: string;
      data: number[];
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
    postageBatchId: BatchId,
    data: Uint8Array,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "uploadChunkResponse";
      requestId: string;
      reference: Reference;
    }>({
      type: "uploadChunk",
      requestId,
      postageBatchId,
      data: Array.from(data),
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
      type: "downloadChunkResponse";
      requestId: string;
      data: number[];
    }>({
      type: "downloadChunk",
      requestId,
      reference,
      options,
    })

    return new Uint8Array(response.data)
  }

  // ============================================================================
  // Postage Stamp Methods
  // ============================================================================

  /**
   * Create postage batch
   */
  async createPostageBatch(
    amount: string,
    depth: number,
    options?: {
      gasPrice?: string;
      immutableFlag?: boolean;
      label?: string;
      waitForUsable?: boolean;
      waitForUsableTimeout?: number;
    },
  ): Promise<BatchId> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "createPostageBatchResponse";
      requestId: string;
      batchId: BatchId;
    }>({
      type: "createPostageBatch",
      requestId,
      amount,
      depth,
      options,
    })

    return response.batchId
  }

  /**
   * Get postage batch information
   */
  async getPostageBatch(postageBatchId: BatchId): Promise<PostageBatch> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "getPostageBatchResponse";
      requestId: string;
      batch: PostageBatch;
    }>({
      type: "getPostageBatch",
      requestId,
      postageBatchId,
    })

    return response.batch
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
