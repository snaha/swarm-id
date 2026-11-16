// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for high-level ACT operations (Bee-compatible API)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Bee, Stamper } from "@ethersphere/bee-js"
import { ChunkSplitter } from "@ethersphere/bee-js"
import type { UploadTarget } from "../upload"
import {
  createActForContent,
  continueActForContent,
  openActHistory,
  decryptActReference,
  addGranteesToAct,
  revokeGranteesFromAct,
  getGranteesFromAct,
  parseCompressedPublicKey,
  type ActKeyCandidates,
} from "./index"
import {
  publicKeyFromPrivate,
  compressPublicKey,
  deriveKeys,
  counterModeDecrypt,
  counterModeEncrypt,
  entryEncryptionKey,
} from "./crypto"
import {
  collectActEntriesFromJson,
  findActEntryByKey,
  findEntryByLookupKey,
} from "./act"
import {
  decryptAndDeserializeGranteeList,
  serializeGranteeList,
} from "./grantee-list"
import {
  addHistoryEntry,
  createHistoryManifest,
  deserializeHistory,
  getAllEntries,
  loadHistoryEntries,
  saveHistoryTreeRecursively,
  type HistoryEntry,
} from "./history"

// Mock the upload/download functions
vi.mock("../upload", () => ({
  uploadData: vi.fn(),
}))

vi.mock("../download-data", () => ({
  downloadDataWithChunkAPI: vi.fn(),
}))

import { uploadData } from "../upload"
import {
  downloadDataWithChunkAPI,
  type ChunkDownloader,
} from "../download-data"

// Helper to create a random 32-byte array
function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

// Helper to convert bytes to hex
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

// Helper to convert hex to bytes
function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}

// Create mock Bee instance for download operations
const mockBee = {} as Bee

// Create mock upload target
function createMockTarget(): UploadTarget {
  return {
    mode: "stamper",
    bee: mockBee,
    stamper: {} as Stamper,
  }
}

// Compute content hash using Swarm's BMT algorithm (same as MantarayNode)
async function computeContentHash(data: Uint8Array): Promise<string> {
  const rootNode = await ChunkSplitter.root(data)
  return rootNode.hash().toHex()
}

// Create a content-addressed storage mock for uploads
function createContentAddressedUploadMock() {
  const storage: Map<string, Uint8Array> = new Map()

  // Mock for the new unified uploadData API
  const uploadMock = async (
    _target: unknown,
    data: Uint8Array,
    options?: { encryptionKey?: Uint8Array | boolean },
  ): Promise<{
    reference: string
    tagUid?: number
    chunkAddresses?: Uint8Array[]
  }> => {
    const address = await computeContentHash(data)
    // If encryption is requested, return 64-byte reference; otherwise 32-byte
    const isEncrypted = options?.encryptionKey !== undefined
    const ref = isEncrypted ? `${address}${address}` : address
    storage.set(ref, data)
    return { reference: ref, chunkAddresses: [] }
  }

  const downloadMock = async (
    _bee: ChunkDownloader,
    ref: string,
  ): Promise<Uint8Array> => {
    const data = storage.get(ref)
    if (!data) {
      throw new Error(`Data not found for reference: ${ref}`)
    }
    return data
  }

  return { storage, uploadMock, downloadMock }
}

// Create test key pair
function createTestKeyPair(seed: number): {
  privateKey: Uint8Array
  publicKey: { x: Uint8Array; y: Uint8Array }
  compressedPublicKey: string
} {
  const privateKey = new Uint8Array(32)
  privateKey[31] = seed
  const publicKey = publicKeyFromPrivate(privateKey)
  const compressed = compressPublicKey(publicKey.x, publicKey.y)
  return {
    privateKey,
    publicKey,
    compressedPublicKey: toHex(compressed),
  }
}

// Helper to load ACT JSON data from storage
function loadActDataFromStorage(
  storage: Map<string, Uint8Array>,
  actReference: string,
): Uint8Array {
  const actData = storage.get(actReference)
  if (!actData) {
    throw new Error(`ACT data not found for reference: ${actReference}`)
  }
  return actData
}

/** A history's entries, newest first, as anyone holding its reference reads them. */
async function historyEntries(
  storage: Map<string, Uint8Array>,
  historyReference: string,
): Promise<HistoryEntry[]> {
  const load = async (reference: string) => {
    const data = storage.get(reference)
    if (!data) throw new Error(`Data not found for reference: ${reference}`)
    return data
  }
  const manifest = deserializeHistory(
    await load(historyReference),
    fromHex(historyReference),
  )
  await loadHistoryEntries(manifest, load)
  return getAllEntries(manifest)
}

/** The entry of `version`'s history whose ACT is `version.actReference`. */
async function entryOf(
  storage: Map<string, Uint8Array>,
  version: { historyReference: string; actReference: string },
): Promise<HistoryEntry> {
  const entry = (await historyEntries(storage, version.historyReference)).find(
    ({ metadata }) => metadata.actReference === version.actReference,
  )
  if (!entry) throw new Error("No history entry for this ACT")
  return entry
}

/** The salt a history entry keeps for its access key, if it keeps one. */
function saltOf(entry: HistoryEntry): Uint8Array | undefined {
  const salt = entry.metadata.accessKeySalt
  return salt === undefined ? undefined : fromHex(salt)
}

/**
 * The access key `version`'s ACT hands `reader`, recovered as a reader does:
 * ECDH with the publisher's public key (its own, for the publisher's
 * self-entry), and the history entry's salt.
 */
async function accessKeyFromAct(
  storage: Map<string, Uint8Array>,
  version: { historyReference: string; actReference: string },
  reader: Uint8Array,
  publisherPublicKey: { x: Uint8Array; y: Uint8Array },
): Promise<Uint8Array> {
  const keys = deriveKeys(reader, publisherPublicKey.x, publisherPublicKey.y)
  const entry = findActEntryByKey(
    loadActDataFromStorage(storage, version.actReference),
    keys.lookupKey,
  )
  if (!entry) throw new Error("No ACT entry for this reader")
  return counterModeDecrypt(
    entry,
    entryEncryptionKey(
      keys.accessKeyDecryptionKey,
      saltOf(await entryOf(storage, version)),
    ),
  )
}

/** The byte-wise XOR of `parts`, as long as the shortest one. */
function xor(...parts: Uint8Array[]): Uint8Array {
  const length = Math.min(...parts.map((part) => part.length))
  return Uint8Array.from({ length }, (_, i) =>
    parts.reduce((byte, part) => byte ^ part[i], 0),
  )
}

/** An upload that continues `historyReference`, as the proxy runs it. */
async function continueHistory(
  historyReference: string,
  contentReference: Uint8Array,
  publisherCandidates: ActKeyCandidates,
) {
  const head = await openActHistory(
    mockBee,
    historyReference,
    publisherCandidates,
  )
  return continueActForContent(head, contentReference)
}

/** Whether `needle` occurs in `haystack`, byte for byte. */
function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((byte, j) => haystack[i + j] === byte)) return true
  }
  return false
}

describe("parseCompressedPublicKey", () => {
  it("should parse compressed public key from hex string", () => {
    const keyPair = createTestKeyPair(1)
    const parsed = parseCompressedPublicKey(keyPair.compressedPublicKey)

    expect(parsed.x).toEqual(keyPair.publicKey.x)
    expect(parsed.y).toEqual(keyPair.publicKey.y)
  })

  it("should throw for invalid hex string", () => {
    expect(() => parseCompressedPublicKey("invalid")).toThrow()
    expect(() => parseCompressedPublicKey("0102")).toThrow() // Too short
  })
})

describe("createActForContent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("should create ACT with publisher and grantees", async () => {
    const target = createMockTarget()
    const publisher = createTestKeyPair(10)
    const grantee1 = createTestKeyPair(11)
    const grantee2 = createTestKeyPair(12)

    const contentRef = randomBytes(64)

    // Use content-addressed storage mock
    const { storage, uploadMock } = createContentAddressedUploadMock()
    vi.mocked(uploadData).mockImplementation(uploadMock)

    const result = await createActForContent(
      target,
      contentRef,
      publisher.privateKey,
      [grantee1.publicKey, grantee2.publicKey],
    )

    // Should have all references
    expect(result.encryptedReference).toBeDefined()
    expect(result.encryptedReference.length).toBe(128) // 64 bytes = 128 hex chars
    expect(result.historyReference).toBeDefined()
    expect(result.granteeListReference).toBeDefined()
    expect(result.publisherPubKey).toBeDefined()
    expect(result.actReference).toBeDefined()

    // ACT manifest should have 3 entries (publisher + 2 grantees)
    const actData = loadActDataFromStorage(storage, result.actReference)
    const actEntries = collectActEntriesFromJson(actData)
    expect(actEntries.length).toBe(3)

    // Grantee list should have 2 grantees
    const granteeListBlob = storage.get(result.granteeListReference)
    expect(granteeListBlob).toBeDefined()
    const grantees = decryptAndDeserializeGranteeList(
      granteeListBlob!,
      publisher.privateKey,
      saltOf(await entryOf(storage, result)),
    )
    expect(grantees.length).toBe(2)
  })

  it("should create ACT that publisher can decrypt", async () => {
    const target = createMockTarget()
    const publisher = createTestKeyPair(20)
    const grantee = createTestKeyPair(21)

    const contentRef = randomBytes(32)

    // Use content-addressed storage mock
    const { storage, uploadMock } = createContentAddressedUploadMock()
    vi.mocked(uploadData).mockImplementation(uploadMock)

    const result = await createActForContent(
      target,
      contentRef,
      publisher.privateKey,
      [grantee.publicKey],
    )

    // Publisher should be able to decrypt
    const actData = loadActDataFromStorage(storage, result.actReference)

    // Derive publisher's lookup key (publisher uses their own pub key)
    const publisherKeys = deriveKeys(
      publisher.privateKey,
      publisher.publicKey.x,
      publisher.publicKey.y,
    )

    // Find publisher's entry
    const encryptedAccessKey = findActEntryByKey(
      actData,
      publisherKeys.lookupKey,
    )
    expect(encryptedAccessKey).toBeDefined()

    // Decrypt access key, with the history entry's salt
    const accessKey = counterModeDecrypt(
      encryptedAccessKey!,
      entryEncryptionKey(
        publisherKeys.accessKeyDecryptionKey,
        saltOf(await entryOf(storage, result)),
      ),
    )

    // Decrypt the encrypted reference
    const encryptedRefBytes = fromHex(result.encryptedReference)
    const decryptedRef = counterModeDecrypt(encryptedRefBytes, accessKey)

    // First 32 bytes should match original content ref
    expect(decryptedRef.slice(0, 32)).toEqual(contentRef)
  })

  it("should create ACT that grantee can decrypt", async () => {
    const target = createMockTarget()
    const publisher = createTestKeyPair(30)
    const grantee = createTestKeyPair(31)

    const contentRef = randomBytes(32)

    // Use content-addressed storage mock
    const { storage, uploadMock } = createContentAddressedUploadMock()
    vi.mocked(uploadData).mockImplementation(uploadMock)

    const result = await createActForContent(
      target,
      contentRef,
      publisher.privateKey,
      [grantee.publicKey],
    )

    // Grantee should be able to decrypt
    const actData = loadActDataFromStorage(storage, result.actReference)

    // Grantee derives keys using publisher's public key
    const granteeKeys = deriveKeys(
      grantee.privateKey,
      publisher.publicKey.x,
      publisher.publicKey.y,
    )

    // Find grantee's entry
    const encryptedAccessKey = findActEntryByKey(actData, granteeKeys.lookupKey)
    expect(encryptedAccessKey).toBeDefined()

    // Decrypt access key, with the history entry's salt
    const accessKey = counterModeDecrypt(
      encryptedAccessKey!,
      entryEncryptionKey(
        granteeKeys.accessKeyDecryptionKey,
        saltOf(await entryOf(storage, result)),
      ),
    )

    // Decrypt the encrypted reference
    const encryptedRefBytes = fromHex(result.encryptedReference)
    const decryptedRef = counterModeDecrypt(encryptedRefBytes, accessKey)

    // First 32 bytes should match original content ref
    expect(decryptedRef.slice(0, 32)).toEqual(contentRef)
  })

  it("returns the timestamp of the new history's single entry", async () => {
    const publisher = createTestKeyPair(35)
    const { uploadMock, downloadMock } = createContentAddressedUploadMock()
    vi.mocked(uploadData).mockImplementation(uploadMock)
    vi.mocked(downloadDataWithChunkAPI).mockImplementation(downloadMock)

    const result = await createActForContent(
      createMockTarget(),
      randomBytes(32),
      publisher.privateKey,
      [],
    )

    const head = await openActHistory(
      mockBee,
      result.historyReference,
      publisher.privateKey,
    )
    expect(result.timestamp).toBe(head.latestEntry.timestamp)
  })
})

describe("continueActForContent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function setup(seed: number) {
    const publisher = createTestKeyPair(seed)
    const grantee = createTestKeyPair(seed + 1)
    const outsider = createTestKeyPair(seed + 2)
    const { storage, uploadMock, downloadMock } =
      createContentAddressedUploadMock()
    vi.mocked(uploadData).mockImplementation(uploadMock)
    vi.mocked(downloadDataWithChunkAPI).mockImplementation(downloadMock)
    return { publisher, grantee, outsider, storage, target: createMockTarget() }
  }

  it("keeps the history, ACT and grantee list, takes the latest entry's timestamp, and uploads nothing", async () => {
    const { publisher, grantee, target } = setup(150)
    const created = await createActForContent(
      target,
      randomBytes(32),
      publisher.privateKey,
      [grantee.publicKey],
    )
    vi.mocked(uploadData).mockClear()

    const continued = await continueHistory(
      created.historyReference,
      randomBytes(32),
      publisher.privateKey,
    )

    expect(uploadData).not.toHaveBeenCalled()
    expect(continued).toMatchObject({
      historyReference: created.historyReference,
      actReference: created.actReference,
      granteeListReference: created.granteeListReference,
      publisherPubKey: created.publisherPubKey,
      timestamp: created.timestamp,
    })
    expect(continued.encryptedReference).not.toBe(created.encryptedReference)
  })

  it("lets the publisher and a grantee of the original ACT read the new version without a timestamp", async () => {
    const { publisher, grantee, outsider, target } = setup(160)
    const created = await createActForContent(
      target,
      randomBytes(32),
      publisher.privateKey,
      [grantee.publicKey],
    )
    const nextVersion = randomBytes(32)

    const continued = await continueHistory(
      created.historyReference,
      nextVersion,
      publisher.privateKey,
    )

    for (const reader of [publisher, grantee]) {
      await expect(
        decryptActReference(
          mockBee,
          continued.encryptedReference,
          continued.historyReference,
          continued.publisherPubKey,
          reader.privateKey,
        ),
      ).resolves.toBe(toHex(nextVersion))
    }
    await expect(
      decryptActReference(
        mockBee,
        continued.encryptedReference,
        continued.historyReference,
        continued.publisherPubKey,
        outsider.privateKey,
      ),
    ).rejects.toThrow("Access denied")
  })

  it("lets a grantee added before the upload read the new version", async () => {
    const { publisher, grantee, outsider, target } = setup(170)
    const created = await createActForContent(
      target,
      randomBytes(32),
      publisher.privateKey,
      [grantee.publicKey],
    )
    const added = await addGranteesToAct(
      target,
      mockBee,
      created.historyReference,
      publisher.privateKey,
      [outsider.publicKey],
    )
    const nextVersion = randomBytes(32)

    const continued = await continueHistory(
      added.historyReference,
      nextVersion,
      publisher.privateKey,
    )

    expect(continued.timestamp).toBe(added.timestamp)
    await expect(
      decryptActReference(
        mockBee,
        continued.encryptedReference,
        continued.historyReference,
        continued.publisherPubKey,
        outsider.privateKey,
      ),
    ).resolves.toBe(toHex(nextVersion))
  })

  it("refuses a candidate that did not publish the history", async () => {
    const { publisher, grantee, outsider, target } = setup(180)
    const created = await createActForContent(
      target,
      randomBytes(32),
      publisher.privateKey,
      [grantee.publicKey],
    )

    // Not even a grantee of it may publish into it.
    await expect(
      openActHistory(mockBee, created.historyReference, [
        outsider.privateKey,
        grantee.privateKey,
      ]),
    ).rejects.toThrow("Cannot find publisher entry")
  })

  it("continues a Bee-compatible history with a 32-byte reference", async () => {
    const { publisher, grantee, target } = setup(190)
    const created = await createActForContent(
      target,
      randomBytes(32),
      publisher.privateKey,
      [grantee.publicKey],
      { beeCompatible: true },
    )
    expect(created.historyReference).toHaveLength(64)
    const nextVersion = randomBytes(32)

    const continued = await continueHistory(
      created.historyReference,
      nextVersion,
      publisher.privateKey,
    )

    expect(continued.historyReference).toBe(created.historyReference)
    expect(continued.encryptedReference).toHaveLength(64)
    await expect(
      decryptActReference(
        mockBee,
        continued.encryptedReference,
        continued.historyReference,
        continued.publisherPubKey,
        grantee.privateKey,
      ),
    ).resolves.toBe(toHex(nextVersion))
  })
})

describe("decryptActReference", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("should decrypt reference when reader is a grantee", async () => {
    const bee = {} as Bee
    const publisher = createTestKeyPair(40)
    const grantee = createTestKeyPair(41)

    const originalContentRef = randomBytes(32)
    const originalContentRefHex = toHex(originalContentRef)

    // Use content-addressed storage mock
    const { uploadMock, downloadMock } = createContentAddressedUploadMock()
    vi.mocked(uploadData).mockImplementation(uploadMock)

    const target = createMockTarget()
    const createResult = await createActForContent(
      target,
      originalContentRef,
      publisher.privateKey,
      [grantee.publicKey],
    )

    // Mock download to return the appropriate blobs
    vi.mocked(downloadDataWithChunkAPI).mockImplementation(downloadMock)

    // Grantee should be able to decrypt
    const decryptedRef = await decryptActReference(
      bee,
      createResult.encryptedReference,
      createResult.historyReference,
      createResult.publisherPubKey,
      grantee.privateKey,
    )

    expect(decryptedRef).toBe(originalContentRefHex)
  })

  it("should decrypt reference when reader is the publisher", async () => {
    const bee = {} as Bee
    const publisher = createTestKeyPair(50)
    const grantee = createTestKeyPair(51)

    const originalContentRef = randomBytes(32)
    const originalContentRefHex = toHex(originalContentRef)

    // Use content-addressed storage mock
    const { uploadMock, downloadMock } = createContentAddressedUploadMock()
    vi.mocked(uploadData).mockImplementation(uploadMock)

    const target = createMockTarget()
    const createResult = await createActForContent(
      target,
      originalContentRef,
      publisher.privateKey,
      [grantee.publicKey],
    )

    vi.mocked(downloadDataWithChunkAPI).mockImplementation(downloadMock)

    // Publisher should be able to decrypt their own content
    const decryptedRef = await decryptActReference(
      bee,
      createResult.encryptedReference,
      createResult.historyReference,
      createResult.publisherPubKey,
      publisher.privateKey,
    )

    expect(decryptedRef).toBe(originalContentRefHex)
  })

  it("should throw error when reader is not authorized", async () => {
    const bee = {} as Bee
    const publisher = createTestKeyPair(60)
    const grantee = createTestKeyPair(61)
    const unauthorized = createTestKeyPair(62)

    const originalContentRef = randomBytes(32)

    // Use content-addressed storage mock
    const { uploadMock, downloadMock } = createContentAddressedUploadMock()
    vi.mocked(uploadData).mockImplementation(uploadMock)

    const target = createMockTarget()
    const createResult = await createActForContent(
      target,
      originalContentRef,
      publisher.privateKey,
      [grantee.publicKey],
    )

    vi.mocked(downloadDataWithChunkAPI).mockImplementation(downloadMock)

    // Unauthorized user should not be able to decrypt
    await expect(
      decryptActReference(
        bee,
        createResult.encryptedReference,
        createResult.historyReference,
        createResult.publisherPubKey,
        unauthorized.privateKey,
      ),
    ).rejects.toThrow("Access denied")
  })
})

describe("addGranteesToAct", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("should add new grantees to existing ACT", async () => {
    const publisher = createTestKeyPair(70)
    const grantee1 = createTestKeyPair(71)
    const grantee2 = createTestKeyPair(72) // New grantee to add

    const originalContentRef = randomBytes(32)

    // Use content-addressed storage mock
    const { storage, uploadMock, downloadMock } =
      createContentAddressedUploadMock()
    vi.mocked(uploadData).mockImplementation(uploadMock)

    const target = createMockTarget()
    const createResult = await createActForContent(
      target,
      originalContentRef,
      publisher.privateKey,
      [grantee1.publicKey],
    )

    // Verify original has 2 entries (publisher + grantee1)
    const originalActData = loadActDataFromStorage(
      storage,
      createResult.actReference,
    )
    const originalEntries = collectActEntriesFromJson(originalActData)
    expect(originalEntries.length).toBe(2)

    // Mock download to return the uploaded blobs
    vi.mocked(downloadDataWithChunkAPI).mockImplementation(downloadMock)

    // Add new grantee
    const result = await addGranteesToAct(
      target,
      mockBee,
      createResult.historyReference,
      publisher.privateKey,
      [grantee2.publicKey],
    )

    expect(result.actReference).toBeDefined()
    expect(result.historyReference).toBeDefined()
    expect(result.granteeListReference).toBeDefined()

    // The timestamp is the new entry's, the latest in the new history
    const head = await openActHistory(
      mockBee,
      result.historyReference,
      publisher.privateKey,
    )
    expect(result.timestamp).toBeGreaterThan(createResult.timestamp)
    expect(head.latestEntry.timestamp).toBe(result.timestamp)

    // Verify new ACT has 3 entries
    const newActData = loadActDataFromStorage(storage, result.actReference)
    const newEntries = collectActEntriesFromJson(newActData)
    expect(newEntries.length).toBe(3)

    // Verify grantee list has 2 grantees
    const newGranteeListBlob = storage.get(result.granteeListReference)!
    const grantees = decryptAndDeserializeGranteeList(
      newGranteeListBlob,
      publisher.privateKey,
      saltOf(await entryOf(storage, result)),
    )
    expect(grantees.length).toBe(2)

    // New grantee should be able to find their entry
    const grantee2Keys = deriveKeys(
      grantee2.privateKey,
      publisher.publicKey.x,
      publisher.publicKey.y,
    )
    const grantee2Entry = findActEntryByKey(newActData, grantee2Keys.lookupKey)
    expect(grantee2Entry).toBeDefined()
  })
})

describe("revokeGranteesFromAct", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("should revoke grantees and drop their entries", async () => {
    const publisher = createTestKeyPair(80)
    const grantee1 = createTestKeyPair(81)
    const grantee2 = createTestKeyPair(82) // Will be revoked

    const originalContentRef = randomBytes(32)

    // Use content-addressed storage mock
    const { storage, uploadMock, downloadMock } =
      createContentAddressedUploadMock()
    vi.mocked(uploadData).mockImplementation(uploadMock)

    const target = createMockTarget()
    const createResult = await createActForContent(
      target,
      originalContentRef,
      publisher.privateKey,
      [grantee1.publicKey, grantee2.publicKey],
    )

    // Verify original has 3 entries
    const originalActData = loadActDataFromStorage(
      storage,
      createResult.actReference,
    )
    const originalEntries = collectActEntriesFromJson(originalActData)
    expect(originalEntries.length).toBe(3)

    // Mock download to return the uploaded blobs
    vi.mocked(downloadDataWithChunkAPI).mockImplementation(downloadMock)

    // Revoke grantee2
    const result = await revokeGranteesFromAct(
      target,
      mockBee,
      createResult.historyReference,
      publisher.privateKey,
      [grantee2.publicKey],
    )

    expect(result.actReference).toBeDefined()
    expect(result.timestamp).toBeGreaterThan(createResult.timestamp)

    // New ACT should have 2 entries (publisher + grantee1)
    const newActData = loadActDataFromStorage(storage, result.actReference)
    const newEntries = collectActEntriesFromJson(newActData)
    expect(newEntries.length).toBe(2)

    // Verify grantee list has 1 grantee
    const newGranteeListBlob = storage.get(result.granteeListReference)!
    const grantees = decryptAndDeserializeGranteeList(
      newGranteeListBlob,
      publisher.privateKey,
      saltOf(await entryOf(storage, result)),
    )
    expect(grantees.length).toBe(1)

    // Grantee2 should NOT be able to find their entry in new ACT
    const grantee2Keys = deriveKeys(
      grantee2.privateKey,
      publisher.publicKey.x,
      publisher.publicKey.y,
    )
    const grantee2Entry = findActEntryByKey(newActData, grantee2Keys.lookupKey)
    expect(grantee2Entry).toBeUndefined()

    // Grantee1 should still be able to find their entry
    const grantee1Keys = deriveKeys(
      grantee1.privateKey,
      publisher.publicKey.x,
      publisher.publicKey.y,
    )
    const grantee1Entry = findActEntryByKey(newActData, grantee1Keys.lookupKey)
    expect(grantee1Entry).toBeDefined()
  })

  it("rotates the access key: the new ACT hands out a fresh one", async () => {
    const publisher = createTestKeyPair(84)
    const kept = createTestKeyPair(85)
    const revoked = createTestKeyPair(86)
    const { storage, uploadMock, downloadMock } =
      createContentAddressedUploadMock()
    vi.mocked(uploadData).mockImplementation(uploadMock)
    vi.mocked(downloadDataWithChunkAPI).mockImplementation(downloadMock)
    const target = createMockTarget()
    const created = await createActForContent(
      target,
      randomBytes(32),
      publisher.privateKey,
      [kept.publicKey, revoked.publicKey],
    )

    const result = await revokeGranteesFromAct(
      target,
      mockBee,
      created.historyReference,
      publisher.privateKey,
      [revoked.publicKey],
    )

    const oldKey = await accessKeyFromAct(
      storage,
      created,
      publisher.privateKey,
      publisher.publicKey,
    )
    const newKey = await accessKeyFromAct(
      storage,
      result,
      publisher.privateKey,
      publisher.publicKey,
    )
    expect(newKey).not.toEqual(oldKey)
    // The remaining grantee is handed the same new key as the publisher
    await expect(
      accessKeyFromAct(storage, result, kept.privateKey, publisher.publicKey),
    ).resolves.toEqual(newKey)
  })

  describe("a version continued after the revoke", () => {
    async function revokeThenContinue(seed: number) {
      const publisher = createTestKeyPair(seed)
      const kept = createTestKeyPair(seed + 1)
      const revoked = createTestKeyPair(seed + 2)
      const { storage, uploadMock, downloadMock } =
        createContentAddressedUploadMock()
      vi.mocked(uploadData).mockImplementation(uploadMock)
      vi.mocked(downloadDataWithChunkAPI).mockImplementation(downloadMock)
      const target = createMockTarget()
      const firstVersion = randomBytes(32)
      const created = await createActForContent(
        target,
        firstVersion,
        publisher.privateKey,
        [kept.publicKey, revoked.publicKey],
      )
      // What the revoked grantee legitimately learned while granted
      const oldKey = await accessKeyFromAct(
        storage,
        created,
        revoked.privateKey,
        publisher.publicKey,
      )
      const revocation = await revokeGranteesFromAct(
        target,
        mockBee,
        created.historyReference,
        publisher.privateKey,
        [revoked.publicKey],
      )
      const nextVersion = randomBytes(32)
      const continued = await continueHistory(
        revocation.historyReference,
        nextVersion,
        publisher.privateKey,
      )
      return {
        kept,
        revoked,
        firstVersion,
        created,
        oldKey,
        revocation,
        nextVersion,
        continued,
      }
    }

    it("is encrypted under the rotated key and read by a remaining grantee", async () => {
      const { kept, revocation, nextVersion, continued } =
        await revokeThenContinue(200)

      expect(continued.timestamp).toBe(revocation.timestamp)
      expect(continued.actReference).toBe(revocation.actReference)
      await expect(
        decryptActReference(
          mockBee,
          continued.encryptedReference,
          continued.historyReference,
          continued.publisherPubKey,
          kept.privateKey,
        ),
      ).resolves.toBe(toHex(nextVersion))
    })

    it("is out of a revoked grantee's reach, even with the access key they held", async () => {
      const { revoked, created, oldKey, nextVersion, continued } =
        await revokeThenContinue(210)

      await expect(
        decryptActReference(
          mockBee,
          continued.encryptedReference,
          continued.historyReference,
          continued.publisherPubKey,
          revoked.privateKey,
        ),
      ).rejects.toThrow("Access denied")
      // A timestamp from before the revoke opens the entry that still names
      // them, and its key does not open the new version
      await expect(
        decryptActReference(
          mockBee,
          continued.encryptedReference,
          continued.historyReference,
          continued.publisherPubKey,
          revoked.privateKey,
          created.timestamp,
        ),
      ).resolves.not.toBe(toHex(nextVersion))
      // Every earlier entry of the history still hands them the old key; it
      // does not open the new version.
      expect(
        counterModeDecrypt(fromHex(continued.encryptedReference), oldKey),
      ).not.toEqual(nextVersion)
    })

    it("leaves the version before the revoke readable at its own timestamp", async () => {
      const { kept, firstVersion, created, continued } =
        await revokeThenContinue(220)

      await expect(
        decryptActReference(
          mockBee,
          created.encryptedReference,
          continued.historyReference,
          created.publisherPubKey,
          kept.privateKey,
          created.timestamp,
        ),
      ).resolves.toBe(toHex(firstVersion))
      // Without it, the latest entry's key is used, and that one was rotated
      await expect(
        decryptActReference(
          mockBee,
          created.encryptedReference,
          continued.historyReference,
          created.publisherPubKey,
          kept.privateKey,
        ),
      ).resolves.not.toBe(toHex(firstVersion))
    })
  })

  // The versions' own entry predates the late grantees; the entries that added
  // them carry the same key and name them.
  it("lets grantees added after a version read it, after a revoke, at the version's own timestamp", async () => {
    const publisher = createTestKeyPair(230)
    const revoked = createTestKeyPair(231)
    const late = createTestKeyPair(232)
    const later = createTestKeyPair(233)
    const { uploadMock, downloadMock } = createContentAddressedUploadMock()
    vi.mocked(uploadData).mockImplementation(uploadMock)
    vi.mocked(downloadDataWithChunkAPI).mockImplementation(downloadMock)
    const target = createMockTarget()
    const firstVersion = randomBytes(32)
    const created = await createActForContent(
      target,
      firstVersion,
      publisher.privateKey,
      [revoked.publicKey],
    )
    const secondVersion = randomBytes(32)
    const continued = await continueHistory(
      created.historyReference,
      secondVersion,
      publisher.privateKey,
    )
    const added = await addGranteesToAct(
      target,
      mockBee,
      created.historyReference,
      publisher.privateKey,
      [late.publicKey],
    )
    const addedLater = await addGranteesToAct(
      target,
      mockBee,
      added.historyReference,
      publisher.privateKey,
      [later.publicKey],
    )
    const revocation = await revokeGranteesFromAct(
      target,
      mockBee,
      addedLater.historyReference,
      publisher.privateKey,
      [revoked.publicKey],
    )

    const read = (
      version: { encryptedReference: string; timestamp: number },
      reader: Uint8Array,
    ) =>
      decryptActReference(
        mockBee,
        version.encryptedReference,
        revocation.historyReference,
        created.publisherPubKey,
        reader,
        version.timestamp,
      )
    for (const reader of [late, later]) {
      await expect(read(created, reader.privateKey)).resolves.toBe(
        toHex(firstVersion),
      )
      await expect(read(continued, reader.privateKey)).resolves.toBe(
        toHex(secondVersion),
      )
    }
  })

  // The entry that adds them carries the rotated key; the version's own
  // entry, and every one up to the revoke, carries the key it was encrypted
  // under, and none of them names the late grantee.
  it("keeps a version from before a revoke out of a grantee added after it, at the version's own timestamp", async () => {
    const publisher = createTestKeyPair(240)
    const revoked = createTestKeyPair(241)
    const late = createTestKeyPair(242)
    const { uploadMock, downloadMock } = createContentAddressedUploadMock()
    vi.mocked(uploadData).mockImplementation(uploadMock)
    vi.mocked(downloadDataWithChunkAPI).mockImplementation(downloadMock)
    const target = createMockTarget()
    const created = await createActForContent(
      target,
      randomBytes(32),
      publisher.privateKey,
      [revoked.publicKey],
    )
    const revocation = await revokeGranteesFromAct(
      target,
      mockBee,
      created.historyReference,
      publisher.privateKey,
      [revoked.publicKey],
    )
    const added = await addGranteesToAct(
      target,
      mockBee,
      revocation.historyReference,
      publisher.privateKey,
      [late.publicKey],
    )

    await expect(
      decryptActReference(
        mockBee,
        created.encryptedReference,
        added.historyReference,
        created.publisherPubKey,
        late.privateKey,
        created.timestamp,
      ),
    ).rejects.toThrow("Access denied: no ACT entry found for this key")
  })

  it("never encrypts an existing content reference under the rotated key (#496)", async () => {
    // counterModeEncrypt is nonce-free CTR: one key, one keystream. A revoked
    // grantee knows every reference published before the revoke, so a
    // ciphertext of one of them under the new key would hand them its
    // keystream (KS = C_new XOR R), and with it every later version. The new
    // key may only ever encrypt references made after the revoke.
    const publisher = createTestKeyPair(90)
    const kept = createTestKeyPair(91)
    const revoked = createTestKeyPair(92)
    const contentRef = randomBytes(32)
    const { storage, uploadMock, downloadMock } =
      createContentAddressedUploadMock()
    vi.mocked(uploadData).mockImplementation(uploadMock)
    vi.mocked(downloadDataWithChunkAPI).mockImplementation(downloadMock)
    const target = createMockTarget()
    const created = await createActForContent(
      target,
      contentRef,
      publisher.privateKey,
      [kept.publicKey, revoked.publicKey],
    )
    const uploaded: Uint8Array[] = []
    vi.mocked(uploadData).mockImplementation(async (t, data, options) => {
      uploaded.push(data)
      return uploadMock(t, data, options)
    })

    const result = await revokeGranteesFromAct(
      target,
      mockBee,
      created.historyReference,
      publisher.privateKey,
      [revoked.publicKey],
    )

    expect(result).not.toHaveProperty("encryptedReference")
    const newKey = await accessKeyFromAct(
      storage,
      result,
      publisher.privateKey,
      publisher.publicKey,
    )
    const reEncrypted = counterModeEncrypt(contentRef, newKey)
    const reEncryptedHex = new TextEncoder().encode(toHex(reEncrypted))
    expect(uploaded.length).toBeGreaterThan(0)
    for (const blob of uploaded) {
      expect(containsBytes(blob, reEncrypted)).toBe(false)
      expect(containsBytes(blob, reEncryptedHex)).toBe(false)
    }
  })

  it("puts the new entry after the latest one, even one stamped ahead of this clock", async () => {
    // A device whose clock runs fast leaves an entry stamped in our future. A
    // revoke stamped by our clock would sort before it, and the latest entry
    // would still hand the revoked grantee the old key.
    const CLOCK_AHEAD_SECONDS = 3600
    const publisher = createTestKeyPair(94)
    const revoked = createTestKeyPair(95)
    const { storage, uploadMock, downloadMock } =
      createContentAddressedUploadMock()
    vi.mocked(uploadData).mockImplementation(uploadMock)
    vi.mocked(downloadDataWithChunkAPI).mockImplementation(downloadMock)
    const target = createMockTarget()
    const created = await createActForContent(
      target,
      randomBytes(32),
      publisher.privateKey,
      [revoked.publicKey],
    )
    const ahead = createHistoryManifest()
    addHistoryEntry(
      ahead,
      created.timestamp + CLOCK_AHEAD_SECONDS,
      created.actReference,
      created.granteeListReference,
      (await entryOf(storage, created)).metadata.accessKeySalt,
    )
    const { rootReference } = await saveHistoryTreeRecursively(ahead, (data) =>
      uploadData(target, data, { encryptionKey: true }),
    )

    const result = await revokeGranteesFromAct(
      target,
      mockBee,
      rootReference,
      publisher.privateKey,
      [revoked.publicKey],
    )

    expect(result.timestamp).toBeGreaterThan(
      created.timestamp + CLOCK_AHEAD_SECONDS,
    )
    const head = await openActHistory(
      mockBee,
      result.historyReference,
      publisher.privateKey,
    )
    expect(head.latestEntry.metadata.actReference).toBe(result.actReference)
  })
})

// An entry's lookup key and encryption key both follow from one ECDH, fixed
// per (publisher, grantee) pair, and counterModeEncrypt is nonce-free CTR. Two
// ACTs holding an entry for one pair would differ there by exactly their two
// access keys, so the key of a native history's entries is salted per access
// key (#408).
describe("a salt per access key in a native history (#408)", () => {
  const SALT_SIZE = 32

  beforeEach(() => {
    vi.clearAllMocks()
  })

  function setup() {
    const { storage, uploadMock, downloadMock } =
      createContentAddressedUploadMock()
    vi.mocked(uploadData).mockImplementation(uploadMock)
    vi.mocked(downloadDataWithChunkAPI).mockImplementation(downloadMock)
    return { storage, target: createMockTarget() }
  }

  /**
   * What a holder of `known`'s access key computes for `other`'s from each
   * lookup key the two ACTs share: the key they hold, XORed with both
   * entries.
   */
  function keysFromSharedEntries(
    storage: Map<string, Uint8Array>,
    known: { actReference: string },
    knownKey: Uint8Array,
    other: { actReference: string },
  ): Uint8Array[] {
    const otherEntries = collectActEntriesFromJson(
      loadActDataFromStorage(storage, other.actReference),
    )
    return collectActEntriesFromJson(
      loadActDataFromStorage(storage, known.actReference),
    ).flatMap((entry) => {
      const shared = findEntryByLookupKey(otherEntries, entry.lookupKey)
      return shared
        ? [xor(knownKey, entry.encryptedAccessKey, shared.encryptedAccessKey)]
        : []
    })
  }

  it("keeps a version continued after a revoke from the revoked grantee, who XORs the key they held with the entries both ACTs share", async () => {
    const { storage, target } = setup()
    const publisher = createTestKeyPair(250)
    const kept = createTestKeyPair(251)
    const revoked = createTestKeyPair(252)
    const firstVersion = randomBytes(32)
    const created = await createActForContent(
      target,
      firstVersion,
      publisher.privateKey,
      [kept.publicKey, revoked.publicKey],
    )
    // What the revoked grantee legitimately held
    const heldKey = await accessKeyFromAct(
      storage,
      created,
      revoked.privateKey,
      publisher.publicKey,
    )
    expect(
      counterModeDecrypt(fromHex(created.encryptedReference), heldKey),
    ).toEqual(firstVersion)
    const revocation = await revokeGranteesFromAct(
      target,
      mockBee,
      created.historyReference,
      publisher.privateKey,
      [revoked.publicKey],
    )
    const secret = randomBytes(32)
    const continued = await continueHistory(
      revocation.historyReference,
      secret,
      publisher.privateKey,
    )

    const candidates = keysFromSharedEntries(
      storage,
      created,
      heldKey,
      revocation,
    )

    // The publisher's own entry and the remaining grantee's
    expect(candidates).toHaveLength(2)
    for (const candidate of candidates) {
      expect(
        counterModeDecrypt(fromHex(continued.encryptedReference), candidate),
      ).not.toEqual(secret)
    }
  })

  it("keeps a history from a grantee of another history by the same publisher, who XORs the key they hold with the publisher's entry in both", async () => {
    const { storage, target } = setup()
    const publisher = createTestKeyPair(253)
    const granteeOfA = createTestKeyPair(254)
    const granteeOfB = createTestKeyPair(255)
    const historyA = await createActForContent(
      target,
      randomBytes(32),
      publisher.privateKey,
      [granteeOfA.publicKey],
    )
    const secretOfB = randomBytes(32)
    const historyB = await createActForContent(
      target,
      secretOfB,
      publisher.privateKey,
      [granteeOfB.publicKey],
    )
    const keyOfA = await accessKeyFromAct(
      storage,
      historyA,
      granteeOfA.privateKey,
      publisher.publicKey,
    )

    const candidates = keysFromSharedEntries(
      storage,
      historyA,
      keyOfA,
      historyB,
    )

    // The publisher's own entry
    expect(candidates).toHaveLength(1)
    for (const candidate of candidates) {
      expect(
        counterModeDecrypt(fromHex(historyB.encryptedReference), candidate),
      ).not.toEqual(secretOfB)
    }
  })

  it("draws a fresh salt for a native history's first entry and for each revoke, and keeps it on an add", async () => {
    const { storage, target } = setup()
    const publisher = createTestKeyPair(1)
    const grantee = createTestKeyPair(2)
    const late = createTestKeyPair(3)
    const created = await createActForContent(
      target,
      randomBytes(32),
      publisher.privateKey,
      [grantee.publicKey],
    )
    const another = await createActForContent(
      target,
      randomBytes(32),
      publisher.privateKey,
      [grantee.publicKey],
    )
    const added = await addGranteesToAct(
      target,
      mockBee,
      created.historyReference,
      publisher.privateKey,
      [late.publicKey],
    )
    const revocation = await revokeGranteesFromAct(
      target,
      mockBee,
      added.historyReference,
      publisher.privateKey,
      [grantee.publicKey],
    )

    const createdSalt = saltOf(await entryOf(storage, created))
    const anotherSalt = saltOf(await entryOf(storage, another))
    const addedSalt = saltOf(await entryOf(storage, added))
    const revocationSalt = saltOf(await entryOf(storage, revocation))

    expect(createdSalt).toHaveLength(SALT_SIZE)
    expect(anotherSalt).toHaveLength(SALT_SIZE)
    expect(anotherSalt).not.toEqual(createdSalt)
    expect(addedSalt).toEqual(createdSalt)
    expect(revocationSalt).toHaveLength(SALT_SIZE)
    expect(revocationSalt).not.toEqual(createdSalt)
    // The add copies every entry byte for byte, and its new one opens the
    // same key
    const addedEntries = collectActEntriesFromJson(
      loadActDataFromStorage(storage, added.actReference),
    )
    for (const entry of collectActEntriesFromJson(
      loadActDataFromStorage(storage, created.actReference),
    )) {
      expect(
        findEntryByLookupKey(addedEntries, entry.lookupKey)?.encryptedAccessKey,
      ).toEqual(entry.encryptedAccessKey)
    }
    await expect(
      accessKeyFromAct(storage, added, late.privateKey, publisher.publicKey),
    ).resolves.toEqual(
      await accessKeyFromAct(
        storage,
        created,
        grantee.privateKey,
        publisher.publicKey,
      ),
    )
  })

  it("writes no salt in a Bee-compatible history, whose entries are what Bee's unsalted construction gives", async () => {
    const { storage, target } = setup()
    const publisher = createTestKeyPair(4)
    const grantee = createTestKeyPair(5)
    const late = createTestKeyPair(6)
    const contentRef = randomBytes(32)
    const created = await createActForContent(
      target,
      contentRef,
      publisher.privateKey,
      [grantee.publicKey],
      { beeCompatible: true },
    )
    const added = await addGranteesToAct(
      target,
      mockBee,
      created.historyReference,
      publisher.privateKey,
      [late.publicKey],
    )
    const revocation = await revokeGranteesFromAct(
      target,
      mockBee,
      added.historyReference,
      publisher.privateKey,
      [grantee.publicKey],
    )

    const versions = [
      { version: created, grantees: [grantee] },
      { version: added, grantees: [grantee, late] },
      { version: revocation, grantees: [late] },
    ]
    for (const { version, grantees } of versions) {
      expect(
        (await entryOf(storage, version)).metadata.accessKeySalt,
      ).toBeUndefined()
      const actData = loadActDataFromStorage(storage, version.actReference)
      const self = deriveKeys(
        publisher.privateKey,
        publisher.publicKey.x,
        publisher.publicKey.y,
      )
      const accessKey = counterModeDecrypt(
        findActEntryByKey(actData, self.lookupKey)!,
        self.accessKeyDecryptionKey,
      )
      for (const { publicKey } of grantees) {
        const keys = deriveKeys(publisher.privateKey, publicKey.x, publicKey.y)
        expect(findActEntryByKey(actData, keys.lookupKey)).toEqual(
          counterModeEncrypt(accessKey, keys.accessKeyDecryptionKey),
        )
      }
    }
    // The unsalted key opens the version
    const self = deriveKeys(
      publisher.privateKey,
      publisher.publicKey.x,
      publisher.publicKey.y,
    )
    const createdKey = counterModeDecrypt(
      findActEntryByKey(
        loadActDataFromStorage(storage, created.actReference),
        self.lookupKey,
      )!,
      self.accessKeyDecryptionKey,
    )
    expect(
      counterModeDecrypt(fromHex(created.encryptedReference), createdKey),
    ).toEqual(contentRef)
  })

  // The grantee list's key is fixed per publisher but for the salt, and a
  // grantee knows their own position in a list.
  it("shares no keystream between a publisher's native grantee lists, across histories or across a revoke", async () => {
    const { storage, target } = setup()
    const publisher = createTestKeyPair(7)
    const first = createTestKeyPair(8)
    const second = createTestKeyPair(9)
    const historyA = await createActForContent(
      target,
      randomBytes(32),
      publisher.privateKey,
      [first.publicKey],
    )
    const historyB = await createActForContent(
      target,
      randomBytes(32),
      publisher.privateKey,
      [second.publicKey],
    )
    // `first` is listed first, ahead of `second`, until the revoke
    const shared = await createActForContent(
      target,
      randomBytes(32),
      publisher.privateKey,
      [first.publicKey, second.publicKey],
    )
    const revocation = await revokeGranteesFromAct(
      target,
      mockBee,
      shared.historyReference,
      publisher.privateKey,
      [first.publicKey],
    )
    const list = (version: { granteeListReference: string }) =>
      storage.get(version.granteeListReference)!
    const firstListed = serializeGranteeList([first.publicKey])
    const secondListed = serializeGranteeList([second.publicKey])

    // `first` XORs the entry they know out of the other list's first one
    expect(xor(list(historyA), firstListed, list(historyB))).not.toEqual(
      secondListed,
    )
    expect(xor(list(shared), firstListed, list(revocation))).not.toEqual(
      secondListed,
    )
  })
})

describe("getGranteesFromAct", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("should return list of grantees as compressed hex strings", async () => {
    const bee = {} as Bee
    const publisher = createTestKeyPair(90)
    const grantee1 = createTestKeyPair(91)
    const grantee2 = createTestKeyPair(92)

    // Use content-addressed storage mock
    const { uploadMock, downloadMock } = createContentAddressedUploadMock()
    vi.mocked(uploadData).mockImplementation(uploadMock)

    const target = createMockTarget()
    const createResult = await createActForContent(
      target,
      randomBytes(32),
      publisher.privateKey,
      [grantee1.publicKey, grantee2.publicKey],
    )

    // Mock download to return the uploaded blobs
    vi.mocked(downloadDataWithChunkAPI).mockImplementation(downloadMock)

    // Get grantees
    const grantees = await getGranteesFromAct(
      bee,
      createResult.historyReference,
      publisher.privateKey,
    )

    expect(grantees.length).toBe(2)
    expect(grantees).toContain(grantee1.compressedPublicKey)
    expect(grantees).toContain(grantee2.compressedPublicKey)
  })

  it("should return empty array for ACT with no grantees", async () => {
    const bee = {} as Bee
    const publisher = createTestKeyPair(100)

    // Use content-addressed storage mock
    const { uploadMock, downloadMock } = createContentAddressedUploadMock()
    vi.mocked(uploadData).mockImplementation(uploadMock)

    const target = createMockTarget()
    const createResult = await createActForContent(
      target,
      randomBytes(32),
      publisher.privateKey,
      [],
    )

    vi.mocked(downloadDataWithChunkAPI).mockImplementation(downloadMock)

    const grantees = await getGranteesFromAct(
      bee,
      createResult.historyReference,
      publisher.privateKey,
    )

    expect(grantees.length).toBe(0)
  })
})

describe("ACT end-to-end flow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("should support full upload/download/manage lifecycle", async () => {
    const bee = {} as Bee
    const target = createMockTarget()

    // Setup participants
    const publisher = createTestKeyPair(110)
    const alice = createTestKeyPair(111)
    const bob = createTestKeyPair(112)
    const charlie = createTestKeyPair(113) // Will be added later
    const eve = createTestKeyPair(114) // Unauthorized

    const secretData = new TextEncoder().encode("Top secret message!")

    // Use content-addressed storage mock
    const { uploadMock, downloadMock } = createContentAddressedUploadMock()
    vi.mocked(uploadData).mockImplementation(uploadMock)

    // Step 1: Publisher creates ACT with Alice and Bob
    const createResult = await createActForContent(
      target,
      secretData,
      publisher.privateKey,
      [alice.publicKey, bob.publicKey],
    )

    // Step 2: Verify Alice can decrypt
    vi.mocked(downloadDataWithChunkAPI).mockImplementation(downloadMock)

    const aliceDecrypted = await decryptActReference(
      bee,
      createResult.encryptedReference,
      createResult.historyReference,
      createResult.publisherPubKey,
      alice.privateKey,
    )
    expect(fromHex(aliceDecrypted).slice(0, secretData.length)).toEqual(
      secretData,
    )

    // Step 3: Verify Eve cannot decrypt
    await expect(
      decryptActReference(
        bee,
        createResult.encryptedReference,
        createResult.historyReference,
        createResult.publisherPubKey,
        eve.privateKey,
      ),
    ).rejects.toThrow("Access denied")

    // Step 4: Publisher adds Charlie
    const addResult = await addGranteesToAct(
      target,
      mockBee,
      createResult.historyReference,
      publisher.privateKey,
      [charlie.publicKey],
    )

    // Charlie should now be able to decrypt (using same encrypted ref)
    const charlieDecrypted = await decryptActReference(
      bee,
      createResult.encryptedReference,
      addResult.historyReference,
      createResult.publisherPubKey,
      charlie.privateKey,
    )
    expect(fromHex(charlieDecrypted).slice(0, secretData.length)).toEqual(
      secretData,
    )

    // Step 5: Publisher revokes Bob, then publishes a new version
    const revokeResult = await revokeGranteesFromAct(
      target,
      mockBee,
      addResult.historyReference,
      publisher.privateKey,
      [bob.publicKey],
    )
    const nextData = new TextEncoder().encode("Second secret message!")
    const nextVersion = await continueHistory(
      revokeResult.historyReference,
      nextData,
      publisher.privateKey,
    )

    // Bob should NOT be able to decrypt the new version
    await expect(
      decryptActReference(
        bee,
        nextVersion.encryptedReference,
        nextVersion.historyReference,
        createResult.publisherPubKey,
        bob.privateKey,
      ),
    ).rejects.toThrow("Access denied")

    // Alice and Charlie should be able to decrypt it
    for (const reader of [alice, charlie]) {
      const decrypted = await decryptActReference(
        bee,
        nextVersion.encryptedReference,
        nextVersion.historyReference,
        createResult.publisherPubKey,
        reader.privateKey,
      )
      expect(fromHex(decrypted).slice(0, nextData.length)).toEqual(nextData)
    }

    // Alice still reads the first version, at the timestamp it was published
    const aliceFirstVersion = await decryptActReference(
      bee,
      createResult.encryptedReference,
      revokeResult.historyReference,
      createResult.publisherPubKey,
      alice.privateKey,
      createResult.timestamp,
    )
    expect(fromHex(aliceFirstVersion).slice(0, secretData.length)).toEqual(
      secretData,
    )

    // Step 6: Verify grantee list
    const finalGrantees = await getGranteesFromAct(
      bee,
      revokeResult.historyReference,
      publisher.privateKey,
    )

    expect(finalGrantees.length).toBe(2)
    expect(finalGrantees).toContain(alice.compressedPublicKey)
    expect(finalGrantees).toContain(charlie.compressedPublicKey)
    expect(finalGrantees).not.toContain(bob.compressedPublicKey)
  })
})

describe("identity-level keys: a reader or publisher holding several keys", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // The proxy holds two keys per session — the origin-bound app key and the
  // account-wide sharing key — and does not know which one a share was made out
  // to. Every reader/publisher entry point therefore accepts candidates and
  // picks the one the ACT names (#519).
  function setup(seed: number) {
    const publisher = createTestKeyPair(seed)
    const appKey = createTestKeyPair(seed + 1)
    const sharingKey = createTestKeyPair(seed + 2)
    const { uploadMock, downloadMock } = createContentAddressedUploadMock()
    vi.mocked(uploadData).mockImplementation(uploadMock)
    vi.mocked(downloadDataWithChunkAPI).mockImplementation(downloadMock)
    return { publisher, appKey, sharingKey, target: createMockTarget() }
  }

  it("decrypts with whichever candidate is the grantee, and denies when none is", async () => {
    const { publisher, appKey, sharingKey, target } = setup(110)
    const contentRef = randomBytes(32)
    const created = await createActForContent(
      target,
      contentRef,
      publisher.privateKey,
      [sharingKey.publicKey],
    )

    await expect(
      decryptActReference(
        mockBee,
        created.encryptedReference,
        created.historyReference,
        created.publisherPubKey,
        [appKey.privateKey, sharingKey.privateKey],
      ),
    ).resolves.toBe(toHex(contentRef))

    await expect(
      decryptActReference(
        mockBee,
        created.encryptedReference,
        created.historyReference,
        created.publisherPubKey,
        [appKey.privateKey],
      ),
    ).rejects.toThrow("Access denied")
  })

  it("adds, lists and revokes grantees with whichever candidate published the ACT", async () => {
    const { publisher, appKey, sharingKey, target } = setup(120)
    const newGrantee = createTestKeyPair(123)
    const created = await createActForContent(
      target,
      randomBytes(32),
      sharingKey.privateKey,
      [publisher.publicKey],
    )
    const candidates = [appKey.privateKey, sharingKey.privateKey]

    const added = await addGranteesToAct(
      target,
      mockBee,
      created.historyReference,
      candidates,
      [newGrantee.publicKey],
    )
    await expect(
      getGranteesFromAct(mockBee, added.historyReference, candidates),
    ).resolves.toEqual([
      publisher.compressedPublicKey,
      newGrantee.compressedPublicKey,
    ])

    const revoked = await revokeGranteesFromAct(
      target,
      mockBee,
      added.historyReference,
      candidates,
      [publisher.publicKey],
    )
    await expect(
      getGranteesFromAct(mockBee, revoked.historyReference, candidates),
    ).resolves.toEqual([newGrantee.compressedPublicKey])
  })

  // #885: the user may switch the sharing key off for an app. It is still
  // tried, so a share made out to it fails with the denial — a permission
  // problem — rather than with "not a grantee", which the app key alone would
  // say. A share made out to the app key is untouched.
  it("fails with a denied candidate's error exactly when the ACT names it", async () => {
    const { publisher, appKey, sharingKey, target } = setup(140)
    const denied = new Error("sharing switched off")
    const candidates = [
      appKey.privateKey,
      { privateKey: sharingKey.privateKey, denied },
    ]
    const toSharing = await createActForContent(
      target,
      randomBytes(32),
      publisher.privateKey,
      [sharingKey.publicKey],
    )
    const contentRef = randomBytes(32)
    const toApp = await createActForContent(
      target,
      contentRef,
      publisher.privateKey,
      [appKey.publicKey],
    )

    await expect(
      decryptActReference(
        mockBee,
        toSharing.encryptedReference,
        toSharing.historyReference,
        toSharing.publisherPubKey,
        candidates,
      ),
    ).rejects.toBe(denied)
    await expect(
      decryptActReference(
        mockBee,
        toApp.encryptedReference,
        toApp.historyReference,
        toApp.publisherPubKey,
        candidates,
      ),
    ).resolves.toBe(toHex(contentRef))

    const bySharing = await createActForContent(
      target,
      randomBytes(32),
      sharingKey.privateKey,
      [publisher.publicKey],
    )
    await expect(
      getGranteesFromAct(mockBee, bySharing.historyReference, candidates),
    ).rejects.toBe(denied)
    await expect(
      addGranteesToAct(
        target,
        mockBee,
        bySharing.historyReference,
        candidates,
        [appKey.publicKey],
      ),
    ).rejects.toBe(denied)
    await expect(
      openActHistory(mockBee, bySharing.historyReference, candidates),
    ).rejects.toBe(denied)
  })

  // The version's own entry names only the denied sharing key; the app key is
  // added later under the same access key.
  it("reads through an allowed candidate a later entry names under the same key, past a denied one the version's own entry names", async () => {
    const { publisher, appKey, sharingKey, target } = setup(150)
    const denied = new Error("sharing switched off")
    const candidates = [
      appKey.privateKey,
      { privateKey: sharingKey.privateKey, denied },
    ]
    const contentRef = randomBytes(32)
    const created = await createActForContent(
      target,
      contentRef,
      publisher.privateKey,
      [sharingKey.publicKey],
    )
    const added = await addGranteesToAct(
      target,
      mockBee,
      created.historyReference,
      publisher.privateKey,
      [appKey.publicKey],
    )

    for (const timestamp of [undefined, created.timestamp]) {
      await expect(
        decryptActReference(
          mockBee,
          created.encryptedReference,
          added.historyReference,
          created.publisherPubKey,
          candidates,
          timestamp,
        ),
      ).resolves.toBe(toHex(contentRef))
    }
  })

  it("refuses to manage an ACT none of the candidates published", async () => {
    const { publisher, appKey, sharingKey, target } = setup(130)
    const created = await createActForContent(
      target,
      randomBytes(32),
      sharingKey.privateKey,
      [publisher.publicKey],
    )

    await expect(
      getGranteesFromAct(mockBee, created.historyReference, [
        appKey.privateKey,
      ]),
    ).rejects.toThrow("Cannot find publisher entry")
    await expect(
      addGranteesToAct(
        target,
        mockBee,
        created.historyReference,
        [appKey.privateKey],
        [appKey.publicKey],
      ),
    ).rejects.toThrow("Cannot find publisher entry")
  })
})
