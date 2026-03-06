/**
 * Swarm ID Export/Import Module
 *
 * Provides serialization and deserialization for the .swarmid export format.
 * Security: appSecret is structurally excluded from the schema so Zod strips
 * it during parsing, preventing maliciously crafted imports from injecting
 * fake app secrets.
 */

import { z } from "zod"
import {
  AccountSchemaV1,
  IdentitySchemaV1,
  ConnectedAppSchemaV1,
  PostageStampSchemaV1,
} from "../schemas"
import type { Account, Identity, ConnectedApp, PostageStamp } from "../schemas"
import {
  serializeAccount,
  serializeIdentity,
  serializeConnectedApp,
  serializePostageStamp,
} from "./storage-managers"

// ============================================================================
// Constants
// ============================================================================

const SWARM_ID_EXPORT_VERSION = 1

// ============================================================================
// Schemas
// ============================================================================

/**
 * Connected app schema for export — omits appSecret (derivable via HMAC-SHA256).
 * Zod v4 strips unknown keys by default, so any appSecret in input is silently dropped.
 */
const ExportedConnectedAppSchemaV1 = ConnectedAppSchemaV1.omit({
  appSecret: true,
})

/**
 * Top-level schema for .swarmid export files.
 */
export const SwarmIdExportSchemaV1 = z.object({
  version: z.literal(SWARM_ID_EXPORT_VERSION),
  account: AccountSchemaV1,
  identities: z.array(IdentitySchemaV1),
  connectedApps: z.array(ExportedConnectedAppSchemaV1),
  postageStamps: z.array(PostageStampSchemaV1),
})

// ============================================================================
// Types
// ============================================================================

export type SwarmIdExport = z.infer<typeof SwarmIdExportSchemaV1>

export type ExportedConnectedApp = z.infer<typeof ExportedConnectedAppSchemaV1>

export type SwarmIdImportResult =
  | { success: true; data: SwarmIdExport }
  | { success: false; error: z.ZodError }

// ============================================================================
// Serialize
// ============================================================================

/**
 * Serialize account data into a plain object suitable for JSON export.
 * Strips appSecret from connected apps to prevent leaking derivable secrets.
 */
export function serializeSwarmIdExport(
  account: Account,
  identities: Identity[],
  connectedApps: ConnectedApp[],
  postageStamps: PostageStamp[],
): Record<string, unknown> {
  return {
    version: SWARM_ID_EXPORT_VERSION,
    account: serializeAccount(account),
    identities: identities.map(serializeIdentity),
    connectedApps: connectedApps.map((app) => {
      const { appSecret: _, ...rest } = serializeConnectedApp(app)
      return rest
    }),
    postageStamps: postageStamps.map(serializePostageStamp),
  }
}

// ============================================================================
// Deserialize
// ============================================================================

/**
 * Deserialize and validate a .swarmid export file.
 * Returns a discriminated union: success with parsed data, or failure with Zod error.
 * Any appSecret injected in the raw data is stripped by the schema.
 */
export function deserializeSwarmIdExport(data: unknown): SwarmIdImportResult {
  const result = SwarmIdExportSchemaV1.safeParse(data)

  if (!result.success) {
    return { success: false, error: result.error }
  }

  return { success: true, data: result.data }
}
