// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Passkey (WebAuthn) access method. The authenticator's PRF extension output
 * is the key material for encrypting the seed — the passkey never holds the
 * seed itself, it only gates the decryption key.
 *
 * Copied (with swarm-ui style adjustments) from `ui/src/lib/crypto/passkey.ts`.
 */
import { deriveKeyFromPrf } from '$lib/crypto/encryption'

const WEBAUTHN_TIMEOUT_MS = 60_000

export interface PasskeyKey {
  credentialId: string
  key: CryptoKey
}

function generateChallenge(): Uint8Array {
  const challenge = new Uint8Array(32)
  crypto.getRandomValues(challenge)
  return challenge
}

async function generatePrfSalt(): Promise<Uint8Array> {
  // Domain-bound salt prevents cross-domain key derivation.
  const saltString = `${window.location.hostname}:swarm-id-seed-encryption-v1`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(saltString))
  return new Uint8Array(digest)
}

function bufferToBase64url(buffer: ArrayBuffer): string {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)))
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

function friendlyWebAuthnError(error: unknown): never {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
        throw new Error('Authentication was cancelled or denied.')
      case 'InvalidStateError':
        throw new Error('This passkey is already registered on this device.')
      case 'NotSupportedError':
        throw new Error('Your device does not support passkeys.')
      case 'SecurityError':
        throw new Error('Passkeys require a secure (HTTPS) context.')
      case 'AbortError':
        throw new Error('Authentication was cancelled.')
    }
    throw new Error(`Authentication error: ${error.message}`)
  }
  throw error instanceof Error ? error : new Error('Unknown authentication error.')
}

/**
 * Register a new passkey and derive the seed-encryption key from its PRF
 * output. Falls back to an extra authentication when the authenticator does
 * not return PRF results during registration.
 */
export async function createPasskeyKey(
  accountName: string,
  signal?: AbortSignal,
): Promise<PasskeyKey> {
  const prfSalt = await generatePrfSalt()

  let credential: Credential | undefined
  try {
    credential =
      (await navigator.credentials.create({
        signal,
        publicKey: {
          challenge: generateChallenge() as BufferSource,
          rp: { name: 'Swarm ID', id: window.location.hostname },
          user: {
            id: crypto.getRandomValues(new Uint8Array(32)) as BufferSource,
            name: accountName,
            displayName: accountName,
          },
          pubKeyCredParams: [
            { alg: -7, type: 'public-key' }, // ES256
            { alg: -257, type: 'public-key' }, // RS256
          ],
          authenticatorSelection: {
            requireResidentKey: true,
            residentKey: 'required',
            // Must match authentication ('required' there too): CTAP2 keeps
            // separate PRF secrets for UV and non-UV, so a non-UV registration
            // would encrypt the seed under a key no later assertion can derive.
            userVerification: 'required',
          },
          extensions: { prf: { eval: { first: prfSalt as BufferSource } } },
          timeout: WEBAUTHN_TIMEOUT_MS,
          attestation: 'none',
        },
      })) ?? undefined
  } catch (error) {
    friendlyWebAuthnError(error)
  }

  if (!credential || !(credential instanceof PublicKeyCredential)) {
    throw new Error('Failed to create the passkey.')
  }

  const extensionResults = credential.getClientExtensionResults()
  if (!extensionResults.prf?.enabled) {
    throw new Error(
      'Your authenticator does not support the PRF extension. Try a device with Touch ID, Face ID, or Windows Hello.',
    )
  }

  const credentialId = bufferToBase64url(credential.rawId)
  const prfOutput = extensionResults.prf.results?.first

  if (prfOutput) {
    return { credentialId, key: await deriveKeyFromPrf(toUint8Array(prfOutput)) }
  }

  // Registration did not evaluate PRF — authenticate once to get the output.
  return authenticateWithPasskey(credentialId, signal)
}

/** Authenticate with an existing passkey and re-derive the seed-encryption key. */
export async function authenticateWithPasskey(
  credentialId: string,
  signal?: AbortSignal,
): Promise<PasskeyKey> {
  const prfSalt = await generatePrfSalt()

  let credential: Credential | undefined
  try {
    credential =
      (await navigator.credentials.get({
        signal,
        publicKey: {
          challenge: generateChallenge() as BufferSource,
          rpId: window.location.hostname,
          timeout: WEBAUTHN_TIMEOUT_MS,
          userVerification: 'required',
          allowCredentials: [
            { id: base64urlToBuffer(credentialId) as BufferSource, type: 'public-key' },
          ],
          extensions: { prf: { eval: { first: prfSalt as BufferSource } } },
        },
      })) ?? undefined
  } catch (error) {
    friendlyWebAuthnError(error)
  }

  if (!credential || !(credential instanceof PublicKeyCredential)) {
    throw new Error('Authentication failed: no credential returned.')
  }

  const prfOutput = credential.getClientExtensionResults().prf?.results?.first
  if (!prfOutput) {
    throw new Error(
      'Your authenticator did not return PRF results. Try a device with Touch ID, Face ID, or Windows Hello.',
    )
  }

  return {
    credentialId: bufferToBase64url(credential.rawId),
    key: await deriveKeyFromPrf(toUint8Array(prfOutput)),
  }
}
