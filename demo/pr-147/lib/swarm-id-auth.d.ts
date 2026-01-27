import type { AuthOptions } from "./types";
/**
 * Swarm ID Auth - Runs in the authentication popup
 *
 * Responsibilities:
 * - Load or generate master identity
 * - Derive app-specific secrets
 * - Send secrets to iframe via postMessage
 * - Manage master key storage
 */
export declare class SwarmIdAuth {
    private appOrigin;
    private masterKey;
    private masterKeyStorageKey;
    private postageBatchId;
    private signerKey;
    constructor(options?: AuthOptions);
    /**
     * Initialize the auth popup
     */
    initialize(): Promise<void>;
    /**
     * Get the app origin
     */
    getAppOrigin(): string | undefined;
    /**
     * Get the master key (for display purposes, should be truncated)
     */
    getMasterKey(): string | undefined;
    /**
     * Check if master key exists
     */
    hasMasterKey(): boolean;
    /**
     * Set the postage batch ID
     */
    setPostageBatchId(batchId: string): void;
    /**
     * Get the postage batch ID
     */
    getPostageBatchId(): string | undefined;
    /**
     * Set the signer key
     */
    setSignerKey(key: string): void;
    /**
     * Get the signer key
     */
    getSignerKey(): string | undefined;
    /**
     * Set authentication data (batch ID and/or signer key)
     */
    setAuthData({ postageBatchId, signerKey, }: {
        postageBatchId?: string;
        signerKey?: string;
    }): void;
    /**
     * Setup new identity (generate and store master key)
     */
    setupNewIdentity(): Promise<string>;
    /**
     * Authenticate - derive app-specific secret and send to iframe
     */
    authenticate(): Promise<void>;
    /**
     * Close the popup window
     */
    close(delay?: number): void;
}
/**
 * Initialize auth popup (called from HTML page)
 */
export declare function initAuth(options?: AuthOptions): Promise<SwarmIdAuth>;
//# sourceMappingURL=swarm-id-auth.d.ts.map