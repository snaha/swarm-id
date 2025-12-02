/**
 * Ethereum Wallet Integration for Swarm ID
 *
 * Provides functions for connecting to Ethereum wallets (MetaMask, WalletConnect, etc.)
 * and implementing Sign-In with Ethereum (SIWE) for account creation.
 */

import { BrowserProvider, JsonRpcSigner, hashMessage, SigningKey, BaseWallet } from 'ethers'
import { createWeb3Modal, defaultConfig } from '@web3modal/ethers'

export interface EthereumProvider {
	request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
	on?: (event: string, callback: (...args: unknown[]) => void) => void
	removeListener?: (event: string, callback: (...args: unknown[]) => void) => void
}

// Web3Modal instance (singleton)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let web3Modal: any | undefined

/**
 * Initialize Web3Modal
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getWeb3Modal(): any {
	if (web3Modal) {
		return web3Modal
	}

	// WalletConnect Project ID - Optional, uses placeholder if not set
	// Get your own at https://cloud.walletconnect.com
	const projectId = import.meta.env.PUBLIC_WALLETCONNECT_PROJECT_ID || 'placeholder-project-id'

	// Metadata for the app
	const metadata = {
		name: 'Swarm ID',
		description: 'Swarm Identity Management',
		url: window.location.origin,
		icons: ['https://avatars.githubusercontent.com/u/34437435'],
	}

	// Ethereum mainnet config
	const chains = [
		{
			chainId: 1,
			name: 'Ethereum',
			currency: 'ETH',
			explorerUrl: 'https://etherscan.io',
			rpcUrl: 'https://cloudflare-eth.com',
		},
	]

	const ethersConfig = defaultConfig({
		metadata,
		enableEIP6963: true, // Enable EIP-6963 for multi-wallet support
		enableInjected: true, // Enable injected wallets (MetaMask, etc.)
		enableCoinbase: true, // Enable Coinbase Wallet
		defaultChainId: 1,
	})

	web3Modal = createWeb3Modal({
		ethersConfig,
		chains,
		projectId,
		enableAnalytics: false,
	})

	return web3Modal
}

export interface WalletConnection {
	address: string
	provider: BrowserProvider
	signer: JsonRpcSigner
}

export interface SignedMessage {
	message: string
	signature: string
	address: string
	masterKey: string
	masterAddress: string
}

/**
 * Check if Ethereum provider is available (e.g., MetaMask)
 */
export function isEthereumProviderAvailable(): boolean {
	return typeof window !== 'undefined' && 'ethereum' in window
}

/**
 * Get the Ethereum provider from window
 */
export function getEthereumProvider(): EthereumProvider | undefined {
	if (!isEthereumProviderAvailable()) {
		return undefined
	}
	return (window as unknown as Window & { ethereum: EthereumProvider }).ethereum
}

/**
 * Connect to Ethereum wallet using Web3Modal
 *
 * Opens a modal UI allowing users to connect via:
 * - MetaMask (browser extension)
 * - WalletConnect (mobile wallets via QR code)
 * - Coinbase Wallet
 * - Other supported wallets
 */
export async function connectWallet(): Promise<WalletConnection> {
	try {
		// Get or initialize Web3Modal
		const modal = getWeb3Modal()

		// Open the modal and wait for user to connect
		await modal.open()

		// Wait for connection
		const walletProvider = await modal.getWalletProvider()
		if (!walletProvider) {
			throw new Error('No wallet provider available after connection')
		}

		// Create ethers provider
		const provider = new BrowserProvider(walletProvider)
		const signer = await provider.getSigner()
		const address = await signer.getAddress()

		console.log('✅ Connected to wallet:', address)

		// Close modal after successful connection
		modal.close()

		return {
			address,
			provider,
			signer,
		}
	} catch (error) {
		if (error instanceof Error) {
			if (error.message.includes('User rejected') || error.message.includes('rejected')) {
				throw new Error('Wallet connection rejected by user')
			}
		}
		throw error
	}
}

/**
 * Disconnect wallet
 */
export async function disconnectWallet(): Promise<void> {
	if (web3Modal) {
		await web3Modal.disconnect()
	}
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
	secretSeed: string
}): Promise<SignedMessage> {
	const { signer, address, secretSeed } = params

	// Create SIWE message
	const message = createSIWEMessage({
		address,
		domain: window.location.host,
		uri: window.location.origin,
		statement: `Sign in to Swarm ID. Secret seed: ${secretSeed}`,
	})

	try {
		// Sign the message
		console.log('📝 Requesting signature...')
		const signature = await signer.signMessage(message)
		const digest = hashMessage(message)
		const publicKey = SigningKey.recoverPublicKey(digest, signature)
		const seedHash = hashMessage(secretSeed)
		const masterKey = hashMessage(`${seedHash} ${publicKey}`)
		const signingKey = new SigningKey(masterKey)
		const baseWallet = new BaseWallet(signingKey)
		const masterAddress = baseWallet.address

		console.log('🔑 Master key derived from signature:', masterKey.substring(0, 16) + '...')

		return {
			message,
			signature,
			address,
			masterKey,
			masterAddress,
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

/**
 * Full flow: Connect wallet and sign SIWE message
 */
export async function connectAndSign(params: {
	secretSeed: string
}): Promise<SignedMessage & { address: string }> {
	// Step 1: Connect wallet
	const wallet = await connectWallet()

	// Step 2: Sign SIWE message
	const signed = await signSIWEMessage({
		signer: wallet.signer,
		address: wallet.address,
		secretSeed: params.secretSeed,
	})

	return signed
}

async function isConnected() {
	const ethereum = getEthereumProvider()
	if (!ethereum) {
		return false
	}
	const accounts = (await ethereum.request({ method: 'eth_accounts' })) as Array<string>
	if (accounts.length) {
		return true
	} else {
		return false
	}
}
