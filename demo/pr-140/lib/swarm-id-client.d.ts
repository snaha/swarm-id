import type { ClientOptions, AuthStatus, ConnectionInfo, UploadResult, FileData, UploadOptions, DownloadOptions, Reference } from "./types";
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
export declare class SwarmIdClient {
    private iframe;
    private iframeOrigin;
    private iframePath;
    private timeout;
    private onAuthChange?;
    private popupMode;
    private metadata;
    private buttonConfig?;
    private containerId?;
    private ready;
    private readyPromise;
    private readyResolve?;
    private readyReject?;
    private pendingRequests;
    private requestIdCounter;
    private messageListener;
    private proxyInitializedPromise;
    private proxyInitializedResolve?;
    private proxyInitializedReject?;
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
    constructor(options: ClientOptions);
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
    initialize(): Promise<void>;
    /**
     * Setup message listener for iframe responses
     */
    private setupMessageListener;
    /**
     * Handle messages from iframe
     */
    private handleIframeMessage;
    /**
     * Send message to iframe
     */
    private sendMessage;
    /**
     * Send request and wait for response
     */
    private sendRequest;
    /**
     * Generate unique request ID
     */
    private generateRequestId;
    /**
     * Ensure client is initialized
     */
    private ensureReady;
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
    getAuthIframe(): HTMLIFrameElement;
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
    checkAuthStatus(): Promise<AuthStatus>;
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
    disconnect(): Promise<void>;
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
    connect(popupMode?: "window" | "popup"): string;
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
    getConnectionInfo(): Promise<ConnectionInfo>;
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
    uploadData(data: Uint8Array, options?: UploadOptions, onProgress?: (progress: {
        total: number;
        processed: number;
    }) => void): Promise<UploadResult>;
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
    downloadData(reference: Reference, options?: DownloadOptions): Promise<Uint8Array>;
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
    uploadFile(file: File | Uint8Array, name?: string, options?: UploadOptions): Promise<UploadResult>;
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
    downloadFile(reference: Reference, path?: string, options?: DownloadOptions): Promise<FileData>;
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
    uploadChunk(data: Uint8Array, options?: UploadOptions): Promise<UploadResult>;
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
    downloadChunk(reference: Reference, options?: DownloadOptions): Promise<Uint8Array>;
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
    destroy(): void;
}
//# sourceMappingURL=swarm-id-client.d.ts.map