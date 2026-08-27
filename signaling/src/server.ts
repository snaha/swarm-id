// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Account-bus signaling and relay server (docs/Account-Bus.md, phase 2).
 *
 * Peers connect over WebSocket and name their room in a `join` frame, forming
 * one room per topic (topics are account-derived and unguessable). The topic
 * used to travel as `/?topic=<hex>`, which put the room capability into every
 * ingress and proxy access log; `/?topic=` is still accepted for clients cached
 * from before that change (#577). The server does two things and nothing else:
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
/**
 * The client treats this as permanent and stops reconnecting for good, so it is
 * reserved for the one thing that will never come right: a topic this server
 * refuses and would refuse identically on every retry. Everything else — load,
 * an exhausted budget — closes with 1013.
 */
export const WS_CLOSE_POLICY_VIOLATION = 1008
/** Transient — the client backs off and comes back. */
export const WS_CLOSE_TRY_AGAIN_LATER = 1013
/**
 * A socket that never named a room (`preJoinTimeoutMs`). Its own code rather
 * than 1008, because 1008 already means "this server predates the join frame"
 * to a client, which answers it by putting the topic back in the URL for the
 * life of the page — the exact thing #577 removes. Application range (4000+),
 * numbered after HTTP 408 so it reads as what it is; a client that does not
 * know it backs off and retries, which is the right answer for a socket that
 * failed to speak in time.
 */
export const WS_CLOSE_JOIN_TIMEOUT = 4408

/**
 * `ws` keeps a closing socket in `wss.clients` for up to 30 s waiting for the
 * peer's close frame, and the heartbeat below only walks `rooms` — a refused
 * socket is in neither, so nothing reclaims its global-cap slot. A flood that
 * ignores the close would refuse every real user for one TCP handshake each.
 * Give the frame a moment to reach an honest client, then drop the socket.
 */
const REFUSAL_LINGER_MS = 1000

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
 * Outbound cost of negotiating with ONE peer: an offer/answer plus ~15 ICE
 * candidates, doubled for renegotiation and relay traffic. The budget is sized
 * from this times the room cap rather than fixed, because `welcome` makes a
 * newcomer initiate toward every peer already in the room at once — a flat
 * number that looks generous for a 4-peer room cuts off a full one mid-join.
 */
const MESSAGES_PER_PEER_NEGOTIATION = 40
const DEFAULT_MESSAGE_RATE_WINDOW_MS = 10_000
/**
 * How long a socket may sit unjoined. The topic now arrives in the first frame
 * rather than the URL, so there is a window where a socket has been accepted
 * and named nothing — and a socket that never names a room holds a connection
 * slot for free, which is a cheaper flood than any the caps above bound.
 * Generous next to a round trip, far below anything a real client takes.
 */
const DEFAULT_PRE_JOIN_TIMEOUT_MS = 10_000

const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('join'),
    topic: z.string(),
  }),
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
  /** How long a socket may stay unjoined before it is turned away. */
  preJoinTimeoutMs?: number
}

/**
 * Turn a socket away and make sure it actually goes: `close` alone leaves it
 * counting against the connection cap until the peer answers or `ws` gives up
 * 30 s later, and a refused socket joined no room, so the heartbeat cannot
 * reach it either (see `REFUSAL_LINGER_MS`).
 *
 * Only the first call does anything. A socket closed for outrunning its message
 * budget keeps delivering whatever was already in flight, and arming a timer per
 * frame would hand the flood we are refusing an allocation per message.
 */
function refuse(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState !== WebSocket.OPEN) return
  socket.close(code, reason)
  setTimeout(() => socket.terminate(), REFUSAL_LINGER_MS).unref()
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
  const messageRateLimit =
    options.messageRateLimit ?? maxPeersPerRoom * MESSAGES_PER_PEER_NEGOTIATION
  const messageRateWindowMs = options.messageRateWindowMs ?? DEFAULT_MESSAGE_RATE_WINDOW_MS
  const preJoinTimeoutMs = options.preJoinTimeoutMs ?? DEFAULT_PRE_JOIN_TIMEOUT_MS

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

  // `ws` forwards the HTTP server's errors here, and once `listen` has resolved
  // nothing else is listening for them — an unhandled 'error' is an uncaught
  // exception. What arrives after the bind is an accept failure (EMFILE, when a
  // flood of bare TCP connections exhausts the file descriptors), so the very
  // load these bounds exist to survive would otherwise end the process through
  // a door none of them cover. It is per-accept and transient: log it and keep
  // serving. Note this must be on `wss`, not on the HTTP server — a listener
  // there does not stop the forwarded copy from going unhandled.
  wss.on('error', (error) => {
    // Only once the bind has taken. A failure before that is already the
    // caller's rejection, and logging it here would double-report it.
    if (httpServer.listening) {
      console.error('[signaling] server error:', error)
    }
  })

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    // First, before any early return: `ws` reports every protocol-level fault
    // by emitting 'error' on the socket — a frame past `maxPayload`, a reserved
    // opcode, invalid UTF-8 in a text frame — and an unhandled 'error' on an
    // EventEmitter is an uncaught exception. Without this, one oversized frame
    // from any client that gets past `verifyClient` takes the whole service
    // down. `ws` answers the bad frame with a close of its own, which would sit
    // in `wss.clients` for 30 s; terminate instead, as with a refusal.
    socket.on('error', () => socket.terminate())

    const url = new URL(request.url ?? '/', 'http://localhost')
    // The topic belongs in the first frame, not the URL: query strings are
    // recorded by every ingress and proxy access log as a matter of course, and
    // the topic IS the room capability — anything that reads those logs can
    // join (#577). The query string is still accepted, and has to be: a client
    // bundle cached from before this change puts it there, and a mid-deploy
    // reload that could not join its own account's room would silently stop
    // seeing its other tabs.
    const queryTopic = url.searchParams.get('topic')

    const peer: Peer = {
      id: randomUUID(),
      socket,
      alive: true,
      windowStartedAt: Date.now(),
      messagesInWindow: 0,
    }
    let joined: { topic: string; room: Map<string, Peer> } | undefined
    socket.on('pong', () => {
      peer.alive = true
    })

    /** Admit this socket to a room, or refuse it. Same answer either way in,
     *  so the query string and the join frame cannot drift apart. */
    const join = (topic: string): void => {
      // Refusing a socket closes it, but cannot stop the client talking — a
      // frame may already be in flight, and a rude client ignores the close
      // outright (`REFUSAL_LINGER_MS`). Admitting one anyway would put a
      // CLOSING socket in the room and announce a peer that is about to be
      // terminated. The `joined` half is the same guard read the other way: a
      // peer already in a room does not get moved to another.
      if (joined || socket.readyState !== WebSocket.OPEN) return
      if (!TOPIC_PATTERN.test(topic)) {
        refuse(socket, WS_CLOSE_POLICY_VIOLATION, 'invalid topic')
        return
      }

      // Both caps are load, so both refuse with 1013 (see the close codes above).
      const existing = rooms.get(topic)
      if (!existing && rooms.size >= maxRooms) {
        refuse(socket, WS_CLOSE_TRY_AGAIN_LATER, 'too many rooms')
        return
      }
      const room = existing ?? new Map<string, Peer>()
      if (room.size >= maxPeersPerRoom) {
        refuse(socket, WS_CLOSE_TRY_AGAIN_LATER, 'room full')
        return
      }

      rooms.set(topic, room)
      joined = { topic, room }

      send(peer, {
        type: 'welcome',
        peerId: peer.id,
        peers: [...room.keys()],
      })
      for (const other of room.values()) {
        send(other, { type: 'peer-joined', peerId: peer.id })
      }
      room.set(peer.id, peer)
    }

    // Unjoined sockets are turned away rather than left to sit: one that never
    // names a room costs a connection slot for nothing. Unref'd so it cannot be
    // what keeps the process alive.
    const preJoinTimer =
      queryTopic !== null
        ? undefined
        : setTimeout(() => {
            if (!joined) refuse(socket, WS_CLOSE_JOIN_TIMEOUT, 'no join')
          }, preJoinTimeoutMs)
    preJoinTimer?.unref()

    if (queryTopic !== null) join(queryTopic)

    socket.on('message', (data) => {
      // Counted before the parse, so a flood of garbage is bounded too. A
      // fixed window that resets whole, not a sliding one or a token bucket:
      // the burst that matters (WebRTC negotiation) is exactly what a window
      // sized for it already allows, and the seam it leaves — up to two
      // budgets across a window boundary — is still bounded.
      const now = Date.now()
      if (now - peer.windowStartedAt >= messageRateWindowMs) {
        peer.windowStartedAt = now
        peer.messagesInWindow = 0
      }
      peer.messagesInWindow += 1
      if (peer.messagesInWindow > messageRateLimit) {
        // 1013, not 1008: the client hard-codes a policy close as permanent and
        // stops reconnecting for the rest of the page's life, which would trade
        // one overrun for a context that never syncs again. The window will
        // pass, so this genuinely is try-again-later.
        //
        // Note that a client which keeps overrunning comes back at roughly the
        // reconnect floor rather than backing off — the backoff resets on any
        // message received, and `welcome` arrives on every accepted socket. It
        // is the connection cap, not the backoff, that bounds that; the cost
        // per cycle is one handshake, the same as any reconnect flood.
        refuse(socket, WS_CLOSE_TRY_AGAIN_LATER, 'message rate exceeded')
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

      // Until a room is named, the join frame is the only thing this socket can
      // say. Relaying or signalling before it would let an unjoined socket
      // address a room it never named.
      if (!joined) {
        if (message.type !== 'join') return
        if (preJoinTimer) clearTimeout(preJoinTimer)
        join(message.topic)
        return
      }
      // A second join is not a room change: the peer is already in one, and
      // moving it would leave the first room announcing a peer that left it.
      if (message.type === 'join') return
      const room = joined.room

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
      if (preJoinTimer) clearTimeout(preJoinTimer)
      if (!joined) return
      const { topic, room } = joined
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

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(options.port, () => {
      const address = httpServer.address()
      const port = typeof address === 'object' && address !== null ? address.port : options.port
      // Armed here rather than above: `clearInterval` only ever runs from the
      // `close` handed out below, so a timer started before `listen` outlives a
      // failed bind (EADDRINUSE rejects with no handle) and holds the event
      // loop open forever.
      //
      // Reaping a ghost is not just tidiness: rooms are only reclaimed at size
      // 0, so one ghost pins its room forever, every publisher keeps relaying
      // to it, and its `peer-left` never fires — leaving every live peer
      // holding a half-open RTCPeerConnection. `terminate()` fires 'close', so
      // the teardown above does all of that for us.
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
