// Session store for tracking current account/identity creation flow

export type SessionData = {
	// Temporary data during account creation
	accountName?: string
	accountType?: 'passkey' | 'ethereum'
	masterKey?: string // Credential ID for passkey or derived key for Ethereum
	masterAddress?: string
	ethereumAddress?: string

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

	setAccountCreationData(data: {
		accountName: string
		accountType: 'passkey' | 'ethereum'
		masterKey?: string // Credential ID for passkey or derived key for Ethereum
		masterAddress?: string,
		ethereumAddress?: string
	}) {
		session = { ...session, ...data }
	},

	clearAccountCreationData() {
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

	clear() {
		session = {}
	},
}
