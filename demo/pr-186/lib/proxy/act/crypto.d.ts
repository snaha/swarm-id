/**
 * Derive public key from private key
 */
export declare function publicKeyFromPrivate(privKey: Uint8Array): {
    x: Uint8Array;
    y: Uint8Array;
};
/**
 * Compute ECDH shared secret (x-coordinate of shared point)
 */
export declare function ecdhSharedSecret(privKey: Uint8Array, pubX: Uint8Array, pubY: Uint8Array): Uint8Array;
/**
 * Derive lookup key and access key decryption key from ECDH shared secret
 */
export declare function deriveKeys(privKey: Uint8Array, pubX: Uint8Array, pubY: Uint8Array): {
    lookupKey: Uint8Array;
    accessKeyDecryptionKey: Uint8Array;
};
/**
 * Counter-mode encryption/decryption
 * Matches Bee's Go implementation (bee/pkg/encryption/encryption.go:134-168)
 * For each 32-byte block i: data[i] XOR keccak256(keccak256(key || uint32LE(i)))
 */
export declare function counterModeEncrypt(data: Uint8Array, key: Uint8Array): Uint8Array;
/**
 * Counter-mode decryption (symmetric with encryption)
 */
export declare const counterModeDecrypt: typeof counterModeEncrypt;
/**
 * Parse compressed public key (33 bytes) to uncompressed coordinates
 */
export declare function publicKeyFromCompressed(compressed: Uint8Array): {
    x: Uint8Array;
    y: Uint8Array;
};
/**
 * Compress public key to 33 bytes
 */
export declare function compressPublicKey(x: Uint8Array, y: Uint8Array): Uint8Array;
/**
 * Generate a random 32-byte key using crypto.getRandomValues
 */
export declare function generateRandomKey(): Uint8Array;
//# sourceMappingURL=crypto.d.ts.map