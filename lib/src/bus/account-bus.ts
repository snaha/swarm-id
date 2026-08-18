// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The account bus: a real-time message channel between all live contexts of an
 * account (proxy iframes, SwarmID tabs — later, via more transports, other
 * partitions and devices). Design: `docs/Account-Bus.md`.
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
  publish(message: BusMessageInput): void
  subscribe(handler: (raw: unknown) => void): () => void
  close(): void
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

  publish(message: BusMessageInput): void {
    for (const transport of this.transports) {
      transport.publish(message)
    }
  }

  /**
   * Attach a transport after construction (e.g. the signaling transport once
   * the account's derivation key is known). Returns a remover that detaches
   * and closes it. Duplicate delivery across transports is tolerated by
   * design: every current message kind applies idempotently (absolute bucket
   * values; LWW snapshot merges).
   */
  addTransport(transport: BusTransport): () => void {
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

  close(): void {
    for (const unsubscribe of this.transportUnsubscribers) {
      unsubscribe()
    }
    this.handlers.clear()
    for (const transport of this.transports) {
      transport.close()
    }
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
