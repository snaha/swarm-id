// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Account-bus message schemas.
 *
 * Wire format is JSON-serializable (plain objects, hex strings) so the same
 * messages can later travel transports that leave the browser (WebRTC,
 * SWIP-60). Receivers parse with `BusMessageSchema`, which revives typed
 * values (BatchId, PrivateKey, bigint) exactly like the device-state feed
 * payloads do — see `docs/Account-Bus.md`.
 */

import { z } from "zod"

import {
  AccountStateSnapshotSchemaV1,
  UtilizationUpdateMessageSchema,
} from "../schemas"

/**
 * A full account-state snapshot from another live context. Merged with
 * `mergeSnapshotWithRemote`, i.e. exactly like a device-state feed payload.
 */
export const AccountDeltaMessageSchema = z.object({
  type: z.literal("account-delta"),
  snapshot: AccountStateSnapshotSchemaV1,
})

export const BusMessageSchema = z.discriminatedUnion("type", [
  UtilizationUpdateMessageSchema,
  AccountDeltaMessageSchema,
])

export type AccountDeltaMessage = z.infer<typeof AccountDeltaMessageSchema>
export type BusMessage = z.infer<typeof BusMessageSchema>
/** What publishers hand to the bus: the JSON-serializable wire form. */
export type BusMessageInput = z.input<typeof BusMessageSchema>
