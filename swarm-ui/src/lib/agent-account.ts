/**
 * Agent account management using BIP39 seed phrases
 * Derives deterministic Ethereum addresses from mnemonic phrases
 */

import { HDNodeWallet, Mnemonic } from 'ethers'
import { EthAddress, Bytes } from '@ethersphere/bee-js'
import type { AgentAccount } from '@swarm-id/lib'

export interface AgentAccountResult {
	ethereumAddress: EthAddress
	masterKey: Bytes
}

export interface CreateAgentAccountOptions {
	name: string
	seedPhrase: string
}

export interface CreateAgentAccountResult {
	account: Omit<AgentAccount, 'swarmEncryptionKey'>
	masterKey: Bytes
}

export type SeedPhraseValidation = { valid: true; phrase: string } | { valid: false; error: string }

/**
 * Validates a BIP39 mnemonic seed phrase
 * Accepts 12 or 24 word phrases
 * Returns the normalized (trimmed, lowercased) phrase when valid
 */
export function validateSeedPhrase(phrase: string): SeedPhraseValidation {
	const trimmed = phrase.trim()

	if (!trimmed) {
		return { valid: false, error: 'Please enter your seed phrase' }
	}

	const normalized = trimmed.toLowerCase()
	const words = normalized.split(/\s+/)

	// Check word count
	if (words.length !== 12 && words.length !== 24) {
		return {
			valid: false,
			error: `Invalid word count: ${words.length}. Must be 12 or 24 words.`,
		}
	}

	// Validate using ethers.js Mnemonic
	try {
		Mnemonic.fromPhrase(normalized)
		return { valid: true, phrase: normalized }
	} catch {
		return {
			valid: false,
			error: 'Invalid mnemonic phrase. Please check that all words are from the BIP39 wordlist.',
		}
	}
}

/**
 * Derives Ethereum address and master key from a BIP39 seed phrase
 */
export function deriveFromSeedPhrase(seedPhrase: string): AgentAccountResult {
	// Validate the phrase first (returns normalized phrase when valid)
	const validation = validateSeedPhrase(seedPhrase)
	if (!validation.valid) {
		throw new Error(validation.error)
	}

	// Derive HD wallet from mnemonic using validated/normalized phrase
	const wallet = HDNodeWallet.fromPhrase(validation.phrase)

	// Use the private key as the master key (32 bytes)
	// Remove '0x' prefix from private key
	const privateKeyHex = wallet.privateKey.slice(2)
	const masterKey = new Bytes(privateKeyHex)

	return {
		ethereumAddress: new EthAddress(wallet.address),
		masterKey,
	}
}

/**
 * Creates a new agent account from a BIP39 seed phrase
 * Note: The seed phrase is NOT stored - it must be re-entered on each authentication
 */
export function createAgentAccount(options: CreateAgentAccountOptions): CreateAgentAccountResult {
	const { ethereumAddress, masterKey } = deriveFromSeedPhrase(options.seedPhrase)

	return {
		account: {
			id: ethereumAddress,
			name: options.name,
			createdAt: Date.now(),
			type: 'agent',
		},
		masterKey,
	}
}

/**
 * Authenticates an agent account by re-entering the seed phrase
 * Verifies the derived address matches the stored account ID
 */
export function authenticateAgentAccount(
	seedPhrase: string,
	expectedAddress: EthAddress,
): AgentAccountResult {
	const result = deriveFromSeedPhrase(seedPhrase)

	// Verify the derived address matches the expected one
	if (result.ethereumAddress.toString() !== expectedAddress.toString()) {
		throw new Error(
			'Seed phrase does not match this account. The derived address differs from the stored account address.',
		)
	}

	return result
}

/**
 * Counts words in a seed phrase (for UI feedback)
 */
export function countSeedPhraseWords(phrase: string): number {
	const trimmed = phrase.trim()
	if (trimmed === '') return 0
	return trimmed.split(/\s+/).length
}
