import { z } from 'zod'
import { browser } from '$app/environment'
import {
	EthAddressSchema,
	TimestampSchema,
	HexStringSchema,
	VersionedStorageSchema,
} from '$lib/schemas/base'

// ============================================================================
// Schema & Types
// ============================================================================

const STORAGE_KEY = 'swarm-accounts'
const CURRENT_VERSION = 1

const AccountBaseSchema = z.object({
	id: EthAddressSchema,
	name: z.string().min(1).max(100),
	createdAt: TimestampSchema,
})

const PasskeyAccountSchema = AccountBaseSchema.extend({
	type: z.literal('passkey'),
	credentialId: z.string().min(1),
})

const EthereumAccountSchema = AccountBaseSchema.extend({
	type: z.literal('ethereum'),
	ethereumAddress: EthAddressSchema,
	encryptedMasterKey: HexStringSchema.min(1),
	encryptionSalt: HexStringSchema.min(1),
})

const AccountSchemaV1 = z.discriminatedUnion('type', [PasskeyAccountSchema, EthereumAccountSchema])

export type Account = z.infer<typeof AccountSchemaV1>

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

function saveAccounts(data: Account[]): void {
	if (!browser) return
	localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: CURRENT_VERSION, data }))
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

	removeAccount(id: string) {
		accounts = accounts.filter((a) => a.id !== id)
		saveAccounts(accounts)
	},

	getAccount(id: string): Account | undefined {
		return accounts.find((a) => a.id === id)
	},

	setAccountName(id: string, name: string) {
		accounts = accounts.map((account) => (account.id === id ? { ...account, name } : account))
		saveAccounts(accounts)
	},

	clear() {
		accounts = []
		if (browser) localStorage.removeItem(STORAGE_KEY)
	},
}
