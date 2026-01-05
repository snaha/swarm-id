import { z } from 'zod'
import { browser } from '$app/environment'
import { EthAddress } from '@ethersphere/bee-js'
import { VersionedStorageSchema } from '$lib/schemas'
import { type Account, AccountSchemaV1 } from '$lib/types'

// ============================================================================
// Storage
// ============================================================================

const STORAGE_KEY = 'swarm-accounts'
const CURRENT_VERSION = 1

// ============================================================================
// Storage (versioned)
// ============================================================================

function loadAccounts(): Account[] {
	if (!browser) return []
	const stored = localStorage.getItem(STORAGE_KEY)
	if (!stored) return []

	try {
		const parsed: unknown = JSON.parse(stored)
		return parse(parsed)
	} catch (e) {
		console.error('[Accounts] Load failed:', e)
		return []
	}
}

function parse(parsed: unknown): Account[] {
	const versioned = VersionedStorageSchema.safeParse(parsed)
	const version = versioned.success ? versioned.data.version : 0
	const data = versioned.success ? versioned.data.data : parsed

	switch (version) {
		case 0: // Legacy unversioned data
		case 1: {
			const result = z.array(AccountSchemaV1).safeParse(data)
			if (!result.success) {
				console.error('[Accounts] Invalid data:', result.error.format())
				return []
			}
			return result.data
		}
		default:
			console.error(`[Accounts] Unknown version: ${version}`)
			return []
	}
}

/**
 * Serialize account for storage (convert Bytes instances to hex strings)
 */
function serializeAccount(account: Account): Record<string, unknown> {
	const base = {
		id: account.id.toHex(),
		name: account.name,
		createdAt: account.createdAt,
		type: account.type,
	}

	if (account.type === 'passkey') {
		return { ...base, credentialId: account.credentialId }
	} else {
		return {
			...base,
			ethereumAddress: account.ethereumAddress.toHex(),
			encryptedMasterKey: account.encryptedMasterKey.toHex(),
			encryptionSalt: account.encryptionSalt.toHex(),
		}
	}
}

function saveAccounts(data: Account[]): void {
	if (!browser) return
	const serialized = data.map(serializeAccount)
	localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: CURRENT_VERSION, data: serialized }))
}

// ============================================================================
// Reactive Store
// ============================================================================

let accounts = $state<Account[]>(loadAccounts())

export const accountsStore = {
	get accounts() {
		return accounts
	},

	addAccount(account: Account): Account {
		accounts = [...accounts, account]
		saveAccounts(accounts)
		return account
	},

	removeAccount(id: EthAddress) {
		accounts = accounts.filter((a) => !a.id.equals(id))
		saveAccounts(accounts)
	},

	getAccount(id: EthAddress): Account | undefined {
		return accounts.find((a) => a.id.equals(id))
	},

	setAccountName(id: EthAddress, name: string) {
		accounts = accounts.map((account) => (account.id.equals(id) ? { ...account, name } : account))
		saveAccounts(accounts)
	},

	clear() {
		accounts = []
		if (browser) localStorage.removeItem(STORAGE_KEY)
	},
}
