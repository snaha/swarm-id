// Type definitions for Swarm Identity

export type Identity = {
	id: string
	accountId: string
	name: string
	defaultPostageStampBatchID?: string
	createdAt: number
}

export type Account = {
	id: string
	name: string
	type: 'passkey' | 'ethereum'
	masterKey: string
	ethereumAddress?: string
	createdAt: number
}

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
