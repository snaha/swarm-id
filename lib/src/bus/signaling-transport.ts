// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-partition/cross-device bus transport via the self-hosted signaling
 * server (docs/Account-Bus.md, phase 2; server: `signaling/`).
 *
 * Every envelope is end-to-end AES-GCM encrypted with the account-derived bus
 * key before it leaves the context — the server relays ciphertext only. When a
 * `createPeerConnection` factory is provided, peer pairs opportunistically
 * upgrade to a WebRTC DataChannel (the newcomer initiates, so there is no
 * offer glare) and envelopes flow peer-to-peer; the relay remains the per-peer
 * fallback whenever no channel is open.
 */

import { z } from "zod"

import type { BusTransport } from "./account-bus"
import type { BusMessageInput } from "./messages"
import {
  encryptBackupPayload,
  decryptBackupPayload,
} from "../utils/backup-encryption"

const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("welcome"),
    peerId: z.string(),
    peers: z.array(z.string()),
  }),
  z.object({ type: z.literal("peer-joined"), peerId: z.string() }),
  z.object({ type: z.literal("peer-left"), peerId: z.string() }),
  z.object({
    type: z.literal("relay"),
    from: z.string(),
    payload: z.string(),
  }),
  z.object({
    type: z.literal("signal"),
    from: z.string(),
    payload: z.unknown(),
  }),
])

const SignalPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("offer"), sdp: z.string() }),
  z.object({ kind: z.literal("answer"), sdp: z.string() }),
  z.object({ kind: z.literal("ice"), candidate: z.unknown() }),
])

const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 30000
const DATA_CHANNEL_LABEL = "bus"
/**
 * The server's close code for a topic it refuses, and the only close it sends
 * that is permanent — everything transient comes back as 1013. Mirrors the
 * constant exported from `signaling/src/server.ts` rather than importing it:
 * that module pulls in `ws` and `node:http`, and `@swarm-id/signaling` is a
 * devDependency here, so an import would drag a Node-only server into the
 * browser bundle for the sake of one number.
 */
const WS_CLOSE_POLICY_VIOLATION = 1008

export interface SignalingTransportOptions {
  /** Signaling server URL, e.g. `wss://swarm-id.snaha.net/bus`. */
  url: string
  /** Account-derived room topic (`deriveBusContext`). */
  topic: string
  /** Account-derived AES-GCM envelope key (`deriveBusContext`). */
  encryptionKey: CryptoKey
  /**
   * Factory for the WebRTC upgrade; omit to stay relay-only (e.g. in
   * environments without RTCPeerConnection). No STUN/TURN is configured by
   * default: same-device loopback and LAN peers connect via host candidates,
   * everything else falls back to the relay.
   */
  createPeerConnection?: () => RTCPeerConnection
}

interface PeerState {
  connection?: RTCPeerConnection
  dataChannel?: RTCDataChannel
}

export class SignalingTransport implements BusTransport {
  readonly local = false
  private options: SignalingTransportOptions
  private socket: WebSocket | undefined
  private peers = new Map<string, PeerState>()
  private handlers = new Set<(raw: unknown) => void>()
  private closed = false
  private reconnectDelayMs = RECONNECT_BASE_DELAY_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  /** In-flight `deliver` calls, awaited by `close()` so a teardown
   *  announcement published in the closing tick still reaches the wire. */
  private pendingDeliveries = new Set<Promise<void>>()

  constructor(options: SignalingTransportOptions) {
    this.options = options
    this.connect()
  }

  /** Live peers currently visible in the room (test/debug aid). */
  get peerCount(): number {
    return this.peers.size
  }

  publish(message: BusMessageInput): void {
    const delivery = this.deliver(message).catch((error) => {
      console.error("[SignalingTransport] Publish failed:", error)
    })
    this.pendingDeliveries.add(delivery)
    void delivery.finally(() => this.pendingDeliveries.delete(delivery))
  }

  subscribe(handler: (raw: unknown) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  /**
   * Stops reconnecting at once, but lets in-flight publishes reach the wire
   * first: `deliver` awaits envelope encryption, and callers announce a
   * teardown (`lease-released`) and close the bus in the same tick, so tearing
   * the socket down synchronously would drop exactly the message a waiting
   * peer is owed. Each pending delivery is a single encrypt plus synchronous
   * sends, so this settles promptly — it is not a flush of a send queue.
   */
  close(): void {
    this.closed = true
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
    }
    if (this.pendingDeliveries.size === 0) {
      this.shutdown()
      return
    }
    void Promise.allSettled([...this.pendingDeliveries]).then(() =>
      this.shutdown(),
    )
  }

  private shutdown(): void {
    this.handlers.clear()
    for (const peer of this.peers.values()) {
      peer.connection?.close()
    }
    this.peers.clear()
    this.socket?.close()
  }

  // ==========================================================================
  // Socket lifecycle
  // ==========================================================================

  private connect(): void {
    const url = new URL(this.options.url)
    url.searchParams.set("topic", this.options.topic)
    const socket = new WebSocket(url.toString())
    this.socket = socket

    socket.addEventListener("message", (event) => {
      // Backoff resets here, not on `open`. The server accepts the socket and
      // only then closes it on a policy or payload violation, so resetting on
      // `open` made every such failure reconnect at the 1 s floor forever. A
      // message received is proof the connection was actually useful.
      this.reconnectDelayMs = RECONNECT_BASE_DELAY_MS
      void this.handleServerMessage(String(event.data))
    })
    socket.addEventListener("close", (event) => {
      // A policy close is permanent for this topic (the server only sends it
      // for a topic it will reject identically next time); retrying is a hot
      // loop against an answer that will not change.
      if (event.code === WS_CLOSE_POLICY_VIOLATION) {
        console.error(
          "[SignalingTransport] Signaling server rejected the topic; not reconnecting.",
        )
        this.closed = true
        return
      }
      this.scheduleReconnect()
    })
    socket.addEventListener("error", () => {
      // The close event follows and drives the reconnect.
    })
  }

  private scheduleReconnect(): void {
    if (this.closed) return
    for (const peer of this.peers.values()) {
      peer.connection?.close()
    }
    this.peers.clear()
    // Equal jitter. Every client connected when the service restarts — a
    // deploy, an OOM — schedules its retry from the same instant, so an
    // undithered delay brings them all back in lockstep at exactly the moment
    // the server can least take it. Spread the wait over the second half of
    // the window; the undithered sequence stays the backoff of record so the
    // doubling is still 1s → 2s → 4s.
    const jittered =
      this.reconnectDelayMs / 2 + Math.random() * (this.reconnectDelayMs / 2)
    this.reconnectTimer = setTimeout(() => this.connect(), jittered)
    this.reconnectDelayMs = Math.min(
      this.reconnectDelayMs * 2,
      RECONNECT_MAX_DELAY_MS,
    )
  }

  // ==========================================================================
  // Sending
  // ==========================================================================

  private async deliver(message: BusMessageInput): Promise<void> {
    if (this.peers.size === 0) return
    const ciphertext = await encryptBackupPayload(
      JSON.stringify(message),
      this.options.encryptionKey,
    )
    for (const [peerId, peer] of this.peers) {
      // Per peer, and never fatal to the rest of the fan-out: a `send` that
      // throws (SCTP size limit, a channel torn down between the readyState
      // read and the call) used to escape this loop and starve every peer
      // after it — for a teardown `lease-released` that costs the waiter its
      // whole poll interval. A failed channel falls through to the relay.
      if (peer.dataChannel?.readyState === "open") {
        try {
          peer.dataChannel.send(ciphertext)
          continue
        } catch (error) {
          console.warn(
            "[SignalingTransport] DataChannel send failed; relaying:",
            error,
          )
        }
      }
      this.sendToServer({ type: "relay", to: peerId, payload: ciphertext })
    }
  }

  private sendToServer(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message))
    }
  }

  // ==========================================================================
  // Receiving
  // ==========================================================================

  private async handleServerMessage(data: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    const result = ServerMessageSchema.safeParse(parsed)
    if (!result.success) return
    const message = result.data

    switch (message.type) {
      case "welcome":
        for (const peerId of message.peers) {
          this.peers.set(peerId, {})
          // The newcomer (us) initiates toward every existing peer.
          void this.initiatePeerConnection(peerId)
        }
        return
      case "peer-joined":
        // The joiner initiates; we just track it.
        this.peers.set(message.peerId, {})
        return
      case "peer-left": {
        const peer = this.peers.get(message.peerId)
        peer?.connection?.close()
        this.peers.delete(message.peerId)
        return
      }
      case "relay":
        await this.receiveEnvelope(message.payload)
        return
      case "signal":
        await this.handleSignal(message.from, message.payload)
        return
    }
  }

  private async receiveEnvelope(ciphertext: string): Promise<void> {
    let plaintext: string
    try {
      plaintext = await decryptBackupPayload(
        ciphertext,
        this.options.encryptionKey,
      )
    } catch {
      // Wrong key or corrupted payload — not for us.
      return
    }
    let raw: unknown
    try {
      raw = JSON.parse(plaintext)
    } catch {
      return
    }
    for (const handler of this.handlers) {
      handler(raw)
    }
  }

  // ==========================================================================
  // WebRTC upgrade
  // ==========================================================================

  private async initiatePeerConnection(peerId: string): Promise<void> {
    const create = this.options.createPeerConnection
    if (!create) return
    try {
      const connection = create()
      const peer = this.peers.get(peerId)
      if (!peer) return
      peer.connection = connection
      this.adoptDataChannel(
        connection.createDataChannel(DATA_CHANNEL_LABEL),
        peer,
      )
      this.forwardIceCandidates(connection, peerId)
      const offer = await connection.createOffer()
      await connection.setLocalDescription(offer)
      this.sendSignal(peerId, { kind: "offer", sdp: offer.sdp ?? "" })
    } catch (error) {
      console.error("[SignalingTransport] WebRTC initiate failed:", error)
    }
  }

  private async handleSignal(from: string, payload: unknown): Promise<void> {
    const create = this.options.createPeerConnection
    if (!create) return
    const result = SignalPayloadSchema.safeParse(payload)
    if (!result.success) return
    const signal = result.data
    const peer = this.peers.get(from)
    if (!peer) return

    try {
      if (signal.kind === "offer") {
        const connection = create()
        peer.connection = connection
        connection.ondatachannel = (event) => {
          this.adoptDataChannel(event.channel, peer)
        }
        this.forwardIceCandidates(connection, from)
        await connection.setRemoteDescription({
          type: "offer",
          sdp: signal.sdp,
        })
        const answer = await connection.createAnswer()
        await connection.setLocalDescription(answer)
        this.sendSignal(from, { kind: "answer", sdp: answer.sdp ?? "" })
        return
      }
      if (signal.kind === "answer") {
        await peer.connection?.setRemoteDescription({
          type: "answer",
          sdp: signal.sdp,
        })
        return
      }
      await peer.connection?.addIceCandidate(
        signal.candidate as RTCIceCandidateInit,
      )
    } catch (error) {
      console.error("[SignalingTransport] WebRTC signal failed:", error)
    }
  }

  private adoptDataChannel(channel: RTCDataChannel, peer: PeerState): void {
    peer.dataChannel = channel
    channel.onmessage = (event) => {
      void this.receiveEnvelope(String(event.data))
    }
  }

  private forwardIceCandidates(
    connection: RTCPeerConnection,
    peerId: string,
  ): void {
    connection.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal(peerId, {
          kind: "ice",
          candidate: event.candidate.toJSON(),
        })
      }
    }
  }

  private sendSignal(
    to: string,
    payload: z.infer<typeof SignalPayloadSchema>,
  ): void {
    this.sendToServer({ type: "signal", to, payload })
  }
}
