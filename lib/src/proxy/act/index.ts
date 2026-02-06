/**
 * ACT (Access Control Tries) - Bee-Compatible Implementation
 *
 * This module provides client-side ACT operations with Bee-compatible
 * multi-reference model:
 * - ACT manifest (JSON format with lookup key -> encrypted access key mappings)
 * - Encrypted grantee list (stored separately)
 * - History manifest (tracks ACT versions over time)
 */

import type { Bee, BeeRequestOptions, UploadOptions } from "@ethersphere/bee-js"
import type { UploadContext, UploadProgress } from "../types"
import { uploadDataWithSigning } from "../upload-data"
import { downloadDataWithChunkAPI } from "../download-data"
import { hexToUint8Array, uint8ArrayToHex } from "../../utils/hex"
import {
  deriveKeys,
  counterModeEncrypt,
  counterModeDecrypt,
  publicKeyFromPrivate,
  generateRandomKey,
  publicKeyFromCompressed,
  compressPublicKey,
} from "./crypto"
import {
  serializeAct,
  deserializeAct,
  findEntryByLookupKey,
  publicKeysEqual,
  type ActEntry,
} from "./act"
import {
  serializeAndEncryptGranteeList,
  decryptAndDeserializeGranteeList,
  type UncompressedPublicKey,
} from "./grantee-list"
import {
  createHistoryManifest,
  addHistoryEntry,
  getLatestEntry,
  getEntryAtTimestamp,
  serializeHistory,
  deserializeHistory,
  getCurrentTimestamp,
} from "./history"

// Reference size constants
const REFERENCE_SIZE = 32
const ENCRYPTED_REFERENCE_SIZE = 64

/**
 * Result of ACT upload operation
 */
export interface ActUploadResult {
  encryptedReference: string // Encrypted content reference (NOT stored in ACT)
  historyReference: string // History manifest reference (root of ACT versions)
  granteeListReference: string // Encrypted grantee list reference
  publisherPubKey: string // Compressed public key for sharing with grantees
  actReference: string // Latest ACT reference (for convenience)
  tagUid?: number
}

/**
 * Result of ACT grantee modification
 */
export interface ActGranteeModifyResult {
  historyReference: string
  granteeListReference: string
  actReference: string
  tagUid?: number
}

/**
 * Result of ACT revocation (includes new encrypted reference due to key rotation)
 */
export interface ActRevocationResult extends ActGranteeModifyResult {
  encryptedReference: string // New encrypted reference after key rotation
}

/**
 * Format decrypted reference - trim to 32 bytes if second half is all zeros
 */
function formatDecryptedReference(decryptedRef: Uint8Array): string {
  let isShortRef = true
  for (let i = REFERENCE_SIZE; i < decryptedRef.length; i++) {
    if (decryptedRef[i] !== 0) {
      isShortRef = false
      break
    }
  }

  if (isShortRef) {
    return uint8ArrayToHex(decryptedRef.slice(0, REFERENCE_SIZE))
  }
  return uint8ArrayToHex(decryptedRef)
}

/**
 * Create an ACT-protected upload
 *
 * This creates:
 * 1. ACT manifest (JSON format with lookup key -> encrypted access key mappings)
 * 2. Encrypted grantee list (for publisher management)
 * 3. History manifest (tracks ACT versions over time)
 *
 * @param context - Upload context with bee and stamper
 * @param contentReference - The reference to protect (32 or 64 bytes)
 * @param publisherPrivateKey - Publisher's private key (32 bytes)
 * @param granteePublicKeys - Array of grantee public keys
 * @param options - Upload options
 * @param requestOptions - Bee request options
 * @param onProgress - Progress callback
 * @returns Multiple references for ACT
 */
export async function createActForContent(
  context: UploadContext,
  contentReference: Uint8Array,
  publisherPrivateKey: Uint8Array,
  granteePublicKeys: Array<{ x: Uint8Array; y: Uint8Array }>,
  options?: UploadOptions,
  requestOptions?: BeeRequestOptions,
  onProgress?: (progress: UploadProgress) => void,
): Promise<ActUploadResult> {
  // Pad reference to 64 bytes if needed
  const paddedRef = new Uint8Array(ENCRYPTED_REFERENCE_SIZE)
  paddedRef.set(contentReference.slice(0, ENCRYPTED_REFERENCE_SIZE))

  // Generate random access key
  const accessKey = generateRandomKey()

  // Encrypt the content reference with the access key
  const encryptedRef = counterModeEncrypt(paddedRef, accessKey)

  // Get publisher's public key
  const publisherPubKey = publicKeyFromPrivate(publisherPrivateKey)

  // Create entries for publisher and all grantees
  const entries: ActEntry[] = []

  // Entry for publisher (so they can decrypt their own content)
  const publisherKeys = deriveKeys(
    publisherPrivateKey,
    publisherPubKey.x,
    publisherPubKey.y,
  )
  entries.push({
    lookupKey: publisherKeys.lookupKey,
    encryptedAccessKey: counterModeEncrypt(
      accessKey,
      publisherKeys.accessKeyDecryptionKey,
    ),
  })

  // Entry for each grantee
  for (const granteePubKey of granteePublicKeys) {
    const granteeKeys = deriveKeys(
      publisherPrivateKey,
      granteePubKey.x,
      granteePubKey.y,
    )
    entries.push({
      lookupKey: granteeKeys.lookupKey,
      encryptedAccessKey: counterModeEncrypt(
        accessKey,
        granteeKeys.accessKeyDecryptionKey,
      ),
    })
  }

  // 1. Serialize and upload ACT manifest (JSON format)
  const actBlob = serializeAct(entries)
  console.log(
    `[ACT] Created ACT manifest: ${actBlob.length} bytes, ${entries.length} entries`,
  )

  const actResult = await uploadDataWithSigning(
    context,
    actBlob,
    options,
    undefined,
    requestOptions,
  )

  // 2. Serialize and upload encrypted grantee list
  const encryptedGranteeList = serializeAndEncryptGranteeList(
    granteePublicKeys,
    publisherPrivateKey,
  )
  console.log(
    `[ACT] Created encrypted grantee list: ${encryptedGranteeList.length} bytes`,
  )

  const granteeListResult = await uploadDataWithSigning(
    context,
    encryptedGranteeList,
    options,
    undefined,
    requestOptions,
  )

  // 3. Create and upload history manifest
  const timestamp = getCurrentTimestamp()
  let historyManifest = createHistoryManifest()
  historyManifest = addHistoryEntry(
    historyManifest,
    timestamp,
    actResult.reference,
    granteeListResult.reference,
  )

  const historyBlob = serializeHistory(historyManifest)
  console.log(`[ACT] Created history manifest: ${historyBlob.length} bytes`)

  const historyResult = await uploadDataWithSigning(
    context,
    historyBlob,
    options,
    onProgress,
    requestOptions,
  )

  // Compress publisher public key for API response
  const compressedPubKey = compressPublicKey(
    publisherPubKey.x,
    publisherPubKey.y,
  )

  return {
    encryptedReference: uint8ArrayToHex(encryptedRef),
    historyReference: historyResult.reference,
    granteeListReference: granteeListResult.reference,
    publisherPubKey: uint8ArrayToHex(compressedPubKey),
    actReference: actResult.reference,
    tagUid: historyResult.tagUid,
  }
}

/**
 * Decrypt an ACT-protected reference
 *
 * @param bee - Bee instance
 * @param encryptedReference - The encrypted reference (hex string)
 * @param historyReference - History manifest reference
 * @param publisherPubKeyHex - Publisher's compressed public key (hex)
 * @param readerPrivateKey - Reader's private key (32 bytes)
 * @param timestamp - Optional timestamp to look up specific ACT version
 * @param requestOptions - Bee request options
 * @returns Decrypted content reference (hex string)
 */
export async function decryptActReference(
  bee: Bee,
  encryptedReference: string,
  historyReference: string,
  publisherPubKeyHex: string,
  readerPrivateKey: Uint8Array,
  timestamp?: number,
  requestOptions?: BeeRequestOptions,
): Promise<string> {
  // Parse publisher public key
  const compressedPubKey = hexToUint8Array(publisherPubKeyHex)
  const publisherPubKey = publicKeyFromCompressed(compressedPubKey)

  // Download history manifest
  const historyData = await downloadDataWithChunkAPI(
    bee,
    historyReference,
    undefined,
    undefined,
    requestOptions,
  )
  const historyManifest = deserializeHistory(historyData)

  // Get the appropriate entry
  const entry = timestamp
    ? getEntryAtTimestamp(historyManifest, timestamp)
    : getLatestEntry(historyManifest)

  if (!entry) {
    throw new Error("No ACT entry found in history")
  }

  const actReference = entry.metadata.actReference
  console.log(`[ACT] Found ACT in history at timestamp ${entry.timestamp}`)

  // Download ACT manifest
  const actBlob = await downloadDataWithChunkAPI(
    bee,
    actReference,
    undefined,
    undefined,
    requestOptions,
  )
  const entries = deserializeAct(actBlob)

  console.log(`[ACT] Downloaded ACT: ${entries.length} entries`)

  // Derive keys using reader's private key and publisher's public key
  const derivedKeys = deriveKeys(
    readerPrivateKey,
    publisherPubKey.x,
    publisherPubKey.y,
  )

  // Find entry matching the lookup key
  let actEntry = findEntryByLookupKey(entries, derivedKeys.lookupKey)

  if (!actEntry) {
    // Also try self-lookup (if reader is publisher)
    const readerPubKey = publicKeyFromPrivate(readerPrivateKey)
    const selfKeys = deriveKeys(
      readerPrivateKey,
      readerPubKey.x,
      readerPubKey.y,
    )
    actEntry = findEntryByLookupKey(entries, selfKeys.lookupKey)

    if (!actEntry) {
      throw new Error("Access denied: no ACT entry found for this key")
    }

    // Use self keys for decryption
    const accessKey = counterModeDecrypt(
      actEntry.encryptedAccessKey,
      selfKeys.accessKeyDecryptionKey,
    )
    const encryptedRef = hexToUint8Array(encryptedReference)
    const decryptedRef = counterModeDecrypt(encryptedRef, accessKey)
    return formatDecryptedReference(decryptedRef)
  }

  // Decrypt access key
  const accessKey = counterModeDecrypt(
    actEntry.encryptedAccessKey,
    derivedKeys.accessKeyDecryptionKey,
  )

  // Decrypt the content reference
  const encryptedRef = hexToUint8Array(encryptedReference)
  const decryptedRef = counterModeDecrypt(encryptedRef, accessKey)

  return formatDecryptedReference(decryptedRef)
}

/**
 * Add grantees to an existing ACT
 */
export async function addGranteesToAct(
  context: UploadContext,
  historyReference: string,
  publisherPrivateKey: Uint8Array,
  newGranteePublicKeys: Array<{ x: Uint8Array; y: Uint8Array }>,
  options?: UploadOptions,
  requestOptions?: BeeRequestOptions,
  onProgress?: (progress: UploadProgress) => void,
): Promise<ActGranteeModifyResult> {
  const { bee } = context

  // Download history manifest
  const historyData = await downloadDataWithChunkAPI(
    bee,
    historyReference,
    undefined,
    undefined,
    requestOptions,
  )
  let historyManifest = deserializeHistory(historyData)

  // Get latest entry
  const latestEntry = getLatestEntry(historyManifest)
  if (!latestEntry) {
    throw new Error("History manifest is empty")
  }

  // Download current ACT
  const actBlob = await downloadDataWithChunkAPI(
    bee,
    latestEntry.metadata.actReference,
    undefined,
    undefined,
    requestOptions,
  )
  const entries = deserializeAct(actBlob)

  // Get publisher's public key and recover access key
  const publisherPubKey = publicKeyFromPrivate(publisherPrivateKey)
  const publisherKeys = deriveKeys(
    publisherPrivateKey,
    publisherPubKey.x,
    publisherPubKey.y,
  )
  const publisherEntry = findEntryByLookupKey(entries, publisherKeys.lookupKey)

  if (!publisherEntry) {
    throw new Error("Cannot find publisher entry in ACT")
  }

  const accessKey = counterModeDecrypt(
    publisherEntry.encryptedAccessKey,
    publisherKeys.accessKeyDecryptionKey,
  )

  // Add entries for new grantees
  const newEntries = [...entries]
  for (const granteePubKey of newGranteePublicKeys) {
    const granteeKeys = deriveKeys(
      publisherPrivateKey,
      granteePubKey.x,
      granteePubKey.y,
    )
    newEntries.push({
      lookupKey: granteeKeys.lookupKey,
      encryptedAccessKey: counterModeEncrypt(
        accessKey,
        granteeKeys.accessKeyDecryptionKey,
      ),
    })
  }

  // Download and update grantee list
  let existingGrantees: UncompressedPublicKey[] = []
  if (latestEntry.metadata.encryptedGranteeListRef) {
    const encryptedList = await downloadDataWithChunkAPI(
      bee,
      latestEntry.metadata.encryptedGranteeListRef,
      undefined,
      undefined,
      requestOptions,
    )
    existingGrantees = decryptAndDeserializeGranteeList(
      encryptedList,
      publisherPrivateKey,
    )
  }
  const updatedGrantees = [...existingGrantees, ...newGranteePublicKeys]

  // Upload new ACT
  const newActBlob = serializeAct(newEntries)
  const actResult = await uploadDataWithSigning(
    context,
    newActBlob,
    options,
    undefined,
    requestOptions,
  )

  // Upload updated grantee list
  const encryptedGranteeList = serializeAndEncryptGranteeList(
    updatedGrantees,
    publisherPrivateKey,
  )
  const granteeListResult = await uploadDataWithSigning(
    context,
    encryptedGranteeList,
    options,
    undefined,
    requestOptions,
  )

  // Add new history entry
  const timestamp = getCurrentTimestamp()
  historyManifest = addHistoryEntry(
    historyManifest,
    timestamp,
    actResult.reference,
    granteeListResult.reference,
  )

  // Upload new history
  const historyBlob = serializeHistory(historyManifest)
  const historyResult = await uploadDataWithSigning(
    context,
    historyBlob,
    options,
    onProgress,
    requestOptions,
  )

  console.log(
    `[ACT] Added ${newGranteePublicKeys.length} grantees, new history: ${historyResult.reference}`,
  )

  return {
    historyReference: historyResult.reference,
    granteeListReference: granteeListResult.reference,
    actReference: actResult.reference,
    tagUid: historyResult.tagUid,
  }
}

/**
 * Revoke grantees from an ACT (performs key rotation)
 */
export async function revokeGranteesFromAct(
  context: UploadContext,
  historyReference: string,
  encryptedReference: string,
  publisherPrivateKey: Uint8Array,
  revokePublicKeys: Array<{ x: Uint8Array; y: Uint8Array }>,
  options?: UploadOptions,
  requestOptions?: BeeRequestOptions,
  onProgress?: (progress: UploadProgress) => void,
): Promise<ActRevocationResult> {
  const { bee } = context

  // Download history manifest
  const historyData = await downloadDataWithChunkAPI(
    bee,
    historyReference,
    undefined,
    undefined,
    requestOptions,
  )
  let historyManifest = deserializeHistory(historyData)

  // Get latest entry
  const latestEntry = getLatestEntry(historyManifest)
  if (!latestEntry) {
    throw new Error("History manifest is empty")
  }

  // Download current ACT
  const actBlob = await downloadDataWithChunkAPI(
    bee,
    latestEntry.metadata.actReference,
    undefined,
    undefined,
    requestOptions,
  )
  const entries = deserializeAct(actBlob)

  // Get publisher's public key and recover old access key
  const publisherPubKey = publicKeyFromPrivate(publisherPrivateKey)
  const publisherKeys = deriveKeys(
    publisherPrivateKey,
    publisherPubKey.x,
    publisherPubKey.y,
  )
  const publisherEntry = findEntryByLookupKey(entries, publisherKeys.lookupKey)

  if (!publisherEntry) {
    throw new Error("Cannot find publisher entry in ACT")
  }

  const oldAccessKey = counterModeDecrypt(
    publisherEntry.encryptedAccessKey,
    publisherKeys.accessKeyDecryptionKey,
  )

  // Decrypt the content reference
  const encryptedRef = hexToUint8Array(encryptedReference)
  const decryptedRef = counterModeDecrypt(encryptedRef, oldAccessKey)

  // Generate NEW access key for key rotation
  const newAccessKey = generateRandomKey()

  // Encrypt content reference with new access key
  const newEncryptedRef = counterModeEncrypt(decryptedRef, newAccessKey)

  // Get current grantee list and filter out revoked
  let currentGrantees: UncompressedPublicKey[] = []
  if (latestEntry.metadata.encryptedGranteeListRef) {
    const encryptedList = await downloadDataWithChunkAPI(
      bee,
      latestEntry.metadata.encryptedGranteeListRef,
      undefined,
      undefined,
      requestOptions,
    )
    currentGrantees = decryptAndDeserializeGranteeList(
      encryptedList,
      publisherPrivateKey,
    )
  }

  const remainingGrantees = currentGrantees.filter((grantee) => {
    return !revokePublicKeys.some((revoked) =>
      publicKeysEqual(grantee, revoked),
    )
  })

  // Rebuild ALL entries with new access key
  const newEntries: ActEntry[] = []

  // Entry for publisher
  newEntries.push({
    lookupKey: publisherKeys.lookupKey,
    encryptedAccessKey: counterModeEncrypt(
      newAccessKey,
      publisherKeys.accessKeyDecryptionKey,
    ),
  })

  // Entry for each remaining grantee
  for (const granteePubKey of remainingGrantees) {
    const granteeKeys = deriveKeys(
      publisherPrivateKey,
      granteePubKey.x,
      granteePubKey.y,
    )
    newEntries.push({
      lookupKey: granteeKeys.lookupKey,
      encryptedAccessKey: counterModeEncrypt(
        newAccessKey,
        granteeKeys.accessKeyDecryptionKey,
      ),
    })
  }

  // Upload new ACT
  const newActBlob = serializeAct(newEntries)
  const actResult = await uploadDataWithSigning(
    context,
    newActBlob,
    options,
    undefined,
    requestOptions,
  )

  // Upload updated grantee list
  const encryptedGranteeList = serializeAndEncryptGranteeList(
    remainingGrantees,
    publisherPrivateKey,
  )
  const granteeListResult = await uploadDataWithSigning(
    context,
    encryptedGranteeList,
    options,
    undefined,
    requestOptions,
  )

  // Add new history entry
  const timestamp = getCurrentTimestamp()
  historyManifest = addHistoryEntry(
    historyManifest,
    timestamp,
    actResult.reference,
    granteeListResult.reference,
  )

  // Upload new history
  const historyBlob = serializeHistory(historyManifest)
  const historyResult = await uploadDataWithSigning(
    context,
    historyBlob,
    options,
    onProgress,
    requestOptions,
  )

  console.log(
    `[ACT] Revoked ${revokePublicKeys.length} grantees, key rotation complete`,
  )

  return {
    encryptedReference: uint8ArrayToHex(newEncryptedRef),
    historyReference: historyResult.reference,
    granteeListReference: granteeListResult.reference,
    actReference: actResult.reference,
    tagUid: historyResult.tagUid,
  }
}

/**
 * Get grantees from an ACT
 */
export async function getGranteesFromAct(
  bee: Bee,
  historyReference: string,
  publisherPrivateKey: Uint8Array,
  requestOptions?: BeeRequestOptions,
): Promise<string[]> {
  // Download history manifest
  const historyData = await downloadDataWithChunkAPI(
    bee,
    historyReference,
    undefined,
    undefined,
    requestOptions,
  )
  const historyManifest = deserializeHistory(historyData)

  // Get latest entry
  const latestEntry = getLatestEntry(historyManifest)
  if (!latestEntry || !latestEntry.metadata.encryptedGranteeListRef) {
    return []
  }

  // Download and decrypt grantee list
  const encryptedList = await downloadDataWithChunkAPI(
    bee,
    latestEntry.metadata.encryptedGranteeListRef,
    undefined,
    undefined,
    requestOptions,
  )

  const grantees = decryptAndDeserializeGranteeList(
    encryptedList,
    publisherPrivateKey,
  )

  // Return as compressed hex strings
  return grantees.map((grantee) => {
    const compressed = compressPublicKey(grantee.x, grantee.y)
    return uint8ArrayToHex(compressed)
  })
}

/**
 * Parse a compressed public key from hex string
 */
export function parseCompressedPublicKey(hex: string): {
  x: Uint8Array
  y: Uint8Array
} {
  const compressed = hexToUint8Array(hex)
  return publicKeyFromCompressed(compressed)
}

// Re-export types and utilities
export { type ActEntry, type BeeActManifest } from "./act"
export { type UncompressedPublicKey } from "./grantee-list"
export {
  type HistoryManifest,
  type HistoryEntry,
  type HistoryEntryMetadata,
} from "./history"
export {
  publicKeyFromPrivate,
  compressPublicKey,
  publicKeyFromCompressed,
} from "./crypto"
