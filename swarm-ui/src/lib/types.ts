// Type definitions for Swarm Identity

export type Identity = {
	id: string
	accountId: string
	name: string
	defaultPostageStampBatchID?: string
	createdAt: number
}

type AccountBase = {
	id: string // an ethereum address
	name: string
	createdAt: number
}

export type PasskeyAccount = AccountBase & {
	type: 'passkey'
	credentialId: string // WebAuthn credential ID
	// No masterKey stored - retrieved via passkey re-authentication
}

export type EthereumAccount = AccountBase & {
	type: 'ethereum'
	ethereumAddress: string
	encryptedMasterKey: string // AES-GCM encrypted masterKey
	encryptionSalt: string // HKDF salt (hex string)
}

export type Account = PasskeyAccount | EthereumAccount

export type AppData = {
	appUrl: string
	appName: string
	appIcon?: string
	appDescription?: string
}

export type ConnectedApp = AppData & {
	lastConnectedAt: number
	identityId: string
}

export type PostageStamp = {
	identityId: string
	batchID: string
	utilization: number
	usable: boolean
	depth: number
	amount: string
	bucketDepth: number
	blockNumber: number
	immutableFlag: boolean
	exists: boolean
	batchTTL?: number
	createdAt: number
}
