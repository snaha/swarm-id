// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ACT (Access Control Tries) - Bee-Compatible Implementation
 *
 * This module provides client-side ACT operations with Bee-compatible
 * Simple Manifest (JSON) format:
 * - ACT manifest (JSON with lookup key -> encrypted access key mappings)
 * - Encrypted grantee list (stored separately)
 * - History manifest (tracks ACT versions over time)
 */

import type { Bee, BeeRequestOptions, UploadOptions } from "@ethersphere/bee-js"
import type { UploadProgress } from "../types"
import { uploadData, type UploadTarget } from "../upload"
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

type ActUploadOptions = UploadOptions & { beeCompatible?: boolean }

/**
 * The private keys one session may read or publish with. A proxy holds two —
 * the origin-bound app key and the account-wide sharing key (#519) — and does
 * not know which one a share was made out to, so every reader/publisher entry
 * point takes candidates and uses the one the ACT names.
 */
export type ActKeyCandidates = Uint8Array | Uint8Array[]

function candidateKeys(keys: ActKeyCandidates): Uint8Array[] {
  return Array.isArray(keys) ? keys : [keys]
}

/**
 * The candidate that published the ACT: the one whose self-entry (ECDH with
 * its own public key) the manifest carries.
 */
function findPublisherKey(
  entries: ActEntry[],
  keys: ActKeyCandidates,
): {
  privateKey: Uint8Array
  derived: ReturnType<typeof deriveKeys>
  entry: ActEntry
} {
  for (const privateKey of candidateKeys(keys)) {
    const pub = publicKeyFromPrivate(privateKey)
    const derived = deriveKeys(privateKey, pub.x, pub.y)
    const entry = findEntryByLookupKey(entries, derived.lookupKey)
    if (entry) {
      return { privateKey, derived, entry }
    }
  }
  throw new Error("Cannot find publisher entry in ACT")
}

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
  saveHistoryTreeRecursively,
  deserializeHistory,
  loadHistoryEntries,
  getCurrentTimestamp,
} from "./history"

// Reference size constants
const REFERENCE_SIZE = 32

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
 * Result of ACT revocation. `encryptedReference` is returned unchanged (#496):
 * revocation drops the revoked entries but must not re-encrypt the reference.
 */
export interface ActRevocationResult extends ActGranteeModifyResult {
  encryptedReference: string // Unchanged content reference (see #496)
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
 * 1. ACT manifest (JSON Simple Manifest with lookup key -> encrypted access key mappings)
 * 2. Encrypted grantee list (for publisher management)
 * 3. History manifest (tracks ACT versions over time)
 *
 * @param config - Upload configuration (stamper or subsidised gateway)
 * @param contentReference - The reference to protect (32 or 64 bytes)
 * @param publisherPrivateKey - Publisher's private key (32 bytes)
 * @param granteePublicKeys - Array of grantee public keys
 * @param options - Upload options
 * @param requestOptions - Bee request options
 * @param onProgress - Progress callback
 * @returns Multiple references for ACT
 */
export async function createActForContent(
  target: UploadTarget,
  contentReference: Uint8Array,
  publisherPrivateKey: Uint8Array,
  granteePublicKeys: Array<{ x: Uint8Array; y: Uint8Array }>,
  options?: ActUploadOptions,
  requestOptions?: BeeRequestOptions,
  onProgress?: (progress: UploadProgress) => void,
): Promise<ActUploadResult> {
  // Generate random access key
  const accessKey = generateRandomKey()

  // Encrypt the content reference with the access key
  // CTR mode preserves input length - 32-byte ref → 32-byte encrypted
  const encryptedRef = counterModeEncrypt(contentReference, accessKey)

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

  // 1. Serialize and upload ACT manifest (JSON Simple Manifest format)
  const actJson = serializeAct(entries)

  const beeCompatible = options?.beeCompatible === true

  const actResult = await uploadData(target, actJson, {
    encryptionKey: beeCompatible ? undefined : true,
    pin: options?.pin,
    deferred: options?.deferred,
    tag: options?.tag,
    requestOptions,
  })

  // 2. Serialize and upload encrypted grantee list
  const encryptedGranteeList = serializeAndEncryptGranteeList(
    granteePublicKeys,
    publisherPrivateKey,
  )

  const granteeListResult = await uploadData(target, encryptedGranteeList, {
    encryptionKey: true,
    pin: options?.pin,
    deferred: options?.deferred,
    requestOptions,
  })

  // 3. Create and upload history manifest
  const timestamp = getCurrentTimestamp()
  const historyManifest = createHistoryManifest()
  addHistoryEntry(
    historyManifest,
    timestamp,
    actResult.reference,
    granteeListResult.reference,
  )

  // Save history tree bottom-up using Bee's actual returned references
  // This ensures parent nodes reference children by their actual storage addresses
  const historyResult = await saveHistoryTreeRecursively(
    historyManifest,
    async (data, isRoot) => {
      return uploadData(target, data, {
        encryptionKey: beeCompatible ? undefined : true,
        pin: options?.pin,
        deferred: options?.deferred,
        tag: options?.tag,
        onProgress: isRoot ? onProgress : undefined,
        requestOptions,
      })
    },
  )

  const historyReference = historyResult.rootReference
  const historyTagUid = historyResult.tagUid

  // Compress publisher public key for API response
  const compressedPubKey = compressPublicKey(
    publisherPubKey.x,
    publisherPubKey.y,
  )

  return {
    encryptedReference: uint8ArrayToHex(encryptedRef),
    historyReference,
    granteeListReference: granteeListResult.reference,
    publisherPubKey: uint8ArrayToHex(compressedPubKey),
    actReference: actResult.reference,
    tagUid: historyTagUid,
  }
}

/**
 * Decrypt an ACT-protected reference
 *
 * @param bee - Bee instance
 * @param encryptedReference - The encrypted reference (hex string)
 * @param historyReference - History manifest reference
 * @param publisherPubKeyHex - Publisher's compressed public key (hex)
 * @param readerPrivateKeys - Reader's private key(s), 32 bytes each; the first
 *   one the ACT names (as a grantee, or as the publisher itself) decrypts
 * @param timestamp - Optional timestamp to look up specific ACT version
 * @param requestOptions - Bee request options
 * @returns Decrypted content reference (hex string)
 */
export async function decryptActReference(
  bee: Bee,
  encryptedReference: string,
  historyReference: string,
  publisherPubKeyHex: string,
  readerPrivateKeys: ActKeyCandidates,
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
  const historyManifest = deserializeHistory(
    historyData,
    hexToUint8Array(historyReference),
  )

  // Load child nodes to populate entry data
  await loadHistoryEntries(historyManifest, async (ref) => {
    return downloadDataWithChunkAPI(
      bee,
      ref,
      undefined,
      undefined,
      requestOptions,
    )
  })

  // Get the appropriate entry
  const entry = timestamp
    ? getEntryAtTimestamp(historyManifest, timestamp)
    : getLatestEntry(historyManifest)

  if (!entry) {
    throw new Error("No ACT entry found in history")
  }

  const actReference = entry.metadata.actReference

  // Download ACT manifest (JSON Simple Manifest)
  const actData = await downloadDataWithChunkAPI(
    bee,
    actReference,
    undefined,
    undefined,
    requestOptions,
  )
  const entries = deserializeAct(actData)

  // Each candidate key, first as a grantee (ECDH with the publisher), then as
  // the publisher itself (ECDH with its own key) — all local, the manifest is
  // already here.
  for (const readerPrivateKey of candidateKeys(readerPrivateKeys)) {
    const readerPubKey = publicKeyFromPrivate(readerPrivateKey)
    for (const peer of [publisherPubKey, readerPubKey]) {
      const keys = deriveKeys(readerPrivateKey, peer.x, peer.y)
      const entry = findEntryByLookupKey(entries, keys.lookupKey)
      if (!entry) continue
      const accessKey = counterModeDecrypt(
        entry.encryptedAccessKey,
        keys.accessKeyDecryptionKey,
      )
      const decryptedRef = counterModeDecrypt(
        hexToUint8Array(encryptedReference),
        accessKey,
      )
      return formatDecryptedReference(decryptedRef)
    }
  }

  throw new Error("Access denied: no ACT entry found for this key")
}

/**
 * Add grantees to an existing ACT
 */
export async function addGranteesToAct(
  target: UploadTarget,
  bee: Bee,
  historyReference: string,
  publisherCandidates: ActKeyCandidates,
  newGranteePublicKeys: Array<{ x: Uint8Array; y: Uint8Array }>,
  options?: ActUploadOptions,
  requestOptions?: BeeRequestOptions,
  onProgress?: (progress: UploadProgress) => void,
): Promise<ActGranteeModifyResult> {
  const beeCompatible = historyReference.length === 64

  // Download history manifest
  const historyData = await downloadDataWithChunkAPI(
    bee,
    historyReference,
    undefined,
    undefined,
    requestOptions,
  )
  const historyManifest = deserializeHistory(
    historyData,
    hexToUint8Array(historyReference),
  )

  // Load child nodes to populate entry data
  await loadHistoryEntries(historyManifest, async (ref) => {
    return downloadDataWithChunkAPI(
      bee,
      ref,
      undefined,
      undefined,
      requestOptions,
    )
  })

  // Get latest entry
  const latestEntry = getLatestEntry(historyManifest)
  if (!latestEntry) {
    throw new Error("History manifest is empty")
  }

  // Download current ACT (JSON Simple Manifest)
  const actData = await downloadDataWithChunkAPI(
    bee,
    latestEntry.metadata.actReference,
    undefined,
    undefined,
    requestOptions,
  )
  const entries = deserializeAct(actData)

  // Recover the access key with whichever candidate published the ACT
  const {
    privateKey: publisherPrivateKey,
    derived: publisherKeys,
    entry: publisherEntry,
  } = findPublisherKey(entries, publisherCandidates)
  const accessKey = counterModeDecrypt(
    publisherEntry.encryptedAccessKey,
    publisherKeys.accessKeyDecryptionKey,
  )

  // Create new ACT manifest with existing entries plus new grantees
  const newEntries: ActEntry[] = [...entries]
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

  // Upload new ACT manifest (JSON Simple Manifest format)
  const newActJson = serializeAct(newEntries)

  const actResult = await uploadData(target, newActJson, {
    encryptionKey: beeCompatible ? undefined : true,
    pin: options?.pin,
    deferred: options?.deferred,
    tag: options?.tag,
    requestOptions,
  })

  // Upload updated grantee list
  const encryptedGranteeList = serializeAndEncryptGranteeList(
    updatedGrantees,
    publisherPrivateKey,
  )
  const granteeListResult = await uploadData(target, encryptedGranteeList, {
    encryptionKey: true,
    pin: options?.pin,
    deferred: options?.deferred,
    requestOptions,
  })

  // Add new history entry
  const timestamp = getCurrentTimestamp()
  addHistoryEntry(
    historyManifest,
    timestamp,
    actResult.reference,
    granteeListResult.reference,
  )

  // Save history tree bottom-up using Bee's actual returned references
  const historyResult = await saveHistoryTreeRecursively(
    historyManifest,
    async (data, isRoot) => {
      return uploadData(target, data, {
        encryptionKey: beeCompatible ? undefined : true,
        pin: options?.pin,
        deferred: options?.deferred,
        tag: options?.tag,
        onProgress: isRoot ? onProgress : undefined,
        requestOptions,
      })
    },
  )

  const newHistoryReference = historyResult.rootReference
  const historyTagUid = historyResult.tagUid

  return {
    historyReference: newHistoryReference,
    granteeListReference: granteeListResult.reference,
    actReference: actResult.reference,
    tagUid: historyTagUid,
  }
}

/**
 * Revoke grantees from an ACT by dropping their entries. The content reference is
 * returned unchanged — revocation must not re-encrypt it (#496).
 */
export async function revokeGranteesFromAct(
  target: UploadTarget,
  bee: Bee,
  historyReference: string,
  encryptedReference: string,
  publisherCandidates: ActKeyCandidates,
  revokePublicKeys: Array<{ x: Uint8Array; y: Uint8Array }>,
  options?: ActUploadOptions,
  requestOptions?: BeeRequestOptions,
  onProgress?: (progress: UploadProgress) => void,
): Promise<ActRevocationResult> {
  const beeCompatible = historyReference.length === 64

  // Download history manifest
  const historyData = await downloadDataWithChunkAPI(
    bee,
    historyReference,
    undefined,
    undefined,
    requestOptions,
  )
  const historyManifest = deserializeHistory(
    historyData,
    hexToUint8Array(historyReference),
  )

  // Load child nodes to populate entry data
  await loadHistoryEntries(historyManifest, async (ref) => {
    return downloadDataWithChunkAPI(
      bee,
      ref,
      undefined,
      undefined,
      requestOptions,
    )
  })

  // Get latest entry
  const latestEntry = getLatestEntry(historyManifest)
  if (!latestEntry) {
    throw new Error("History manifest is empty")
  }

  // Download current ACT (JSON Simple Manifest)
  const actData = await downloadDataWithChunkAPI(
    bee,
    latestEntry.metadata.actReference,
    undefined,
    undefined,
    requestOptions,
  )
  const entries = deserializeAct(actData)

  // Recover the access key with whichever candidate published the ACT
  const {
    privateKey: publisherPrivateKey,
    derived: publisherKeys,
    entry: publisherEntry,
  } = findPublisherKey(entries, publisherCandidates)

  // Keep the existing access key. Rotating it and re-encrypting the SAME content
  // reference under the new key was a revocation bypass (#496): counterModeEncrypt
  // is nonce-free CTR, so two ciphertexts of the same reference expose the new
  // keystream to any former grantee, who read both from immutable history. Re-keying
  // is also pointless — immutability keeps the old ciphertext readable forever, so
  // it can never un-share. Revocation only drops the revoked entries from the ACT.
  const accessKey = counterModeDecrypt(
    publisherEntry.encryptedAccessKey,
    publisherKeys.accessKeyDecryptionKey,
  )

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

  // Rebuild the ACT with the surviving entries under the same access key.
  const newEntries: ActEntry[] = []

  // Entry for publisher
  newEntries.push({
    lookupKey: publisherKeys.lookupKey,
    encryptedAccessKey: counterModeEncrypt(
      accessKey,
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
        accessKey,
        granteeKeys.accessKeyDecryptionKey,
      ),
    })
  }

  // Upload new ACT manifest (JSON Simple Manifest format)
  const newActJson = serializeAct(newEntries)

  const actResult = await uploadData(target, newActJson, {
    encryptionKey: beeCompatible ? undefined : true,
    pin: options?.pin,
    deferred: options?.deferred,
    tag: options?.tag,
    requestOptions,
  })

  // Upload updated grantee list
  const encryptedGranteeList = serializeAndEncryptGranteeList(
    remainingGrantees,
    publisherPrivateKey,
  )
  const granteeListResult = await uploadData(target, encryptedGranteeList, {
    encryptionKey: true,
    pin: options?.pin,
    deferred: options?.deferred,
    requestOptions,
  })

  // Add new history entry
  const timestamp = getCurrentTimestamp()
  addHistoryEntry(
    historyManifest,
    timestamp,
    actResult.reference,
    granteeListResult.reference,
  )

  // Save history tree bottom-up using Bee's actual returned references
  const historyResult = await saveHistoryTreeRecursively(
    historyManifest,
    async (data, isRoot) => {
      return uploadData(target, data, {
        encryptionKey: beeCompatible ? undefined : true,
        pin: options?.pin,
        deferred: options?.deferred,
        tag: options?.tag,
        onProgress: isRoot ? onProgress : undefined,
        requestOptions,
      })
    },
  )

  const newHistoryReference = historyResult.rootReference
  const historyTagUid = historyResult.tagUid

  return {
    // Unchanged — see #496: revocation must not re-encrypt the reference.
    encryptedReference,
    historyReference: newHistoryReference,
    granteeListReference: granteeListResult.reference,
    actReference: actResult.reference,
    tagUid: historyTagUid,
  }
}

/**
 * Get grantees from an ACT
 */
export async function getGranteesFromAct(
  bee: Bee,
  historyReference: string,
  publisherCandidates: ActKeyCandidates,
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
  const historyManifest = deserializeHistory(
    historyData,
    hexToUint8Array(historyReference),
  )

  // Load child nodes to populate entry data
  await loadHistoryEntries(historyManifest, async (ref) => {
    return downloadDataWithChunkAPI(
      bee,
      ref,
      undefined,
      undefined,
      requestOptions,
    )
  })

  // Get latest entry
  const latestEntry = getLatestEntry(historyManifest)
  if (!latestEntry || !latestEntry.metadata.encryptedGranteeListRef) {
    return []
  }

  // The ACT manifest says which candidate published it. Decrypting the list
  // with the wrong key yields garbage that only a 0x04 prefix check would
  // catch, so it is not used to tell the keys apart.
  const actData = await downloadDataWithChunkAPI(
    bee,
    latestEntry.metadata.actReference,
    undefined,
    undefined,
    requestOptions,
  )
  const { privateKey: publisherPrivateKey } = findPublisherKey(
    deserializeAct(actData),
    publisherCandidates,
  )

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
export { type ActEntry } from "./act"
export { type UncompressedPublicKey } from "./grantee-list"
export { type HistoryEntry, type HistoryEntryMetadata } from "./history"
export {
  publicKeyFromPrivate,
  compressPublicKey,
  publicKeyFromCompressed,
} from "./crypto"
