import type { Bee, Stamper, UploadOptions, BeeRequestOptions } from "@ethersphere/bee-js";
/**
 * Options for creating a feed manifest
 */
export interface CreateFeedManifestOptions {
    /**
     * Whether to encrypt the manifest.
     * Default: true (encrypted)
     */
    encrypt?: boolean;
    /**
     * Feed type: "Sequence" for sequential feeds, "Epoch" for epoch feeds.
     * Default: "Sequence"
     */
    feedType?: "Sequence" | "Epoch";
}
/**
 * Result of creating a feed manifest
 */
export interface CreateFeedManifestResult {
    /**
     * Reference to the feed manifest.
     * - Encrypted: 128 hex chars (64 bytes = address + encryption key)
     * - Unencrypted: 64 hex chars (32 bytes = address)
     */
    reference: string;
    /**
     * Tag UID if a tag was created during upload
     */
    tagUid?: number;
}
/**
 * Create a feed manifest directly using chunk upload
 *
 * Instead of using bee.createFeedManifest() which calls the /feeds endpoint,
 * this function builds the manifest locally as a MantarayNode and uploads it
 * via the encrypted chunk endpoint (or plain chunk endpoint if encrypt=false).
 *
 * Feed manifests have a single "/" path with metadata:
 * - swarm-feed-owner: Owner's ethereum address (40 hex chars, no 0x)
 * - swarm-feed-topic: Topic hash (64 hex chars)
 * - swarm-feed-type: "Sequence" for sequential feeds
 *
 * IMPORTANT: This function implements client-side "saveRecursively" logic:
 * 1. Upload the "/" child node first and get its address
 * 2. Set the child's selfAddress to the uploaded address
 * 3. Then upload the root node (which references the child's address)
 *
 * Without this, Bee's /bzz/ endpoint returns 404 because the "/" child chunk
 * doesn't exist (only its calculated hash was stored in the root manifest).
 *
 * @param bee - Bee client instance
 * @param stamper - Stamper for client-side signing
 * @param topic - Topic hex string (64 chars)
 * @param owner - Owner hex string (40 chars, no 0x prefix)
 * @param options - Options for creating the manifest (encrypt, etc.)
 * @param uploadOptions - Upload options (tag, deferred, etc.)
 * @param requestOptions - Bee request options
 * @returns Reference to the feed manifest
 */
export declare function createFeedManifestDirect(bee: Bee, stamper: Stamper, topic: string, owner: string, options?: CreateFeedManifestOptions, uploadOptions?: UploadOptions, requestOptions?: BeeRequestOptions): Promise<CreateFeedManifestResult>;
//# sourceMappingURL=feed-manifest.d.ts.map