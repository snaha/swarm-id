import type { Account } from '$lib/types'
import { authenticateWithPasskey } from '$lib/passkey'
import { connectAndSign } from '$lib/ethereum'
import { decryptMasterKey, deriveEncryptionKey } from '$lib/utils/encryption'
import { authenticateAgentAccount } from '$lib/agent-account'
import { keccak256 } from 'ethers'
import { Bytes } from '@ethersphere/bee-js'

/**
 * Error thrown when an agent account requires seed phrase authentication.
 * The caller should show a UI to collect the seed phrase, then call
 * getMasterKeyFromAgentAccount with the collected phrase.
 */
export class SeedPhraseRequiredError extends Error {
	constructor(public readonly accountId: string) {
		super('Seed phrase required for agent account authentication')
		this.name = 'SeedPhraseRequiredError'
	}
}

/**
 * Authenticates an agent account with the provided seed phrase.
 * Use this after catching SeedPhraseRequiredError and collecting the seed phrase from the user.
 */
export function getMasterKeyFromAgentAccount(account: Account, seedPhrase: string): Bytes {
	if (account.type !== 'agent') {
		throw new Error('getMasterKeyFromAgentAccount can only be used with agent accounts')
	}
	const result = authenticateAgentAccount(seedPhrase, account.id)
	return result.masterKey
}

/**
 * Retrieves the master key from an account by authenticating the user.
 * For passkey accounts: Re-authenticates using WebAuthn
 * For ethereum accounts: Connects wallet and decrypts the stored master key
 * For agent accounts: Throws SeedPhraseRequiredError - caller must collect seed phrase
 *                     and use getMasterKeyFromAgentAccount
 */
export async function getMasterKeyFromAccount(account: Account): Promise<Bytes> {
	if (account.type === 'passkey') {
		const swarmIdDomain = window.location.hostname
		const challenge = new Bytes(keccak256(new TextEncoder().encode(swarmIdDomain))).toUint8Array()
		const passkeyAccount = await authenticateWithPasskey({
			rpId: swarmIdDomain,
			challenge,
			allowCredentialIds: [account.credentialId],
		})
		return passkeyAccount.masterKey
	} else if (account.type === 'agent') {
		// Agent accounts require the caller to collect the seed phrase via UI
		throw new SeedPhraseRequiredError(account.id.toString())
	} else {
		const signed = await connectAndSign()
		const encryptionKey = await deriveEncryptionKey(signed.publicKey, account.encryptionSalt)
		return await decryptMasterKey(account.encryptedMasterKey, encryptionKey)
	}
}
