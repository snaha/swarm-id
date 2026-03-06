// Session store for tracking current account/identity creation flow

import type { Account, AppData } from '$lib/types'
import type { EncryptedSwarmIdExport } from '@swarm-id/lib'
import { Bytes } from '@ethersphere/bee-js'

export type SessionData = {
	// Account during creation flow (ready to be persisted)
	account?: Account

	// Temporary masterKey during account/identity creation flow
	// Cleared immediately after identity is created
	temporaryMasterKey?: Bytes

	// Active account and identity
	currentAccountId?: string
	currentIdentityId?: string

	// Creation flow: whether account is being created as synced
	isSyncedCreation?: boolean

	// Stamp flow: tracks whether user chose 'account' or 'separate' stamp
	selectedStampOption?: 'account' | 'separate'

	// App data
	appData?: AppData
	appOrigin?: string

	// Import flow
	importFileData?: unknown
	importHeader?: EncryptedSwarmIdExport
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

	setTemporaryMasterKey(masterKey: Bytes | string) {
		const key = masterKey instanceof Bytes ? masterKey : new Bytes(masterKey)
		session = { ...session, temporaryMasterKey: key }
	},

	clearTemporaryMasterKey() {
		session = { ...session, temporaryMasterKey: undefined }
	},

	setAppOrigin(appOrigin: string) {
		session = { ...session, appOrigin }
	},

	clearAppOrigin() {
		session = { ...session, appOrigin: undefined }
	},

	setAppData(appData: AppData) {
		session = { ...session, appData }
	},

	clearAppData() {
		session = { ...session, appData: undefined }
	},

	setImportData(fileData: unknown, header: EncryptedSwarmIdExport) {
		session = { ...session, importFileData: fileData, importHeader: header }
	},

	clearImportData() {
		session = { ...session, importFileData: undefined, importHeader: undefined }
	},

	setSyncedCreation(synced: boolean) {
		session = { ...session, isSyncedCreation: synced }
	},

	setStampOption(option: 'account' | 'separate') {
		session = { ...session, selectedStampOption: option }
	},

	clearStampOption() {
		session = { ...session, selectedStampOption: undefined }
	},

	clear() {
		session = {}
	},
}
