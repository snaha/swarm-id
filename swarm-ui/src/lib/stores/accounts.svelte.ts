export type Account = {
	id: string
	name: string
	type: 'passkey' | 'ethereum'
	masterKey: string
	ethereumAddress?: string
	createdAt: number
}

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

	addAccount(account: Omit<Account, 'id' | 'createdAt'>): Account {
		const newAccount: Account = {
			...account,
			id: crypto.randomUUID(),
			createdAt: Date.now(),
		}
		accounts = [...accounts, newAccount]
		saveAccounts(accounts)
		return newAccount
	},

	removeAccount(id: string) {
		accounts = accounts.filter((a) => a.id !== id)
		saveAccounts(accounts)
	},

	getAccount(id: string): Account | undefined {
		return accounts.find((a) => a.id === id)
	},

	clear() {
		accounts = []
		saveAccounts(accounts)
	},
}
