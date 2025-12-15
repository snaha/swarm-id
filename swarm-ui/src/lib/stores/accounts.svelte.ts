import type { Account } from '$lib/types'

const STORAGE_KEY = 'swarm-accounts'

// Load accounts from localStorage
function loadAccounts(): Account[] {
	if (typeof window === 'undefined') return []
	const stored = localStorage.getItem(STORAGE_KEY)
	return stored ? JSON.parse(stored) : []
}

// Save accounts to localStorage
function saveAccounts(accounts: Account[]) {
	if (typeof window === 'undefined') return
	localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts))
}

// Reactive state using Svelte 5 runes
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
		saveAccounts(accounts)
	},
}
