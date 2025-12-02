// Session store for tracking current account/identity creation flow

import type { Account, DistributiveOmit } from '$lib/types'

export type SessionData = {
	// Account during creation flow (ready to be persisted)
	account?: Account

	// Temporary masterKey during account/identity creation flow
	// Cleared immediately after identity is created
	temporaryMasterKey?: string

	// Active account and identity
	currentAccountId?: string
	currentIdentityId?: string
}

// Reactive state using Svelte 5 runes
let session = $state<SessionData>({})

export const sessionStore = {
	get data() {
		return session
	},

	setAccount(account: Account) {
		session = { ...session, account }
	},

	clearAccount() {
		session = {
			currentAccountId: session.currentAccountId,
			currentIdentityId: session.currentIdentityId,
		}
	},

	setCurrentAccount(accountId: string) {
		session = { ...session, currentAccountId: accountId }
	},

	setCurrentIdentity(identityId: string) {
		session = { ...session, currentIdentityId: identityId }
	},

	setTemporaryMasterKey(masterKey: string) {
		session = { ...session, temporaryMasterKey: masterKey }
	},

	clearTemporaryMasterKey() {
		session = { ...session, temporaryMasterKey: undefined }
	},

	clear() {
		session = {}
	},
}
