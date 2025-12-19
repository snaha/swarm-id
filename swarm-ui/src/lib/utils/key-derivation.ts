/**
 * Swarm Identity - Key Derivation Utilities
 *
 * Provides cryptographic functions for deriving app-specific secrets
 * from a master identity key.
 */

import { Bytes } from '@ethersphere/bee-js'

/**
 * Derive an identity-specific master key from account master key and identity ID
 *
 * Uses HMAC-SHA256 to create a deterministic, unique key for each identity.
 * This enables hierarchical key derivation: Account → Identity → App.
 * The same account master key + identity ID will always produce the same identity key.
 *
 * @param accountMasterKey - The account's master key (Bytes or hex string)
 * @param identityId - The identity's unique identifier
 * @returns The derived identity master key as a hex string
 */
export async function deriveIdentityKey(
	accountMasterKey: Bytes | string,
	identityId: string,
): Promise<string> {
	console.log('[KeyDerivation] Deriving identity key for:', identityId)

	const encoder = new TextEncoder()

	// Convert account master key to Uint8Array
	const keyData =
		accountMasterKey instanceof Bytes
			? accountMasterKey.toUint8Array()
			: new Bytes(accountMasterKey).toUint8Array()
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
	const identityKeyHex = new Bytes(new Uint8Array(signature)).toHex()
	console.log('[KeyDerivation] Identity key derived:', identityKeyHex.substring(0, 16) + '...')

	return identityKeyHex
}

/**
 * Derive an app-specific secret from a master key and app origin
 *
 * Uses HMAC-SHA256 to create a deterministic, unique secret for each app.
 * The same master key + app origin will always produce the same secret.
 *
 * @param masterKey - The master identity key (Bytes or hex string)
 * @param appOrigin - The app's origin (e.g., "https://swarm-app.local:8080")
 * @returns The derived secret as a hex string
 */
export async function deriveSecret(masterKey: Bytes | string, appOrigin: string): Promise<string> {
	console.log('[KeyDerivation] Deriving secret for app:', appOrigin)

	const encoder = new TextEncoder()

	// Convert master key to Uint8Array
	const keyData =
		masterKey instanceof Bytes ? masterKey.toUint8Array() : new Bytes(masterKey).toUint8Array()
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
	const secretHex = new Bytes(new Uint8Array(signature)).toHex()
	console.log('[KeyDerivation] Secret derived:', secretHex.substring(0, 16) + '...')

	return secretHex
}
