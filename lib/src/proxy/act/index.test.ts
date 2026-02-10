/**
 * Unit tests for high-level ACT operations (Bee-compatible API)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Bee, Stamper } from "@ethersphere/bee-js"
import { MerkleTree } from "@ethersphere/bee-js"
import type { UploadContext } from "../types"
import {
  createActForContent,
  decryptActReference,
  addGranteesToAct,
  revokeGranteesFromAct,
  getGranteesFromAct,
  parseCompressedPublicKey,
} from "./index"
import {
  publicKeyFromPrivate,
  compressPublicKey,
  deriveKeys,
  counterModeDecrypt,
} from "./crypto"
import { collectActEntriesFromJson, findActEntryByKey } from "./act"
import { decryptAndDeserializeGranteeList } from "./grantee-list"

// Mock the upload/download functions
vi.mock("../upload-encrypted-data", () => ({
  uploadEncryptedDataWithSigning: vi.fn(),
}))

vi.mock("../download-data", () => ({
  downloadDataWithChunkAPI: vi.fn(),
}))

import { uploadEncryptedDataWithSigning } from "../upload-encrypted-data"
import { downloadDataWithChunkAPI } from "../download-data"

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

// Create mock context
function createMockContext(): UploadContext {
  return {
    bee: {} as Bee,
    stamper: {} as Stamper,
  }
}

// Create a valid 32-byte hex reference for mocking
function createMockReference(counter: number): string {
  // Create a 32-byte array with the counter as the last byte
  const bytes = new Uint8Array(32)
  bytes[31] = counter
  return toHex(bytes)
}

// Compute content hash using Swarm's BMT algorithm (same as MantarayNode)
async function computeContentHash(data: Uint8Array): Promise<string> {
  const rootNode = await MerkleTree.root(data)
  return toHex(rootNode.hash())
}

// Create a content-addressed storage mock for uploads
function createContentAddressedUploadMock() {
  const storage: Map<string, Uint8Array> = new Map()

  const uploadMock = async (
    _ctx: UploadContext,
    data: Uint8Array,
  ): Promise<{
    reference: string
    tagUid?: number
    chunkAddresses: Uint8Array[]
  }> => {
    const address = await computeContentHash(data)
    // Fake 64-byte encrypted reference: address + address
    const ref = `${address}${address}`
    storage.set(ref, data)
    return { reference: ref, chunkAddresses: [] }
  }

  const downloadMock = async (_bee: Bee, ref: string): Promise<Uint8Array> => {
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
    const context = createMockContext()
    const publisher = createTestKeyPair(10)
    const grantee1 = createTestKeyPair(11)
    const grantee2 = createTestKeyPair(12)

    const contentRef = randomBytes(64)

    // Use content-addressed storage mock
    const { storage, uploadMock } = createContentAddressedUploadMock()
    vi.mocked(uploadEncryptedDataWithSigning).mockImplementation(uploadMock)

    const result = await createActForContent(
      context,
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
    )
    expect(grantees.length).toBe(2)
  })

  it("should create ACT that publisher can decrypt", async () => {
    const context = createMockContext()
    const publisher = createTestKeyPair(20)
    const grantee = createTestKeyPair(21)

    const contentRef = randomBytes(32)

    // Use content-addressed storage mock
    const { storage, uploadMock } = createContentAddressedUploadMock()
    vi.mocked(uploadEncryptedDataWithSigning).mockImplementation(uploadMock)

    const result = await createActForContent(
      context,
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

    // Decrypt access key
    const accessKey = counterModeDecrypt(
      encryptedAccessKey!,
      publisherKeys.accessKeyDecryptionKey,
    )

    // Decrypt the encrypted reference
    const encryptedRefBytes = fromHex(result.encryptedReference)
    const decryptedRef = counterModeDecrypt(encryptedRefBytes, accessKey)

    // First 32 bytes should match original content ref
    expect(decryptedRef.slice(0, 32)).toEqual(contentRef)
  })

  it("should create ACT that grantee can decrypt", async () => {
    const context = createMockContext()
    const publisher = createTestKeyPair(30)
    const grantee = createTestKeyPair(31)

    const contentRef = randomBytes(32)

    // Use content-addressed storage mock
    const { storage, uploadMock } = createContentAddressedUploadMock()
    vi.mocked(uploadEncryptedDataWithSigning).mockImplementation(uploadMock)

    const result = await createActForContent(
      context,
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

    // Decrypt access key
    const accessKey = counterModeDecrypt(
      encryptedAccessKey!,
      granteeKeys.accessKeyDecryptionKey,
    )

    // Decrypt the encrypted reference
    const encryptedRefBytes = fromHex(result.encryptedReference)
    const decryptedRef = counterModeDecrypt(encryptedRefBytes, accessKey)

    // First 32 bytes should match original content ref
    expect(decryptedRef.slice(0, 32)).toEqual(contentRef)
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
    vi.mocked(uploadEncryptedDataWithSigning).mockImplementation(uploadMock)

    const context = createMockContext()
    const createResult = await createActForContent(
      context,
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
    vi.mocked(uploadEncryptedDataWithSigning).mockImplementation(uploadMock)

    const context = createMockContext()
    const createResult = await createActForContent(
      context,
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
    vi.mocked(uploadEncryptedDataWithSigning).mockImplementation(uploadMock)

    const context = createMockContext()
    const createResult = await createActForContent(
      context,
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
    vi.mocked(uploadEncryptedDataWithSigning).mockImplementation(uploadMock)

    const context = createMockContext()
    const createResult = await createActForContent(
      context,
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
      context,
      createResult.historyReference,
      publisher.privateKey,
      [grantee2.publicKey],
    )

    expect(result.actReference).toBeDefined()
    expect(result.historyReference).toBeDefined()
    expect(result.granteeListReference).toBeDefined()

    // Verify new ACT has 3 entries
    const newActData = loadActDataFromStorage(storage, result.actReference)
    const newEntries = collectActEntriesFromJson(newActData)
    expect(newEntries.length).toBe(3)

    // Verify grantee list has 2 grantees
    const newGranteeListBlob = storage.get(result.granteeListReference)!
    const grantees = decryptAndDeserializeGranteeList(
      newGranteeListBlob,
      publisher.privateKey,
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

  it("should revoke grantees and rotate keys", async () => {
    const publisher = createTestKeyPair(80)
    const grantee1 = createTestKeyPair(81)
    const grantee2 = createTestKeyPair(82) // Will be revoked

    const originalContentRef = randomBytes(32)

    // Use content-addressed storage mock
    const { storage, uploadMock, downloadMock } =
      createContentAddressedUploadMock()
    vi.mocked(uploadEncryptedDataWithSigning).mockImplementation(uploadMock)

    const context = createMockContext()
    const createResult = await createActForContent(
      context,
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
      context,
      createResult.historyReference,
      createResult.encryptedReference,
      publisher.privateKey,
      [grantee2.publicKey],
    )

    // Should have new encrypted reference (key rotation)
    expect(result.encryptedReference).not.toBe(createResult.encryptedReference)
    expect(result.actReference).toBeDefined()

    // New ACT should have 2 entries (publisher + grantee1)
    const newActData = loadActDataFromStorage(storage, result.actReference)
    const newEntries = collectActEntriesFromJson(newActData)
    expect(newEntries.length).toBe(2)

    // Verify grantee list has 1 grantee
    const newGranteeListBlob = storage.get(result.granteeListReference)!
    const grantees = decryptAndDeserializeGranteeList(
      newGranteeListBlob,
      publisher.privateKey,
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
    vi.mocked(uploadEncryptedDataWithSigning).mockImplementation(uploadMock)

    const context = createMockContext()
    const createResult = await createActForContent(
      context,
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
    vi.mocked(uploadEncryptedDataWithSigning).mockImplementation(uploadMock)

    const context = createMockContext()
    const createResult = await createActForContent(
      context,
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
    const context = createMockContext()

    // Setup participants
    const publisher = createTestKeyPair(110)
    const alice = createTestKeyPair(111)
    const bob = createTestKeyPair(112)
    const charlie = createTestKeyPair(113) // Will be added later
    const eve = createTestKeyPair(114) // Unauthorized

    const secretData = new TextEncoder().encode("Top secret message!")

    // Use content-addressed storage mock
    const { uploadMock, downloadMock } = createContentAddressedUploadMock()
    vi.mocked(uploadEncryptedDataWithSigning).mockImplementation(uploadMock)

    // Step 1: Publisher creates ACT with Alice and Bob
    const createResult = await createActForContent(
      context,
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
      context,
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

    // Step 5: Publisher revokes Bob
    const revokeResult = await revokeGranteesFromAct(
      context,
      addResult.historyReference,
      createResult.encryptedReference,
      publisher.privateKey,
      [bob.publicKey],
    )

    // Bob should NOT be able to decrypt the new ACT
    await expect(
      decryptActReference(
        bee,
        revokeResult.encryptedReference,
        revokeResult.historyReference,
        createResult.publisherPubKey,
        bob.privateKey,
      ),
    ).rejects.toThrow("Access denied")

    // Alice and Charlie should still be able to decrypt
    const aliceStillDecrypted = await decryptActReference(
      bee,
      revokeResult.encryptedReference,
      revokeResult.historyReference,
      createResult.publisherPubKey,
      alice.privateKey,
    )
    expect(fromHex(aliceStillDecrypted).slice(0, secretData.length)).toEqual(
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
