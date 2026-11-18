// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The account bus: a real-time message channel between the live contexts of an
 * account. Two contexts construct one: the proxy iframes, and — since the
 * `account-delta` publisher — the SwarmID tab, which is where a revoke happens
 * and the only context that can tell a partitioned iframe about one. The tab
 * attaches the signaling transport alone: everything a `BroadcastChannel`
 * reaches from there already converges through storage events, and the
 * partitioned iframe is in another storage partition, which only a server round
 * trip crosses.
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
  /** To everyone the transport reaches, or to `to` alone where the transport
   *  can address one peer; one that cannot sends to everyone. */
  publish(message: BusMessageInput, to?: string): void
  /**
   * `from` is the transport's own name for whoever sent the message — a peer
   * id on the signaling transport, absent on a transport that has no peers.
   * It is what lets `onPeerLeft` be attributed to the devices that peer spoke
   * for (#572).
   */
  subscribe(handler: (raw: unknown, from?: string) => void): () => void
  /**
   * A peer left the room. Optional: a transport without peers has no
   * departures to report, which is a truthful answer rather than a gap.
   */
  onPeerLeft?(handler: (peerId: string) => void): () => void
  /**
   * The two things a lane (`sync/bus-lease.ts`) needs from a transport that crosses
   * devices (models/bus-lease, #1017), and the whole of what it may assume
   * about how the transport knows:
   *
   * - `confirmedAgoMs`: how long ago this context's own connection to the
   *   service was last confirmed, `Infinity` when it is not.
   * - `absentExceptMs`: for how long the service has shown no context other
   *   than the given ones, known to this context or not; `0` when another is
   *   present or the transport cannot tell.
   *
   * They must come from one authority: if a context is shown absent over
   * some span, its own connection was not confirmed within that span.
   *
   * `onConfirmed` reports each confirmation with how long the context had
   * been unconfirmed just before it (`Infinity` for the first of a
   * connection), so a gap is seen even when nothing asked during it.
   *
   * A context is named by `selfId`, the same name `subscribe` reports as
   * `from`. A reconnect is a new context: its name changes, and whatever the
   * old one held or was promised is void.
   */
  selfId?(): string | undefined
  confirmedAgoMs?(): number
  absentExceptMs?(peerIds: ReadonlySet<string>): number
  onConfirmed?(handler: (unconfirmedForMs: number) => void): () => void
  /** A message from `peerId` arrived, on whatever path. */
  notePeer?(peerId: string): void
  close(): void
}

/** Restricts a publish to transports that stay inside this browser profile. */
export interface PublishOptions {
  localOnly?: boolean
  /** The one context the message is for, by its name on the transport that
   *  crosses devices. Others may still see it on a transport that cannot
   *  address a single peer. */
  to?: string
}

const CHANNEL_PREFIX = "swarm-id-bus-v1"

/** The channel a topic's local transport speaks on. Exported so nothing has to
 *  re-spell the prefix: a copy of it in a test keeps passing after a bump, on a
 *  channel the proxy no longer listens to. */
export function busChannelName(topic: string): string {
  return `${CHANNEL_PREFIX}:${topic}`
}

/**
 * Same-origin, same-partition transport. Covers SwarmID tab↔tab and same-dApp
 * Safari tabs; delivery is per browsing-context, never back to the sender.
 *
 * The topic is the account-derived one from `deriveBusContext`, the same value
 * the signaling transport uses as its room, so co-resident accounts never share
 * an unencrypted channel: an `account-delta` payload carries
 * `postageStamps[].signerKey`.
 */
export class BroadcastChannelTransport implements BusTransport {
  readonly local = true
  readonly channelName: string
  private channel: BroadcastChannel
  // No `from`: every context on this channel is this browser profile, and the
  // channel names none of them. Nothing here can leave the room separately.
  private handlers = new Set<(raw: unknown) => void>()

  constructor(topic: string) {
    this.channelName = busChannelName(topic)
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

/** The context a lane message says it is from. */
function laneSender(message: BusMessage): string | undefined {
  return message.type === "lane-claim" ||
    message.type === "lane-free" ||
    message.type === "lane-held"
    ? message.from
    : undefined
}

/**
 * Fans a publish out to every transport and funnels received messages through
 * schema validation to subscribers. Invalid messages are dropped silently
 * (any context on the topic can post; only well-formed messages count).
 */
export class AccountBus {
  private transports: BusTransport[]
  private handlers = new Set<(message: BusMessage, from?: string) => void>()
  private peerLeftHandlers = new Set<(peerId: string) => void>()
  private confirmedHandlers = new Set<(unconfirmedForMs: number) => void>()
  private transportUnsubscribers: (() => void)[]
  private closed = false

  constructor(transports: BusTransport[]) {
    this.transports = transports
    this.transportUnsubscribers = transports.flatMap((transport) =>
      this.listenTo(transport),
    )
  }

  /** Both subscriptions a transport offers, as one list of removers. */
  private listenTo(transport: BusTransport): (() => void)[] {
    const removers = [
      transport.subscribe((raw, from) => {
        const message = this.dispatch(raw, from)
        if (!message) return
        // A path that names no sender (BroadcastChannel) still carries lane
        // messages, and those say who sent them. Every transport hears of the
        // sender: the one that keeps the room may not have it in view yet.
        const sender = from ?? laneSender(message)
        if (sender === undefined) return
        for (const each of this.transports) each.notePeer?.(sender)
      }),
    ]
    const onPeerLeft = transport.onPeerLeft?.((peerId) => {
      for (const handler of this.peerLeftHandlers) {
        try {
          handler(peerId)
        } catch (error) {
          console.error("[AccountBus] Peer-left handler error:", error)
        }
      }
    })
    if (onPeerLeft) removers.push(onPeerLeft)
    const onConfirmed = transport.onConfirmed?.((unconfirmedForMs) => {
      for (const handler of this.confirmedHandlers) {
        try {
          handler(unconfirmedForMs)
        } catch (error) {
          console.error("[AccountBus] Confirmed handler error:", error)
        }
      }
    })
    if (onConfirmed) removers.push(onConfirmed)
    return removers
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
      transport.publish(message, options?.to)
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
    // Through the same path as a constructor-time transport: the signaling one
    // is always attached here, so a departure hook wired only in the
    // constructor would never see the transport that has peers.
    const removers = this.listenTo(transport)
    this.transportUnsubscribers.push(...removers)
    return () => {
      for (const remove of removers) remove()
      transport.close()
      this.transports = this.transports.filter((t) => t !== transport)
      this.transportUnsubscribers = this.transportUnsubscribers.filter(
        (u) => !removers.includes(u),
      )
    }
  }

  subscribe(handler: (message: BusMessage, from?: string) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  /**
   * A peer left the room, by the name the delivering transport uses for it.
   * The signaling server sends this on socket close, its reaper included, so
   * it is the one departure signal that survives a tab being closed.
   */
  onPeerLeft(handler: (peerId: string) => void): () => void {
    this.peerLeftHandlers.add(handler)
    return () => this.peerLeftHandlers.delete(handler)
  }

  /**
   * How long ago this context's connection was confirmed by every transport
   * that crosses devices; `Infinity` with none attached. A context for which
   * this is too old is read-only on its partitions.
   */
  confirmedAgoMs(): number {
    const answers = this.transports.flatMap((transport) =>
      transport.confirmedAgoMs ? [transport.confirmedAgoMs()] : [],
    )
    return answers.length === 0 ? Infinity : Math.max(...answers)
  }

  /** This context's name on the transport that crosses devices; undefined
   *  while it has no confirmed place there. */
  selfId(): string | undefined {
    for (const transport of this.transports) {
      const id = transport.selfId?.()
      if (id !== undefined) return id
    }
    return undefined
  }

  /** How long every such transport has shown nobody but the given contexts;
   *  `0` with none attached. */
  absentExceptMs(peerIds: ReadonlySet<string>): number {
    const answers = this.transports.flatMap((transport) =>
      transport.absentExceptMs ? [transport.absentExceptMs(peerIds)] : [],
    )
    return answers.length === 0 ? 0 : Math.min(...answers)
  }

  /** Each confirmation of a transport that crosses devices, with how long it
   *  had been unconfirmed just before. */
  onConfirmed(handler: (unconfirmedForMs: number) => void): () => void {
    this.confirmedHandlers.add(handler)
    return () => this.confirmedHandlers.delete(handler)
  }

  /** Idempotent, and terminal: a closed bus neither publishes nor attaches. */
  close(): void {
    this.closed = true
    for (const unsubscribe of this.transportUnsubscribers) {
      unsubscribe()
    }
    this.transportUnsubscribers = []
    this.handlers.clear()
    this.peerLeftHandlers.clear()
    this.confirmedHandlers.clear()
    for (const transport of this.transports) {
      transport.close()
    }
    this.transports = []
  }

  /** Returns the message when it was well-formed. */
  private dispatch(raw: unknown, from?: string): BusMessage | undefined {
    const result = BusMessageSchema.safeParse(raw)
    if (!result.success) return undefined
    for (const handler of this.handlers) {
      try {
        handler(result.data, from)
      } catch (error) {
        console.error("[AccountBus] Handler error:", error)
      }
    }
    return result.data
  }
}
