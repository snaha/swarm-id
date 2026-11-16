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
import type { MantarayNode } from "@ethersphere/core-sdk"
import { Binary } from "cafe-utility"
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
  entryEncryptionKey,
  generateAccessKeySalt,
} from "./crypto"

type ActUploadOptions = UploadOptions & { beeCompatible?: boolean }

/**
 * The private keys one session may read or publish with. A proxy holds two —
 * the origin-bound app key and the account-wide sharing key (#519) — and does
 * not know which one a share was made out to, so every reader/publisher entry
 * point takes candidates and uses the one the ACT names.
 *
 * A candidate may be **denied** (#885): it is still tried, and when the ACT
 * names it and no allowed candidate, the call fails with that error instead
 * of succeeding. So a share made out to a key the user has switched off reads
 * as a permission problem, not as "not a grantee".
 */
export type ActKeyCandidate =
  | Uint8Array
  | { privateKey: Uint8Array; denied: Error }
export type ActKeyCandidates = ActKeyCandidate | ActKeyCandidate[]

function candidateKeys(
  keys: ActKeyCandidates,
): { privateKey: Uint8Array; denied?: Error }[] {
  return (Array.isArray(keys) ? keys : [keys]).map((key) =>
    key instanceof Uint8Array ? { privateKey: key } : key,
  )
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
  for (const { privateKey, denied } of candidateKeys(keys)) {
    const pub = publicKeyFromPrivate(privateKey)
    const derived = deriveKeys(privateKey, pub.x, pub.y)
    const entry = findEntryByLookupKey(entries, derived.lookupKey)
    if (entry) {
      if (denied) throw denied
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
  getAllEntries,
  saveHistoryTreeRecursively,
  deserializeHistory,
  loadHistoryEntries,
  getCurrentTimestamp,
  type HistoryEntry,
} from "./history"

// Reference size constants
const REFERENCE_SIZE = 32
/** A plain 32-byte reference in hex */
const PLAIN_REFERENCE_HEX_LENGTH = REFERENCE_SIZE * 2

/**
 * Whether a history is Bee-compatible: addressed by a plain 32-byte reference
 * that Bee's own ACT endpoints can read, not an encrypted 64-byte one.
 */
export function isBeeCompatibleHistory(historyReference: string): boolean {
  return historyReference.length === PLAIN_REFERENCE_HEX_LENGTH
}

/**
 * Result of ACT upload operation
 */
export interface ActUploadResult {
  encryptedReference: string // Encrypted content reference (NOT stored in ACT)
  historyReference: string // History manifest reference (root of ACT versions)
  granteeListReference: string // Encrypted grantee list reference
  publisherPubKey: string // Compressed public key for sharing with grantees
  actReference: string // Latest ACT reference (for convenience)
  /**
   * The history entry whose access key encrypted `encryptedReference`. A
   * revoke rotates the key, so reading this version after one takes it.
   */
  timestamp: number
  tagUid?: number
}

/**
 * Result of ACT grantee modification, adding or revoking
 */
export interface ActGranteeModifyResult {
  historyReference: string
  granteeListReference: string
  actReference: string
  timestamp: number // The new history entry's
  tagUid?: number
}

/**
 * The latest entry of an existing history, opened by the candidate that
 * published it: what adding or revoking grantees builds on, and what an
 * upload continuing the history encrypts under (#931).
 */
export interface ActHistoryHead {
  historyReference: string
  /** Every entry loaded; a new version is appended to it */
  historyManifest: MantarayNode
  latestEntry: HistoryEntry
  /** The latest entry's ACT */
  entries: ActEntry[]
  publisherPrivateKey: Uint8Array
  /** The latest entry's access key */
  accessKey: Uint8Array
  /**
   * The latest entry's salt (#408), which an add keeps with the key; absent
   * in a Bee-compatible history and in an entry written unsalted
   */
  accessKeySalt?: Uint8Array
}

/** A new ACT for the history: its entries and the grantee list beside it */
interface ActVersion {
  entries: ActEntry[]
  grantees: UncompressedPublicKey[]
  publisherPrivateKey: Uint8Array
  /** The salt the entries and the grantee list are encrypted with, if any */
  accessKeySalt?: Uint8Array
}

/** How the chunks of a new ACT version are uploaded */
interface ActVersionUpload {
  beeCompatible: boolean
  options?: ActUploadOptions
  requestOptions?: BeeRequestOptions
  onProgress?: (progress: UploadProgress) => void
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
 * The ACT entry that hands `accessKey` to `grantee`, keyed and encrypted by
 * the ECDH of the publisher's key with theirs, the encryption key mixed with
 * the access key's salt when it has one (#408). The lookup key stays unsalted,
 * so a reader and the publisher find their entry without it. The publisher's
 * own entry is the one made out to its own public key.
 */
function actEntryFor(
  publisherPrivateKey: Uint8Array,
  grantee: UncompressedPublicKey,
  accessKey: Uint8Array,
  salt: Uint8Array | undefined,
): ActEntry {
  const keys = deriveKeys(publisherPrivateKey, grantee.x, grantee.y)
  return {
    lookupKey: keys.lookupKey,
    encryptedAccessKey: counterModeEncrypt(
      accessKey,
      entryEncryptionKey(keys.accessKeyDecryptionKey, salt),
    ),
  }
}

/**
 * A fresh salt for a new access key in a native history, none in a
 * Bee-compatible one: Bee decrypts its entries unsalted (#408).
 */
function newAccessKeySalt(beeCompatible: boolean): Uint8Array | undefined {
  return beeCompatible ? undefined : generateAccessKeySalt()
}

/** The salt a history entry keeps for its access key, if it keeps one */
function saltOf(entry: HistoryEntry): Uint8Array | undefined {
  const { accessKeySalt } = entry.metadata
  return accessKeySalt === undefined
    ? undefined
    : hexToUint8Array(accessKeySalt)
}

/**
 * Now, or just after the latest entry when that one is stamped ahead of this
 * clock, as a device whose clock runs fast leaves it. The new entry has to
 * be the latest: readers and later uploads take the latest entry's ACT, and
 * after a revoke the one before it still names the revoked grantees.
 */
function nextEntryTimestamp(historyManifest: MantarayNode): number {
  const now = getCurrentTimestamp()
  const latest = getLatestEntry(historyManifest)
  return latest && latest.timestamp >= now ? latest.timestamp + 1 : now
}

/**
 * Upload an ACT and its encrypted grantee list, and save the history with
 * them as its new latest entry.
 */
async function appendActVersion(
  target: UploadTarget,
  historyManifest: MantarayNode,
  version: ActVersion,
  { beeCompatible, options, requestOptions, onProgress }: ActVersionUpload,
): Promise<ActGranteeModifyResult> {
  // ACT manifest (JSON Simple Manifest format)
  const actResult = await uploadData(target, serializeAct(version.entries), {
    encryptionKey: beeCompatible ? undefined : true,
    pin: options?.pin,
    deferred: options?.deferred,
    tag: options?.tag,
    requestOptions,
  })

  const encryptedGranteeList = serializeAndEncryptGranteeList(
    version.grantees,
    version.publisherPrivateKey,
    version.accessKeySalt,
  )
  const granteeListResult = await uploadData(target, encryptedGranteeList, {
    encryptionKey: true,
    pin: options?.pin,
    deferred: options?.deferred,
    requestOptions,
  })

  const timestamp = nextEntryTimestamp(historyManifest)
  addHistoryEntry(
    historyManifest,
    timestamp,
    actResult.reference,
    granteeListResult.reference,
    version.accessKeySalt && uint8ArrayToHex(version.accessKeySalt),
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

  return {
    historyReference: historyResult.rootReference,
    granteeListReference: granteeListResult.reference,
    actReference: actResult.reference,
    timestamp,
    tagUid: historyResult.tagUid,
  }
}

/** A history manifest with every entry loaded */
async function loadHistory(
  bee: Bee,
  historyReference: string,
  requestOptions?: BeeRequestOptions,
): Promise<MantarayNode> {
  const download = (reference: string) =>
    downloadDataWithChunkAPI(
      bee,
      reference,
      undefined,
      undefined,
      requestOptions,
    )
  const historyManifest = deserializeHistory(
    await download(historyReference),
    hexToUint8Array(historyReference),
  )
  // Load child nodes to populate entry data
  await loadHistoryEntries(historyManifest, download)
  return historyManifest
}

/** An ACT manifest's entries (JSON Simple Manifest) */
async function downloadAct(
  bee: Bee,
  actReference: string,
  requestOptions?: BeeRequestOptions,
): Promise<ActEntry[]> {
  const actData = await downloadDataWithChunkAPI(
    bee,
    actReference,
    undefined,
    undefined,
    requestOptions,
  )
  return deserializeAct(actData)
}

/** The grantees of a history's latest entry, decrypted with the publisher's key */
async function downloadGranteeList(
  bee: Bee,
  head: ActHistoryHead,
  requestOptions?: BeeRequestOptions,
): Promise<UncompressedPublicKey[]> {
  const reference = head.latestEntry.metadata.encryptedGranteeListRef
  if (!reference) return []
  const encryptedList = await downloadDataWithChunkAPI(
    bee,
    reference,
    undefined,
    undefined,
    requestOptions,
  )
  return decryptAndDeserializeGranteeList(
    encryptedList,
    head.publisherPrivateKey,
    head.accessKeySalt,
  )
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
  granteePublicKeys: UncompressedPublicKey[],
  options?: ActUploadOptions,
  requestOptions?: BeeRequestOptions,
  onProgress?: (progress: UploadProgress) => void,
): Promise<ActUploadResult> {
  const beeCompatible = options?.beeCompatible === true
  const accessKey = generateRandomKey()
  const accessKeySalt = newAccessKeySalt(beeCompatible)

  // Entries for the publisher (so they can decrypt their own content) and
  // every grantee
  const publisherPubKey = publicKeyFromPrivate(publisherPrivateKey)
  const version = await appendActVersion(
    target,
    createHistoryManifest(),
    {
      entries: [publisherPubKey, ...granteePublicKeys].map((grantee) =>
        actEntryFor(publisherPrivateKey, grantee, accessKey, accessKeySalt),
      ),
      grantees: granteePublicKeys,
      publisherPrivateKey,
      accessKeySalt,
    },
    {
      beeCompatible,
      options,
      requestOptions,
      onProgress,
    },
  )

  return {
    // CTR mode preserves input length - 32-byte ref → 32-byte encrypted
    encryptedReference: uint8ArrayToHex(
      counterModeEncrypt(contentReference, accessKey),
    ),
    publisherPubKey: uint8ArrayToHex(
      compressPublicKey(publisherPubKey.x, publisherPubKey.y),
    ),
    ...version,
  }
}

/**
 * Open an existing history at its latest entry, with whichever candidate
 * published it, and recover that entry's access key with its salt.
 */
export async function openActHistory(
  bee: Bee,
  historyReference: string,
  publisherCandidates: ActKeyCandidates,
  requestOptions?: BeeRequestOptions,
): Promise<ActHistoryHead> {
  const historyManifest = await loadHistory(
    bee,
    historyReference,
    requestOptions,
  )
  const latestEntry = getLatestEntry(historyManifest)
  if (!latestEntry) {
    throw new Error("History manifest is empty")
  }
  const entries = await downloadAct(
    bee,
    latestEntry.metadata.actReference,
    requestOptions,
  )
  const { privateKey, derived, entry } = findPublisherKey(
    entries,
    publisherCandidates,
  )
  const accessKeySalt = saltOf(latestEntry)
  return {
    historyReference,
    historyManifest,
    latestEntry,
    entries,
    publisherPrivateKey: privateKey,
    accessKey: counterModeDecrypt(
      entry.encryptedAccessKey,
      entryEncryptionKey(derived.accessKeyDecryptionKey, accessKeySalt),
    ),
    accessKeySalt,
  }
}

/**
 * Protect a new content reference with an existing history, as Bee's upload
 * to a history address does: the reference is encrypted with the latest
 * entry's access key, and the history comes back as it is. Nothing is
 * uploaded (no ACT, grantee list or history entry), so the latest entry's
 * grantees read it; they are managed with `addGranteesToAct` and
 * `revokeGranteesFromAct`.
 */
export function continueActForContent(
  head: ActHistoryHead,
  contentReference: Uint8Array,
): ActUploadResult {
  const { encryptedGranteeListRef } = head.latestEntry.metadata
  if (!encryptedGranteeListRef) {
    throw new Error("The history's latest entry names no grantee list")
  }
  const publisherPubKey = publicKeyFromPrivate(head.publisherPrivateKey)
  return {
    encryptedReference: uint8ArrayToHex(
      counterModeEncrypt(contentReference, head.accessKey),
    ),
    historyReference: head.historyReference,
    granteeListReference: encryptedGranteeListRef,
    publisherPubKey: uint8ArrayToHex(
      compressPublicKey(publisherPubKey.x, publisherPubKey.y),
    ),
    actReference: head.latestEntry.metadata.actReference,
    timestamp: head.latestEntry.timestamp,
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
 *   allowed one the ACT names (as a grantee, or as the publisher itself)
 *   decrypts, and a denied one's error is thrown when no allowed one is named
 * @param timestamp - The history entry whose access key encrypted the
 *   reference, as its upload returned it; the latest entry when omitted. A
 *   reader that entry does not name is looked up in the later entries that
 *   carry the same key, up to the next rotation, so the one timestamp opens
 *   the version for every grantee of its key, including one added later
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

  const historyManifest = await loadHistory(
    bee,
    historyReference,
    requestOptions,
  )

  const anchor = timestamp
    ? getEntryAtTimestamp(historyManifest, timestamp)
    : getLatestEntry(historyManifest)

  if (!anchor) {
    throw new Error("No ACT entry found in history")
  }

  const accessKey = await accessKeyOfRun(
    bee,
    historyManifest,
    anchor,
    readerLookups(publisherPubKey, readerPrivateKeys),
    requestOptions,
  )
  return formatDecryptedReference(
    counterModeDecrypt(hexToUint8Array(encryptedReference), accessKey),
  )
}

/**
 * What a reader finds its entry in an ACT by, and decrypts it with once mixed
 * with the history entry's salt
 */
interface ReaderLookup {
  lookupKey: Uint8Array
  accessKeyDecryptionKey: Uint8Array
  denied?: Error
}

/**
 * Each candidate key, first as a grantee (ECDH with the publisher), then as
 * the publisher itself (ECDH with its own key), in the order an ACT is
 * searched.
 */
function readerLookups(
  publisherPubKey: UncompressedPublicKey,
  readerPrivateKeys: ActKeyCandidates,
): ReaderLookup[] {
  return candidateKeys(readerPrivateKeys).flatMap(({ privateKey, denied }) => {
    const readerPubKey = publicKeyFromPrivate(privateKey)
    return [publisherPubKey, readerPubKey].map((peer) => {
      const { lookupKey, accessKeyDecryptionKey } = deriveKeys(
        privateKey,
        peer.x,
        peer.y,
      )
      return { lookupKey, accessKeyDecryptionKey, denied }
    })
  })
}

/** One history entry: its ACT's entries, and the salt they are encrypted with */
interface ActOfEntry {
  entries: ActEntry[]
  salt: Uint8Array | undefined
}

/**
 * The anchor entry's access key, handed to the reader by the anchor's ACT or
 * by a later entry's under the same key: an add keeps the key, so a grantee
 * added after a version is named only further on. The later ACTs are
 * downloaded one at a time, oldest first, and only while no earlier one hands
 * the reader the key; the walk stops at the first rotation, so it never hands
 * out a key the reader was not granted.
 *
 * A denied candidate an ACT names is passed over, so a share also made out to
 * an allowed one, in that ACT or a later one under the same key, still reads.
 * When none hands out the key, the first denial is thrown, or "access denied"
 * when no candidate was named at all.
 */
async function accessKeyOfRun(
  bee: Bee,
  historyManifest: MantarayNode,
  anchor: HistoryEntry,
  lookups: ReaderLookup[],
  requestOptions?: BeeRequestOptions,
): Promise<Uint8Array> {
  let denial: Error | undefined
  const accessKeyIn = ({ entries, salt }: ActOfEntry) => {
    for (const { lookupKey, accessKeyDecryptionKey, denied } of lookups) {
      const entry = findEntryByLookupKey(entries, lookupKey)
      if (!entry) continue
      if (denied) {
        denial ??= denied
        continue
      }
      return counterModeDecrypt(
        entry.encryptedAccessKey,
        entryEncryptionKey(accessKeyDecryptionKey, salt),
      )
    }
    return undefined
  }
  const actOf = async (entry: HistoryEntry): Promise<ActOfEntry> => ({
    entries: await downloadAct(
      bee,
      entry.metadata.actReference,
      requestOptions,
    ),
    salt: saltOf(entry),
  })

  const anchorAct = await actOf(anchor)
  const named = accessKeyIn(anchorAct)
  if (named) return named

  const laterEntries = getAllEntries(historyManifest)
    .filter((entry) => entry.timestamp > anchor.timestamp)
    .reverse()
  for (const entry of laterEntries) {
    // A new salt is a rotation, told before its ACT is downloaded
    if (!sameSalt(saltOf(entry), anchorAct.salt)) break
    const act = await actOf(entry)
    if (!holdsSameAccessKey(anchorAct, act)) break
    const accessKey = accessKeyIn(act)
    if (accessKey) return accessKey
  }
  throw denial ?? new Error("Access denied: no ACT entry found for this key")
}

/** Whether two entries carry the same salt, or both none */
function sameSalt(
  a: Uint8Array | undefined,
  b: Uint8Array | undefined,
): boolean {
  return a === undefined || b === undefined ? a === b : Binary.equals(a, b)
}

/**
 * Whether `later` holds the same access key as `anchor`. An add keeps the key
 * and its salt and copies every entry byte for byte; a rotation draws a fresh
 * key, and in a native history a fresh salt (#408), and re-encrypts every
 * entry. So `later` holds the key when it keeps the salt, or the absence of
 * one, and holds one of `anchor`'s entries byte for byte: under one salt, a
 * lookup key and the key encrypting its entry both follow from one ECDH. The
 * publisher's own entry is in every ACT of a history, so two of them always
 * share a lookup key.
 */
function holdsSameAccessKey(anchor: ActOfEntry, later: ActOfEntry): boolean {
  return (
    sameSalt(anchor.salt, later.salt) &&
    anchor.entries.some((entry) => {
      const copy = findEntryByLookupKey(later.entries, entry.lookupKey)
      return (
        copy !== undefined &&
        Binary.equals(copy.encryptedAccessKey, entry.encryptedAccessKey)
      )
    })
  )
}

/**
 * Add grantees to an existing ACT. The access key stays: a new grantee reads
 * every version published under it.
 */
export async function addGranteesToAct(
  target: UploadTarget,
  bee: Bee,
  historyReference: string,
  publisherCandidates: ActKeyCandidates,
  newGranteePublicKeys: UncompressedPublicKey[],
  options?: ActUploadOptions,
  requestOptions?: BeeRequestOptions,
  onProgress?: (progress: UploadProgress) => void,
): Promise<ActGranteeModifyResult> {
  const head = await openActHistory(
    bee,
    historyReference,
    publisherCandidates,
    requestOptions,
  )
  const existingGrantees = await downloadGranteeList(bee, head, requestOptions)

  // The existing entries, plus one per new grantee under the same key and
  // salt (#408): the grantee list only grows, so it may keep its keystream
  return appendActVersion(
    target,
    head.historyManifest,
    {
      entries: [
        ...head.entries,
        ...newGranteePublicKeys.map((grantee) =>
          actEntryFor(
            head.publisherPrivateKey,
            grantee,
            head.accessKey,
            head.accessKeySalt,
          ),
        ),
      ],
      grantees: [...existingGrantees, ...newGranteePublicKeys],
      publisherPrivateKey: head.publisherPrivateKey,
      accessKeySalt: head.accessKeySalt,
    },
    {
      beeCompatible: isBeeCompatibleHistory(historyReference),
      options,
      requestOptions,
      onProgress,
    },
  )
}

/**
 * Revoke grantees by rotating the access key, as Bee's ACT update does: a new
 * ACT under a fresh key, with a fresh salt in a native history, names the
 * publisher and the remaining grantees, and becomes the history's latest
 * entry. No content reference is re-encrypted.
 */
export async function revokeGranteesFromAct(
  target: UploadTarget,
  bee: Bee,
  historyReference: string,
  publisherCandidates: ActKeyCandidates,
  revokePublicKeys: UncompressedPublicKey[],
  options?: ActUploadOptions,
  requestOptions?: BeeRequestOptions,
  onProgress?: (progress: UploadProgress) => void,
): Promise<ActGranteeModifyResult> {
  const head = await openActHistory(
    bee,
    historyReference,
    publisherCandidates,
    requestOptions,
  )
  const remainingGrantees = (
    await downloadGranteeList(bee, head, requestOptions)
  ).filter(
    (grantee) =>
      !revokePublicKeys.some((revoked) => publicKeysEqual(grantee, revoked)),
  )

  // A fresh key, which encrypts nothing here but the new ACT's own entries.
  // Every earlier entry stays in the immutable history, so a revoked grantee
  // keeps the old key and every version published under it. Keeping the old
  // key would hand them every later version too, from any earlier entry.
  // counterModeEncrypt is nonce-free CTR, one keystream per key, so the new
  // key must never encrypt a reference they already know: two ciphertexts of
  // one reference expose the keystream (#496). It only ever encrypts
  // references uploaded after the revoke.
  //
  // The entries of the remaining grantees and the publisher are fixed per
  // pair but for the salt, and a revoked grantee who obtains the history
  // reference every remaining reader holds reads this ACT too. In a native
  // history a fresh salt gives those entries new keystreams, so the old key
  // tells nothing about the new one (#408). A Bee-compatible history has no
  // salt: there the old key XORed with the two ACTs' entries for one pair is
  // the new key, and the revoke keeps out only a grantee who never reads this
  // ACT.
  const beeCompatible = isBeeCompatibleHistory(historyReference)
  const accessKey = generateRandomKey()
  const accessKeySalt = newAccessKeySalt(beeCompatible)
  const { publisherPrivateKey } = head
  return appendActVersion(
    target,
    head.historyManifest,
    {
      entries: [
        publicKeyFromPrivate(publisherPrivateKey),
        ...remainingGrantees,
      ].map((grantee) =>
        actEntryFor(publisherPrivateKey, grantee, accessKey, accessKeySalt),
      ),
      grantees: remainingGrantees,
      publisherPrivateKey,
      accessKeySalt,
    },
    {
      beeCompatible,
      options,
      requestOptions,
      onProgress,
    },
  )
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
  const historyManifest = await loadHistory(
    bee,
    historyReference,
    requestOptions,
  )

  // Get latest entry
  const latestEntry = getLatestEntry(historyManifest)
  if (!latestEntry || !latestEntry.metadata.encryptedGranteeListRef) {
    return []
  }

  // The ACT manifest says which candidate published it. Decrypting the list
  // with the wrong key yields garbage that only a 0x04 prefix check would
  // catch, so it is not used to tell the keys apart.
  const { privateKey: publisherPrivateKey } = findPublisherKey(
    await downloadAct(bee, latestEntry.metadata.actReference, requestOptions),
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
    saltOf(latestEntry),
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
