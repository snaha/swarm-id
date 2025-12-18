// Type definitions for Swarm Identity
// Types are derived from Zod schemas (single source of truth)

import { z } from 'zod'
import { UrlSchema } from './schemas'

// Re-export all types from stores
export type { Account } from './stores/accounts.svelte'
export type { Identity } from './stores/identities.svelte'
export type { ConnectedApp } from './stores/connected-apps.svelte'
export type { PostageStamp } from './stores/postage-stamps.svelte'

// App metadata (used for connection requests before identity is assigned)
export const AppDataSchema = z.object({
	appUrl: UrlSchema,
	appName: z.string().min(1).max(100),
	appIcon: z.string().max(10000).optional(),
	appDescription: z.string().max(500).optional(),
})

export type AppData = z.infer<typeof AppDataSchema>
