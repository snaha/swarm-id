/**
 * Passkey-based identity management using WebAuthn PRF extension
 * Derives deterministic Ethereum addresses from hardware-backed passkeys
 */

import {
	startRegistration,
	startAuthentication,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON,
	type RegistrationResponseJSON,
	type AuthenticationResponseJSON,
} from '@simplewebauthn/browser'
import { HDNodeWallet } from 'ethers'

export interface PasskeyIdentity {
	credentialId: string
	publicKey: Uint8Array
	ethereumAddress: string
	prfAvailable: boolean
	prfOutput?: Uint8Array
}

export interface PasskeyRegistrationOptions {
	rpName: string
	rpId?: string
	userName: string
	userDisplayName?: string
	challenge?: Uint8Array
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
	const saltString = `${window.location.hostname}:ethereum-identity-v1`
	const encoder = new TextEncoder()
	const saltBytes = encoder.encode(saltString)
	return await crypto.subtle.digest('SHA-256', saltBytes)
}

function bufferToBase64url(buffer: Uint8Array): string {
	const base64 = btoa(String.fromCharCode(...buffer))
	return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/**
 * Create a new passkey credential with PRF extension enabled
 */
export async function createPasskeyIdentity(
	options: PasskeyRegistrationOptions,
): Promise<PasskeyIdentity> {
	const challenge = options.challenge || generateChallenge()

	const registrationOptions: PublicKeyCredentialCreationOptionsJSON = {
		challenge: bufferToBase64url(challenge),
		rp: {
			name: options.rpName,
			id: options.rpId || window.location.hostname,
		},
		user: {
			id: bufferToBase64url(crypto.getRandomValues(new Uint8Array(32))),
			name: options.userName,
			displayName: options.userDisplayName || options.userName,
		},
		pubKeyCredParams: [
			{ alg: -7, type: 'public-key' },
			{ alg: -257, type: 'public-key' },
		],
		authenticatorSelection: {
			authenticatorAttachment: 'platform',
			requireResidentKey: true,
			residentKey: 'required',
			userVerification: 'required',
		},
		timeout: 60000,
		attestation: 'none',
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	;(registrationOptions as any).extensions = { prf: {} }

	const registrationResponse = await startRegistration({ optionsJSON: registrationOptions })

	return processRegistrationResponse(registrationResponse)
}

/**
 * Authenticate with passkey and derive Ethereum address using PRF extension
 */
export async function authenticateWithPasskey(
	options: PasskeyAuthenticationOptions = {},
): Promise<PasskeyIdentity> {
	const challenge = options.challenge || generateChallenge()
	const prfSalt = await generatePRFSalt()

	const authenticationOptions: PublicKeyCredentialRequestOptionsJSON = {
		challenge: bufferToBase64url(challenge),
		rpId: options.rpId || window.location.hostname,
		timeout: 60000,
		userVerification: 'required',
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	;(authenticationOptions as any).extensions = {
		prf: {
			eval: {
				first: prfSalt,
			},
		},
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

async function processRegistrationResponse(
	response: RegistrationResponseJSON,
): Promise<PasskeyIdentity> {
	const credentialId = response.id

	let prfAvailable = false
	try {
		const clientExtensionResults = response.clientExtensionResults || {}
		const prfResult = (clientExtensionResults as { prf?: { enabled?: boolean } })?.prf
		prfAvailable = prfResult?.enabled ?? false
		console.log('📝 Registration: PRF extension', prfAvailable ? 'enabled ✅' : 'not available ❌')
	} catch (error) {
		console.warn('⚠️ Failed to check PRF availability:', error)
	}

	return {
		credentialId,
		publicKey: new Uint8Array(65),
		ethereumAddress: '',
		prfAvailable,
		prfOutput: undefined,
	}
}

async function processAuthenticationResponse(
	response: AuthenticationResponseJSON,
): Promise<PasskeyIdentity> {
	const credentialId = response.id

	let prfAvailable = false
	let prfOutput: Uint8Array | undefined

	try {
		const clientExtensionResults = response.clientExtensionResults || {}
		const prfResult = (
			clientExtensionResults as {
				prf?: { results?: { first?: ArrayBuffer } }
			}
		)?.prf
		const prfResults = prfResult?.results

		if (prfResults?.first) {
			prfOutput = new Uint8Array(prfResults.first)
			prfAvailable = true
			console.log('🔑 PRF output received:', prfOutput.length, 'bytes')
		} else {
			console.warn('⚠️ PRF extension did not return results')
		}
	} catch (error) {
		console.warn('⚠️ Failed to extract PRF results:', error)
	}

	if (!prfAvailable || !prfOutput) {
		throw new Error(
			'PRF extension not available. Please use a modern browser (Chrome 128+, Safari 18+) with a platform authenticator that supports PRF.',
		)
	}

	const ethereumAddress = await deriveEthereumAddress(prfOutput)

	return {
		credentialId,
		publicKey: new Uint8Array(0),
		ethereumAddress,
		prfAvailable,
		prfOutput,
	}
}

/**
 * Derive key material using HKDF (HMAC-based Key Derivation Function)
 */
async function deriveKeyWithHKDF(prfOutput: Uint8Array, info: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', prfOutput, { name: 'HKDF' }, false, [
		'deriveBits',
	])

	const derivedBits = await crypto.subtle.deriveBits(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: new Uint8Array(32),
			info: new TextEncoder().encode(info),
		},
		key,
		256,
	)

	return new Uint8Array(derivedBits)
}

/**
 * Derive Ethereum address from PRF output
 */
async function deriveEthereumAddress(prfOutput: Uint8Array): Promise<string> {
	const entropy = await deriveKeyWithHKDF(prfOutput, 'ethereum-wallet-seed')

	const entropyHex =
		'0x' +
		Array.from(entropy)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')

	const wallet = HDNodeWallet.fromSeed(entropyHex)

	return wallet.address
}

/**
 * Check if WebAuthn is supported
 */
export function isPasskeySupported(): boolean {
	return (
		typeof window !== 'undefined' &&
		window.PublicKeyCredential !== undefined &&
		typeof window.PublicKeyCredential === 'function'
	)
}

/**
 * Check if platform authenticator is available
 */
export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
	if (!isPasskeySupported()) {
		return false
	}

	try {
		return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
	} catch {
		return false
	}
}
