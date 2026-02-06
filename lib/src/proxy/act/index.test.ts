/**
 * Unit tests for high-level ACT operations (Bee-compatible API)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Bee, Stamper } from "@ethersphere/bee-js"
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
import { deserializeAct, findEntryByLookupKey } from "./act"
import { decryptAndDeserializeGranteeList } from "./grantee-list"
import { deserializeHistory, getLatestEntry } from "./history"

// Mock the upload/download functions
vi.mock("../upload-data", () => ({
  uploadDataWithSigning: vi.fn(),
}))

vi.mock("../download-data", () => ({
  downloadDataWithChunkAPI: vi.fn(),
}))

import { uploadDataWithSigning } from "../upload-data"
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

    // Track all uploaded blobs (ACT, grantee list, history)
    const uploadedBlobs: Uint8Array[] = []
    vi.mocked(uploadDataWithSigning).mockImplementation(
      async (_ctx, data: Uint8Array) => {
        uploadedBlobs.push(data)
        return { reference: toHex(randomBytes(32)), tagUid: 123 }
      },
    )

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

    // 3 uploads: ACT manifest, grantee list, history manifest
    expect(uploadDataWithSigning).toHaveBeenCalledTimes(3)
    expect(uploadedBlobs.length).toBe(3)

    // First blob is ACT manifest
    const actEntries = deserializeAct(uploadedBlobs[0])
    expect(actEntries.length).toBe(3) // publisher + 2 grantees

    // Second blob is encrypted grantee list
    const grantees = decryptAndDeserializeGranteeList(
      uploadedBlobs[1],
      publisher.privateKey,
    )
    expect(grantees.length).toBe(2)

    // Third blob is history manifest
    const history = deserializeHistory(uploadedBlobs[2])
    const latestEntry = getLatestEntry(history)
    expect(latestEntry).toBeDefined()
  })

  it("should create ACT that publisher can decrypt", async () => {
    const context = createMockContext()
    const publisher = createTestKeyPair(20)
    const grantee = createTestKeyPair(21)

    const contentRef = randomBytes(32)

    const uploadedBlobs: Uint8Array[] = []
    vi.mocked(uploadDataWithSigning).mockImplementation(
      async (_ctx, data: Uint8Array) => {
        uploadedBlobs.push(data)
        return { reference: toHex(randomBytes(32)) }
      },
    )

    const result = await createActForContent(
      context,
      contentRef,
      publisher.privateKey,
      [grantee.publicKey],
    )

    // Publisher should be able to decrypt
    const actEntries = deserializeAct(uploadedBlobs[0])

    // Derive publisher's lookup key (publisher uses their own pub key)
    const publisherKeys = deriveKeys(
      publisher.privateKey,
      publisher.publicKey.x,
      publisher.publicKey.y,
    )

    // Find publisher's entry
    const publisherEntry = findEntryByLookupKey(
      actEntries,
      publisherKeys.lookupKey,
    )
    expect(publisherEntry).toBeDefined()

    // Decrypt access key
    const accessKey = counterModeDecrypt(
      publisherEntry!.encryptedAccessKey,
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

    const uploadedBlobs: Uint8Array[] = []
    vi.mocked(uploadDataWithSigning).mockImplementation(
      async (_ctx, data: Uint8Array) => {
        uploadedBlobs.push(data)
        return { reference: toHex(randomBytes(32)) }
      },
    )

    const result = await createActForContent(
      context,
      contentRef,
      publisher.privateKey,
      [grantee.publicKey],
    )

    // Grantee should be able to decrypt
    const actEntries = deserializeAct(uploadedBlobs[0])

    // Grantee derives keys using publisher's public key
    const granteeKeys = deriveKeys(
      grantee.privateKey,
      publisher.publicKey.x,
      publisher.publicKey.y,
    )

    // Find grantee's entry
    const granteeEntry = findEntryByLookupKey(actEntries, granteeKeys.lookupKey)
    expect(granteeEntry).toBeDefined()

    // Decrypt access key
    const accessKey = counterModeDecrypt(
      granteeEntry!.encryptedAccessKey,
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

    // First create an ACT
    const uploadedBlobs: Map<string, Uint8Array> = new Map()
    let uploadCounter = 0

    vi.mocked(uploadDataWithSigning).mockImplementation(
      async (_ctx, data: Uint8Array) => {
        const ref = `ref_${++uploadCounter}`
        uploadedBlobs.set(ref, data)
        return { reference: ref }
      },
    )

    const context = createMockContext()
    const createResult = await createActForContent(
      context,
      originalContentRef,
      publisher.privateKey,
      [grantee.publicKey],
    )

    // Mock download to return the appropriate blobs
    vi.mocked(downloadDataWithChunkAPI).mockImplementation(
      async (_bee, ref) => {
        return uploadedBlobs.get(ref)!
      },
    )

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

    const uploadedBlobs: Map<string, Uint8Array> = new Map()
    let uploadCounter = 0

    vi.mocked(uploadDataWithSigning).mockImplementation(
      async (_ctx, data: Uint8Array) => {
        const ref = `ref_${++uploadCounter}`
        uploadedBlobs.set(ref, data)
        return { reference: ref }
      },
    )

    const context = createMockContext()
    const createResult = await createActForContent(
      context,
      originalContentRef,
      publisher.privateKey,
      [grantee.publicKey],
    )

    vi.mocked(downloadDataWithChunkAPI).mockImplementation(
      async (_bee, ref) => {
        return uploadedBlobs.get(ref)!
      },
    )

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

    const uploadedBlobs: Map<string, Uint8Array> = new Map()
    let uploadCounter = 0

    vi.mocked(uploadDataWithSigning).mockImplementation(
      async (_ctx, data: Uint8Array) => {
        const ref = `ref_${++uploadCounter}`
        uploadedBlobs.set(ref, data)
        return { reference: ref }
      },
    )

    const context = createMockContext()
    const createResult = await createActForContent(
      context,
      originalContentRef,
      publisher.privateKey,
      [grantee.publicKey],
    )

    vi.mocked(downloadDataWithChunkAPI).mockImplementation(
      async (_bee, ref) => {
        return uploadedBlobs.get(ref)!
      },
    )

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

    // Track all uploaded blobs
    const uploadedBlobs: Map<string, Uint8Array> = new Map()
    let uploadCounter = 0

    vi.mocked(uploadDataWithSigning).mockImplementation(
      async (_ctx, data: Uint8Array) => {
        const ref = `ref_${++uploadCounter}`
        uploadedBlobs.set(ref, data)
        return { reference: ref }
      },
    )

    const context = createMockContext()
    const createResult = await createActForContent(
      context,
      originalContentRef,
      publisher.privateKey,
      [grantee1.publicKey],
    )

    // Verify original has 2 entries (publisher + grantee1)
    const originalActBlob = uploadedBlobs.get(createResult.actReference)!
    const originalEntries = deserializeAct(originalActBlob)
    expect(originalEntries.length).toBe(2)

    // Mock download to return the uploaded blobs
    vi.mocked(downloadDataWithChunkAPI).mockImplementation(
      async (_bee, ref) => {
        return uploadedBlobs.get(ref)!
      },
    )

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
    const newActBlob = uploadedBlobs.get(result.actReference)!
    const newEntries = deserializeAct(newActBlob)
    expect(newEntries.length).toBe(3)

    // Verify grantee list has 2 grantees
    const newGranteeListBlob = uploadedBlobs.get(result.granteeListReference)!
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
    const grantee2Entry = findEntryByLookupKey(
      newEntries,
      grantee2Keys.lookupKey,
    )
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

    // Track all uploaded blobs
    const uploadedBlobs: Map<string, Uint8Array> = new Map()
    let uploadCounter = 0

    vi.mocked(uploadDataWithSigning).mockImplementation(
      async (_ctx, data: Uint8Array) => {
        const ref = `ref_${++uploadCounter}`
        uploadedBlobs.set(ref, data)
        return { reference: ref }
      },
    )

    const context = createMockContext()
    const createResult = await createActForContent(
      context,
      originalContentRef,
      publisher.privateKey,
      [grantee1.publicKey, grantee2.publicKey],
    )

    // Verify original has 3 entries
    const originalActBlob = uploadedBlobs.get(createResult.actReference)!
    const originalEntries = deserializeAct(originalActBlob)
    expect(originalEntries.length).toBe(3)

    // Mock download to return the uploaded blobs
    vi.mocked(downloadDataWithChunkAPI).mockImplementation(
      async (_bee, ref) => {
        return uploadedBlobs.get(ref)!
      },
    )

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
    const newActBlob = uploadedBlobs.get(result.actReference)!
    const newEntries = deserializeAct(newActBlob)
    expect(newEntries.length).toBe(2)

    // Verify grantee list has 1 grantee
    const newGranteeListBlob = uploadedBlobs.get(result.granteeListReference)!
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
    const grantee2Entry = findEntryByLookupKey(
      newEntries,
      grantee2Keys.lookupKey,
    )
    expect(grantee2Entry).toBeUndefined()

    // Grantee1 should still be able to find their entry
    const grantee1Keys = deriveKeys(
      grantee1.privateKey,
      publisher.publicKey.x,
      publisher.publicKey.y,
    )
    const grantee1Entry = findEntryByLookupKey(
      newEntries,
      grantee1Keys.lookupKey,
    )
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

    // Track all uploaded blobs
    const uploadedBlobs: Map<string, Uint8Array> = new Map()
    let uploadCounter = 0

    vi.mocked(uploadDataWithSigning).mockImplementation(
      async (_ctx, data: Uint8Array) => {
        const ref = `ref_${++uploadCounter}`
        uploadedBlobs.set(ref, data)
        return { reference: ref }
      },
    )

    const context = createMockContext()
    const createResult = await createActForContent(
      context,
      randomBytes(32),
      publisher.privateKey,
      [grantee1.publicKey, grantee2.publicKey],
    )

    // Mock download to return the uploaded blobs
    vi.mocked(downloadDataWithChunkAPI).mockImplementation(
      async (_bee, ref) => {
        return uploadedBlobs.get(ref)!
      },
    )

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

    // Track all uploaded blobs
    const uploadedBlobs: Map<string, Uint8Array> = new Map()
    let uploadCounter = 0

    vi.mocked(uploadDataWithSigning).mockImplementation(
      async (_ctx, data: Uint8Array) => {
        const ref = `ref_${++uploadCounter}`
        uploadedBlobs.set(ref, data)
        return { reference: ref }
      },
    )

    const context = createMockContext()
    const createResult = await createActForContent(
      context,
      randomBytes(32),
      publisher.privateKey,
      [],
    )

    vi.mocked(downloadDataWithChunkAPI).mockImplementation(
      async (_bee, ref) => {
        return uploadedBlobs.get(ref)!
      },
    )

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

    // Track uploaded blobs
    const uploadedBlobs: Map<string, Uint8Array> = new Map()
    let uploadCounter = 0

    vi.mocked(uploadDataWithSigning).mockImplementation(
      async (_ctx, data: Uint8Array) => {
        const ref = `ref_${++uploadCounter}`
        uploadedBlobs.set(ref, data)
        return { reference: ref }
      },
    )

    // Step 1: Publisher creates ACT with Alice and Bob
    const createResult = await createActForContent(
      context,
      secretData,
      publisher.privateKey,
      [alice.publicKey, bob.publicKey],
    )

    // Step 2: Verify Alice can decrypt
    vi.mocked(downloadDataWithChunkAPI).mockImplementation(
      async (_bee, ref) => {
        return uploadedBlobs.get(ref)!
      },
    )

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
