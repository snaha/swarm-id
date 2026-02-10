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

import { MantarayNode } from "@ethersphere/bee-js"
import { hexToUint8Array, uint8ArrayToHex } from "../../utils/hex"

// Constants
const MAX_INT64 = BigInt("9223372036854775807")
const ENCODER = new TextEncoder()

// Bee uses "encryptedglref" as the metadata key for encrypted grantee list reference
const ENCRYPTED_GRANTEE_LIST_METADATA_KEY = "encryptedglref"

// Ensure monotonic seconds so multiple ACT updates within the same second
// don't collide on the same history key (mantaray requires unique paths).
let lastTimestamp = 0

/**
 * Single history entry metadata
 */
export interface HistoryEntryMetadata {
  actReference: string // Reference to the ACT manifest
  encryptedGranteeListRef?: string // Reference to encrypted grantee list (publisher only)
}

/**
 * History entry with timestamp
 */
export interface HistoryEntry {
  timestamp: number // Unix timestamp in seconds
  metadata: HistoryEntryMetadata
}

/**
 * Result of serializing a history tree
 */
export interface SerializedHistoryTree {
  blobs: Map<string, Uint8Array> // Content address -> serialized data
  rootReference: string // Reference to the root node
}

/**
 * Result of saving a history tree
 */
export interface SaveHistoryTreeResult {
  rootReference: string // Reference to the root node (from Bee)
  tagUid?: number // Tag UID from root upload
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
export function calculateReversedTimestamp(timestamp: number): string {
  const reversed = MAX_INT64 - BigInt(timestamp)
  return reversed.toString()
}

/**
 * Calculate original timestamp from reversed key
 *
 * @param reversedKey - Reversed timestamp string
 * @returns Original Unix timestamp in seconds
 */
export function calculateOriginalTimestamp(reversedKey: string): number {
  const reversed = BigInt(reversedKey)
  const original = MAX_INT64 - reversed
  return Number(original)
}

/**
 * Create a new empty history manifest using MantarayNode
 */
export function createHistoryManifest(): MantarayNode {
  return new MantarayNode()
}

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
export function addHistoryEntry(
  manifest: MantarayNode,
  timestamp: number,
  actReference: string,
  encryptedGranteeListRef?: string,
): void {
  const path = calculateReversedTimestamp(timestamp)
  const reference = hexToUint8Array(actReference)
  const metadata = encryptedGranteeListRef
    ? { [ENCRYPTED_GRANTEE_LIST_METADATA_KEY]: encryptedGranteeListRef }
    : undefined
  manifest.addFork(ENCODER.encode(path), reference, metadata)
}

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
export function getLatestEntry(
  manifest: MantarayNode,
): HistoryEntry | undefined {
  const nodes = manifest.collect()
  if (nodes.length === 0) {
    return undefined
  }

  // Sort by path ascending (smallest = latest timestamp due to reversal)
  nodes.sort((a, b) => a.fullPathString.localeCompare(b.fullPathString))

  const latest = nodes[0]
  return {
    timestamp: calculateOriginalTimestamp(latest.fullPathString),
    metadata: {
      actReference: uint8ArrayToHex(latest.targetAddress),
      encryptedGranteeListRef:
        latest.metadata?.[ENCRYPTED_GRANTEE_LIST_METADATA_KEY],
    },
  }
}

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
export function getEntryAtTimestamp(
  manifest: MantarayNode,
  timestamp: number,
): HistoryEntry | undefined {
  const targetPath = calculateReversedTimestamp(timestamp)
  const nodes = manifest.collect()

  if (nodes.length === 0) {
    return undefined
  }

  // Sort by path ascending
  nodes.sort((a, b) => a.fullPathString.localeCompare(b.fullPathString))

  // Find the first node with path >= targetPath (which corresponds to timestamp <= target)
  for (const node of nodes) {
    if (node.fullPathString >= targetPath) {
      return {
        timestamp: calculateOriginalTimestamp(node.fullPathString),
        metadata: {
          actReference: uint8ArrayToHex(node.targetAddress),
          encryptedGranteeListRef:
            node.metadata?.[ENCRYPTED_GRANTEE_LIST_METADATA_KEY],
        },
      }
    }
  }

  // If no entry at or before timestamp, return the oldest entry
  // (this is the "first" ACT state)
  const oldest = nodes[nodes.length - 1]
  return {
    timestamp: calculateOriginalTimestamp(oldest.fullPathString),
    metadata: {
      actReference: uint8ArrayToHex(oldest.targetAddress),
      encryptedGranteeListRef:
        oldest.metadata?.[ENCRYPTED_GRANTEE_LIST_METADATA_KEY],
    },
  }
}

/**
 * Get all history entries sorted by timestamp (newest first)
 *
 * @param manifest - History manifest (MantarayNode)
 * @returns Array of entries sorted newest first
 */
export function getAllEntries(manifest: MantarayNode): HistoryEntry[] {
  const nodes = manifest.collect()

  // Sort by path ascending (newest first due to reversed timestamps)
  nodes.sort((a, b) => a.fullPathString.localeCompare(b.fullPathString))

  return nodes.map((node) => ({
    timestamp: calculateOriginalTimestamp(node.fullPathString),
    metadata: {
      actReference: uint8ArrayToHex(node.targetAddress),
      encryptedGranteeListRef:
        node.metadata?.[ENCRYPTED_GRANTEE_LIST_METADATA_KEY],
    },
  }))
}

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
export async function serializeHistoryTree(
  manifest: MantarayNode,
): Promise<SerializedHistoryTree> {
  const blobs = new Map<string, Uint8Array>()

  async function marshalRecursively(node: MantarayNode): Promise<void> {
    // First, marshal all child nodes
    for (const fork of node.forks.values()) {
      await marshalRecursively(fork.node)
    }

    // Now marshal this node (which will use children's selfAddresses)
    const data = await node.marshal()
    const selfAddress = await node.calculateSelfAddress()
    node.selfAddress = selfAddress.toUint8Array()
    blobs.set(selfAddress.toHex(), data)
  }

  await marshalRecursively(manifest)

  const rootRef = uint8ArrayToHex(manifest.selfAddress!)
  return { blobs, rootReference: rootRef }
}

/**
 * Upload callback type for saveHistoryTreeRecursively
 */
export type UploadCallback = (
  data: Uint8Array,
  isRoot: boolean,
) => Promise<{ reference: string; tagUid?: number }>

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
export async function saveHistoryTreeRecursively(
  manifest: MantarayNode,
  uploadFn: UploadCallback,
): Promise<SaveHistoryTreeResult> {
  async function saveRecursively(
    node: MantarayNode,
    isRoot: boolean,
  ): Promise<{ reference: string; tagUid?: number }> {
    // First, save all child forks recursively
    for (const fork of node.forks.values()) {
      await saveRecursively(fork.node, false)
    }

    // Now marshal this node - children's selfAddress should be set from their uploads
    const data = await node.marshal()

    // Upload and get Bee's actual reference
    const result = await uploadFn(data, isRoot)

    // Update selfAddress with Bee's reference (critical for parent marshaling)
    node.selfAddress = hexToUint8Array(result.reference)

    return result
  }

  const result = await saveRecursively(manifest, true)

  return {
    rootReference: result.reference,
    tagUid: result.tagUid,
  }
}

/**
 * Serialize history manifest root to Mantaray binary format
 *
 * @deprecated Use serializeHistoryTree for proper Mantaray serialization
 * @param manifest - History manifest (MantarayNode)
 * @returns Serialized root manifest as Uint8Array
 */
export async function serializeHistory(
  manifest: MantarayNode,
): Promise<Uint8Array> {
  return manifest.marshal()
}

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
export function deserializeHistory(
  data: Uint8Array,
  selfAddress: Uint8Array,
): MantarayNode {
  return MantarayNode.unmarshalFromData(data, selfAddress)
}

/**
 * Load child node data into a deserialized manifest
 *
 * After deserializing the root node, this function loads all child node data
 * so that targetAddress is available for each entry.
 *
 * @param manifest - Deserialized root manifest
 * @param loadData - Callback to load data for a given reference
 */
export async function loadHistoryEntries(
  manifest: MantarayNode,
  loadData: (reference: string) => Promise<Uint8Array>,
): Promise<void> {
  async function loadRecursively(node: MantarayNode): Promise<void> {
    for (const fork of node.forks.values()) {
      if (!fork.node.selfAddress) {
        throw new Error("Fork node selfAddress is not set")
      }

      // Load the child node data
      const childRef = uint8ArrayToHex(fork.node.selfAddress)
      const childData = await loadData(childRef)

      // Deserialize the child node
      const childNode = MantarayNode.unmarshalFromData(
        childData,
        fork.node.selfAddress,
      )

      // Copy the loaded data to the fork node
      fork.node.targetAddress = childNode.targetAddress
      fork.node.forks = childNode.forks
      fork.node.obfuscationKey = childNode.obfuscationKey

      // Fix parent pointers for nested forks
      for (const nestedFork of fork.node.forks.values()) {
        nestedFork.node.parent = fork.node
      }

      // Recursively load any nested forks
      await loadRecursively(fork.node)
    }
  }

  await loadRecursively(manifest)
}

/**
 * Get current Unix timestamp in seconds
 */
export function getCurrentTimestamp(): number {
  const now = Math.floor(Date.now() / 1000)
  if (now <= lastTimestamp) {
    lastTimestamp += 1
    return lastTimestamp
  }
  lastTimestamp = now
  return now
}
