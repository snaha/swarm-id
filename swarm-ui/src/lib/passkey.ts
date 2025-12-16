/**
 * Passkey-based identity management using WebAuthn
 * Derives deterministic Ethereum addresses from platform authenticator PRF output
 */

import {
	startRegistration,
	startAuthentication,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON,
	type AuthenticationResponseJSON,
} from '@simplewebauthn/browser'
import { HDNodeWallet } from 'ethers'

// Type augmentation for PRF extension (not in standard types)
declare module '@simplewebauthn/browser' {
	interface AuthenticationExtensionsClientOutputs {
		prf?: {
			enabled?: boolean
			results?: {
				first?: ArrayBuffer
				second?: ArrayBuffer
			}
		}
	}
}

export interface PasskeyAccount {
	credentialId: string
	ethereumAddress: string
	masterKey: string // Hex-encoded seed for HD wallet derivation
}

export interface PasskeyRegistrationOptions {
	rpName: string
	rpId: string
	userId: string
	userName: string
	userDisplayName?: string
	challenge?: Uint8Array
	excludeCredentials?: Array<{ id: string; type: 'public-key' }>
}

export interface PasskeyAuthenticationOptions {
	rpId?: string
	challenge?: Uint8Array
	allowCredentials?: Array<{ id: string; type: 'public-key' }>
}

function generateChallenge(): Uint8Array {
	const challenge = new Uint8Array(32)
	crypto.getRandomValues(challenge)
	return challenge
}

async function generatePRFSalt(): Promise<ArrayBuffer> {
	// Domain-specific salt prevents cross-domain key derivation
	const saltString = `${window.location.hostname}:ethereum-wallet-v1`
	const encoder = new TextEncoder()
	const saltBytes = encoder.encode(saltString)
	return await crypto.subtle.digest('SHA-256', saltBytes)
}

function bufferToBase64url(buffer: Uint8Array): string {
	const base64 = btoa(String.fromCharCode(...buffer))
	return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/**
 * Create a new passkey credential with platform authenticator (Touch ID/Face ID)
 */
export async function createPasskeyAccount(
	options: PasskeyRegistrationOptions,
): Promise<PasskeyAccount> {
	const challenge = options.challenge || generateChallenge()
	const prfSalt = await generatePRFSalt()

	const registrationOptions: PublicKeyCredentialCreationOptionsJSON = {
		challenge: bufferToBase64url(challenge),
		rp: {
			name: options.rpName,
			id: options.rpId,
		},
		user: {
			id: bufferToBase64url(new TextEncoder().encode(options.userId)),
			name: options.userName,
			displayName: options.userDisplayName || options.userName,
		},
		pubKeyCredParams: [
			{ alg: -7, type: 'public-key' }, // ES256 (ECDSA with SHA-256)
			{ alg: -257, type: 'public-key' }, // RS256 (RSA with SHA-256)
		],
		authenticatorSelection: {
			requireResidentKey: true,
			residentKey: 'required',
			userVerification: 'preferred',
		},
		extensions: {
			prf: {
				// Request PRF evaluation during registration to get the key in one step
				// (avoids requiring a second authentication after account creation)
				eval: { first: prfSalt },
			},
		} as AuthenticationExtensionsClientInputs,
		timeout: 60000,
		attestation: 'none',
	}

	// Exclude already-registered credentials to prevent duplicate registrations
	// transports hint helps the browser check all possible authenticator connections
	if (options.excludeCredentials && options.excludeCredentials.length > 0) {
		registrationOptions.excludeCredentials = options.excludeCredentials.map((cred) => ({
			id: cred.id,
			type: cred.type,
			transports: ['internal', 'hybrid', 'usb'],
		}))
	}

	const registrationResponse = await startRegistration({ optionsJSON: registrationOptions })

	// Check if PRF extension is available
	const prfEnabled = registrationResponse.clientExtensionResults?.prf?.enabled ?? false
	console.log('📝 PRF extension:', prfEnabled ? 'enabled ✅' : 'not available ❌')

	if (!prfEnabled) {
		throw new Error(
			'PRF extension not available on this device. Please use a device with Touch ID, Face ID, or Windows Hello.',
		)
	}

	const credentialId = registrationResponse.id
	console.log('📝 Registration: Credential created successfully')
	console.log('🔑 Credential ID:', credentialId)

	// Check if we got PRF results during registration
	const prfResults = (
		registrationResponse.clientExtensionResults as {
			prf?: { results?: { first?: ArrayBuffer } }
		}
	)?.prf?.results?.first

	let account: PasskeyAccount

	if (prfResults) {
		// Use PRF output from registration
		console.log('✅ Got PRF output during registration (single biometric prompt)')
		const prfBytes = new Uint8Array(prfResults)
		const wallet = await deriveWalletFromPRF(prfBytes)
		account = {
			credentialId,
			ethereumAddress: wallet.address,
			masterKey: wallet.masterKey,
		}
	} else {
		// Fallback: authenticate separately to get PRF output
		console.log('🔐 Authenticating to get PRF output (second biometric prompt)')
		account = await authenticateWithPasskey({
			rpId: options.rpId,
			allowCredentials: [{ id: credentialId, type: 'public-key' }],
		})
	}

	console.log('✅ Passkey account created with address:', account.ethereumAddress)

	return account
}

/**
 * Authenticate with passkey and derive Ethereum address from PRF output
 */
export async function authenticateWithPasskey(
	options: PasskeyAuthenticationOptions = {},
): Promise<PasskeyAccount> {
	const challenge = options.challenge || generateChallenge()
	const prfSalt = await generatePRFSalt()

	const authenticationOptions: PublicKeyCredentialRequestOptionsJSON = {
		challenge: bufferToBase64url(challenge),
		rpId: options.rpId || window.location.hostname,
		timeout: 60000,
		userVerification: 'required',
		extensions: {
			prf: {
				eval: {
					first: prfSalt,
				},
			},
		} as AuthenticationExtensionsClientInputs,
	}

	if (options.allowCredentials) {
		authenticationOptions.allowCredentials = options.allowCredentials.map((cred) => ({
			id: cred.id,
			type: cred.type,
			transports: ['internal', 'hybrid'],
		}))
	}

	const authenticationResponse = await startAuthentication({ optionsJSON: authenticationOptions })

	return processAuthenticationResponse(authenticationResponse)
}

async function processAuthenticationResponse(
	response: AuthenticationResponseJSON,
): Promise<PasskeyAccount> {
	const credentialId = response.id

	// Extract PRF output
	const clientExtensionResults = response.clientExtensionResults || {}
	const prfResult = (
		clientExtensionResults as {
			prf?: { results?: { first?: ArrayBuffer } }
		}
	)?.prf
	const prfOutput = prfResult?.results?.first

	if (!prfOutput) {
		throw new Error(
			'PRF extension did not return results. Please use a device with Touch ID, Face ID, or Windows Hello.',
		)
	}

	const prfBytes = new Uint8Array(prfOutput)
	console.log('🔑 PRF output received:', prfBytes.length, 'bytes')

	// Derive Ethereum wallet from PRF output
	const wallet = await deriveWalletFromPRF(prfBytes)

	return {
		credentialId,
		ethereumAddress: wallet.address,
		masterKey: wallet.masterKey,
	}
}

/**
 * Derive master key from PRF output using importKey + deriveKey pattern
 * Follows Yubico's best practice guide for PRF key derivation
 */
async function deriveMasterKeyFromPRF(prfOutput: Uint8Array): Promise<Uint8Array> {
	// Step 1: Import PRF result as master key
	const masterKey = await crypto.subtle.importKey(
		'raw',
		prfOutput,
		'HKDF',
		false, // non-extractable
		['deriveKey'], // only for key derivation
	)

	// Step 2: Derive purpose-specific key for Ethereum wallet
	const derivedKey = await crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			salt: new Uint8Array(), // empty salt (PRF already provides entropy)
			hash: 'SHA-256',
			info: new TextEncoder().encode('ethereum-hd-wallet-v1'), // purpose binding
		},
		masterKey,
		{ name: 'HMAC', hash: 'SHA-256', length: 256 }, // output: 256-bit key
		true, // extractable (need to export for HDNodeWallet)
		['sign'], // usage
	)

	// Step 3: Export derived key as raw bytes
	const exportedKey = await crypto.subtle.exportKey('raw', derivedKey)
	return new Uint8Array(exportedKey)
}

/**
 * Create Ethereum wallet from seed bytes
 * Converts seed to HD wallet and returns address + master key
 */
export function createEthereumWalletFromSeed(seedBytes: Uint8Array): {
	address: string
	masterKey: string
} {
	// Convert to hex for HDNodeWallet
	const entropyHex =
		'0x' +
		Array.from(seedBytes)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')

	// Create HD wallet from seed
	const wallet = HDNodeWallet.fromSeed(entropyHex)

	return {
		address: wallet.address,
		masterKey: entropyHex,
	}
}

/**
 * Derive Ethereum wallet from PRF output
 * Returns both the Ethereum address and master key for HD wallet derivation
 */
async function deriveWalletFromPRF(
	prfOutput: Uint8Array,
): Promise<{ address: string; masterKey: string }> {
	// Step 1: Derive master key using importKey + deriveKey
	const seedBytes = await deriveMasterKeyFromPRF(prfOutput)

	// Step 2: Create Ethereum wallet from seed
	return createEthereumWalletFromSeed(seedBytes)
}
