import { Binary } from "cafe-utility"
import { counterModeEncrypt, counterModeDecrypt } from "./crypto"

// Grantee list format constants
const UNCOMPRESSED_PUBLIC_KEY_SIZE = 65 // 0x04 prefix + 32 byte X + 32 byte Y
const UNCOMPRESSED_PREFIX = 0x04
const PUBLIC_KEY_COORD_SIZE = 32

// Grantee list encryption key derivation suffix
const GRANTEE_LIST_KEY_SUFFIX = new TextEncoder().encode("act-grantee-list")

/**
 * Public key in uncompressed format
 */
export interface UncompressedPublicKey {
  x: Uint8Array // 32 bytes
  y: Uint8Array // 32 bytes
}

/**
 * Derive the encryption key for the grantee list
 *
 * This is different from the legacy format key derivation.
 * The grantee list is encrypted with a key derived from the publisher's private key.
 */
export function deriveGranteeListEncryptionKey(
  publisherPrivKey: Uint8Array,
): Uint8Array {
  const input = Binary.concatBytes(publisherPrivKey, GRANTEE_LIST_KEY_SUFFIX)
  return Binary.keccak256(input)
}

/**
 * Serialize grantee list to Bee-compatible format
 *
 * Bee stores grantees as concatenated 65-byte uncompressed secp256k1 public keys.
 * Format: [0x04 || X (32 bytes) || Y (32 bytes)] for each key
 *
 * @param grantees - Array of public keys with x and y coordinates
 * @returns Serialized grantee list
 */
export function serializeGranteeList(
  grantees: UncompressedPublicKey[],
): Uint8Array {
  const result = new Uint8Array(grantees.length * UNCOMPRESSED_PUBLIC_KEY_SIZE)

  for (let i = 0; i < grantees.length; i++) {
    const offset = i * UNCOMPRESSED_PUBLIC_KEY_SIZE

    // 0x04 prefix for uncompressed point
    result[offset] = UNCOMPRESSED_PREFIX

    // X coordinate (32 bytes)
    result.set(grantees[i].x, offset + 1)

    // Y coordinate (32 bytes)
    result.set(grantees[i].y, offset + 1 + PUBLIC_KEY_COORD_SIZE)
  }

  return result
}

/**
 * Deserialize grantee list from Bee-compatible format
 *
 * @param data - Serialized grantee list (concatenated 65-byte uncompressed keys)
 * @returns Array of public keys with x and y coordinates
 */
export function deserializeGranteeList(
  data: Uint8Array,
): UncompressedPublicKey[] {
  if (data.length === 0) {
    return []
  }

  if (data.length % UNCOMPRESSED_PUBLIC_KEY_SIZE !== 0) {
    throw new Error(
      `Invalid grantee list length: ${data.length} is not a multiple of ${UNCOMPRESSED_PUBLIC_KEY_SIZE}`,
    )
  }

  const granteeCount = data.length / UNCOMPRESSED_PUBLIC_KEY_SIZE
  const grantees: UncompressedPublicKey[] = []

  for (let i = 0; i < granteeCount; i++) {
    const offset = i * UNCOMPRESSED_PUBLIC_KEY_SIZE

    // Verify 0x04 prefix
    if (data[offset] !== UNCOMPRESSED_PREFIX) {
      throw new Error(
        `Invalid public key prefix at index ${i}: expected 0x04, got 0x${data[offset].toString(16)}`,
      )
    }

    // Extract X coordinate
    const x = data.slice(offset + 1, offset + 1 + PUBLIC_KEY_COORD_SIZE)

    // Extract Y coordinate
    const y = data.slice(
      offset + 1 + PUBLIC_KEY_COORD_SIZE,
      offset + UNCOMPRESSED_PUBLIC_KEY_SIZE,
    )

    grantees.push({ x, y })
  }

  return grantees
}

/**
 * Encrypt a serialized grantee list for storage
 *
 * @param granteeList - Serialized grantee list
 * @param publisherPrivKey - Publisher's private key for key derivation
 * @returns Encrypted grantee list
 */
export function encryptGranteeList(
  granteeList: Uint8Array,
  publisherPrivKey: Uint8Array,
): Uint8Array {
  const encryptionKey = deriveGranteeListEncryptionKey(publisherPrivKey)
  return counterModeEncrypt(granteeList, encryptionKey)
}

/**
 * Decrypt an encrypted grantee list
 *
 * @param encryptedList - Encrypted grantee list
 * @param publisherPrivKey - Publisher's private key for key derivation
 * @returns Decrypted serialized grantee list
 */
export function decryptGranteeList(
  encryptedList: Uint8Array,
  publisherPrivKey: Uint8Array,
): Uint8Array {
  const encryptionKey = deriveGranteeListEncryptionKey(publisherPrivKey)
  return counterModeDecrypt(encryptedList, encryptionKey)
}

/**
 * Serialize and encrypt grantee list in one step
 *
 * @param grantees - Array of public keys
 * @param publisherPrivKey - Publisher's private key
 * @returns Encrypted serialized grantee list ready for upload
 */
export function serializeAndEncryptGranteeList(
  grantees: UncompressedPublicKey[],
  publisherPrivKey: Uint8Array,
): Uint8Array {
  const serialized = serializeGranteeList(grantees)
  return encryptGranteeList(serialized, publisherPrivKey)
}

/**
 * Decrypt and deserialize grantee list in one step
 *
 * @param encryptedList - Encrypted serialized grantee list
 * @param publisherPrivKey - Publisher's private key
 * @returns Array of public keys
 */
export function decryptAndDeserializeGranteeList(
  encryptedList: Uint8Array,
  publisherPrivKey: Uint8Array,
): UncompressedPublicKey[] {
  const decrypted = decryptGranteeList(encryptedList, publisherPrivKey)
  return deserializeGranteeList(decrypted)
}

/**
 * Add grantees to an existing encrypted grantee list
 *
 * @param encryptedList - Existing encrypted grantee list
 * @param newGrantees - New grantees to add
 * @param publisherPrivKey - Publisher's private key
 * @returns New encrypted grantee list with added grantees
 */
export function addToGranteeList(
  encryptedList: Uint8Array,
  newGrantees: UncompressedPublicKey[],
  publisherPrivKey: Uint8Array,
): Uint8Array {
  // Decrypt existing list
  const existingGrantees =
    encryptedList.length > 0
      ? decryptAndDeserializeGranteeList(encryptedList, publisherPrivKey)
      : []

  // Add new grantees
  const updatedGrantees = [...existingGrantees, ...newGrantees]

  // Re-encrypt
  return serializeAndEncryptGranteeList(updatedGrantees, publisherPrivKey)
}

/**
 * Remove grantees from an existing encrypted grantee list
 *
 * @param encryptedList - Existing encrypted grantee list
 * @param revokeGrantees - Grantees to remove
 * @param publisherPrivKey - Publisher's private key
 * @returns New encrypted grantee list with removed grantees
 */
export function removeFromGranteeList(
  encryptedList: Uint8Array,
  revokeGrantees: UncompressedPublicKey[],
  publisherPrivKey: Uint8Array,
): Uint8Array {
  // Decrypt existing list
  const existingGrantees = decryptAndDeserializeGranteeList(
    encryptedList,
    publisherPrivKey,
  )

  // Filter out revoked grantees
  const remainingGrantees = existingGrantees.filter((existing) => {
    return !revokeGrantees.some((revoke) => publicKeysEqual(existing, revoke))
  })

  // Re-encrypt
  return serializeAndEncryptGranteeList(remainingGrantees, publisherPrivKey)
}

/**
 * Check if two public keys are equal
 */
function publicKeysEqual(
  a: UncompressedPublicKey,
  b: UncompressedPublicKey,
): boolean {
  if (a.x.length !== b.x.length || a.y.length !== b.y.length) return false
  for (let i = 0; i < a.x.length; i++) {
    if (a.x[i] !== b.x[i]) return false
  }
  for (let i = 0; i < a.y.length; i++) {
    if (a.y[i] !== b.y[i]) return false
  }
  return true
}
