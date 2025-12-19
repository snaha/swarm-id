import { z } from 'zod'
import { EthAddress, BatchId, Bytes } from '@ethersphere/bee-js'

// =============================================================================
// Typed Schemas (validate and transform to bee-js types)
// =============================================================================

/**
 * Ethereum address - validates and transforms to EthAddress class
 * Accepts 40 hex characters with or without 0x prefix
 */
export const EthAddressSchema = z
	.string()
	.refine(
		(s) => {
			try {
				new EthAddress(s)
				return true
			} catch {
				return false
			}
		},
		{ message: 'Must be a valid Ethereum address (20 bytes)' },
	)
	.transform((s) => new EthAddress(s))

/**
 * Batch ID - validates and transforms to BatchId class
 * Accepts 64 hex characters (32 bytes)
 */
export const BatchIdSchema = z
	.string()
	.refine(
		(s) => {
			try {
				new BatchId(s)
				return true
			} catch {
				return false
			}
		},
		{ message: 'Must be a valid BatchId (32 bytes)' },
	)
	.transform((s) => new BatchId(s))

/**
 * Hex-encoded string - validates and transforms to Bytes class
 * Accepts any valid hex string (with or without 0x prefix)
 */
export const HexStringSchema = z
	.string()
	.min(1, { message: 'Hex string cannot be empty' })
	.refine(
		(s) => {
			try {
				new Bytes(s)
				return true
			} catch {
				return false
			}
		},
		{ message: 'Must be a valid hex string' },
	)
	.transform((s) => new Bytes(s))

// =============================================================================
// Primitive Schemas (no transformation, for simple validation)
// =============================================================================

/**
 * Unix timestamp in milliseconds
 */
export const TimestampSchema = z.number().int().nonnegative()

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
