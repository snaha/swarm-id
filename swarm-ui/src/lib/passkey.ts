/**
 * Passkey-based identity management using WebAuthn
 * Derives deterministic Ethereum addresses from platform authenticator PRF output
 */

import { HDNodeWallet } from 'ethers'
import { EthAddress, Bytes } from '@ethersphere/bee-js'
import { toPrefixedHex } from './utils/hex'

export interface PasskeyAccount {
  credentialId: string
  ethereumAddress: EthAddress
  masterKey: Bytes
}

export interface PasskeyRegistrationOptions {
  rpName: string
  rpId: string
  userId: string
  userName: string
  userDisplayName?: string
  challenge?: Uint8Array
  excludeCredentialIds?: string[]
}

export interface PasskeyAuthenticationOptions {
  rpId?: string
  challenge?: Uint8Array
  allowCredentialIds?: string[]
}

function generateChallenge(): Uint8Array {
  const challenge = new Uint8Array(32)
  crypto.getRandomValues(challenge)
  return challenge
}

async function generatePRFSalt(): Promise<Uint8Array> {
  // Domain-specific salt prevents cross-domain key derivation
  const saltString = `${window.location.hostname}:ethereum-wallet-v1`
  const encoder = new TextEncoder()
  const saltBytes = encoder.encode(saltString)
  const digest = await crypto.subtle.digest('SHA-256', saltBytes)
  return new Uint8Array(digest)
}

function bufferToBase64url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer
  const base64 = btoa(String.fromCharCode(...bytes))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function base64urlToBuffer(base64url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4)
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/') + padding
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function toUint8Array(buffer: BufferSource): Uint8Array {
  return buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer)
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

/**
 * Wraps WebAuthn errors with user-friendly messages
 */
function handleWebAuthnError(error: unknown): never {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
        throw new Error('Authentication was cancelled or denied by the user.')
      case 'InvalidStateError':
        throw new Error('This credential is already registered on this device.')
      case 'NotSupportedError':
        throw new Error('Your device does not support the required authentication features.')
      case 'SecurityError':
        throw new Error('Authentication requires HTTPS.')
      case 'AbortError':
        throw new Error('Authentication was aborted.')
      default:
        throw new Error(`Authentication error: ${error.message}`)
    }
  }
  throw error instanceof Error ? error : new Error('Unknown authentication error.')
}

/**
 * Derive master key from PRF output using HKDF
 * Follows Yubico's best practice guide for PRF key derivation
 */
async function deriveMasterKeyFromPRF(prfOutput: Uint8Array): Promise<Uint8Array> {
  const masterKey = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveBits'])
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      salt: new Uint8Array(), // empty salt (PRF already provides entropy)
      hash: 'SHA-256',
      info: new TextEncoder().encode('ethereum-hd-wallet-v1'), // purpose binding
    },
    masterKey,
    256, // 256 bits
  )
  return new Uint8Array(derivedBits)
}

/**
 * Create Ethereum wallet from seed bytes
 * Converts seed to HD wallet and returns address + master key
 */
export function createEthereumWalletFromSeed(seedBytes: Uint8Array): {
  address: EthAddress
  masterKey: Bytes
} {
  const masterKey = new Bytes(seedBytes)
  const wallet = HDNodeWallet.fromSeed(toPrefixedHex(masterKey))

  return {
    address: new EthAddress(wallet.address),
    masterKey,
  }
}

/**
 * Create a new passkey credential with platform authenticator (Touch ID/Face ID)
 */
export async function createPasskeyAccount(
  options: PasskeyRegistrationOptions,
): Promise<PasskeyAccount> {
  const challenge = options.challenge || generateChallenge()
  const prfSalt = await generatePRFSalt()

  const publicKeyOptions: PublicKeyCredentialCreationOptions = {
    challenge,
    rp: {
      name: options.rpName,
      id: options.rpId,
    },
    user: {
      id: new TextEncoder().encode(options.userId),
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
    },
    timeout: 60000,
    attestation: 'none',
  }

  // Exclude already-registered credentials to prevent duplicate registrations
  if (options.excludeCredentialIds && options.excludeCredentialIds.length > 0) {
    publicKeyOptions.excludeCredentials = options.excludeCredentialIds.map((id) => ({
      id: base64urlToBuffer(id),
      type: 'public-key' as const,
      transports: ['internal', 'hybrid', 'usb'] as AuthenticatorTransport[],
    }))
  }

  let credential: Credential | null
  try {
    credential = await navigator.credentials.create({ publicKey: publicKeyOptions })
  } catch (error) {
    handleWebAuthnError(error)
  }

  if (!credential || !(credential instanceof PublicKeyCredential)) {
    throw new Error('Failed to create credential')
  }

  // Check if PRF extension is available
  const extensionResults = credential.getClientExtensionResults()
  const prfEnabled = extensionResults.prf?.enabled ?? false
  console.log('PRF extension:', prfEnabled ? 'enabled' : 'not available')

  if (!prfEnabled) {
    throw new Error(
      'PRF extension not available on this device. Please use a device with Touch ID, Face ID, or Windows Hello.',
    )
  }

  const credentialId = bufferToBase64url(credential.rawId)
  console.log('Registration: Credential created successfully')
  console.log('Credential ID:', credentialId)

  // Check if we got PRF results during registration
  const prfResults = extensionResults.prf?.results?.first

  let account: PasskeyAccount

  if (prfResults) {
    // Use PRF output from registration
    console.log('Got PRF output during registration (single biometric prompt)')
    const seedBytes = await deriveMasterKeyFromPRF(toUint8Array(prfResults))
    const wallet = createEthereumWalletFromSeed(seedBytes)
    account = {
      credentialId,
      ethereumAddress: wallet.address,
      masterKey: wallet.masterKey,
    }
  } else {
    // Fallback: authenticate separately to get PRF output
    console.log('Authenticating to get PRF output (second biometric prompt)')
    account = await authenticateWithPasskey({
      rpId: options.rpId,
      allowCredentialIds: [credentialId],
    })
  }

  console.log('Passkey account created with address:', toPrefixedHex(account.ethereumAddress))

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

  const publicKeyOptions: PublicKeyCredentialRequestOptions = {
    challenge,
    rpId: options.rpId || window.location.hostname,
    timeout: 60000,
    userVerification: 'required',
    extensions: {
      prf: {
        eval: {
          first: prfSalt,
        },
      },
    },
  }

  if (options.allowCredentialIds) {
    publicKeyOptions.allowCredentials = options.allowCredentialIds.map((id) => ({
      id: base64urlToBuffer(id),
      type: 'public-key' as const,
      transports: ['internal', 'hybrid', 'usb'] as AuthenticatorTransport[],
    }))
  }

  let credential: Credential | null
  try {
    credential = await navigator.credentials.get({ publicKey: publicKeyOptions })
  } catch (error) {
    handleWebAuthnError(error)
  }

  if (!credential || !(credential instanceof PublicKeyCredential)) {
    throw new Error('Authentication failed: no credential returned')
  }

  // Extract credential ID and PRF output
  const credentialId = bufferToBase64url(credential.rawId)
  const extensionResults = credential.getClientExtensionResults()
  const prfOutput = extensionResults.prf?.results?.first

  if (!prfOutput) {
    throw new Error(
      'PRF extension did not return results. Please use a device with Touch ID, Face ID, or Windows Hello.',
    )
  }

  console.log('PRF output received:', toUint8Array(prfOutput).length, 'bytes')

  // Derive Ethereum wallet from PRF output
  const seedBytes = await deriveMasterKeyFromPRF(toUint8Array(prfOutput))
  const wallet = createEthereumWalletFromSeed(seedBytes)

  return {
    credentialId,
    ethereumAddress: wallet.address,
    masterKey: wallet.masterKey,
  }
}
