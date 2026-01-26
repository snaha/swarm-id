/**
 * Swarm Identity - Key Derivation Utilities
 *
 * Provides cryptographic functions for deriving app-specific secrets
 * from a master identity key.
 */
/**
 * Derive an app-specific secret from a master key and app origin
 *
 * Uses HMAC-SHA256 to create a deterministic, unique secret for each app.
 * The same master key + app origin will always produce the same secret.
 *
 * @param masterKey - The master identity key (hex string)
 * @param appOrigin - The app's origin (e.g., "https://swarm-app.local:8080")
 * @returns The derived secret as a hex string
 */
export declare function deriveSecret(masterKey: string, appOrigin: string): Promise<string>;
/**
 * Generate a random master key for testing/demo purposes
 *
 * In production, this would be derived from a user's mnemonic or
 * imported from an existing identity.
 *
 * @returns A random 32-byte key as a hex string
 */
export declare function generateMasterKey(): Promise<string>;
/**
 * Convert a hex string to Uint8Array
 *
 * @param hexString - Hex string (e.g., "deadbeef")
 * @returns Uint8Array
 */
export declare function hexToUint8Array(hexString: string): Uint8Array;
/**
 * Convert a Uint8Array to hex string
 *
 * @param bytes - Uint8Array to convert
 * @returns Hex string (e.g., "deadbeef")
 */
export declare function uint8ArrayToHex(bytes: Uint8Array): string;
/**
 * Verify that a derived secret matches the expected value
 *
 * Useful for testing.
 *
 * @param masterKey - Master key hex string
 * @param appOrigin - App origin
 * @param expectedSecret - Expected secret hex string
 * @returns true if the derived secret matches the expected secret
 */
export declare function verifySecret(masterKey: string, appOrigin: string, expectedSecret: string): Promise<boolean>;
export declare const utils: {
    hexToUint8Array: typeof hexToUint8Array;
    uint8ArrayToHex: typeof uint8ArrayToHex;
};
//# sourceMappingURL=key-derivation.d.ts.map