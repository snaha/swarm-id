/**
 * ACT History Management
 *
 * This module provides timestamped versioning of ACT entries, matching Bee's
 * approach to tracking ACT versions over time.
 *
 * Key concepts:
 * - Each ACT update creates a new history entry
 * - Entries are keyed by reversed timestamp (MaxInt64 - timestamp)
 * - History enables looking up ACT state at any point in time
 * - Encrypted grantee list reference is stored in metadata
 *
 * This implementation uses the MantarayNode class from bee-js to produce
 * Bee-compatible binary manifests with the proper version hash header.
 *
 * IMPORTANT: Mantaray manifests are hierarchical - each child node must be
 * uploaded separately to Swarm. The root node references children by their
 * content addresses (selfAddress). To read entries, all child nodes must be
 * loaded recursively.
 */
import { MantarayNode } from '@ethersphere/bee-js';
/**
 * Single history entry metadata
 */
export interface HistoryEntryMetadata {
    actReference: string;
    encryptedGranteeListRef?: string;
}
/**
 * History entry with timestamp
 */
export interface HistoryEntry {
    timestamp: number;
    metadata: HistoryEntryMetadata;
}
/**
 * Result of serializing a history tree
 */
export interface SerializedHistoryTree {
    blobs: Map<string, Uint8Array>;
    rootReference: string;
}
/**
 * Result of saving a history tree
 */
export interface SaveHistoryTreeResult {
    rootReference: string;
    tagUid?: number;
}
/**
 * Calculate reversed timestamp key for history lookup
 *
 * Bee uses reversed timestamps so that the latest entry sorts first.
 * Key = MaxInt64 - timestamp
 *
 * @param timestamp - Unix timestamp in seconds
 * @returns Reversed timestamp as string (for use as path)
 */
export declare function calculateReversedTimestamp(timestamp: number): string;
/**
 * Calculate original timestamp from reversed key
 *
 * @param reversedKey - Reversed timestamp string
 * @returns Original Unix timestamp in seconds
 */
export declare function calculateOriginalTimestamp(reversedKey: string): number;
/**
 * Create a new empty history manifest using MantarayNode
 */
export declare function createHistoryManifest(): MantarayNode;
/**
 * Add an entry to the history manifest
 *
 * This mutates the manifest in place by adding a fork.
 *
 * @param manifest - Existing history manifest (MantarayNode)
 * @param timestamp - Unix timestamp for this entry
 * @param actReference - Reference to the ACT manifest (hex string)
 * @param encryptedGranteeListRef - Optional reference to encrypted grantee list (hex string)
 */
export declare function addHistoryEntry(manifest: MantarayNode, timestamp: number, actReference: string, encryptedGranteeListRef?: string): void;
/**
 * Get the latest history entry (most recent timestamp)
 *
 * Since keys are reversed timestamps, the smallest key is the latest entry.
 * NOTE: This requires the manifest to have been loaded with loadRecursively()
 * or to have been populated locally with addHistoryEntry().
 *
 * @param manifest - History manifest (MantarayNode)
 * @returns Latest entry with its timestamp, or undefined if empty
 */
export declare function getLatestEntry(manifest: MantarayNode): HistoryEntry | undefined;
/**
 * Get entry at or before a specific timestamp
 *
 * This finds the ACT state that was valid at the given timestamp.
 * NOTE: This requires the manifest to have been loaded with loadRecursively().
 *
 * @param manifest - History manifest (MantarayNode)
 * @param timestamp - Target timestamp
 * @returns Entry at or before timestamp, or undefined if none exists
 */
export declare function getEntryAtTimestamp(manifest: MantarayNode, timestamp: number): HistoryEntry | undefined;
/**
 * Get all history entries sorted by timestamp (newest first)
 *
 * @param manifest - History manifest (MantarayNode)
 * @returns Array of entries sorted newest first
 */
export declare function getAllEntries(manifest: MantarayNode): HistoryEntry[];
/**
 * Serialize the entire history manifest tree to individual blobs
 *
 * Mantaray manifests are hierarchical - each node is stored at its content
 * address. This function returns all blobs that need to be uploaded, keyed
 * by their content addresses.
 *
 * @deprecated Use saveHistoryTreeRecursively instead which uploads bottom-up
 * and uses Bee's actual returned references to avoid address mismatches.
 *
 * @param manifest - History manifest (MantarayNode)
 * @returns Map of content address -> serialized data, plus root reference
 */
export declare function serializeHistoryTree(manifest: MantarayNode): Promise<SerializedHistoryTree>;
/**
 * Upload callback type for saveHistoryTreeRecursively
 */
export type UploadCallback = (data: Uint8Array, isRoot: boolean) => Promise<{
    reference: string;
    tagUid?: number;
}>;
/**
 * Save the entire history manifest tree by uploading bottom-up
 *
 * This function uploads nodes in the correct order (children before parents)
 * and uses Bee's actual returned references to update selfAddress before
 * marshaling parents. This avoids address mismatches between local hash
 * computation and Bee's storage.
 *
 * The flow mirrors MantarayNode.saveRecursively() from bee-js:
 * 1. Recursively save all child forks first
 * 2. Marshal this node (which uses children's updated selfAddress)
 * 3. Upload and set selfAddress from Bee's response
 *
 * @param manifest - History manifest (MantarayNode)
 * @param uploadFn - Callback to upload data, returns reference from Bee
 * @returns Root reference from Bee and optional tag UID
 */
export declare function saveHistoryTreeRecursively(manifest: MantarayNode, uploadFn: UploadCallback): Promise<SaveHistoryTreeResult>;
/**
 * Serialize history manifest root to Mantaray binary format
 *
 * @deprecated Use serializeHistoryTree for proper Mantaray serialization
 * @param manifest - History manifest (MantarayNode)
 * @returns Serialized root manifest as Uint8Array
 */
export declare function serializeHistory(manifest: MantarayNode): Promise<Uint8Array>;
/**
 * Deserialize history manifest from Mantaray binary format
 *
 * NOTE: After deserialization, call loadRecursively() or manually load
 * child nodes to populate targetAddress for entries.
 *
 * @param data - Serialized manifest
 * @param selfAddress - The reference/address of the manifest (32 bytes as Uint8Array)
 * @returns Parsed history manifest (MantarayNode)
 */
export declare function deserializeHistory(data: Uint8Array, selfAddress: Uint8Array): MantarayNode;
/**
 * Load child node data into a deserialized manifest
 *
 * After deserializing the root node, this function loads all child node data
 * so that targetAddress is available for each entry.
 *
 * @param manifest - Deserialized root manifest
 * @param loadData - Callback to load data for a given reference
 */
export declare function loadHistoryEntries(manifest: MantarayNode, loadData: (reference: string) => Promise<Uint8Array>): Promise<void>;
/**
 * Get current Unix timestamp in seconds
 */
export declare function getCurrentTimestamp(): number;
//# sourceMappingURL=history.d.ts.map