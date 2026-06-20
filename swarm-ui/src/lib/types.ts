// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Type definitions for Swarm Identity
// Re-exports types from @snaha/swarm-id

import { z } from 'zod'

// ============================================================================
// Re-export types from lib
// ============================================================================

export type { Account, ConnectedApp, PostageStamp } from '@snaha/swarm-id'

export type AccountSyncType = 'local' | 'synced'

// ============================================================================
// App Metadata (used for connection requests - local to swarm-ui)
// ============================================================================

const UrlSchema = z.url()

export const AppDataSchema = z.object({
  appUrl: UrlSchema,
  appName: z.string().min(1).max(100),
  appIcon: z.string().max(10000).optional(),
  appDescription: z.string().max(500).optional(),
})

export type AppData = z.infer<typeof AppDataSchema>
