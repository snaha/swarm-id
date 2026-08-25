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

/**
 * A context waiting for a batch-write partition (all slots held by live
 * peers) asks live holders to yield. An idle holder releases via the normal
 * Swarm lease protocol and answers with `lease-released`; holders mid-write
 * ignore it. Repeats are harmless (yield-if-idle is a guarded no-op).
 *
 * `requestId` is 8 hex chars, fresh per poll round, and exists so exactly one
 * holder answers: each derives the same permutation of the partitions from it
 * and yields at its own rank (`swarm-id-proxy.ts`, `yieldRankDelayMs`). It is
 * optional so a peer on an older bundle still gets served — its request is
 * answered by every idle holder, as it was before.
 */
export const LeaseRequestMessageSchema = z.object({
  type: z.literal("lease-request"),
  accountId: z.string().length(40),
  fromDeviceId: z.string(),
  requestId: z.string().optional(),
})

/**
 * A holder released its partition (on request or teardown) — waiting peers
 * wake their slot poll immediately instead of sleeping out the interval. The
 * lock SOCs on Swarm remain the authority; this is purely a wake-up.
 *
 * `requestId` echoes the `lease-request` this answers, so holders further down
 * the rank order can stand down. Absent on a teardown release, which answers
 * no request.
 */
export const LeaseReleasedMessageSchema = z.object({
  type: z.literal("lease-released"),
  accountId: z.string().length(40),
  partition: z.number().int().min(0),
  fromDeviceId: z.string(),
  requestId: z.string().optional(),
})

export const BusMessageSchema = z.discriminatedUnion("type", [
  UtilizationUpdateMessageSchema,
  AccountDeltaMessageSchema,
  LeaseRequestMessageSchema,
  LeaseReleasedMessageSchema,
])

export type AccountDeltaMessage = z.infer<typeof AccountDeltaMessageSchema>
export type BusMessage = z.infer<typeof BusMessageSchema>
/** What publishers hand to the bus: the JSON-serializable wire form. */
export type BusMessageInput = z.input<typeof BusMessageSchema>
