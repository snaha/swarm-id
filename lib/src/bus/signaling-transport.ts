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
import {
  ServerMessageSchema,
  WS_CLOSE_POLICY_VIOLATION,
} from "@swarm-id/signaling/protocol"
import type { ClientMessage } from "@swarm-id/signaling/protocol"

import type { BusTransport } from "./account-bus"
import type { BusMessageInput } from "./messages"
import { encryptEnvelope, decryptEnvelope } from "./envelope"

const SignalPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("offer"), sdp: z.string() }),
  z.object({ kind: z.literal("answer"), sdp: z.string() }),
  z.object({ kind: z.literal("ice"), candidate: z.unknown() }),
])

const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 30000
const DATA_CHANNEL_LABEL = "bus"
/** How long a departed peer is remembered. Only the last several seconds of
 *  a departure matter to anyone asking who is absent. */
const PRESENCE_MEMORY_MS = 60_000

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
  /** True once this connection's remote description is set. `addIceCandidate`
   *  rejects before that, so candidates arriving first have to wait. */
  remoteDescriptionSet: boolean
  /** Candidates that arrived before the remote description, replayed once it
   *  lands. Signals are handled concurrently (`void this.handleSignal(...)`),
   *  so an `ice` message routinely reaches us mid-negotiation — without this
   *  the candidate was logged and dropped, and the pair silently fell back to
   *  the server relay it was trying to stop using.
   *
   *  Neither field is optional: a `?.push` on the queue would drop a candidate
   *  in exactly the state the queue is for, so every `PeerState` is born with
   *  an empty one. */
  pendingCandidates: RTCIceCandidateInit[]
}

/** A peer we have just heard of: no connection yet, and an empty queue rather
 *  than an absent one, so a candidate arriving first has somewhere to go. */
function newPeerState(): PeerState {
  return { remoteDescriptionSet: false, pendingCandidates: [] }
}

export class SignalingTransport implements BusTransport {
  readonly local = false
  private options: SignalingTransportOptions
  private socket: WebSocket | undefined
  private peers = new Map<string, PeerState>()
  private handlers = new Set<(raw: unknown, from?: string) => void>()
  private peerLeftHandlers = new Set<(peerId: string) => void>()
  private closed = false
  private reconnectDelayMs = RECONNECT_BASE_DELAY_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  /** In-flight `deliver` calls, awaited by `close()` so a teardown
   *  announcement published in the closing tick still reaches the wire. */
  private pendingDeliveries = new Set<Promise<void>>()

  // Liveness, all of it scoped to one socket's stay in the room: a reconnect
  // is a new session and starts every clock again. Times are
  // `performance.now()`, which a change to the system clock cannot move.
  /** When this session's `welcome` arrived. */
  private sessionStartedAt: number | undefined
  /** When the newest ping the server has answered was SENT: the server
   *  counted this socket a room member no earlier than that. */
  private confirmedAt: number | undefined
  private pingNonce = 0
  private pingsSentAt = new Map<number, number>()
  private confirmedHandlers = new Set<(unconfirmedForMs: number) => void>()
  /** This socket's name in the room, as the server gave it. */
  private selfPeerId: string | undefined
  /** When each peer that is not in our room was last known present: when it
   *  left, or when a message from it arrived although our view of the room
   *  did not contain it. */
  private peerLastPresentAt = new Map<string, number>()

  constructor(options: SignalingTransportOptions) {
    this.options = options
    this.connect()
  }

  /** Live peers currently visible in the room (test/debug aid). */
  get peerCount(): number {
    return this.peers.size
  }

  /**
   * Settles once every publish so far has been encrypted and handed to its
   * socket or data channel — what a page about to close waits for (#711).
   * Not a delivery receipt: nothing here says a peer has read it.
   */
  settled(): Promise<void> {
    return Promise.allSettled([...this.pendingDeliveries]).then(() => undefined)
  }

  publish(message: BusMessageInput): void {
    const delivery = this.deliver(message).catch((error) => {
      console.error("[SignalingTransport] Publish failed:", error)
    })
    this.pendingDeliveries.add(delivery)
    void delivery.finally(() => this.pendingDeliveries.delete(delivery))
  }

  subscribe(handler: (raw: unknown, from?: string) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  onPeerLeft(handler: (peerId: string) => void): () => void {
    this.peerLeftHandlers.add(handler)
    return () => this.peerLeftHandlers.delete(handler)
  }

  confirmedAgoMs(): number {
    if (this.confirmedAt === undefined) return Infinity
    return performance.now() - this.confirmedAt
  }

  onConfirmed(handler: (unconfirmedForMs: number) => void): () => void {
    this.confirmedHandlers.add(handler)
    return () => this.confirmedHandlers.delete(handler)
  }

  /** This context's name in the room for the current connection; a new one
   *  after every reconnect. */
  selfId(): string | undefined {
    return this.selfPeerId
  }

  notePeer(peerId: string): void {
    // Heard from a peer our view of the room does not contain: the view is
    // behind, and the peer was present a moment ago.
    if (peerId === this.selfPeerId || this.peers.has(peerId)) return
    this.markPresent(peerId)
  }

  private markPresent(peerId: string): void {
    const now = performance.now()
    for (const [peer, at] of this.peerLastPresentAt) {
      if (now - at > PRESENCE_MEMORY_MS) this.peerLastPresentAt.delete(peer)
    }
    this.peerLastPresentAt.set(peerId, now)
  }

  /**
   * The server's room is the authority. Everyone outside `peerIds` is absent
   * while every peer in the room is in the set, counted from the latest of:
   * this context joining, and a peer outside the set last being present.
   */
  absentExceptMs(peerIds: ReadonlySet<string>): number {
    if (this.sessionStartedAt === undefined) return 0
    for (const peerId of this.peers.keys()) {
      if (!peerIds.has(peerId)) return 0
    }
    let since = this.sessionStartedAt
    for (const [peerId, at] of this.peerLastPresentAt) {
      if (!peerIds.has(peerId)) since = Math.max(since, at)
    }
    return performance.now() - since
  }

  /**
   * Stops reconnecting at once, but lets in-flight publishes reach the wire
   * first: `deliver` awaits envelope encryption, and callers publish a last
   * message and close the bus in the same tick, so tearing the socket down
   * synchronously would drop exactly the message a peer is owed. Each pending delivery is a single encrypt plus synchronous
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
    // Our own socket going is not a report that anyone else left, so these are
    // dropped rather than fired: the tracker ages the room out, and a
    // reconnect relearns it from the peers' own beats.
    this.peerLeftHandlers.clear()
    for (const peer of this.peers.values()) {
      peer.connection?.close()
    }
    this.peers.clear()
    this.endSession()
    this.confirmedHandlers.clear()
    this.socket?.close()
  }

  private endSession(): void {
    this.sessionStartedAt = undefined
    this.confirmedAt = undefined
    this.pingsSentAt.clear()
    this.selfPeerId = undefined
    this.peerLastPresentAt.clear()
  }

  /** One round trip with the server; the answer is handled in `pong`. */
  private ping(): void {
    this.pingNonce += 1
    this.pingsSentAt.set(this.pingNonce, performance.now())
    this.sendToServer({ type: "ping", nonce: this.pingNonce })
  }

  // ==========================================================================
  // Socket lifecycle
  // ==========================================================================

  private connect(): void {
    // The topic travels in the first frame, not the query string: query strings
    // are recorded by every ingress and proxy access log as a matter of course,
    // and the topic IS the room capability — anything reading those logs can
    // join (#577). Payload confidentiality is unaffected either way (topic and
    // envelope key come from separate HMAC contexts); what a topic buys is
    // membership: presence, traffic patterns, ciphertext to keep, and a
    // position to inject from.
    const socket = new WebSocket(this.options.url)
    this.socket = socket

    socket.addEventListener("open", () => {
      this.sendToServer({ type: "join", topic: this.options.topic })
    })

    socket.addEventListener("message", (event) => {
      // Backoff resets here, not on `open`. The server accepts the socket and
      // only then closes it on a policy or payload violation, so resetting on
      // `open` made every such failure reconnect at the 1 s floor forever. A
      // message received is proof the connection was actually useful.
      this.reconnectDelayMs = RECONNECT_BASE_DELAY_MS
      void this.handleServerMessage(String(event.data))
    })
    socket.addEventListener("close", (event) => {
      this.endSession()
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
    const ciphertext = await encryptEnvelope(
      JSON.stringify(message),
      this.options.encryptionKey,
    )
    for (const [peerId, peer] of this.peers) {
      // Per peer, and never fatal to the rest of the fan-out: a `send` that
      // throws (SCTP size limit, a channel torn down between the readyState
      // read and the call) must not escape this loop and starve every peer
      // after it. A failed channel falls through to the relay.
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

  private sendToServer(message: ClientMessage): void {
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
        this.sessionStartedAt = performance.now()
        this.selfPeerId = message.peerId
        this.ping()
        for (const peerId of message.peers) {
          this.peers.set(peerId, newPeerState())
          // The newcomer (us) initiates toward every existing peer.
          void this.initiatePeerConnection(peerId)
        }
        return
      case "peer-joined":
        // The joiner initiates; we just track it.
        this.peers.set(message.peerId, newPeerState())
        return
      case "peer-left": {
        const peer = this.peers.get(message.peerId)
        peer?.connection?.close()
        this.peers.delete(message.peerId)
        this.markPresent(message.peerId)
        // Reported, not just cleaned up: this is the only departure signal a
        // closing tab produces (why, in `PresenceTracker`'s header). The
        // server's reaper closes a dead socket too, so a crash and a dropped
        // network arrive here as well.
        for (const handler of this.peerLeftHandlers) {
          handler(message.peerId)
        }
        return
      }
      case "relay":
        await this.receiveEnvelope(message.payload, message.from)
        return
      case "signal":
        await this.handleSignal(message.from, message.payload)
        return
      case "tick":
        this.ping()
        return
      case "pong": {
        // Answers arrive in the order the pings were sent, so everything up
        // to this nonce is settled. A nonce from an earlier session is not in
        // the map.
        const sentAt = this.pingsSentAt.get(message.nonce)
        if (sentAt === undefined) return
        const unconfirmedForMs = this.confirmedAgoMs()
        this.confirmedAt = sentAt
        for (const nonce of this.pingsSentAt.keys()) {
          if (nonce <= message.nonce) this.pingsSentAt.delete(nonce)
        }
        for (const handler of this.confirmedHandlers) handler(unconfirmedForMs)
        return
      }
    }
  }

  private async receiveEnvelope(
    ciphertext: string,
    from: string,
  ): Promise<void> {
    let plaintext: string
    try {
      plaintext = await decryptEnvelope(ciphertext, this.options.encryptionKey)
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
      handler(raw, from)
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
      this.adoptConnection(peer, connection)
      this.adoptDataChannel(
        connection.createDataChannel(DATA_CHANNEL_LABEL),
        peer,
        peerId,
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
        this.adoptConnection(peer, connection)
        connection.ondatachannel = (event) => {
          this.adoptDataChannel(event.channel, peer, from)
        }
        this.forwardIceCandidates(connection, from)
        await connection.setRemoteDescription({
          type: "offer",
          sdp: signal.sdp,
        })
        await this.flushPendingCandidates(peer, connection)
        const answer = await connection.createAnswer()
        await connection.setLocalDescription(answer)
        this.sendSignal(from, { kind: "answer", sdp: answer.sdp ?? "" })
        return
      }
      if (signal.kind === "answer") {
        // An answer for no connection describes nothing, so it must not mark
        // the queue as flushable either.
        const connection = peer.connection
        if (!connection) return
        await connection.setRemoteDescription({
          type: "answer",
          sdp: signal.sdp,
        })
        await this.flushPendingCandidates(peer, connection)
        return
      }
      // Queue rather than apply while the sibling offer/answer handler is
      // still awaiting its `setRemoteDescription`. The check and the push are
      // one synchronous step, so they cannot interleave with the flush.
      if (!peer.remoteDescriptionSet) {
        peer.pendingCandidates.push(signal.candidate as RTCIceCandidateInit)
        return
      }
      await peer.connection?.addIceCandidate(
        signal.candidate as RTCIceCandidateInit,
      )
    } catch (error) {
      console.error("[SignalingTransport] WebRTC signal failed:", error)
    }
  }

  /**
   * Install a freshly created connection on a peer, closing whatever was there.
   * A duplicate or renegotiated offer used to overwrite the field and leak the
   * previous `RTCPeerConnection`, which keeps its ICE agent and sockets alive.
   * The candidate queue resets with it: the new connection has no remote
   * description, and candidates gathered for the old one are meaningless.
   */
  private adoptConnection(
    peer: PeerState,
    connection: RTCPeerConnection,
  ): void {
    peer.connection?.close()
    peer.connection = connection
    peer.remoteDescriptionSet = false
    peer.pendingCandidates = []
  }

  /**
   * Replay the candidates that arrived before the remote description. One bad
   * candidate must not strand the rest, so each is applied on its own.
   *
   * Takes the connection whose description just landed, and does nothing if the
   * peer has moved on to another: signals are handled concurrently, so a second
   * offer can be adopted while this one is still awaiting
   * `setRemoteDescription`, and marking the flag then would describe a
   * connection that has no remote description — re-opening the drop window this
   * queue exists to close, for candidates that arrive before the new
   * negotiation finishes.
   */
  private async flushPendingCandidates(
    peer: PeerState,
    connection: RTCPeerConnection,
  ): Promise<void> {
    if (peer.connection !== connection) return
    peer.remoteDescriptionSet = true
    const pending = peer.pendingCandidates
    peer.pendingCandidates = []
    for (const candidate of pending) {
      try {
        await connection.addIceCandidate(candidate)
      } catch (error) {
        console.warn("[SignalingTransport] ICE candidate rejected:", error)
      }
    }
  }

  private adoptDataChannel(
    channel: RTCDataChannel,
    peer: PeerState,
    peerId: string,
  ): void {
    peer.dataChannel = channel
    channel.onmessage = (event) => {
      // One channel per peer, so who sent it is settled by which channel it
      // arrived on — the relay path is told by the server instead.
      void this.receiveEnvelope(String(event.data), peerId)
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
