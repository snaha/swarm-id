// Type definitions for Swarm Identity
// Types are derived from Zod schemas (single source of truth)

import { z } from 'zod'
import {
	UrlSchema,
	EthAddressSchema,
	BatchIdSchema,
	TimestampSchema,
	HexStringSchema,
} from './schemas'
import { DAY } from './time'

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_SESSION_DURATION = 30 * DAY

// ============================================================================
// Account Schemas & Types
// ============================================================================

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
	encryptedMasterKey: HexStringSchema,
	encryptionSalt: HexStringSchema,
})

export const AccountSchemaV1 = z.discriminatedUnion('type', [
	PasskeyAccountSchema,
	EthereumAccountSchema,
])

export type Account = z.infer<typeof AccountSchemaV1>

// ============================================================================
// Identity Schemas & Types
// ============================================================================

const IdentitySettingsSchemaV1 = z.object({
	appSessionDuration: z.number().optional(),
})

export const IdentitySchemaV1 = z.object({
	id: z.string().min(1),
	accountId: EthAddressSchema,
	name: z.string().min(1).max(100),
	defaultPostageStampBatchID: BatchIdSchema.optional(),
	createdAt: TimestampSchema,
	settings: IdentitySettingsSchemaV1.optional(),
})

export type Identity = z.infer<typeof IdentitySchemaV1>

// ============================================================================
// Connected App Schemas & Types
// ============================================================================

export const ConnectedAppSchemaV1 = z.object({
	appUrl: UrlSchema,
	appName: z.string().min(1).max(100),
	lastConnectedAt: TimestampSchema,
	identityId: z.string().min(1),
	appIcon: z.string().max(10000).optional(),
	appDescription: z.string().max(500).optional(),
	connectedUntil: TimestampSchema.optional(),
})

export type ConnectedApp = z.infer<typeof ConnectedAppSchemaV1>

// ============================================================================
// Postage Stamp Schemas & Types
// ============================================================================

export const PostageStampSchemaV1 = z.object({
	identityId: z.string().min(1),
	batchID: BatchIdSchema,
	utilization: z.number().min(0).max(100),
	usable: z.boolean(),
	depth: z.number().int().nonnegative(),
	amount: z.string(), // BigInt as string
	bucketDepth: z.number().int().nonnegative(),
	blockNumber: z.number().int().nonnegative(),
	immutableFlag: z.boolean(),
	exists: z.boolean(),
	batchTTL: z.number().int().nonnegative().optional(),
	createdAt: TimestampSchema,
})

export type PostageStamp = z.infer<typeof PostageStampSchemaV1>

// ============================================================================
// App Metadata (used for connection requests)
// ============================================================================

export const AppDataSchema = z.object({
	appUrl: UrlSchema,
	appName: z.string().min(1).max(100),
	appIcon: z.string().max(10000).optional(),
	appDescription: z.string().max(500).optional(),
})

export type AppData = z.infer<typeof AppDataSchema>
