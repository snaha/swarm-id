/**
 * Bee Compatibility Test Vectors
 *
 * These tests verify our ACT cryptographic implementation produces identical
 * outputs to Bee's implementation using test vectors extracted from Bee's codebase.
 *
 * Test vectors from:
 * - bee/pkg/accesscontrol/access_test.go (private keys, lookup keys)
 * - bee/pkg/crypto/dh_test.go (ECDH shared secret)
 */

import { describe, it, expect } from "vitest"
import {
  publicKeyFromPrivate,
  ecdhSharedSecret,
  deriveKeys,
  publicKeyFromCompressed,
  compressPublicKey,
  counterModeEncrypt,
  counterModeDecrypt,
  generateRandomKey,
} from "./crypto"
import { findEntryByLookupKey, type ActEntry } from "./act"

// =============================================================================
// Test Vectors from Bee
// =============================================================================

// Fixed private keys from bee/pkg/accesscontrol/access_test.go
const BEE_PRIVATE_KEYS = {
  KEY_0: "a786dd84b61485de12146fd9c4c02d87e8fd95f0542765cb7fc3d2e428c0bcfa",
  KEY_1: "b786dd84b61485de12146fd9c4c02d87e8fd95f0542765cb7fc3d2e428c0bcfb",
  KEY_2: "c786dd84b61485de12146fd9c4c02d87e8fd95f0542765cb7fc3d2e428c0bcfc",
}

// Expected lookup keys when Key 1 is the publisher (from setupAccessLogic())
// See bee/pkg/accesscontrol/access_test.go TestAddNewGranteeToContent
const BEE_EXPECTED_LOOKUP_KEYS = {
  // ECDH(Key1_priv, Key0_pub) - adding Key 0 as grantee
  KEY1_WITH_KEY0_PUB:
    "b6ee086390c280eeb9824c331a4427596f0c8510d5564bc1b6168d0059a46e2b",
  // ECDH(Key1_priv, Key1_pub) - publisher self-lookup
  KEY1_SELF: "a13678e81f9d939b9401a3ad7e548d2ceb81c50f8c76424296e83a1ad79c0df0",
  // ECDH(Key1_priv, Key2_pub) - adding Key 2 as grantee
  KEY1_WITH_KEY2_PUB:
    "d5e9a6499ca74f5b8b958a4b89b7338045b2baa9420e115443a8050e26986564",
}

// ECDH test vector from bee/pkg/crypto/dh_test.go
const BEE_ECDH_TEST = {
  PRIVATE_KEY:
    "c786dd84b61485de12146fd9c4c02d87e8fd95f0542765cb7fc3d2e428c0bcfa",
  PUBLIC_KEY_COMPRESSED:
    "0271e574ad8f6a6c998c84c27df18124fddd906aba9d852150da4223edde14044f",
  SALT: "cb7e692f211f8ae4f858ff56ce8a4fc0e40bae1a36f8283f0ceb6bb4be133f1e",
  EXPECTED_SHARED_KEY:
    "9edbd3beeb48c090158ccb82d679c5ea2bcb74850d34fe55c10b32e16b822007",
}

// Test reference from Bee tests (used for encrypt/decrypt verification)
const BEE_TEST_REFERENCE =
  "39a5ea87b141fe44aa609c3327ecd896c0e2122897f5f4bbacf74db1033c5559"

// Values from actual Bee debug logs for CTR verification
const BEE_CTR_DEBUG = {
  ENCRYPTED_REF:
    "daae5cf4b3978362e7975548de9139ee6cfd5b4422179b23a55eded1b975ea52",
  ACCESS_KEY:
    "f264f1e4a6c0104a295bc650b80dc38635eb56ba047b6c9b41bd7241cf4bbf99",
  DECRYPTED_REF:
    "ffe4a41dcc711ab78148a37c92599c116a75e2ee02a16cd651eee9a077e7af5b",
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex
  const bytes = new Uint8Array(cleanHex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/**
 * Convert Uint8Array to hex string
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

// =============================================================================
// Tests
// =============================================================================

describe("Bee Compatibility Tests", () => {
  describe("Public Key Generation from Private Key", () => {
    it("should generate consistent public key for Key 0", () => {
      const privKey = hexToBytes(BEE_PRIVATE_KEYS.KEY_0)
      const pubKey = publicKeyFromPrivate(privKey)

      // Verify the public key is 32 bytes each for x and y
      expect(pubKey.x.length).toBe(32)
      expect(pubKey.y.length).toBe(32)

      // Verify roundtrip through compression
      const compressed = compressPublicKey(pubKey.x, pubKey.y)
      const decompressed = publicKeyFromCompressed(compressed)
      expect(decompressed.x).toEqual(pubKey.x)
      expect(decompressed.y).toEqual(pubKey.y)
    })

    it("should generate different public keys for each private key", () => {
      const privKey0 = hexToBytes(BEE_PRIVATE_KEYS.KEY_0)
      const privKey1 = hexToBytes(BEE_PRIVATE_KEYS.KEY_1)
      const privKey2 = hexToBytes(BEE_PRIVATE_KEYS.KEY_2)

      const pubKey0 = publicKeyFromPrivate(privKey0)
      const pubKey1 = publicKeyFromPrivate(privKey1)
      const pubKey2 = publicKeyFromPrivate(privKey2)

      expect(bytesToHex(pubKey0.x)).not.toBe(bytesToHex(pubKey1.x))
      expect(bytesToHex(pubKey1.x)).not.toBe(bytesToHex(pubKey2.x))
      expect(bytesToHex(pubKey0.x)).not.toBe(bytesToHex(pubKey2.x))
    })
  })

  describe("ECDH Shared Secret", () => {
    it("should compute shared secret with correct length from Bee ECDH test vector keys", () => {
      const privKey = hexToBytes(BEE_ECDH_TEST.PRIVATE_KEY)
      const compressedPubKey = hexToBytes(BEE_ECDH_TEST.PUBLIC_KEY_COMPRESSED)

      // Decompress the public key
      const pubKey = publicKeyFromCompressed(compressedPubKey)

      // Compute ECDH shared secret (x-coordinate only)
      const sharedSecret = ecdhSharedSecret(privKey, pubKey.x, pubKey.y)

      expect(sharedSecret.length).toBe(32)
    })

    it("should correctly decompress and use Bee ECDH test public key", () => {
      // Verify the public key from ECDH test can be decompressed and used
      const compressedPubKey = hexToBytes(BEE_ECDH_TEST.PUBLIC_KEY_COMPRESSED)
      const pubKey = publicKeyFromCompressed(compressedPubKey)

      // Verify coordinates are valid 32-byte values
      expect(pubKey.x.length).toBe(32)
      expect(pubKey.y.length).toBe(32)

      // Verify the x-coordinate matches what's in the compressed key (bytes 1-32)
      expect(bytesToHex(pubKey.x)).toBe(
        BEE_ECDH_TEST.PUBLIC_KEY_COMPRESSED.slice(2),
      )

      // Verify re-compression produces original
      const recompressed = compressPublicKey(pubKey.x, pubKey.y)
      expect(bytesToHex(recompressed)).toBe(BEE_ECDH_TEST.PUBLIC_KEY_COMPRESSED)
    })

    it("should produce symmetric ECDH results between two parties", () => {
      const privKey0 = hexToBytes(BEE_PRIVATE_KEYS.KEY_0)
      const privKey1 = hexToBytes(BEE_PRIVATE_KEYS.KEY_1)

      const pubKey0 = publicKeyFromPrivate(privKey0)
      const pubKey1 = publicKeyFromPrivate(privKey1)

      // Key0 computes shared secret with Key1's public
      const shared01 = ecdhSharedSecret(privKey0, pubKey1.x, pubKey1.y)

      // Key1 computes shared secret with Key0's public
      const shared10 = ecdhSharedSecret(privKey1, pubKey0.x, pubKey0.y)

      // Both should be equal (ECDH symmetry)
      expect(bytesToHex(shared01)).toBe(bytesToHex(shared10))
    })
  })

  describe("Key Derivation - Lookup Keys", () => {
    it("should derive correct lookup key for Publisher (Key 1) with Key 0 public", () => {
      // Bee's setupAccessLogic() uses Key 1 as publisher
      const privKey1 = hexToBytes(BEE_PRIVATE_KEYS.KEY_1)
      const privKey0 = hexToBytes(BEE_PRIVATE_KEYS.KEY_0)
      const pubKey0 = publicKeyFromPrivate(privKey0)

      const { lookupKey } = deriveKeys(privKey1, pubKey0.x, pubKey0.y)

      expect(bytesToHex(lookupKey)).toBe(
        BEE_EXPECTED_LOOKUP_KEYS.KEY1_WITH_KEY0_PUB,
      )
    })

    it("should derive correct lookup key for Publisher (Key 1) self-lookup", () => {
      const privKey1 = hexToBytes(BEE_PRIVATE_KEYS.KEY_1)
      const pubKey1 = publicKeyFromPrivate(privKey1)

      const { lookupKey } = deriveKeys(privKey1, pubKey1.x, pubKey1.y)

      expect(bytesToHex(lookupKey)).toBe(BEE_EXPECTED_LOOKUP_KEYS.KEY1_SELF)
    })

    it("should derive correct lookup key for Publisher (Key 1) with Key 2 public", () => {
      const privKey1 = hexToBytes(BEE_PRIVATE_KEYS.KEY_1)
      const privKey2 = hexToBytes(BEE_PRIVATE_KEYS.KEY_2)
      const pubKey2 = publicKeyFromPrivate(privKey2)

      const { lookupKey } = deriveKeys(privKey1, pubKey2.x, pubKey2.y)

      expect(bytesToHex(lookupKey)).toBe(
        BEE_EXPECTED_LOOKUP_KEYS.KEY1_WITH_KEY2_PUB,
      )
    })
  })

  describe("Symmetric ECDH Property", () => {
    it("should produce same lookup key from both directions (Key0 <-> Key1)", () => {
      const privKey0 = hexToBytes(BEE_PRIVATE_KEYS.KEY_0)
      const privKey1 = hexToBytes(BEE_PRIVATE_KEYS.KEY_1)

      const pubKey0 = publicKeyFromPrivate(privKey0)
      const pubKey1 = publicKeyFromPrivate(privKey1)

      // Key 1 derives lookup key with Key 0's public key
      const keys10 = deriveKeys(privKey1, pubKey0.x, pubKey0.y)

      // Key 0 derives lookup key with Key 1's public key
      const keys01 = deriveKeys(privKey0, pubKey1.x, pubKey1.y)

      // Both should produce the same lookup key (ECDH symmetry)
      expect(bytesToHex(keys10.lookupKey)).toBe(
        BEE_EXPECTED_LOOKUP_KEYS.KEY1_WITH_KEY0_PUB,
      )
      expect(bytesToHex(keys01.lookupKey)).toBe(
        BEE_EXPECTED_LOOKUP_KEYS.KEY1_WITH_KEY0_PUB,
      )
      expect(bytesToHex(keys10.lookupKey)).toBe(bytesToHex(keys01.lookupKey))

      // Access key decryption keys should also match
      expect(bytesToHex(keys10.accessKeyDecryptionKey)).toBe(
        bytesToHex(keys01.accessKeyDecryptionKey),
      )
    })

    it("should produce same lookup key from both directions (Key1 <-> Key2)", () => {
      const privKey1 = hexToBytes(BEE_PRIVATE_KEYS.KEY_1)
      const privKey2 = hexToBytes(BEE_PRIVATE_KEYS.KEY_2)

      const pubKey1 = publicKeyFromPrivate(privKey1)
      const pubKey2 = publicKeyFromPrivate(privKey2)

      // Key 1 derives lookup key with Key 2's public key
      const keys12 = deriveKeys(privKey1, pubKey2.x, pubKey2.y)

      // Key 2 derives lookup key with Key 1's public key
      const keys21 = deriveKeys(privKey2, pubKey1.x, pubKey1.y)

      // Both should produce the same lookup key (ECDH symmetry)
      expect(bytesToHex(keys12.lookupKey)).toBe(
        BEE_EXPECTED_LOOKUP_KEYS.KEY1_WITH_KEY2_PUB,
      )
      expect(bytesToHex(keys21.lookupKey)).toBe(
        BEE_EXPECTED_LOOKUP_KEYS.KEY1_WITH_KEY2_PUB,
      )
    })

    it("should produce same lookup key from both directions (Key0 <-> Key2)", () => {
      const privKey0 = hexToBytes(BEE_PRIVATE_KEYS.KEY_0)
      const privKey2 = hexToBytes(BEE_PRIVATE_KEYS.KEY_2)

      const pubKey0 = publicKeyFromPrivate(privKey0)
      const pubKey2 = publicKeyFromPrivate(privKey2)

      // Key0 derives lookup key with Key2's public key
      const keys02 = deriveKeys(privKey0, pubKey2.x, pubKey2.y)

      // Key2 derives lookup key with Key0's public key
      const keys20 = deriveKeys(privKey2, pubKey0.x, pubKey0.y)

      // Both should produce the same lookup key (ECDH symmetry)
      expect(bytesToHex(keys02.lookupKey)).toBe(bytesToHex(keys20.lookupKey))
      expect(bytesToHex(keys02.accessKeyDecryptionKey)).toBe(
        bytesToHex(keys20.accessKeyDecryptionKey),
      )
    })
  })

  describe("Public Key Compression/Decompression", () => {
    it("should correctly decompress Bee ECDH test public key", () => {
      const compressedPubKey = hexToBytes(BEE_ECDH_TEST.PUBLIC_KEY_COMPRESSED)

      // Decompress
      const decompressed = publicKeyFromCompressed(compressedPubKey)

      // Verify x and y are 32 bytes each
      expect(decompressed.x.length).toBe(32)
      expect(decompressed.y.length).toBe(32)

      // Re-compress and verify it matches original
      const recompressed = compressPublicKey(decompressed.x, decompressed.y)
      expect(bytesToHex(recompressed)).toBe(
        bytesToHex(hexToBytes(BEE_ECDH_TEST.PUBLIC_KEY_COMPRESSED)),
      )
    })

    it("should roundtrip compress/decompress for all Bee test keys", () => {
      const privateKeys = [
        BEE_PRIVATE_KEYS.KEY_0,
        BEE_PRIVATE_KEYS.KEY_1,
        BEE_PRIVATE_KEYS.KEY_2,
      ]

      for (const privKeyHex of privateKeys) {
        const privKey = hexToBytes(privKeyHex)
        const pubKey = publicKeyFromPrivate(privKey)

        // Compress
        const compressed = compressPublicKey(pubKey.x, pubKey.y)
        expect(compressed.length).toBe(33)
        expect([0x02, 0x03]).toContain(compressed[0])

        // Decompress
        const decompressed = publicKeyFromCompressed(compressed)

        // Verify roundtrip
        expect(bytesToHex(decompressed.x)).toBe(bytesToHex(pubKey.x))
        expect(bytesToHex(decompressed.y)).toBe(bytesToHex(pubKey.y))
      }
    })

    it("should handle both even and odd y coordinates", () => {
      const privateKeys = [
        BEE_PRIVATE_KEYS.KEY_0,
        BEE_PRIVATE_KEYS.KEY_1,
        BEE_PRIVATE_KEYS.KEY_2,
      ]

      const prefixes: number[] = []

      for (const privKeyHex of privateKeys) {
        const privKey = hexToBytes(privKeyHex)
        const pubKey = publicKeyFromPrivate(privKey)
        const compressed = compressPublicKey(pubKey.x, pubKey.y)
        prefixes.push(compressed[0])
      }

      // Verify we have valid prefixes (0x02 or 0x03)
      for (const prefix of prefixes) {
        expect([0x02, 0x03]).toContain(prefix)
      }
    })
  })

  describe("Key Derivation Algorithm Verification", () => {
    it("should use correct nonces for lookup key (0x00) and akd key (0x01)", () => {
      const privKey1 = hexToBytes(BEE_PRIVATE_KEYS.KEY_1)
      const pubKey1 = publicKeyFromPrivate(privKey1)

      const { lookupKey, accessKeyDecryptionKey } = deriveKeys(
        privKey1,
        pubKey1.x,
        pubKey1.y,
      )

      // lookupKey and accessKeyDecryptionKey should be different
      // (same input but different nonces: 0x00 vs 0x01)
      expect(bytesToHex(lookupKey)).not.toBe(bytesToHex(accessKeyDecryptionKey))

      // Verify the lookup key matches Bee's expected value for Key1 self-lookup
      expect(bytesToHex(lookupKey)).toBe(BEE_EXPECTED_LOOKUP_KEYS.KEY1_SELF)
    })

    it("should produce 32-byte keys", () => {
      const privKey0 = hexToBytes(BEE_PRIVATE_KEYS.KEY_0)
      const pubKey0 = publicKeyFromPrivate(privKey0)

      const { lookupKey, accessKeyDecryptionKey } = deriveKeys(
        privKey0,
        pubKey0.x,
        pubKey0.y,
      )

      expect(lookupKey.length).toBe(32)
      expect(accessKeyDecryptionKey.length).toBe(32)
    })
  })

  describe("Reference Encryption/Decryption - Publisher (TestDecryptRef_Publisher equivalent)", () => {
    it("should allow publisher to encrypt and decrypt their own reference", () => {
      // Setup: Key 1 is the publisher
      const publisherPrivKey = hexToBytes(BEE_PRIVATE_KEYS.KEY_1)
      const publisherPubKey = publicKeyFromPrivate(publisherPrivKey)

      // Test reference to encrypt
      const testReference = hexToBytes(BEE_TEST_REFERENCE)

      // Step 1: Generate a random access key
      const accessKey = generateRandomKey()
      expect(accessKey.length).toBe(32)

      // Step 2: Encrypt the reference with the access key
      const encryptedReference = counterModeEncrypt(testReference, accessKey)
      expect(encryptedReference.length).toBe(testReference.length)
      expect(bytesToHex(encryptedReference)).not.toBe(bytesToHex(testReference))

      // Step 3: Create ACT entry for publisher (self-lookup)
      // Publisher derives keys with their own public key
      const { lookupKey, accessKeyDecryptionKey } = deriveKeys(
        publisherPrivKey,
        publisherPubKey.x,
        publisherPubKey.y,
      )

      // Verify lookup key matches expected value for Key1 self-lookup
      expect(bytesToHex(lookupKey)).toBe(BEE_EXPECTED_LOOKUP_KEYS.KEY1_SELF)

      // Encrypt the access key with the accessKeyDecryptionKey
      const encryptedAccessKey = counterModeEncrypt(
        accessKey,
        accessKeyDecryptionKey,
      )

      // Create ACT with single entry for publisher
      const actEntries: ActEntry[] = [
        {
          lookupKey,
          encryptedAccessKey,
        },
      ]

      // Step 4: Publisher looks up their entry in ACT (using array directly)
      const {
        lookupKey: derivedLookupKey,
        accessKeyDecryptionKey: derivedAkdKey,
      } = deriveKeys(publisherPrivKey, publisherPubKey.x, publisherPubKey.y)

      const entry = findEntryByLookupKey(actEntries, derivedLookupKey)
      expect(entry).toBeDefined()

      // Step 5: Publisher decrypts the access key
      const decryptedAccessKey = counterModeDecrypt(
        entry!.encryptedAccessKey,
        derivedAkdKey,
      )
      expect(bytesToHex(decryptedAccessKey)).toBe(bytesToHex(accessKey))

      // Step 6: Publisher decrypts the reference
      const decryptedReference = counterModeDecrypt(
        encryptedReference,
        decryptedAccessKey,
      )
      expect(bytesToHex(decryptedReference)).toBe(BEE_TEST_REFERENCE)
    })

    it("should produce consistent encryption across multiple operations", () => {
      const testReference = hexToBytes(BEE_TEST_REFERENCE)

      // Use a fixed access key for deterministic testing
      const fixedAccessKey = hexToBytes(
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      )

      // Encrypt twice with same key should produce same result
      const encrypted1 = counterModeEncrypt(testReference, fixedAccessKey)
      const encrypted2 = counterModeEncrypt(testReference, fixedAccessKey)
      expect(bytesToHex(encrypted1)).toBe(bytesToHex(encrypted2))

      // Decrypt should return original
      const decrypted = counterModeDecrypt(encrypted1, fixedAccessKey)
      expect(bytesToHex(decrypted)).toBe(BEE_TEST_REFERENCE)

      // Counter mode is symmetric
      const reencrypted = counterModeEncrypt(decrypted, fixedAccessKey)
      expect(bytesToHex(reencrypted)).toBe(bytesToHex(encrypted1))
    })
  })

  describe("Reference Encryption/Decryption - Grantee (TestDecryptRefWithGrantee_Success equivalent)", () => {
    it("should allow grantee to decrypt reference shared by publisher", () => {
      // Setup: Key 1 is the publisher, Key 2 is the grantee
      const publisherPrivKey = hexToBytes(BEE_PRIVATE_KEYS.KEY_1)
      const publisherPubKey = publicKeyFromPrivate(publisherPrivKey)

      const granteePrivKey = hexToBytes(BEE_PRIVATE_KEYS.KEY_2)
      const granteePubKey = publicKeyFromPrivate(granteePrivKey)

      // Test reference to encrypt
      const testReference = hexToBytes(BEE_TEST_REFERENCE)

      // Step 1: Publisher generates a random access key
      const accessKey = generateRandomKey()

      // Step 2: Publisher encrypts the reference with the access key
      const encryptedReference = counterModeEncrypt(testReference, accessKey)

      // Step 3: Publisher creates ACT entries for themselves AND the grantee

      // Entry for publisher (self-lookup)
      const publisherKeys = deriveKeys(
        publisherPrivKey,
        publisherPubKey.x,
        publisherPubKey.y,
      )
      const encryptedAccessKeyForPublisher = counterModeEncrypt(
        accessKey,
        publisherKeys.accessKeyDecryptionKey,
      )

      // Entry for grantee (publisher derives with grantee's public key)
      const granteeEntryKeys = deriveKeys(
        publisherPrivKey,
        granteePubKey.x,
        granteePubKey.y,
      )
      const encryptedAccessKeyForGrantee = counterModeEncrypt(
        accessKey,
        granteeEntryKeys.accessKeyDecryptionKey,
      )

      // Verify lookup keys match expected values
      expect(bytesToHex(publisherKeys.lookupKey)).toBe(
        BEE_EXPECTED_LOOKUP_KEYS.KEY1_SELF,
      )
      expect(bytesToHex(granteeEntryKeys.lookupKey)).toBe(
        BEE_EXPECTED_LOOKUP_KEYS.KEY1_WITH_KEY2_PUB,
      )

      // Create ACT with both entries
      const actEntries: ActEntry[] = [
        {
          lookupKey: publisherKeys.lookupKey,
          encryptedAccessKey: encryptedAccessKeyForPublisher,
        },
        {
          lookupKey: granteeEntryKeys.lookupKey,
          encryptedAccessKey: encryptedAccessKeyForGrantee,
        },
      ]

      // Step 4: Grantee derives keys using their private key + publisher's public key
      const granteeDerivation = deriveKeys(
        granteePrivKey,
        publisherPubKey.x,
        publisherPubKey.y,
      )

      // Due to ECDH symmetry, grantee's derivation should produce same lookup key
      expect(bytesToHex(granteeDerivation.lookupKey)).toBe(
        BEE_EXPECTED_LOOKUP_KEYS.KEY1_WITH_KEY2_PUB,
      )

      // Step 5: Grantee looks up their entry in ACT
      const granteeEntry = findEntryByLookupKey(
        actEntries,
        granteeDerivation.lookupKey,
      )
      expect(granteeEntry).toBeDefined()

      // Step 6: Grantee decrypts the access key
      const decryptedAccessKey = counterModeDecrypt(
        granteeEntry!.encryptedAccessKey,
        granteeDerivation.accessKeyDecryptionKey,
      )
      expect(bytesToHex(decryptedAccessKey)).toBe(bytesToHex(accessKey))

      // Step 7: Grantee decrypts the reference
      const decryptedReference = counterModeDecrypt(
        encryptedReference,
        decryptedAccessKey,
      )
      expect(bytesToHex(decryptedReference)).toBe(BEE_TEST_REFERENCE)
    })

    it("should not allow non-grantee to decrypt reference", () => {
      // Setup: Key 1 is the publisher, Key 2 is the grantee, Key 0 is NOT a grantee
      const publisherPrivKey = hexToBytes(BEE_PRIVATE_KEYS.KEY_1)
      const publisherPubKey = publicKeyFromPrivate(publisherPrivKey)

      const granteePrivKey = hexToBytes(BEE_PRIVATE_KEYS.KEY_2)
      const granteePubKey = publicKeyFromPrivate(granteePrivKey)

      const nonGranteePrivKey = hexToBytes(BEE_PRIVATE_KEYS.KEY_0)

      // Test reference
      const testReference = hexToBytes(BEE_TEST_REFERENCE)

      // Publisher creates ACT only for themselves and Key 2 (not Key 0)
      const accessKey = generateRandomKey()

      // Create entries for publisher and grantee only
      const publisherKeys = deriveKeys(
        publisherPrivKey,
        publisherPubKey.x,
        publisherPubKey.y,
      )
      const granteeEntryKeys = deriveKeys(
        publisherPrivKey,
        granteePubKey.x,
        granteePubKey.y,
      )

      const actEntries: ActEntry[] = [
        {
          lookupKey: publisherKeys.lookupKey,
          encryptedAccessKey: counterModeEncrypt(
            accessKey,
            publisherKeys.accessKeyDecryptionKey,
          ),
        },
        {
          lookupKey: granteeEntryKeys.lookupKey,
          encryptedAccessKey: counterModeEncrypt(
            accessKey,
            granteeEntryKeys.accessKeyDecryptionKey,
          ),
        },
      ]

      // Non-grantee (Key 0) tries to derive keys with publisher's public key
      const nonGranteeDerivation = deriveKeys(
        nonGranteePrivKey,
        publisherPubKey.x,
        publisherPubKey.y,
      )

      // Non-grantee's lookup key should NOT match any entry in the ACT
      const nonGranteeEntry = findEntryByLookupKey(
        actEntries,
        nonGranteeDerivation.lookupKey,
      )

      // Entry should not be found (Key 0 was not added as a grantee)
      expect(nonGranteeEntry).toBeUndefined()
    })

    it("should allow multiple grantees to independently decrypt", () => {
      // Setup: Key 1 is the publisher, Key 0 and Key 2 are grantees
      const publisherPrivKey = hexToBytes(BEE_PRIVATE_KEYS.KEY_1)
      const publisherPubKey = publicKeyFromPrivate(publisherPrivKey)

      const grantee0PrivKey = hexToBytes(BEE_PRIVATE_KEYS.KEY_0)
      const grantee0PubKey = publicKeyFromPrivate(grantee0PrivKey)

      const grantee2PrivKey = hexToBytes(BEE_PRIVATE_KEYS.KEY_2)
      const grantee2PubKey = publicKeyFromPrivate(grantee2PrivKey)

      // Test reference
      const testReference = hexToBytes(BEE_TEST_REFERENCE)

      // Publisher creates ACT for themselves and both grantees
      const accessKey = generateRandomKey()
      const encryptedReference = counterModeEncrypt(testReference, accessKey)

      // Derive keys for all parties
      const publisherKeys = deriveKeys(
        publisherPrivKey,
        publisherPubKey.x,
        publisherPubKey.y,
      )
      const grantee0EntryKeys = deriveKeys(
        publisherPrivKey,
        grantee0PubKey.x,
        grantee0PubKey.y,
      )
      const grantee2EntryKeys = deriveKeys(
        publisherPrivKey,
        grantee2PubKey.x,
        grantee2PubKey.y,
      )

      // Verify lookup keys match expected values
      expect(bytesToHex(publisherKeys.lookupKey)).toBe(
        BEE_EXPECTED_LOOKUP_KEYS.KEY1_SELF,
      )
      expect(bytesToHex(grantee0EntryKeys.lookupKey)).toBe(
        BEE_EXPECTED_LOOKUP_KEYS.KEY1_WITH_KEY0_PUB,
      )
      expect(bytesToHex(grantee2EntryKeys.lookupKey)).toBe(
        BEE_EXPECTED_LOOKUP_KEYS.KEY1_WITH_KEY2_PUB,
      )

      // Create ACT with all entries
      const actEntries: ActEntry[] = [
        {
          lookupKey: publisherKeys.lookupKey,
          encryptedAccessKey: counterModeEncrypt(
            accessKey,
            publisherKeys.accessKeyDecryptionKey,
          ),
        },
        {
          lookupKey: grantee0EntryKeys.lookupKey,
          encryptedAccessKey: counterModeEncrypt(
            accessKey,
            grantee0EntryKeys.accessKeyDecryptionKey,
          ),
        },
        {
          lookupKey: grantee2EntryKeys.lookupKey,
          encryptedAccessKey: counterModeEncrypt(
            accessKey,
            grantee2EntryKeys.accessKeyDecryptionKey,
          ),
        },
      ]

      expect(actEntries.length).toBe(3)

      // Grantee 0 decrypts
      const grantee0Derivation = deriveKeys(
        grantee0PrivKey,
        publisherPubKey.x,
        publisherPubKey.y,
      )
      const grantee0Entry = findEntryByLookupKey(
        actEntries,
        grantee0Derivation.lookupKey,
      )
      expect(grantee0Entry).toBeDefined()

      const decryptedAccessKey0 = counterModeDecrypt(
        grantee0Entry!.encryptedAccessKey,
        grantee0Derivation.accessKeyDecryptionKey,
      )
      const decryptedRef0 = counterModeDecrypt(
        encryptedReference,
        decryptedAccessKey0,
      )
      expect(bytesToHex(decryptedRef0)).toBe(BEE_TEST_REFERENCE)

      // Grantee 2 decrypts
      const grantee2Derivation = deriveKeys(
        grantee2PrivKey,
        publisherPubKey.x,
        publisherPubKey.y,
      )
      const grantee2Entry = findEntryByLookupKey(
        actEntries,
        grantee2Derivation.lookupKey,
      )
      expect(grantee2Entry).toBeDefined()

      const decryptedAccessKey2 = counterModeDecrypt(
        grantee2Entry!.encryptedAccessKey,
        grantee2Derivation.accessKeyDecryptionKey,
      )
      const decryptedRef2 = counterModeDecrypt(
        encryptedReference,
        decryptedAccessKey2,
      )
      expect(bytesToHex(decryptedRef2)).toBe(BEE_TEST_REFERENCE)
    })
  })

  describe("ACT Entry Creation - TestAddPublisher equivalent", () => {
    // Equivalent to bee/pkg/accesscontrol/access_test.go:137-161 (TestAddPublisher)
    // This test verifies that adding a publisher entry to the ACT produces
    // the correct lookup key and encrypted access key structure.

    it("should create publisher ACT entry with correct lookup key", () => {
      // Key 1 is the access logic owner (from setupAccessLogic in Bee)
      // Adding Key 0 as a grantee
      const publisherPrivKey = hexToBytes(BEE_PRIVATE_KEYS.KEY_1)
      const granteePrivKey = hexToBytes(BEE_PRIVATE_KEYS.KEY_0)
      const granteePubKey = publicKeyFromPrivate(granteePrivKey)

      // Generate a random access key (simulating what Bee does)
      const accessKey = generateRandomKey()

      // Publisher derives keys for the grantee
      const { lookupKey, accessKeyDecryptionKey } = deriveKeys(
        publisherPrivKey,
        granteePubKey.x,
        granteePubKey.y,
      )

      // Verify lookup key matches expected value from Bee's test
      expect(bytesToHex(lookupKey)).toBe(
        BEE_EXPECTED_LOOKUP_KEYS.KEY1_WITH_KEY0_PUB,
      )

      // Encrypt the access key
      const encryptedAccessKey = counterModeEncrypt(
        accessKey,
        accessKeyDecryptionKey,
      )

      // Verify encrypted access key has correct length (32 bytes)
      const ENCRYPTED_ACCESS_KEY_LENGTH = 32
      expect(encryptedAccessKey.length).toBe(ENCRYPTED_ACCESS_KEY_LENGTH)

      // Verify the ACT entry can be created
      const actEntry: ActEntry = {
        lookupKey,
        encryptedAccessKey,
      }

      // Verify entry can be found by lookup key
      const found = findEntryByLookupKey([actEntry], lookupKey)
      expect(found).toBeDefined()
      expect(bytesToHex(found!.lookupKey)).toBe(
        BEE_EXPECTED_LOOKUP_KEYS.KEY1_WITH_KEY0_PUB,
      )
      expect(found!.encryptedAccessKey.length).toBe(ENCRYPTED_ACCESS_KEY_LENGTH)
    })
  })

  describe("ACT Entry Creation - TestAddNewGranteeToContent equivalent", () => {
    // Equivalent to bee/pkg/accesscontrol/access_test.go:163-214 (TestAddNewGranteeToContent)
    // This test verifies that adding multiple grantees to the same ACT produces
    // correct lookup keys for each grantee.

    it("should add multiple grantees with correct lookup keys", () => {
      // Key 1 is the access logic owner (from setupAccessLogic in Bee)
      const publisherPrivKey = hexToBytes(BEE_PRIVATE_KEYS.KEY_1)
      const publisherPubKey = publicKeyFromPrivate(publisherPrivKey)

      const grantee0PrivKey = hexToBytes(BEE_PRIVATE_KEYS.KEY_0)
      const grantee0PubKey = publicKeyFromPrivate(grantee0PrivKey)

      const grantee2PrivKey = hexToBytes(BEE_PRIVATE_KEYS.KEY_2)
      const grantee2PubKey = publicKeyFromPrivate(grantee2PrivKey)

      // Generate a random access key (same key used for all grantees)
      const accessKey = generateRandomKey()
      const actEntries: ActEntry[] = []

      // Add Key 0 as grantee (first addition)
      const keys0 = deriveKeys(
        publisherPrivKey,
        grantee0PubKey.x,
        grantee0PubKey.y,
      )
      expect(bytesToHex(keys0.lookupKey)).toBe(
        BEE_EXPECTED_LOOKUP_KEYS.KEY1_WITH_KEY0_PUB,
      )
      actEntries.push({
        lookupKey: keys0.lookupKey,
        encryptedAccessKey: counterModeEncrypt(
          accessKey,
          keys0.accessKeyDecryptionKey,
        ),
      })

      // Add Key 1 (self) as grantee (second addition)
      const keys1 = deriveKeys(
        publisherPrivKey,
        publisherPubKey.x,
        publisherPubKey.y,
      )
      expect(bytesToHex(keys1.lookupKey)).toBe(
        BEE_EXPECTED_LOOKUP_KEYS.KEY1_SELF,
      )
      actEntries.push({
        lookupKey: keys1.lookupKey,
        encryptedAccessKey: counterModeEncrypt(
          accessKey,
          keys1.accessKeyDecryptionKey,
        ),
      })

      // Add Key 2 as grantee (third addition)
      const keys2 = deriveKeys(
        publisherPrivKey,
        grantee2PubKey.x,
        grantee2PubKey.y,
      )
      expect(bytesToHex(keys2.lookupKey)).toBe(
        BEE_EXPECTED_LOOKUP_KEYS.KEY1_WITH_KEY2_PUB,
      )
      actEntries.push({
        lookupKey: keys2.lookupKey,
        encryptedAccessKey: counterModeEncrypt(
          accessKey,
          keys2.accessKeyDecryptionKey,
        ),
      })

      // Verify all 3 entries are created
      expect(actEntries.length).toBe(3)

      // Verify all encrypted access keys have correct length (32 bytes)
      const ENCRYPTED_ACCESS_KEY_LENGTH = 32
      for (const entry of actEntries) {
        expect(entry.encryptedAccessKey.length).toBe(
          ENCRYPTED_ACCESS_KEY_LENGTH,
        )
      }

      // Verify all 3 lookup keys are unique
      const lookupKeySet = new Set(
        actEntries.map((e) => bytesToHex(e.lookupKey)),
      )
      expect(lookupKeySet.size).toBe(3)

      // Verify each lookup key can be found in entries
      const entry0 = findEntryByLookupKey(actEntries, keys0.lookupKey)
      const entry1 = findEntryByLookupKey(actEntries, keys1.lookupKey)
      const entry2 = findEntryByLookupKey(actEntries, keys2.lookupKey)

      expect(entry0).toBeDefined()
      expect(entry1).toBeDefined()
      expect(entry2).toBeDefined()

      // Verify each grantee can decrypt the access key and it matches
      const decrypted0 = counterModeDecrypt(
        entry0!.encryptedAccessKey,
        keys0.accessKeyDecryptionKey,
      )
      const decrypted1 = counterModeDecrypt(
        entry1!.encryptedAccessKey,
        keys1.accessKeyDecryptionKey,
      )
      const decrypted2 = counterModeDecrypt(
        entry2!.encryptedAccessKey,
        keys2.accessKeyDecryptionKey,
      )

      expect(bytesToHex(decrypted0)).toBe(bytesToHex(accessKey))
      expect(bytesToHex(decrypted1)).toBe(bytesToHex(accessKey))
      expect(bytesToHex(decrypted2)).toBe(bytesToHex(accessKey))
    })
  })

  describe("CTR Mode Verification with Bee Debug Logs", () => {
    it("should decrypt to same value as Bee", () => {
      const ourDecrypted = counterModeEncrypt(
        hexToBytes(BEE_CTR_DEBUG.ENCRYPTED_REF),
        hexToBytes(BEE_CTR_DEBUG.ACCESS_KEY),
      )
      expect(bytesToHex(ourDecrypted)).toBe(BEE_CTR_DEBUG.DECRYPTED_REF)
    })

    it("should encrypt original to same value Bee received", () => {
      const ourEncrypted = counterModeEncrypt(
        hexToBytes(BEE_CTR_DEBUG.DECRYPTED_REF),
        hexToBytes(BEE_CTR_DEBUG.ACCESS_KEY),
      )
      expect(bytesToHex(ourEncrypted)).toBe(BEE_CTR_DEBUG.ENCRYPTED_REF)
    })
  })
})
