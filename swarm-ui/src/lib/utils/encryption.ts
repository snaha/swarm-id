/**
 * Encryption utilities for secure masterKey storage
 *
 * Uses Web Crypto API for:
 * - HKDF for key derivation from ECDSA public key
 * - AES-GCM for authenticated encryption
 */

import { Bytes } from '@ethersphere/bee-js'

/**
 * Generate a random encryption salt (32 bytes)
 * Used as salt for HKDF key derivation
 */
export function generateEncryptionSalt(): Bytes {
	const salt = new Uint8Array(32)
	crypto.getRandomValues(salt)
	return new Bytes(salt)
}

/**
 * Derive encryption key from ECDSA public key and salt
 *
 * Uses HKDF (HMAC-based Key Derivation Function):
 * - Input: publicKey (recovered from SIWE signature)
 * - Salt: encryptionSalt (random, stored alongside encrypted data)
 * - Info: Context string for domain separation
 * - Output: 256-bit AES-GCM key
 *
 * @param publicKey - Hex string of ECDSA public key (recovered from signature)
 * @param salt - Random salt used as HKDF salt (Bytes or hex string)
 * @returns CryptoKey for AES-GCM encryption/decryption
 */
export async function deriveEncryptionKey(
	publicKey: string,
	salt: Bytes | string,
): Promise<CryptoKey> {
	const publicKeyBytes = new Bytes(publicKey).toUint8Array()
	const saltBytes = salt instanceof Bytes ? salt.toUint8Array() : new Bytes(salt).toUint8Array()

	// Step 1: Import public key as raw key material for HKDF
	const keyMaterial = await crypto.subtle.importKey('raw', publicKeyBytes, 'HKDF', false, [
		'deriveKey',
	])

	// Step 2: Derive AES-GCM key using HKDF
	const encryptionKey = await crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			salt: saltBytes,
			hash: 'SHA-256',
			info: new TextEncoder().encode('swarm-id-masterkey-encryption-v1'),
		},
		keyMaterial,
		{
			name: 'AES-GCM',
			length: 256, // 256-bit key
		},
		false, // non-extractable
		['encrypt', 'decrypt'],
	)

	return encryptionKey
}

/**
 * Encrypt masterKey using AES-GCM
 *
 * @param masterKey - MasterKey to encrypt (Bytes or hex string)
 * @param encryptionKey - CryptoKey derived from public key + nonce
 * @returns Encrypted data (includes IV + ciphertext + auth tag)
 */
export async function encryptMasterKey(
	masterKey: Bytes | string,
	encryptionKey: CryptoKey,
): Promise<Bytes> {
	// Generate random IV (96 bits = 12 bytes, recommended for AES-GCM)
	const iv = new Uint8Array(12)
	crypto.getRandomValues(iv)

	const masterKeyBytes =
		masterKey instanceof Bytes ? masterKey.toUint8Array() : new Bytes(masterKey).toUint8Array()

	// Encrypt using AES-GCM (includes authentication tag automatically)
	const encryptedData = await crypto.subtle.encrypt(
		{
			name: 'AES-GCM',
			iv: iv,
		},
		encryptionKey,
		masterKeyBytes,
	)

	// Combine IV + encrypted data for storage
	// Format: [IV (12 bytes)][Ciphertext + Auth Tag]
	const combined = new Uint8Array(iv.length + encryptedData.byteLength)
	combined.set(iv, 0)
	combined.set(new Uint8Array(encryptedData), iv.length)

	return new Bytes(combined)
}

/**
 * Decrypt masterKey using AES-GCM
 *
 * @param encryptedMasterKey - Encrypted data (IV + ciphertext + tag) as Bytes or hex string
 * @param encryptionKey - CryptoKey derived from public key + nonce
 * @returns Decrypted masterKey
 */
export async function decryptMasterKey(
	encryptedMasterKey: Bytes | string,
	encryptionKey: CryptoKey,
): Promise<Bytes> {
	const encryptedBytes =
		encryptedMasterKey instanceof Bytes
			? encryptedMasterKey.toUint8Array()
			: new Bytes(encryptedMasterKey).toUint8Array()

	// Extract IV (first 12 bytes) and ciphertext (remaining bytes)
	const iv = encryptedBytes.slice(0, 12)
	const ciphertext = encryptedBytes.slice(12)

	// Decrypt using AES-GCM (verifies authentication tag automatically)
	const decryptedData = await crypto.subtle.decrypt(
		{
			name: 'AES-GCM',
			iv: iv,
		},
		encryptionKey,
		ciphertext,
	)

	return new Bytes(new Uint8Array(decryptedData))
}
