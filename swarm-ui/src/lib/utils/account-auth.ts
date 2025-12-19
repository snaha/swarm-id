import type { Account } from '$lib/types'
import { authenticateWithPasskey } from '$lib/passkey'
import { connectAndSign } from '$lib/ethereum'
import { decryptMasterKey, deriveEncryptionKey } from '$lib/utils/encryption'
import { keccak256 } from 'ethers'
import { Bytes } from '@ethersphere/bee-js'

/**
 * Retrieves the master key from an account by authenticating the user.
 * For passkey accounts: Re-authenticates using WebAuthn
 * For ethereum accounts: Connects wallet and decrypts the stored master key
 */
export async function getMasterKeyFromAccount(account: Account): Promise<Bytes> {
	if (account.type === 'passkey') {
		const swarmIdDomain = window.location.hostname
		const challenge = new Bytes(keccak256(new TextEncoder().encode(swarmIdDomain))).toUint8Array()
		const passkeyAccount = await authenticateWithPasskey({
			rpId: swarmIdDomain,
			challenge,
			allowCredentials: [{ id: account.credentialId, type: 'public-key' }],
		})
		return passkeyAccount.masterKey
	} else {
		const signed = await connectAndSign()
		const encryptionKey = await deriveEncryptionKey(signed.publicKey, account.encryptionSalt)
		return await decryptMasterKey(account.encryptedMasterKey, encryptionKey)
	}
}
