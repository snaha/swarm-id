/**
 * Public key in uncompressed format
 */
export interface UncompressedPublicKey {
    x: Uint8Array;
    y: Uint8Array;
}
/**
 * Derive the encryption key for the grantee list
 *
 * This is different from the legacy format key derivation.
 * The grantee list is encrypted with a key derived from the publisher's private key.
 */
export declare function deriveGranteeListEncryptionKey(publisherPrivKey: Uint8Array): Uint8Array;
/**
 * Serialize grantee list to Bee-compatible format
 *
 * Bee stores grantees as concatenated 65-byte uncompressed secp256k1 public keys.
 * Format: [0x04 || X (32 bytes) || Y (32 bytes)] for each key
 *
 * @param grantees - Array of public keys with x and y coordinates
 * @returns Serialized grantee list
 */
export declare function serializeGranteeList(grantees: UncompressedPublicKey[]): Uint8Array;
/**
 * Deserialize grantee list from Bee-compatible format
 *
 * @param data - Serialized grantee list (concatenated 65-byte uncompressed keys)
 * @returns Array of public keys with x and y coordinates
 */
export declare function deserializeGranteeList(data: Uint8Array): UncompressedPublicKey[];
/**
 * Encrypt a serialized grantee list for storage
 *
 * @param granteeList - Serialized grantee list
 * @param publisherPrivKey - Publisher's private key for key derivation
 * @returns Encrypted grantee list
 */
export declare function encryptGranteeList(granteeList: Uint8Array, publisherPrivKey: Uint8Array): Uint8Array;
/**
 * Decrypt an encrypted grantee list
 *
 * @param encryptedList - Encrypted grantee list
 * @param publisherPrivKey - Publisher's private key for key derivation
 * @returns Decrypted serialized grantee list
 */
export declare function decryptGranteeList(encryptedList: Uint8Array, publisherPrivKey: Uint8Array): Uint8Array;
/**
 * Serialize and encrypt grantee list in one step
 *
 * @param grantees - Array of public keys
 * @param publisherPrivKey - Publisher's private key
 * @returns Encrypted serialized grantee list ready for upload
 */
export declare function serializeAndEncryptGranteeList(grantees: UncompressedPublicKey[], publisherPrivKey: Uint8Array): Uint8Array;
/**
 * Decrypt and deserialize grantee list in one step
 *
 * @param encryptedList - Encrypted serialized grantee list
 * @param publisherPrivKey - Publisher's private key
 * @returns Array of public keys
 */
export declare function decryptAndDeserializeGranteeList(encryptedList: Uint8Array, publisherPrivKey: Uint8Array): UncompressedPublicKey[];
/**
 * Add grantees to an existing encrypted grantee list
 *
 * @param encryptedList - Existing encrypted grantee list
 * @param newGrantees - New grantees to add
 * @param publisherPrivKey - Publisher's private key
 * @returns New encrypted grantee list with added grantees
 */
export declare function addToGranteeList(encryptedList: Uint8Array, newGrantees: UncompressedPublicKey[], publisherPrivKey: Uint8Array): Uint8Array;
/**
 * Remove grantees from an existing encrypted grantee list
 *
 * @param encryptedList - Existing encrypted grantee list
 * @param revokeGrantees - Grantees to remove
 * @param publisherPrivKey - Publisher's private key
 * @returns New encrypted grantee list with removed grantees
 */
export declare function removeFromGranteeList(encryptedList: Uint8Array, revokeGrantees: UncompressedPublicKey[], publisherPrivKey: Uint8Array): Uint8Array;
//# sourceMappingURL=grantee-list.d.ts.map