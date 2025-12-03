/**
 * Swarm Identity - Key Derivation Utilities
 *
 * Provides cryptographic functions for deriving app-specific secrets
 * from a master identity key.
 */

/**
 * Derive an identity-specific master key from account master key and identity ID
 *
 * Uses HMAC-SHA256 to create a deterministic, unique key for each identity.
 * This enables hierarchical key derivation: Account → Identity → App.
 * The same account master key + identity ID will always produce the same identity key.
 *
 * @param accountMasterKey - The account's master key (hex string)
 * @param identityId - The identity's unique identifier
 * @returns The derived identity master key as a hex string
 */
export async function deriveIdentityKey(
	accountMasterKey: string,
	identityId: string,
): Promise<string> {
	console.log('[KeyDerivation] Deriving identity key for:', identityId)

	const encoder = new TextEncoder()

	// Convert account master key from hex string to Uint8Array
	const keyData = hexToUint8Array(accountMasterKey)
	const message = encoder.encode(identityId)

	// Import the account master key for HMAC
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		keyData,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)

	// Sign the identity ID with the account master key
	const signature = await crypto.subtle.sign('HMAC', cryptoKey, message)

	// Convert to hex string
	const identityKeyHex = uint8ArrayToHex(new Uint8Array(signature))
	console.log('[KeyDerivation] Identity key derived:', identityKeyHex.substring(0, 16) + '...')

	return identityKeyHex
}

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
export async function deriveSecret(masterKey: string, appOrigin: string): Promise<string> {
	console.log('[KeyDerivation] Deriving secret for app:', appOrigin)

	const encoder = new TextEncoder()

	// Convert master key from hex string to Uint8Array
	const keyData = hexToUint8Array(masterKey)
	const message = encoder.encode(appOrigin)

	// Import the master key for HMAC
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		keyData,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)

	// Sign the app origin with the master key
	const signature = await crypto.subtle.sign('HMAC', cryptoKey, message)

	// Convert to hex string
	const secretHex = uint8ArrayToHex(new Uint8Array(signature))
	console.log('[KeyDerivation] Secret derived:', secretHex.substring(0, 16) + '...')

	return secretHex
}

/**
 * Convert a hex string to Uint8Array
 *
 * @param hexString - Hex string (e.g., "deadbeef")
 * @returns Uint8Array
 */
export function hexToUint8Array(hexString: string): Uint8Array {
	// Remove any whitespace and ensure even length
	const hex = hexString.replace(/\s/g, '').replace(/^0x/, '')
	if (hex.length % 2 !== 0) {
		throw new Error('Invalid hex string: length must be even')
	}

	const bytes = new Uint8Array(hex.length / 2)
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
	}

	return bytes
}

/**
 * Convert a Uint8Array to hex string
 *
 * @param bytes - Uint8Array to convert
 * @returns Hex string (e.g., "deadbeef")
 */
export function uint8ArrayToHex(bytes: Uint8Array): string {
	return (
		'0x' +
		Array.from(bytes)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')
	)
}
