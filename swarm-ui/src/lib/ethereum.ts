/**
 * Ethereum Wallet Integration for Swarm ID
 *
 * Provides functions for connecting to Ethereum wallets (MetaMask, WalletConnect, etc.)
 * and implementing Sign-In with Ethereum (SIWE) for account creation.
 */

import { BrowserProvider, JsonRpcSigner, hashMessage, SigningKey, BaseWallet } from 'ethers'
import type { Eip1193Provider } from 'ethers'

declare let window: Window & {
	ethereum?: Eip1193Provider & { send: (name: string) => Promise<void> }
}

export interface SignedMessage {
	message: string
	digest: string
	signature: string
	publicKey: string
	address: string
}

/**
 * Create a SIWE (Sign-In with Ethereum) message
 *
 * This creates a standardized message that follows the EIP-4361 spec
 */
export function createSIWEMessage(params: {
	address: string
	domain: string
	uri: string
	statement?: string
	nonce?: string
	issuedAt?: string
}): string {
	const {
		address,
		domain,
		uri,
		statement = 'Sign in to Swarm ID',
		nonce = crypto.randomUUID(),
		issuedAt = new Date().toISOString(),
	} = params

	// EIP-4361 formatted message
	const message = [
		`${domain} wants you to sign in with your Ethereum account:`,
		address,
		'',
		statement,
		'',
		`URI: ${uri}`,
		`Version: 1`,
		`Chain ID: 1`, // Ethereum mainnet
		`Nonce: ${nonce}`,
		`Issued At: ${issuedAt}`,
	].join('\n')

	return message
}

/**
 * Sign a SIWE message with the connected wallet
 *
 * The signature is then hashed to create a deterministic master key
 */
export async function signSIWEMessage(params: {
	signer: JsonRpcSigner
	address: string
}): Promise<SignedMessage> {
	const { signer, address } = params

	// Create SIWE message
	const message = createSIWEMessage({
		address,
		domain: window.location.host,
		uri: window.location.origin,
	})

	try {
		// Sign the message
		console.log('📝 Requesting signature...')
		const signature = await signer.signMessage(message)
		const digest = hashMessage(message)
		const publicKey = SigningKey.recoverPublicKey(digest, signature)

		return {
			message,
			digest,
			signature,
			publicKey,
			address,
		}
	} catch (error) {
		if (error instanceof Error) {
			if (error.message.includes('User rejected') || error.message.includes('user rejected')) {
				throw new Error('Signature rejected by user')
			}
		}
		throw error
	}
}

export function deriveMasterKey(
	secretSeed: string,
	publicKey: string,
): {
	masterKey: string
	masterAddress: string
} {
	const seedHash = hashMessage(secretSeed)
	const masterKey = hashMessage(`${seedHash} ${publicKey}`)
	const signingKey = new SigningKey(masterKey)
	const baseWallet = new BaseWallet(signingKey)
	const masterAddress = baseWallet.address

	return {
		masterKey,
		masterAddress,
	}
}

/**
 * Full flow: Connect wallet and sign SIWE message
 */
export async function connectAndSign(): Promise<SignedMessage> {
	// Step 1: Connect wallet
	if (!window.ethereum) {
		throw new Error('No ethereum wallet found')
	}

	await window.ethereum.send('eth_requestAccounts')

	const provider = new BrowserProvider(window.ethereum)
	const signer = await provider.getSigner()

	// Step 2: Sign SIWE message
	const signed = await signSIWEMessage({
		signer: signer,
		address: signer.address,
	})

	return signed
}
