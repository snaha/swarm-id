import type {
  ProxyOptions,
  ParentToIframeMessage,
  IframeToParentMessage,
  PopupToIframeMessage,
} from "./types";
import {
  ParentToIframeMessageSchema,
  PopupToIframeMessageSchema,
} from "./types";

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
  private parentOrigin: string | undefined;
  private parentIdentified: boolean = false;
  private authenticated: boolean = false;
  private appSecret: string | undefined;
  private beeApiUrl: string;
  private defaultBeeApiUrl: string;
  private allowedOrigins: string[];
  private authButtonContainer: HTMLElement | undefined;
  private currentStyles: any;
  private popupMode: "popup" | "window" = "window";

  constructor(options: ProxyOptions) {
    this.defaultBeeApiUrl = options.beeApiUrl;
    this.beeApiUrl = options.beeApiUrl;
    this.allowedOrigins = options.allowedOrigins || [];
    this.setupMessageListener();
    console.log(
      "[Proxy] Proxy initialized with default Bee API:",
      this.defaultBeeApiUrl,
    );
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
      );

      const { type } = event.data;

      // Handle parent identification (must come first)
      if (type === "parentIdentify") {
        this.handleParentIdentify(event);
        return;
      }

      // All other messages require parent to be identified first
      if (!this.parentIdentified) {
        console.warn("[Proxy] Ignoring message - parent not identified yet");
        return;
      }

      // Validate origin
      const isPopup = event.origin === window.location.origin;
      const isParent = event.origin === this.parentOrigin;

      // Handle setButtonStyles message (UI-only, not in schema)
      if (type === "setButtonStyles" && isParent) {
        this.currentStyles = event.data.styles;
        console.log("[Proxy] Button styles updated");
        // Re-render button if not authenticated
        if (!this.authenticated && this.authButtonContainer) {
          this.showAuthButton();
        }
        return;
      }

      if (!isPopup && !isParent) {
        console.warn(
          "[Proxy] Rejected message from unauthorized origin:",
          event.origin,
        );
        return;
      }

      try {
        // Try to parse as parent message first
        if (isParent) {
          try {
            const message = ParentToIframeMessageSchema.parse(event.data);
            await this.handleParentMessage(message, event);
            return;
          } catch (error) {
            console.warn("[Proxy] Invalid parent message:", error);
          }
        }

        // Try to parse as popup message
        if (isPopup) {
          try {
            const message = PopupToIframeMessageSchema.parse(event.data);
            await this.handlePopupMessage(message, event);
            return;
          } catch (error) {
            console.warn("[Proxy] Invalid popup message:", error);
          }
        }

        // Unknown message type
        console.warn("[Proxy] Unknown message type:", type);
        this.sendErrorToParent(
          event,
          event.data.requestId,
          `Unknown message type: ${type}`,
        );
      } catch (error) {
        console.error("[Proxy] Error handling message:", error);
        this.sendErrorToParent(
          event,
          event.data.requestId,
          error instanceof Error ? error.message : "Unknown error",
        );
      }
    });
  }

  /**
   * Handle parent identification
   */
  private handleParentIdentify(event: MessageEvent): void {
    // Prevent parent from changing after first identification
    if (this.parentIdentified) {
      console.error("[Proxy] Parent already identified! Ignoring duplicate.");
      return;
    }

    // Parse the message to get optional parameters
    const message = event.data;
    const parentBeeApiUrl = message.beeApiUrl;
    const parentPopupMode = message.popupMode;

    // Trust event.origin - this is browser-enforced and cannot be spoofed
    this.parentOrigin = event.origin;
    this.parentIdentified = true;

    console.log(
      "[Proxy] Parent identified via postMessage:",
      this.parentOrigin,
    );
    console.log("[Proxy] Parent locked in - cannot be changed");

    // Validate parent is in allowlist (if allowlist is configured)
    if (
      this.allowedOrigins.length > 0 &&
      !this.isAllowedOrigin(this.parentOrigin)
    ) {
      console.warn(
        "[Proxy] Parent origin not in allowlist:",
        this.parentOrigin,
      );
      return;
    }

    // Use parent's Bee API URL if provided, otherwise use default
    if (parentBeeApiUrl) {
      this.beeApiUrl = parentBeeApiUrl;
      console.log("[Proxy] Using Bee API URL from parent:", this.beeApiUrl);
    } else {
      console.log("[Proxy] Using default Bee API URL:", this.beeApiUrl);
    }

    // Use parent's popup mode if provided
    if (parentPopupMode) {
      this.popupMode = parentPopupMode;
      console.log("[Proxy] Using popup mode from parent:", this.popupMode);
    }

    // Load existing secret if available
    this.loadSecret();

    // Acknowledge receipt
    if (event.source) {
      (event.source as WindowProxy).postMessage(
        {
          type: "proxyReady",
          authenticated: this.authenticated,
          parentOrigin: this.parentOrigin,
        } satisfies IframeToParentMessage,
        { targetOrigin: event.origin },
      );
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
        break;

      case "checkAuth":
        this.handleCheckAuth(event);
        break;

      case "requestAuth":
        this.handleRequestAuth(message, event);
        break;

      case "uploadData":
        await this.handleUploadData(message, event);
        break;

      case "downloadData":
        await this.handleDownloadData(message, event);
        break;

      case "uploadFile":
        await this.handleUploadFile(message, event);
        break;

      case "downloadFile":
        await this.handleDownloadFile(message, event);
        break;

      case "uploadChunk":
        await this.handleUploadChunk(message, event);
        break;

      case "downloadChunk":
        await this.handleDownloadChunk(message, event);
        break;

      case "createPostageBatch":
        await this.handleCreatePostageBatch(message, event);
        break;

      case "getPostageBatch":
        await this.handleGetPostageBatch(message, event);
        break;

      default:
        // TypeScript should ensure this is never reached
        const exhaustiveCheck: never = message;
        console.warn("[Proxy] Unhandled message type:", exhaustiveCheck);
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
        await this.handleSetSecret(message, event);
        break;
    }
  }

  /**
   * Check if origin is allowed
   */
  private isAllowedOrigin(origin: string): boolean {
    if (this.allowedOrigins.length === 0) {
      return true; // If no allowlist, allow all
    }
    return this.allowedOrigins.includes(origin);
  }

  /**
   * Load secret from localStorage
   */
  private loadSecret(): void {
    if (!this.parentOrigin) {
      console.log("[Proxy] No parent origin, cannot load secret");
      return;
    }

    const storageKey = `swarm-secret-${this.parentOrigin}`;
    const secret = localStorage.getItem(storageKey);

    if (secret) {
      console.log(
        "[Proxy] Secret loaded from localStorage for:",
        this.parentOrigin,
      );
      this.appSecret = secret;
      this.authenticated = true;
      this.hideAuthButton();
    } else {
      console.log("[Proxy] No secret found for:", this.parentOrigin);
      this.showAuthButton();
    }
  }

  /**
   * Update authentication status and show/hide button accordingly
   */
  private updateAuthStatus(authenticated: boolean): void {
    this.authenticated = authenticated;
    if (authenticated) {
      this.hideAuthButton();
    } else {
      this.showAuthButton();
    }
  }

  /**
   * Save secret to localStorage
   */
  private saveSecret(origin: string, secret: string): void {
    const storageKey = `swarm-secret-${origin}`;
    localStorage.setItem(storageKey, secret);
    console.log("[Proxy] Secret saved to localStorage for:", origin);
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
      (event.source as WindowProxy).postMessage(
        {
          type: "error",
          requestId,
          error,
        } satisfies IframeToParentMessage,
        { targetOrigin: event.origin },
      );
    }
  }

  /**
   * Send message to parent
   */
  private sendToParent(message: IframeToParentMessage): void {
    if (!this.parentOrigin || !window.parent || window.parent === window.self) {
      console.warn("[Proxy] Cannot send message to parent - no parent window");
      return;
    }

    window.parent.postMessage(message, this.parentOrigin);
  }

  // ============================================================================
  // Message Handlers
  // ============================================================================

  private handleCheckAuth(event: MessageEvent): void {
    console.log("[Proxy] Checking authentication status...");

    if (event.source) {
      (event.source as WindowProxy).postMessage(
        {
          type: "authStatusResponse",
          authenticated: this.authenticated,
          origin: this.authenticated ? this.parentOrigin : undefined,
        } satisfies IframeToParentMessage,
        { targetOrigin: event.origin },
      );
    }

    console.log("[Proxy] Authentication status:", this.authenticated);
  }

  private handleRequestAuth(
    message: { type: "requestAuth"; styles?: any },
    _event: MessageEvent,
  ): void {
    console.log(
      "[Proxy] Request to show auth button for parent:",
      this.parentOrigin,
    );

    // Store styles for button creation
    this.currentStyles = message.styles;

    // If container is set, show the button
    if (this.authButtonContainer) {
      this.showAuthButton();
    }
  }

  /**
   * Show authentication button in the UI
   */
  private showAuthButton(): void {
    if (!this.authButtonContainer) {
      console.log("[Proxy] No auth button container set yet");
      return;
    }

    // Clear existing content
    this.authButtonContainer.innerHTML = "";

    // Create button
    const button = document.createElement("button");
    button.textContent = "🔐 Login with Swarm ID";

    // Apply styles
    const styles = this.currentStyles || {};
    button.style.backgroundColor = styles.backgroundColor || "#dd7200";
    button.style.color = styles.color || "white";
    button.style.border = styles.border || "none";
    button.style.borderRadius = styles.borderRadius || "6px";
    button.style.padding = styles.padding || "12px 24px";
    button.style.fontSize = styles.fontSize || "14px";
    button.style.fontWeight = styles.fontWeight || "600";
    button.style.cursor = styles.cursor || "pointer";
    button.style.transition = "all 0.2s";
    button.style.boxShadow = "0 2px 8px rgba(221, 114, 0, 0.3)";

    // Hover effect
    button.addEventListener("mouseenter", () => {
      button.style.transform = "translateY(-1px)";
      button.style.boxShadow = "0 4px 12px rgba(221, 114, 0, 0.5)";
    });
    button.addEventListener("mouseleave", () => {
      button.style.transform = "translateY(0)";
      button.style.boxShadow = "0 2px 8px rgba(221, 114, 0, 0.3)";
    });

    // Click handler - open auth popup or window
    button.addEventListener("click", () => {
      if (!this.parentOrigin) {
        console.error(
          "[Proxy] Cannot open auth window - parent origin not set",
        );
        return;
      }
      console.log(
        "[Proxy] Opening authentication window for parent:",
        this.parentOrigin,
      );

      // Disable button and show spinner
      button.disabled = true;
      button.innerHTML =
        '<span style="display: inline-block; width: 16px; height: 16px; border: 2px solid rgba(255,255,255,.3); border-radius: 50%; border-top-color: white; animation: spin 1s linear infinite;"></span>';

      // Add spinner animation
      if (!document.getElementById("swarm-id-spinner-style")) {
        const style = document.createElement("style");
        style.id = "swarm-id-spinner-style";
        style.textContent =
          "@keyframes spin { to { transform: rotate(360deg); } }";
        document.head.appendChild(style);
      }

      const authUrl = `${window.location.origin}/demo/auth.html?origin=${encodeURIComponent(this.parentOrigin)}`;

      // Open as popup or full window based on popupMode
      if (this.popupMode === "popup") {
        window.open(authUrl, "_blank", "width=500,height=600");
      } else {
        window.open(authUrl, "_blank");
      }
    });

    this.authButtonContainer.appendChild(button);
    console.log("[Proxy] Auth button shown");
  }

  /**
   * Hide authentication button
   */
  private hideAuthButton(): void {
    if (!this.authButtonContainer) {
      return;
    }

    // Clear the button
    this.authButtonContainer.innerHTML = "";
    console.log("[Proxy] Auth button hidden");
  }

  /**
   * Set container element for auth button
   */
  setAuthButtonContainer(container: HTMLElement): void {
    this.authButtonContainer = container;
    console.log("[Proxy] Auth button container set");
    // Don't show button here - let loadSecret() handle it after checking auth status
  }

  private async handleSetSecret(
    message: { type: "setSecret"; appOrigin: string; secret: string },
    event: MessageEvent,
  ): Promise<void> {
    const { appOrigin, secret } = message;

    console.log("[Proxy] Received secret for app:", appOrigin);

    // Validate that appOrigin matches parent origin
    if (appOrigin !== this.parentOrigin) {
      console.warn(
        "[Proxy] App origin mismatch:",
        appOrigin,
        "vs",
        this.parentOrigin,
      );
      // Still save it, but log warning
    }

    // Save secret to partitioned localStorage
    this.saveSecret(appOrigin, secret);
    this.appSecret = secret;
    this.updateAuthStatus(true);

    // Notify parent dApp
    this.sendToParent({
      type: "authSuccess",
      origin: appOrigin,
    });

    console.log("[Proxy] Notified parent of successful authentication");

    // Respond to popup (if still open)
    if (event.source && !(event.source as Window).closed) {
      (event.source as WindowProxy).postMessage(
        {
          type: "secretReceived",
          success: true,
        },
        { targetOrigin: event.origin },
      );
    }
  }

  private async handleUploadData(
    message: any,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      postageBatchId: _postageBatchId,
      data,
      options: _options,
    } = message;

    console.log("[Proxy] Upload data request, size:", data ? data.length : 0);

    if (!this.authenticated || !this.appSecret) {
      throw new Error("Not authenticated. Please login first.");
    }

    try {
      // TODO: Implement actual Bee API call with bee-js
      const reference = await this.simulateUpload(data);

      if (event.source) {
        (event.source as WindowProxy).postMessage(
          {
            type: "uploadDataResponse",
            requestId,
            reference,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        );
      }

      console.log("[Proxy] Data uploaded:", reference);
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "Upload failed",
      );
    }
  }

  private async handleDownloadData(
    message: any,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, reference, options: _options } = message;

    console.log("[Proxy] Download data request, reference:", reference);

    if (!this.authenticated || !this.appSecret) {
      throw new Error("Not authenticated. Please login first.");
    }

    try {
      // TODO: Implement actual Bee API call with bee-js
      const data = await this.simulateDownload(reference);

      if (event.source) {
        (event.source as WindowProxy).postMessage(
          {
            type: "downloadDataResponse",
            requestId,
            data,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        );
      }

      console.log("[Proxy] Data downloaded:", reference);
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "Download failed",
      );
    }
  }

  private async handleUploadFile(
    message: any,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      postageBatchId: _postageBatchId,
      data,
      name,
      options: _options,
    } = message;

    console.log(
      "[Proxy] Upload file request, name:",
      name,
      "size:",
      data ? data.length : 0,
    );

    if (!this.authenticated || !this.appSecret) {
      throw new Error("Not authenticated. Please login first.");
    }

    try {
      // TODO: Implement actual Bee API call with bee-js
      const reference = await this.simulateUpload(data);

      if (event.source) {
        (event.source as WindowProxy).postMessage(
          {
            type: "uploadFileResponse",
            requestId,
            reference,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        );
      }

      console.log("[Proxy] File uploaded:", reference);
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "Upload failed",
      );
    }
  }

  private async handleDownloadFile(
    message: any,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, reference, path, options: _options } = message;

    console.log(
      "[Proxy] Download file request, reference:",
      reference,
      "path:",
      path,
    );

    if (!this.authenticated || !this.appSecret) {
      throw new Error("Not authenticated. Please login first.");
    }

    try {
      // TODO: Implement actual Bee API call with bee-js
      const data = await this.simulateDownload(reference);

      if (event.source) {
        (event.source as WindowProxy).postMessage(
          {
            type: "downloadFileResponse",
            requestId,
            name: path || "file",
            data,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        );
      }

      console.log("[Proxy] File downloaded:", reference);
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "Download failed",
      );
    }
  }

  private async handleUploadChunk(
    message: any,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      postageBatchId: _postageBatchId,
      data,
      options: _options,
    } = message;

    console.log("[Proxy] Upload chunk request, size:", data ? data.length : 0);

    if (!this.authenticated || !this.appSecret) {
      throw new Error("Not authenticated. Please login first.");
    }

    try {
      // TODO: Implement actual Bee API call with bee-js
      const reference = await this.simulateUpload(data);

      if (event.source) {
        (event.source as WindowProxy).postMessage(
          {
            type: "uploadChunkResponse",
            requestId,
            reference,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        );
      }

      console.log("[Proxy] Chunk uploaded:", reference);
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "Upload failed",
      );
    }
  }

  private async handleDownloadChunk(
    message: any,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, reference, options: _options } = message;

    console.log("[Proxy] Download chunk request, reference:", reference);

    if (!this.authenticated || !this.appSecret) {
      throw new Error("Not authenticated. Please login first.");
    }

    try {
      // TODO: Implement actual Bee API call with bee-js
      const data = await this.simulateDownload(reference);

      if (event.source) {
        (event.source as WindowProxy).postMessage(
          {
            type: "downloadChunkResponse",
            requestId,
            data,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        );
      }

      console.log("[Proxy] Chunk downloaded:", reference);
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "Download failed",
      );
    }
  }

  private async handleCreatePostageBatch(
    message: any,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, amount, depth, options: _options } = message;

    console.log(
      "[Proxy] Create postage batch request, amount:",
      amount,
      "depth:",
      depth,
    );

    if (!this.authenticated || !this.appSecret) {
      throw new Error("Not authenticated. Please login first.");
    }

    try {
      // TODO: Implement actual Bee API call with bee-js
      // For now, return a dummy batch ID
      const batchId = "0".repeat(64);

      if (event.source) {
        (event.source as WindowProxy).postMessage(
          {
            type: "createPostageBatchResponse",
            requestId,
            batchId,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        );
      }

      console.log("[Proxy] Postage batch created:", batchId);
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "Create batch failed",
      );
    }
  }

  private async handleGetPostageBatch(
    message: any,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, postageBatchId } = message;

    console.log("[Proxy] Get postage batch request, batchId:", postageBatchId);

    if (!this.authenticated || !this.appSecret) {
      throw new Error("Not authenticated. Please login first.");
    }

    try {
      // TODO: Implement actual Bee API call with bee-js
      // For now, return dummy batch info
      const batch = {
        batchID: postageBatchId,
        utilization: 0,
        usable: true,
        label: "",
        depth: 20,
        amount: "10000000",
        bucketDepth: 16,
        blockNumber: 1,
        immutableFlag: false,
        exists: true,
      };

      if (event.source) {
        (event.source as WindowProxy).postMessage(
          {
            type: "getPostageBatchResponse",
            requestId,
            batch,
          } satisfies IframeToParentMessage,
          { targetOrigin: event.origin },
        );
      }

      console.log("[Proxy] Postage batch retrieved:", postageBatchId);
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "Get batch failed",
      );
    }
  }

  // ============================================================================
  // Placeholder Methods (to be replaced with real bee-js integration)
  // ============================================================================

  private async simulateUpload(data: number[]): Promise<string> {
    // Hash the data using SHA-256
    const uint8Data = new Uint8Array(data);
    const hashBuffer = await crypto.subtle.digest("SHA-256", uint8Data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    console.log("[Proxy] Simulated upload, hash:", hashHex);
    return hashHex;
  }

  private async simulateDownload(reference: string): Promise<number[]> {
    console.log("[Proxy] Simulated download, reference:", reference);

    // Return dummy data for now
    const dummyData = new Uint8Array([1, 2, 3, 4, 5]);
    return Array.from(dummyData);
  }
}

/**
 * Initialize the proxy (called from HTML page)
 */
export function initProxy(options: ProxyOptions): SwarmIdProxy {
  return new SwarmIdProxy(options);
}
