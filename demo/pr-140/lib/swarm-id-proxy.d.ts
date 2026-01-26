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
export declare class SwarmIdProxy {
    private parentOrigin;
    private parentIdentified;
    private authenticated;
    private authLoading;
    private appSecret;
    private postageBatchId;
    private signerKey;
    private stamper;
    private stamperDepth;
    private utilizationCache;
    private beeApiUrl;
    private authButtonContainer;
    private currentStyles;
    private buttonConfig;
    private popupMode;
    private appMetadata;
    private bee;
    private unsubscribeConnectedApps;
    private isConnecting;
    private hasStorageAccess;
    constructor();
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
    private setupConnectedAppsListener;
    /**
     * Handle changes to connected apps storage (triggered by storage events from other windows)
     * Handles both new connections and disconnections.
     */
    private handleConnectedAppsChange;
    /**
     * Clean up resources when the proxy is destroyed.
     * Call this method when the proxy iframe is being unloaded.
     */
    destroy(): void;
    /**
     * Announce that proxy is ready to receive messages
     * Broadcasts to parent with wildcard origin since we don't know parent origin yet
     */
    private announceReady;
    /**
     * Get the stored postage batch ID
     */
    getPostageBatchId(): string | undefined;
    /**
     * Get the stored signer key
     */
    getSignerKey(): string | undefined;
    /**
     * Initialize the Stamper for client-side signing
     * Uses UtilizationAwareStamper to track bucket usage
     */
    private initializeStamper;
    /**
     * Save stamper bucket state to IndexedDB
     * Utilization-aware stamper persists bucket state automatically
     */
    private saveStamperState;
    /**
     * Setup message listener for parent and popup messages
     */
    private setupMessageListener;
    /**
     * Handle parent identification
     */
    private handleParentIdentify;
    /**
     * Handle messages from parent window
     */
    private handleParentMessage;
    /**
     * Handle messages from popup window
     */
    private handlePopupMessage;
    /**
     * Check if Storage Access API is available
     */
    private hasStorageAccessAPI;
    /**
     * Request unpartitioned storage access using the Storage Access API.
     * This allows the iframe to access the same localStorage as the top-level context.
     * Must be called from a user gesture (click handler).
     * @returns true if access was granted, false otherwise
     */
    private requestStorageAccess;
    /**
     * Check if we should use shared storage (either not in iframe, have storage access, or dev mode)
     */
    private canUseSharedStorage;
    /**
     * Check if running inside an iframe
     */
    private isInIframe;
    /**
     * Load authentication data.
     * - If shared storage is accessible: reads from shared storage (ConnectedApp records)
     * - If partitioned (iframe without Storage Access): uses in-memory values (set by handleSetSecret)
     */
    private loadAuthData;
    /**
     * Look up the postage stamp for the currently connected app's identity
     * by reading from shared localStorage stores.
     */
    private lookupPostageStampForApp;
    /**
     * Check if a connection is still valid based on connectedUntil timestamp
     */
    private isConnectionValid;
    /**
     * Look up the app secret from shared storage for the current parent origin.
     * Returns the secret and identityId if found and connection is valid.
     */
    private lookupAppSecretFromSharedStorage;
    /**
     * Update authentication status and update button accordingly
     */
    private updateAuthStatus;
    /**
     * Clear authentication data
     */
    private clearAuthData;
    /**
     * Send error message to parent
     */
    private sendErrorToParent;
    /**
     * Send message to parent
     */
    private sendToParent;
    private handleCheckAuth;
    private handleGetConnectionInfo;
    private handleDisconnect;
    private handleRequestAuth;
    /**
     * Show authentication button in the UI
     */
    private showAuthButton;
    /**
     * Open the authentication popup window.
     * Returns true if popup was opened, false if parent origin is not set.
     */
    private openAuthPopup;
    /**
     * Handle login button click
     */
    private handleLoginClick;
    /**
     * Handle disconnect button click
     */
    private handleDisconnectClick;
    /**
     * Set container element for auth button
     */
    setAuthButtonContainer(container: HTMLElement): void;
    private handleSetSecret;
    private handleUploadData;
    private handleDownloadData;
    private handleUploadFile;
    private handleDownloadFile;
    private handleUploadChunk;
    private handleDownloadChunk;
}
/**
 * Initialize the proxy (called from HTML page)
 */
export declare function initProxy(): SwarmIdProxy;
//# sourceMappingURL=swarm-id-proxy.d.ts.map