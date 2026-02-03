import { browser } from '$app/environment'
import { EthAddress, BatchId } from '@ethersphere/bee-js'
import { createAccountsStorageManager, type Account } from '@swarm-id/lib'
import { triggerSync } from '$lib/utils/sync-hooks'

// ============================================================================
// Storage Manager
// ============================================================================

const storageManager = createAccountsStorageManager()

function loadAccounts(): Account[] {
	if (!browser) return []
	return storageManager.load()
}

function saveAccounts(data: Account[], accountId?: string): void {
	storageManager.save(data)

	if (accountId) {
		triggerSync(accountId)
	}
}

// ============================================================================
// Reactive Store
// ============================================================================

let accounts = $state<Account[]>(loadAccounts())

// Subscribe to cross-tab storage changes (fires in OTHER tabs when localStorage changes)
if (browser) {
	storageManager.subscribe((updatedData) => {
		accounts = updatedData
	})
}

export const accountsStore = {
	get accounts() {
		return accounts
	},

	addAccount(account: Account): Account {
		accounts = [...accounts, account]
		saveAccounts(accounts, account.id.toHex())
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
		saveAccounts(accounts, id.toHex())
	},

	setDefaultStamp(id: EthAddress, batchID: BatchId | undefined) {
		accounts = accounts.map((account) =>
			account.id.equals(id)
				? {
						...account,
						defaultPostageStampBatchID: batchID,
					}
				: account,
		)
		saveAccounts(accounts, id.toHex())
	},

	clear() {
		accounts = []
		storageManager.clear()
	},
}
