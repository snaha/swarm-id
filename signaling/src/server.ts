// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Account-bus signaling and relay server (docs/Account-Bus.md, phase 2).
 *
 * Peers connect over WebSocket to `/?topic=<hex>` and form a room per topic
 * (topics are account-derived and unguessable). The server does two things and
 * nothing else:
 *
 * - `signal`: forward WebRTC SDP/ICE blobs to one named peer, so browsers can
 *   upgrade to direct DataChannels — the preferred data path.
 * - `relay`: forward an opaque encrypted payload to one named peer, for peers
 *   WebRTC cannot connect. Payloads are end-to-end encrypted by the clients;
 *   the server never sees plaintext and stores nothing.
 *
 * Both forward to exactly one peer. There is deliberately no room-wide
 * broadcast: clients fan out per peer anyway (they pick relay vs DataChannel
 * per peer), so a broadcast would only hand anyone who guesses a topic a
 * one-to-many amplifier.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { z } from 'zod'

// Topics are hex secrets derived per account (64 hex chars today); accept a
// generous range so the derivation can evolve without a server deploy.
const TOPIC_PATTERN = /^[0-9a-f]{16,128}$/
// Bus envelopes are small (< a few KB); cap generously to bound abuse.
const MAX_PAYLOAD_BYTES = 65536

const HTTP_OK = 200
const HTTP_NOT_FOUND = 404
const HTTP_SERVICE_UNAVAILABLE = 503
/** The client treats this as permanent and stops reconnecting. */
const WS_CLOSE_POLICY_VIOLATION = 1008
/** Transient — the client backs off and comes back. */
const WS_CLOSE_TRY_AGAIN_LATER = 1013

/**
 * Ping cadence. A socket that has not ponged by the following tick is
 * terminated, so the worst case for noticing a half-open connection is two
 * intervals.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000
/**
 * Bounds for a single 1 vCPU / 0.5 GB instance with no autoscale. Deliberately
 * not per-IP: this service sits behind the platform's ingress, so the socket's
 * remote address is the proxy and the client address only exists in a
 * spoofable `X-Forwarded-For`. A global cap protects the same resource with
 * nothing to misattribute.
 */
const DEFAULT_MAX_CONNECTIONS = 500
const DEFAULT_MAX_ROOMS = 200
/** An account with more than this many live contexts is pathological. */
const DEFAULT_MAX_PEERS_PER_ROOM = 24
/**
 * Generous on purpose. A WebRTC negotiation is an offer/answer plus ~15 ICE
 * candidates PER PEER, so a 4-peer room legitimately sends ~64 messages within
 * a couple of seconds of joining, before any relay traffic. A tight budget
 * would cut off real negotiation, which is exactly the path we want to keep.
 */
const DEFAULT_MESSAGE_RATE_LIMIT = 200
const DEFAULT_MESSAGE_RATE_WINDOW_MS = 10_000

const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('relay'),
    to: z.string(),
    payload: z.string(),
  }),
  z.object({
    type: z.literal('signal'),
    to: z.string(),
    payload: z.unknown(),
  }),
])

interface Peer {
  id: string
  socket: WebSocket
  /**
   * Cleared before each ping and set by the pong. Still clear at the next tick
   * means the socket never answered — `ws` cannot see a half-open TCP on its
   * own, and backgrounded mobile Safari, NAT idle timeouts and sleeping
   * laptops all produce them.
   */
  alive: boolean
  /** Start of the current message-rate window, and its running count. */
  windowStartedAt: number
  messagesInWindow: number
}

export interface SignalingServer {
  port: number
  close(): Promise<void>
}

export interface SignalingServerOptions {
  port: number
  /** Origins allowed to connect; empty/absent allows all (dev). */
  allowedOrigins?: string[]
  /**
   * Overrides for the bounds above. Present so tests can drive them in
   * milliseconds and single digits; the deployed service uses the defaults —
   * env wiring would buy nothing, since changing a DO env var redeploys the
   * service anyway.
   */
  heartbeatIntervalMs?: number
  maxConnections?: number
  maxRooms?: number
  maxPeersPerRoom?: number
  messageRateLimit?: number
  messageRateWindowMs?: number
}

function send(peer: Peer, message: Record<string, unknown>): void {
  if (peer.socket.readyState === WebSocket.OPEN) {
    peer.socket.send(JSON.stringify(message))
  }
}

export function createSignalingServer(options: SignalingServerOptions): Promise<SignalingServer> {
  const rooms = new Map<string, Map<string, Peer>>()
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS
  const maxRooms = options.maxRooms ?? DEFAULT_MAX_ROOMS
  const maxPeersPerRoom = options.maxPeersPerRoom ?? DEFAULT_MAX_PEERS_PER_ROOM
  const messageRateLimit = options.messageRateLimit ?? DEFAULT_MESSAGE_RATE_LIMIT
  const messageRateWindowMs = options.messageRateWindowMs ?? DEFAULT_MESSAGE_RATE_WINDOW_MS

  const httpServer: Server = createServer((request, response) => {
    if (request.url === '/healthz') {
      response.writeHead(HTTP_OK, { 'content-type': 'text/plain' })
      response.end('ok')
      return
    }
    response.writeHead(HTTP_NOT_FOUND)
    response.end()
  })

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_PAYLOAD_BYTES,
    verifyClient: (
      { origin }: { origin?: string },
      callback: (accept: boolean, code?: number, message?: string) => void,
    ) => {
      const allowed = options.allowedOrigins
      if (allowed && allowed.length > 0 && (origin === undefined || !allowed.includes(origin))) {
        callback(false)
        return
      }
      // Refused here rather than after the upgrade so a flood never pays for a
      // WebSocket allocation.
      if (wss.clients.size >= maxConnections) {
        callback(false, HTTP_SERVICE_UNAVAILABLE, 'at capacity')
        return
      }
      callback(true)
    },
  })

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const topic = url.searchParams.get('topic') ?? ''
    if (!TOPIC_PATTERN.test(topic)) {
      socket.close(WS_CLOSE_POLICY_VIOLATION, 'invalid topic')
      return
    }

    // Both caps refuse with 1013, not 1008: the client stops reconnecting on a
    // policy close, which is right for a topic that will never be valid and
    // wrong for load that will pass.
    const existing = rooms.get(topic)
    if (!existing && rooms.size >= maxRooms) {
      socket.close(WS_CLOSE_TRY_AGAIN_LATER, 'too many rooms')
      return
    }
    const room = existing ?? new Map<string, Peer>()
    if (room.size >= maxPeersPerRoom) {
      socket.close(WS_CLOSE_TRY_AGAIN_LATER, 'room full')
      return
    }

    const peer: Peer = {
      id: randomUUID(),
      socket,
      alive: true,
      windowStartedAt: Date.now(),
      messagesInWindow: 0,
    }
    rooms.set(topic, room)
    socket.on('pong', () => {
      peer.alive = true
    })

    send(peer, {
      type: 'welcome',
      peerId: peer.id,
      peers: [...room.keys()],
    })
    for (const other of room.values()) {
      send(other, { type: 'peer-joined', peerId: peer.id })
    }
    room.set(peer.id, peer)

    socket.on('message', (data) => {
      // Counted before the parse, so a flood of garbage is bounded too. Sliding
      // window rather than a token bucket: the burst that matters (WebRTC
      // negotiation) is exactly what a window sized for it already allows.
      const now = Date.now()
      if (now - peer.windowStartedAt >= messageRateWindowMs) {
        peer.windowStartedAt = now
        peer.messagesInWindow = 0
      }
      peer.messagesInWindow += 1
      if (peer.messagesInWindow > messageRateLimit) {
        // A client that outruns this budget is misbehaving, not unlucky.
        socket.close(WS_CLOSE_POLICY_VIOLATION, 'message rate exceeded')
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(String(data))
      } catch {
        return
      }
      const result = ClientMessageSchema.safeParse(parsed)
      if (!result.success) return
      const message = result.data

      if (message.type === 'signal') {
        const target = room.get(message.to)
        if (target) {
          send(target, {
            type: 'signal',
            from: peer.id,
            payload: message.payload,
          })
        }
        return
      }

      const target = room.get(message.to)
      if (target) {
        send(target, { type: 'relay', from: peer.id, payload: message.payload })
      }
    })

    socket.on('close', () => {
      room.delete(peer.id)
      if (room.size === 0) {
        rooms.delete(topic)
        return
      }
      for (const other of room.values()) {
        send(other, { type: 'peer-left', peerId: peer.id })
      }
    })
  })

  // Reaping a ghost is not just tidiness: rooms are only reclaimed at size 0,
  // so one ghost pins its room forever, every publisher keeps relaying to it,
  // and its `peer-left` never fires — leaving every live peer holding a
  // half-open RTCPeerConnection. `terminate()` fires 'close', so the existing
  // teardown below does all of that for us.
  const heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const peer of room.values()) {
        if (!peer.alive) {
          peer.socket.terminate()
          continue
        }
        peer.alive = false
        peer.socket.ping()
      }
    }
  }, heartbeatIntervalMs)

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(options.port, () => {
      const address = httpServer.address()
      const port = typeof address === 'object' && address !== null ? address.port : options.port
      resolve({
        port,
        close: () =>
          new Promise<void>((resolveClose) => {
            clearInterval(heartbeat)
            for (const client of wss.clients) {
              client.terminate()
            }
            wss.close(() => {
              httpServer.close(() => resolveClose())
            })
          }),
      })
    })
  })
}
