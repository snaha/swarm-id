import { z } from 'zod'
import { browser } from '$app/environment'
import { BatchIdSchema, TimestampSchema, VersionedStorageSchema } from '$lib/schemas/base'

// ============================================================================
// Schema & Types
// ============================================================================

const STORAGE_KEY = 'swarm-postage-stamps'
const CURRENT_VERSION = 1

const PostageStampSchemaV1 = z.object({
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
// Storage (versioned)
// ============================================================================

function loadPostageStamps(): PostageStamp[] {
	if (!browser) return []
	const stored = localStorage.getItem(STORAGE_KEY)
	if (!stored) return []

	try {
		const parsed: unknown = JSON.parse(stored)
		return parse(parsed)
	} catch (e) {
		console.error('[PostageStamps] Load failed:', e)
		return []
	}
}

function parse(parsed: unknown): PostageStamp[] {
	const versioned = VersionedStorageSchema.safeParse(parsed)
	const version = versioned.success ? versioned.data.version : 0
	const data = versioned.success ? versioned.data.data : parsed

	switch (version) {
		case 0: // Legacy unversioned data
		case 1: {
			const result = z.array(PostageStampSchemaV1).safeParse(data)
			if (!result.success) {
				console.error('[PostageStamps] Invalid data:', result.error.format())
				return []
			}
			return result.data
		}
		default:
			console.error(`[PostageStamps] Unknown version: ${version}`)
			return []
	}
}

function savePostageStamps(data: PostageStamp[]): void {
	if (!browser) return
	localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: CURRENT_VERSION, data }))
}

// ============================================================================
// Reactive Store
// ============================================================================

let postageStamps = $state<PostageStamp[]>(loadPostageStamps())

export const postageStampsStore = {
	get stamps() {
		return postageStamps
	},

	addStamp(stamp: Omit<PostageStamp, 'createdAt'>): PostageStamp {
		const newStamp: PostageStamp = {
			...stamp,
			createdAt: Date.now(),
		}
		postageStamps = [...postageStamps, newStamp]
		savePostageStamps(postageStamps)
		return newStamp
	},

	removeStamp(batchID: string) {
		postageStamps = postageStamps.filter((s) => s.batchID !== batchID)
		savePostageStamps(postageStamps)
	},

	getStamp(batchID: string): PostageStamp | undefined {
		return postageStamps.find((s) => s.batchID === batchID)
	},

	getStampsByIdentity(identityId: string): PostageStamp[] {
		return postageStamps.filter((s) => s.identityId === identityId)
	},

	clear() {
		postageStamps = []
		if (browser) localStorage.removeItem(STORAGE_KEY)
	},
}
