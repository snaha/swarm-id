/**
 * Encryption utilities for secure masterKey storage
 *
 * Uses Web Crypto API for:
 * - HKDF for key derivation from ECDSA public key
 * - AES-GCM for authenticated encryption
 */

import { hexToUint8Array, uint8ArrayToHex } from './key-derivation'

/**
 * Generate a random encryption salt (32 bytes)
 * Used as salt for HKDF key derivation
 */
export function generateEncryptionSalt(): Uint8Array {
	const salt = new Uint8Array(32)
	crypto.getRandomValues(salt)
	return salt
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
 * @param salt - Random salt used as HKDF salt
 * @returns CryptoKey for AES-GCM encryption/decryption
 */
export async function deriveEncryptionKey(publicKey: string, salt: Uint8Array): Promise<CryptoKey> {
	// Remove '0x' prefix if present
	const cleanPublicKey = publicKey.startsWith('0x') ? publicKey.slice(2) : publicKey
	const publicKeyBytes = hexToUint8Array(cleanPublicKey)

	// Step 1: Import public key as raw key material for HKDF
	const keyMaterial = await crypto.subtle.importKey('raw', publicKeyBytes, 'HKDF', false, [
		'deriveKey',
	])

	// Step 2: Derive AES-GCM key using HKDF
	const encryptionKey = await crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			salt: salt,
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
 * @param masterKey - Hex string of masterKey to encrypt
 * @param encryptionKey - CryptoKey derived from public key + nonce
 * @returns Hex string of encrypted data (includes IV + ciphertext + auth tag)
 */
export async function encryptMasterKey(
	masterKey: string,
	encryptionKey: CryptoKey,
): Promise<string> {
	// Generate random IV (96 bits = 12 bytes, recommended for AES-GCM)
	const iv = new Uint8Array(12)
	crypto.getRandomValues(iv)

	// Remove '0x' prefix if present
	const cleanMasterKey = masterKey.startsWith('0x') ? masterKey.slice(2) : masterKey
	const masterKeyBytes = hexToUint8Array(cleanMasterKey)

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

	return uint8ArrayToHex(combined)
}

/**
 * Decrypt masterKey using AES-GCM
 *
 * @param encryptedMasterKey - Hex string of encrypted data (IV + ciphertext + tag)
 * @param encryptionKey - CryptoKey derived from public key + nonce
 * @returns Hex string of decrypted masterKey (with '0x' prefix)
 */
export async function decryptMasterKey(
	encryptedMasterKey: string,
	encryptionKey: CryptoKey,
): Promise<string> {
	const encryptedBytes = hexToUint8Array(encryptedMasterKey)

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

	// Convert back to hex string with '0x' prefix
	const decryptedHex = uint8ArrayToHex(new Uint8Array(decryptedData))
	return '0x' + decryptedHex
}

/**
 * Decrypt an Ethereum account's masterKey by re-signing SIWE message
 *
 * Process:
 * 1. User connects wallet and signs new SIWE message
 * 2. Recover public key from new signature (same key, different signature)
 * 3. Use stored encryptionSalt to derive same encryption key
 * 4. Decrypt masterKey
 *
 * @param account - EthereumAccount with encrypted masterKey
 * @param secretSeed - Original secret seed used during account creation
 * @returns Decrypted masterKey
 */
export async function decryptEthereumAccountMasterKey(
	account: { encryptedMasterKey: string; encryptionSalt: string },
	secretSeed: string,
): Promise<string> {
	const { connectAndSign } = await import('$lib/ethereum')
	const { SigningKey, hashMessage } = await import('ethers')

	console.log('🔐 Re-authenticating to decrypt masterKey...')

	// Step 1: User signs SIWE message again
	const signed = await connectAndSign({ secretSeed })

	// Step 2: Recover public key from new signature
	const digest = hashMessage(signed.message)
	const publicKey = SigningKey.recoverPublicKey(digest, signed.signature)
	console.log('🔑 Public key recovered:', publicKey.substring(0, 16) + '...')

	// Step 3: Read stored encryptionSalt
	const encryptionSalt = hexToUint8Array(account.encryptionSalt)

	// Step 4: Derive decryption key (same as encryption key)
	const decryptionKey = await deriveEncryptionKey(publicKey, encryptionSalt)
	console.log('🔑 Decryption key derived')

	// Step 5: Decrypt masterKey
	const masterKey = await decryptMasterKey(account.encryptedMasterKey, decryptionKey)
	console.log('✅ MasterKey decrypted')

	return masterKey
}
