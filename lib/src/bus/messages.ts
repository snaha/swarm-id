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
  ConnectedAppSchemaV1,
  UtilizationUpdateMessageSchema,
} from "../schemas"

/**
 * A connected app as it travels the bus: without the per-context session
 * material. Zod drops unknown keys, so this `.omit` enforces the strip on
 * receive — a publisher that forgets it still has `appSecret` and
 * `connectedUntil` removed here, before any receiver sees them.
 */
const BusConnectedAppSchema = ConnectedAppSchemaV1.omit({
  appSecret: true,
  connectedUntil: true,
})

/**
 * A full account-state snapshot from another live context. Merged with the
 * same LWW primitives as a device-state feed payload, minus the session
 * material above.
 */
export const AccountDeltaMessageSchema = z.object({
  type: z.literal("account-delta"),
  snapshot: AccountStateSnapshotSchemaV1.extend({
    connectedApps: z.array(BusConnectedAppSchema),
  }),
})

/** One slot-wait round, as every holder must read it: lower-case hex of a
 *  fixed width, so `parseInt(_, 16)` is a number for all of them or the
 *  message never reaches a handler. */
const LeaseRequestIdSchema = z.string().regex(/^[0-9a-f]{8}$/)

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
 * answered by every idle holder, as it was before — but a present one is
 * format-checked: the rank is `parseInt(requestId, 16)`, so an unconstrained
 * string reintroduces the very bug this fixes (`NaN` or a negative collapses
 * every holder onto the same rank), silently and with nothing to diagnose.
 */
export const LeaseRequestMessageSchema = z.object({
  type: z.literal("lease-request"),
  accountId: z.string().length(40),
  fromDeviceId: z.string(),
  requestId: LeaseRequestIdSchema.optional(),
})

/**
 * The holder that drew the lowest rank for `requestId` is answering it. Sent
 * BEFORE the release starts, because the release itself is two stamped Swarm
 * writes — an order of magnitude longer than the rank step — so a signal sent
 * after it would reach the other holders only once they had all begun yielding
 * too, which is #576 again. Holders further down the order stand down on this;
 * the waiter ignores it (no slot is free yet).
 */
export const LeaseClaimMessageSchema = z.object({
  type: z.literal("lease-claim"),
  accountId: z.string().length(40),
  fromDeviceId: z.string(),
  requestId: LeaseRequestIdSchema,
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
  requestId: LeaseRequestIdSchema.optional(),
})

export const BusMessageSchema = z.discriminatedUnion("type", [
  UtilizationUpdateMessageSchema,
  AccountDeltaMessageSchema,
  LeaseRequestMessageSchema,
  LeaseClaimMessageSchema,
  LeaseReleasedMessageSchema,
])

export type AccountDeltaMessage = z.infer<typeof AccountDeltaMessageSchema>
/** The wire form of a delta: hex strings, not revived `BatchId`/`PrivateKey`. */
export type AccountDeltaInput = z.input<typeof AccountDeltaMessageSchema>
export type BusMessage = z.infer<typeof BusMessageSchema>
/** What publishers hand to the bus: the JSON-serializable wire form. */
export type BusMessageInput = z.input<typeof BusMessageSchema>
