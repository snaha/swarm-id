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
 * @param {string} masterKey - The master identity key (hex string)
 * @param {string} appOrigin - The app's origin (e.g., "https://swarm-app.local:8080")
 * @returns {Promise<string>} - The derived secret as a hex string
 */
export async function deriveSecret(masterKey, appOrigin) {
  console.log('[KeyDerivation] Deriving secret for app:', appOrigin);

  const encoder = new TextEncoder();

  // Convert master key from hex string to Uint8Array
  const keyData = hexToUint8Array(masterKey);
  const message = encoder.encode(appOrigin);

  // Import the master key for HMAC
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // Sign the app origin with the master key
  const signature = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    message
  );

  // Convert to hex string
  const secretHex = uint8ArrayToHex(new Uint8Array(signature));
  console.log('[KeyDerivation] Secret derived:', secretHex.substring(0, 16) + '...');

  return secretHex;
}

/**
 * Generate a random master key for testing/demo purposes
 *
 * In production, this would be derived from a user's mnemonic or
 * imported from an existing identity.
 *
 * @returns {Promise<string>} - A random 32-byte key as a hex string
 */
export async function generateMasterKey() {
  console.log('[KeyDerivation] Generating random master key...');

  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);

  const masterKey = uint8ArrayToHex(randomBytes);
  console.log('[KeyDerivation] Master key generated:', masterKey.substring(0, 16) + '...');

  return masterKey;
}

/**
 * Convert a hex string to Uint8Array
 *
 * @param {string} hexString - Hex string (e.g., "deadbeef")
 * @returns {Uint8Array}
 */
function hexToUint8Array(hexString) {
  // Remove any whitespace and ensure even length
  const hex = hexString.replace(/\s/g, '');
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string: length must be even');
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }

  return bytes;
}

/**
 * Convert a Uint8Array to hex string
 *
 * @param {Uint8Array} bytes
 * @returns {string} - Hex string (e.g., "deadbeef")
 */
function uint8ArrayToHex(bytes) {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Verify that a derived secret matches the expected value
 *
 * Useful for testing.
 *
 * @param {string} masterKey - Master key hex string
 * @param {string} appOrigin - App origin
 * @param {string} expectedSecret - Expected secret hex string
 * @returns {Promise<boolean>}
 */
export async function verifySecret(masterKey, appOrigin, expectedSecret) {
  const derived = await deriveSecret(masterKey, appOrigin);
  return derived === expectedSecret;
}

// Export utility functions for testing
export const utils = {
  hexToUint8Array,
  uint8ArrayToHex
};
