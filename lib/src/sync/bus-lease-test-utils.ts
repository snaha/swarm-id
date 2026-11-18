// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Stand-ins for the account bus in lane tests. */

import {
  BusMessageSchema,
  type BusMessage,
  type BusMessageInput,
} from "../bus/messages"
import { BusLanes, type LaneBus, type LaneLiveness } from "./bus-lease"

/** Liveness answers set by the test, standing in for the signaling room. */
export class FakeLiveness implements LaneLiveness {
  confirmedAgo = 0
  /** How long everybody outside `present` has been gone. */
  absentFor = Infinity
  /** Devices in the room right now. */
  present = new Set<string>()
  private handlers = new Set<(unconfirmedForMs: number) => void>()

  constructor(public id: string | undefined) {}

  selfId(): string | undefined {
    return this.id
  }

  confirmedAgoMs(): number {
    return this.confirmedAgo
  }

  absentExceptMs(deviceIds: ReadonlySet<string>): number {
    for (const device of this.present) {
      if (!deviceIds.has(device)) return 0
    }
    return this.absentFor
  }

  onConfirmed(handler: (unconfirmedForMs: number) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  /** A round trip with the server completes after `gapMs` without one. */
  confirm(gapMs = 0): void {
    this.confirmedAgo = 0
    for (const handler of this.handlers) handler(gapMs)
  }
}

/** The signaling server's tick. */
const SOLO_CONFIRM_MS = 2000

/** A room of contexts whose published messages reach everyone else. */
export function makeRoom() {
  const members: {
    id: string
    liveness: FakeLiveness
    handlers: Set<(message: BusMessage, from?: string) => void>
  }[] = []
  /** Hand `message` to `to` as if the transport had it from `from`. */
  const deliverTo = (to: string, message: BusMessageInput, from: string) => {
    const parsed = BusMessageSchema.parse(message)
    for (const member of members) {
      if (member.id !== to) continue
      for (const handler of member.handlers) handler(parsed, from)
    }
  }
  const join = (id: string): LaneBus & { liveness: FakeLiveness } => {
    const liveness = new FakeLiveness(id)
    const handlers = new Set<(message: BusMessage, from?: string) => void>()
    for (const member of members) {
      member.liveness.present.add(id)
      liveness.present.add(member.id)
    }
    members.push({ id, liveness, handlers })
    return {
      liveness,
      selfId: () => liveness.selfId(),
      confirmedAgoMs: () => liveness.confirmedAgoMs(),
      absentExceptMs: (ids) => liveness.absentExceptMs(ids),
      onConfirmed: (handler) => liveness.onConfirmed(handler),
      publish: (message) => {
        for (const member of members) {
          if (member.id !== id) deliverTo(member.id, message, id)
        }
      },
      subscribe: (handler) => {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
    }
  }
  return { join, deliverTo }
}

/** The lanes of a context that is alone in its room: every claim succeeds at
 *  once. For a process with no account bus that still has to write. */
export function soloLanes(): BusLanes {
  const bus = makeRoom().join("solo")
  // Confirmed on the server's beat, as a real connection is: a holder may
  // stamp only for a while after each confirmation, and an upload outlasts it.
  const beat = setInterval(() => bus.liveness.confirm(), SOLO_CONFIRM_MS)
  beat.unref?.()
  return new BusLanes(bus)
}
