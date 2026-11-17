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
 *
 * Enforced on receive because one forgetful publisher is expensive on both
 * counts: every partitioned iframe on the account would learn every dApp's
 * secret (the leak the strip exists to prevent), and an entry for the receiving
 * app carrying a live `connectedUntil` with a different secret would drive the
 * reconcile into `authenticateFromStorage`, which drops the hydrated view a
 * partitioned session cannot rebuild without a reload.
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

/** The publishing device. Bounded like every other field on the wire: a
 *  room-mate already holds the account keys and can do far worse, so this is
 *  defense in depth, not a trust boundary. */
const DeviceIdSchema = z.string().min(1).max(100)

/** A context's name on the transport that crosses devices. */
const PeerIdSchema = z.string().min(1).max(100)

/** One claim of a lane: an answer counts only for the claim it names. */
const LaneRoundSchema = z.string().regex(/^[0-9a-f]{16}$/)

const laneFields = {
  accountId: z.string().length(40),
  batchId: z.string().length(64),
  partition: z.number().int().min(0),
  /** The context that sent it. On a transport that names senders, a message
   *  naming another is dropped. */
  from: PeerIdSchema,
  round: LaneRoundSchema,
}

/**
 * A context asks for a lane, a (batch, partition), to write on it. Everyone
 * else in the room answers `lane-free` unless it is writing there or claiming
 * the lane itself under a lower name. The protocol is `sync/bus-lease.ts`.
 */
export const LaneClaimMessageSchema = z.object({
  type: z.literal("lane-claim"),
  ...laneFields,
  /** Asks only whether the lane is held: a holder keeps it, idle or not. */
  gentle: z.boolean().optional(),
})

/**
 * "I am not writing on that lane", to the context whose claim `round` names.
 * From a holder it is the handover: it has stopped writing first.
 */
export const LaneFreeMessageSchema = z.object({
  type: z.literal("lane-free"),
  ...laneFields,
  to: PeerIdSchema,
})

/**
 * "I hold that lane and am keeping it", to the context whose claim `round`
 * names. Nothing depends on it arriving: it tells a claimant that waiting
 * will not free the lane.
 */
export const LaneHeldMessageSchema = z.object({
  type: z.literal("lane-held"),
  ...laneFields,
  to: PeerIdSchema,
})

/**
 * "This device is live." Published on joining the room and every
 * `PRESENCE_INTERVAL_MS` (`presence.ts`); a receiver stamps its own clock, so
 * there is no timestamp to skew and a replay (#604) only refreshes a device it
 * has already heard. A peer on an older bundle drops it at the schema — a new
 * kind, not an envelope change, so nothing to deploy in step.
 */
export const PresenceMessageSchema = z.object({
  type: z.literal("presence"),
  accountId: z.string().length(40),
  fromDeviceId: DeviceIdSchema,
})

export const BusMessageSchema = z.discriminatedUnion("type", [
  UtilizationUpdateMessageSchema,
  AccountDeltaMessageSchema,
  LaneClaimMessageSchema,
  LaneFreeMessageSchema,
  LaneHeldMessageSchema,
  PresenceMessageSchema,
])

export type AccountDeltaMessage = z.infer<typeof AccountDeltaMessageSchema>
/** The wire form of a delta: hex strings, not revived `BatchId`/`PrivateKey`. */
export type AccountDeltaInput = z.input<typeof AccountDeltaMessageSchema>
export type BusMessage = z.infer<typeof BusMessageSchema>
/** What publishers hand to the bus: the JSON-serializable wire form. */
export type BusMessageInput = z.input<typeof BusMessageSchema>
