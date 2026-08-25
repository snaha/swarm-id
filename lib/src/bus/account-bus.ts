// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The account bus: a real-time message channel between the live contexts of an
 * account. Today that is the proxy iframes — the only place it is constructed;
 * SwarmID tabs are in scope per `docs/Account-Bus.md` but do not join one, and
 * nothing yet needs them to (they are not batch writers, and account data
 * reaches an unpartitioned iframe through storage events).
 *
 * Durable truth stays in storage; the bus only carries deltas and coordination
 * between live peers. Publishers never receive their own messages back.
 */

import { BusMessageSchema } from "./messages"
import type { BusMessage, BusMessageInput } from "./messages"

/**
 * A transport delivers wire-form messages between contexts; it does not
 * validate them — the bus does, in one place, on receive.
 */
export interface BusTransport {
  /**
   * True when the transport only reaches contexts of this browser profile —
   * i.e. peers that share this device's `deviceId` and therefore its slot
   * lane. `AccountBus.publish(…, { localOnly: true })` uses this to keep
   * lane-scoped traffic off the wire.
   */
  readonly local: boolean
  publish(message: BusMessageInput): void
  subscribe(handler: (raw: unknown) => void): () => void
  close(): void
}

/** Restricts a publish to transports that stay inside this browser profile. */
export interface PublishOptions {
  localOnly?: boolean
}

const CHANNEL_PREFIX = "swarm-id-bus-v1"

/**
 * The one origin-wide topic: every context in this origin+partition. Messages
 * carry their own scoping (batchId, snapshot.accountId). Account-derived,
 * unlinkable topics arrive with the cross-partition transports (phase 2 of
 * `docs/Account-Bus.md`), where contexts of different accounts must not share
 * a channel.
 */
export const ORIGIN_TOPIC = "origin"

/**
 * Same-origin, same-partition transport. Covers SwarmID tab↔tab and same-dApp
 * Safari tabs; delivery is per browsing-context, never back to the sender.
 */
export class BroadcastChannelTransport implements BusTransport {
  readonly local = true
  readonly channelName: string
  private channel: BroadcastChannel
  private handlers = new Set<(raw: unknown) => void>()

  constructor(topic: string) {
    this.channelName = `${CHANNEL_PREFIX}:${topic}`
    this.channel = new BroadcastChannel(this.channelName)
    this.channel.onmessage = (event: MessageEvent) => {
      for (const handler of this.handlers) {
        handler(event.data)
      }
    }
  }

  publish(message: BusMessageInput): void {
    this.channel.postMessage(message)
  }

  subscribe(handler: (raw: unknown) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  close(): void {
    this.handlers.clear()
    this.channel.close()
  }
}

/**
 * Fans a publish out to every transport and funnels received messages through
 * schema validation to subscribers. Invalid messages are dropped silently
 * (any context on the topic can post; only well-formed messages count).
 */
export class AccountBus {
  private transports: BusTransport[]
  private handlers = new Set<(message: BusMessage) => void>()
  private transportUnsubscribers: (() => void)[]
  private closed = false

  constructor(transports: BusTransport[]) {
    this.transports = transports
    this.transportUnsubscribers = transports.map((transport) =>
      transport.subscribe((raw) => this.dispatch(raw)),
    )
  }

  /** The single transport's channel name (test/debug aid). */
  get channelName(): string {
    const [transport] = this.transports
    return transport instanceof BroadcastChannelTransport
      ? transport.channelName
      : ""
  }

  /**
   * `localOnly` keeps a message off transports that leave this browser
   * profile. Used for lane-scoped traffic (`utilization-updated`): the
   * counters are per-partition, every remote peer is a different device on a
   * different lane, so a remote copy is dropped at the receive guard anyway —
   * after paying for encryption and a frame the signaling server's payload cap
   * may refuse outright.
   */
  publish(message: BusMessageInput, options?: PublishOptions): void {
    if (this.closed) return
    for (const transport of this.transports) {
      if (options?.localOnly && !transport.local) continue
      transport.publish(message)
    }
  }

  /**
   * Attach a transport after construction (e.g. the signaling transport once
   * the account's derivation key is known). Returns a remover that detaches
   * and closes it. Duplicate delivery across transports is tolerated by
   * design: every current message kind applies idempotently (LWW snapshot
   * merges; monotonic bucket counters, folded only by a receiver on the
   * publisher's own slot lane — see `UtilizationUpdateMessageSchema`).
   *
   * On a closed bus the transport is closed instead of attached: every join is
   * fire-and-forget, so one whose key derivation was still in flight when the
   * context tore down arrives here holding a live socket, with no other handle
   * left to close it.
   */
  addTransport(transport: BusTransport): () => void {
    if (this.closed) {
      transport.close()
      return () => {}
    }
    this.transports.push(transport)
    const unsubscribe = transport.subscribe((raw) => this.dispatch(raw))
    this.transportUnsubscribers.push(unsubscribe)
    return () => {
      unsubscribe()
      transport.close()
      this.transports = this.transports.filter((t) => t !== transport)
      this.transportUnsubscribers = this.transportUnsubscribers.filter(
        (u) => u !== unsubscribe,
      )
    }
  }

  subscribe(handler: (message: BusMessage) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  /** Idempotent, and terminal: a closed bus neither publishes nor attaches. */
  close(): void {
    this.closed = true
    for (const unsubscribe of this.transportUnsubscribers) {
      unsubscribe()
    }
    this.transportUnsubscribers = []
    this.handlers.clear()
    for (const transport of this.transports) {
      transport.close()
    }
    this.transports = []
  }

  private dispatch(raw: unknown): void {
    const result = BusMessageSchema.safeParse(raw)
    if (!result.success) return
    for (const handler of this.handlers) {
      try {
        handler(result.data)
      } catch (error) {
        console.error("[AccountBus] Handler error:", error)
      }
    }
  }
}
