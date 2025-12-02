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
	// No masterKey stored - retrieved via passkey re-authentication
}

export type EthereumAccount = AccountBase & {
	type: 'ethereum'
	ethereumAddress: string
	encryptedMasterKey: string // AES-GCM encrypted masterKey
	encryptionSalt: string // HKDF salt (hex string)
}

export type Account = PasskeyAccount | EthereumAccount

export type ConnectedApp = {
	appUrl: string
	appName: string
	lastConnectedAt: number
	identityId: string
	favicon?: string
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

// Distributive Omit that preserves discriminated unions
// TypeScript's built-in Omit doesn't distribute over unions, which breaks
// discriminated unions. This helper applies Omit to each union member separately.
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
