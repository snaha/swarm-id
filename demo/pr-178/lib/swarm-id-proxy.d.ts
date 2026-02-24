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
    private utilizationStore;
    private beeApiUrl;
    private authButtonContainer;
    private currentStyles;
    private buttonConfig;
    private popupMode;
    private appMetadata;
    private bee;
    private unsubscribeConnectedApps;
    private isConnecting;
    private parentWindow;
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
     * Handle changes to connected apps storage (triggered by storage events from other windows).
     * Handles new connections, identity changes, and disconnections.
     *
     * Safari partitioning workaround: After auth via setSecret, we ignore disconnect events
     * from storage until storage confirms our connection exists. This prevents Safari's
     * partitioned storage from causing spurious disconnects.
     */
    private handleConnectedAppsChange;
    /**
     * Authenticate using data from connected apps storage
     */
    private authenticateFromStorage;
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
     * Load authentication data from shared storage (ConnectedApp records).
     */
    private loadAuthData;
    /**
     * Look up the postage stamp for the currently connected app's identity
     * by reading from shared localStorage stores.
     */
    private lookupPostageStampForApp;
    /**
     * Look up the account for the currently connected app's identity
     * by reading from shared localStorage stores.
     *
     * @returns Account info with owner address and encryption key, or undefined if not found
     */
    private lookupAccountForApp;
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
    private handleIsConnected;
    private handleGetNodeInfo;
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
    private handleUploadData;
    private handleDownloadData;
    private handleUploadFile;
    private handleDownloadFile;
    private handleUploadChunk;
    private handleDownloadChunk;
    private handleGsocMine;
    private handleGsocSend;
    private handleSocUpload;
    private handleSocRawUpload;
    private handleSocDownload;
    private handleSocRawDownload;
    private handleSocGetOwner;
    private handleActUploadData;
    private handleActDownloadData;
    private handleActAddGrantees;
    private handleActRevokeGrantees;
    private handleActGetGrantees;
    private handleGetPostageBatch;
}
/**
 * Initialize the proxy (called from HTML page)
 */
export declare function initProxy(): SwarmIdProxy;
//# sourceMappingURL=swarm-id-proxy.d.ts.map