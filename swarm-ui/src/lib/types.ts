// Type definitions for Swarm Identity
// Re-exports types from @swarm-id/lib

import { z } from 'zod'

// ============================================================================
// Re-export types from lib
// ============================================================================

export type { Account, Identity, ConnectedApp, PostageStamp } from '@swarm-id/lib'

export type AccountSyncType = 'local' | 'synced'

// ============================================================================
// App Metadata (used for connection requests - local to swarm-ui)
// ============================================================================

const UrlSchema = z.string().url()

export const AppDataSchema = z.object({
  appUrl: UrlSchema,
  appName: z.string().min(1).max(100),
  appIcon: z.string().max(10000).optional(),
  appDescription: z.string().max(500).optional(),
})

export type AppData = z.infer<typeof AppDataSchema>
