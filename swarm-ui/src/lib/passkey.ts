/**
 * Passkey-based identity management using WebAuthn
 * Derives deterministic Ethereum addresses from passkey credentials
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
import { hexToUint8Array, uint8ArrayToHex } from './utils/key-derivation'

export interface PasskeyAccount {
	credentialId: string
	ethereumAddress: string
}

export interface PasskeyRegistrationOptions {
	rpName: string
	rpId: string
	userId: string
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

function bufferToBase64url(buffer: Uint8Array): string {
	const base64 = btoa(String.fromCharCode(...buffer))
	return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function base64urlToBuffer(base64url: string): Uint8Array {
	const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
	const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
	const binary = atob(padded)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}
	return bytes
}

/**
 * Create a new passkey credential
 */
export async function createPasskeyAccount(
	options: PasskeyRegistrationOptions,
): Promise<PasskeyAccount> {
	const challenge = options.challenge || generateChallenge()

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
			authenticatorAttachment: 'cross-platform', // Allow hardware keys like YubiKey
			requireResidentKey: true,
			residentKey: 'required',
			userVerification: 'required',
		},
		extensions: {
			prf: {},
		} as AuthenticationExtensionsClientInputs,
		timeout: 60000,
		attestation: 'none',
	}

	const registrationResponse = await startRegistration({ optionsJSON: registrationOptions })

	return processRegistrationResponse(registrationResponse)
}

/**
 * Authenticate with passkey and derive Ethereum address from credential
 */
export async function authenticateWithPasskey(
	options: PasskeyAuthenticationOptions = {},
): Promise<PasskeyAccount> {
	const challenge = options.challenge || generateChallenge()

	const authenticationOptions: PublicKeyCredentialRequestOptionsJSON = {
		challenge: bufferToBase64url(challenge),
		rpId: options.rpId || window.location.hostname,
		timeout: 60000,
		userVerification: 'required',
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

async function processResponse(responseId: string) {
	const credentialId = '0x' + uint8ArrayToHex(base64urlToBuffer(responseId))

	console.log('📝 Registration: Credential created successfully')
	console.log('🔑 Credential ID:', credentialId)

	// Derive Ethereum address from credential ID
	const ethereumAddress = await deriveEthereumAddressFromCredentialId(credentialId)

	return {
		credentialId,
		ethereumAddress,
	}
}

async function processRegistrationResponse(
	response: RegistrationResponseJSON,
): Promise<PasskeyAccount> {
	console.debug({ response })
	return processResponse(response.response.publicKey)
}

async function processAuthenticationResponse(
	response: AuthenticationResponseJSON,
): Promise<PasskeyAccount> {
	console.debug({ response })
	return processResponse(response.response.signature)
}

/**
 * Derive Ethereum address from credential ID
 * Uses the credential ID as deterministic entropy to generate an Ethereum address
 */
async function deriveEthereumAddressFromCredentialId(credentialId: string): Promise<string> {
	const credentialBytes = hexToUint8Array(credentialId)

	// Hash the credential ID to get 32 bytes of entropy
	const entropy = await crypto.subtle.digest('SHA-256', credentialBytes)
	const entropyBytes = new Uint8Array(entropy)

	// Convert entropy to hex string for HDNodeWallet
	const entropyHex =
		'0x' +
		Array.from(entropyBytes)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')

	// Create HD wallet from entropy
	const wallet = HDNodeWallet.fromSeed(entropyHex)

	console.log('📍 Ethereum Address:', wallet.address)

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
