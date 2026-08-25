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
const WS_CLOSE_POLICY_VIOLATION = 1008

/**
 * Ping cadence. A socket that has not ponged by the following tick is
 * terminated, so the worst case for noticing a half-open connection is two
 * intervals.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000

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
}

export interface SignalingServer {
  port: number
  close(): Promise<void>
}

export interface SignalingServerOptions {
  port: number
  /** Origins allowed to connect; empty/absent allows all (dev). */
  allowedOrigins?: string[]
  /** Override for the ping cadence, so tests can drive it in milliseconds. */
  heartbeatIntervalMs?: number
}

function send(peer: Peer, message: Record<string, unknown>): void {
  if (peer.socket.readyState === WebSocket.OPEN) {
    peer.socket.send(JSON.stringify(message))
  }
}

export function createSignalingServer(options: SignalingServerOptions): Promise<SignalingServer> {
  const rooms = new Map<string, Map<string, Peer>>()
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS

  const httpServer: Server = createServer((request, response) => {
    if (request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok')
      return
    }
    response.writeHead(404)
    response.end()
  })

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_PAYLOAD_BYTES,
    verifyClient: ({ origin }: { origin?: string }) => {
      const allowed = options.allowedOrigins
      if (!allowed || allowed.length === 0) return true
      return origin !== undefined && allowed.includes(origin)
    },
  })

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const topic = url.searchParams.get('topic') ?? ''
    if (!TOPIC_PATTERN.test(topic)) {
      socket.close(WS_CLOSE_POLICY_VIOLATION, 'invalid topic')
      return
    }

    const peer: Peer = { id: randomUUID(), socket, alive: true }
    const room = rooms.get(topic) ?? new Map<string, Peer>()
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
  // teardown above does all of that for us.
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
