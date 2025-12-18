import { z } from 'zod'

/**
 * Ethereum address (40 hex characters, with or without 0x prefix)
 */
export const EthAddressSchema = z.string().regex(/^(0x)?[a-fA-F0-9]{40}$/, {
	message: 'Must be a valid Ethereum address (40 hex chars)',
})

/**
 * Unix timestamp in milliseconds
 */
export const TimestampSchema = z.number().int().nonnegative()

/**
 * Batch ID (64 hex characters)
 */
export const BatchIdSchema = z.string().regex(/^[a-fA-F0-9]{64}$/, {
	message: 'BatchID must be exactly 64 hex characters',
})

/**
 * Hex-encoded string (variable length)
 */
export const HexStringSchema = z.string().regex(/^[a-fA-F0-9]*$/, {
	message: 'Must be a valid hex string',
})

/**
 * URL string
 */
export const UrlSchema = z.string().url()

/**
 * Versioned storage wrapper schema
 * Used to check if data is in versioned format
 */
export const VersionedStorageSchema = z.object({
	version: z.number().int().nonnegative(),
	data: z.unknown(),
})
