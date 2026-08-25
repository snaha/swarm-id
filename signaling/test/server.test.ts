// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createConnection } from 'node:net'
import type { Socket } from 'node:net'

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket as WS } from 'ws'

import {
  createSignalingServer,
  WS_CLOSE_POLICY_VIOLATION,
  WS_CLOSE_TRY_AGAIN_LATER,
} from '../src/server'
import type { SignalingServer } from '../src/server'

/** Bound on a wait for a message the server should send within a tick or two. */
const MESSAGE_TIMEOUT_MS = 2000
/** Comfortably over the server's refusal linger, well under `ws`'s 30 s. */
const REFUSAL_DROP_TIMEOUT_MS = 4000

/**
 * A WebSocket client that completes the handshake and then never answers
 * anything — including a close frame. `ws` clients (and the global WebSocket)
 * reply to a close at protocol level, so neither can stand in for the rude
 * client this is about, the same way `autoPong: false` is the only stand-in
 * for a dead socket in the heartbeat tests.
 */
function rudeUpgrade(port: number, topic: string): Promise<Socket> {
  const key = Buffer.from(randomTopic(), 'hex').toString('base64')
  const socket = createConnection(port, '127.0.0.1')
  socket.write(
    `GET /?topic=${topic} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n\r\n',
  )
  // Resolve on the upgrade response; everything after it is ignored on purpose.
  return new Promise((resolve) => socket.once('data', () => resolve(socket)))
}

// A fresh topic per test keeps rooms isolated — a shared room would leak
// join/leave events from a previous test's closing sockets.
function randomTopic(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

let server: SignalingServer

beforeAll(async () => {
  server = await createSignalingServer({ port: 0 })
})

afterAll(async () => {
  await server.close()
})

interface TestClient {
  socket: WebSocket
  peerId: string
  peersAtWelcome: string[]
  received: Record<string, unknown>[]
  next(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>
  close(): void
}

function connect(topic: string, port: number = server.port): Promise<TestClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?topic=${topic}`)
  const received: Record<string, unknown>[] = []
  const waiters: {
    predicate: (message: Record<string, unknown>) => boolean
    resolve: (message: Record<string, unknown>) => void
  }[] = []

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>
    received.push(message)
    const index = waiters.findIndex((waiter) => waiter.predicate(message))
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1)
      waiter.resolve(message)
    }
  })

  return new Promise((resolve, reject) => {
    socket.addEventListener('error', () => reject(new Error('socket error')))
    socket.addEventListener('message', function onWelcome(event) {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>
      if (message.type !== 'welcome') return
      socket.removeEventListener('message', onWelcome)
      resolve({
        socket,
        peerId: message.peerId as string,
        peersAtWelcome: message.peers as string[],
        received,
        next(predicate) {
          const match = received.find(predicate)
          if (match) return Promise.resolve(match)
          // Bounded: an unbounded wait turns a real regression into a test
          // that hangs until vitest's own timeout, with nothing said about
          // what never arrived.
          return new Promise((resolveNext, rejectNext) => {
            const waiter = { predicate, resolve: resolveNext }
            waiters.push(waiter)
            setTimeout(() => {
              const index = waiters.indexOf(waiter)
              if (index < 0) return
              waiters.splice(index, 1)
              rejectNext(
                new Error(
                  `no matching message within ${MESSAGE_TIMEOUT_MS}ms; got ${JSON.stringify(received)}`,
                ),
              )
            }, MESSAGE_TIMEOUT_MS).unref()
          })
        },
        close() {
          socket.close()
        },
      })
    })
  })
}

describe('signaling server', () => {
  it('welcomes a peer with the existing room roster and announces joins', async () => {
    const topic = randomTopic()
    const first = await connect(topic)
    const second = await connect(topic)
    try {
      expect(first.peersAtWelcome).toEqual([])
      expect(second.peersAtWelcome).toEqual([first.peerId])
      const joined = await first.next((m) => m.type === 'peer-joined')
      expect(joined.peerId).toBe(second.peerId)
    } finally {
      first.close()
      second.close()
    }
  })

  // There is no room-wide broadcast: an untargeted relay is simply malformed,
  // so a peer that guessed a topic gets no amplifier.
  it('drops an untargeted relay instead of broadcasting it', async () => {
    const topic = randomTopic()
    const sender = await connect(topic)
    const receiver = await connect(topic)
    try {
      sender.socket.send(JSON.stringify({ type: 'relay', payload: 'cipher' }))
      sender.socket.send(JSON.stringify({ type: 'relay', to: receiver.peerId, payload: 'direct' }))
      // The well-formed follow-up is the barrier: if the first had been
      // relayed it would have arrived ahead of this one.
      const relayed = await receiver.next((m) => m.type === 'relay')
      expect(relayed).toEqual({
        type: 'relay',
        from: sender.peerId,
        payload: 'direct',
      })
    } finally {
      sender.close()
      receiver.close()
    }
  })

  it('delivers a targeted relay to exactly the named peer', async () => {
    const topic = randomTopic()
    const sender = await connect(topic)
    const target = await connect(topic)
    const bystander = await connect(topic)
    try {
      sender.socket.send(JSON.stringify({ type: 'relay', to: target.peerId, payload: 'direct' }))
      const relayed = await target.next((m) => m.type === 'relay')
      expect(relayed.payload).toBe('direct')
      expect(bystander.received.filter((m) => m.type === 'relay')).toEqual([])
    } finally {
      sender.close()
      target.close()
      bystander.close()
    }
  })

  it('forwards signal messages to the named peer with the sender attached', async () => {
    const topic = randomTopic()
    const caller = await connect(topic)
    const callee = await connect(topic)
    try {
      caller.socket.send(
        JSON.stringify({
          type: 'signal',
          to: callee.peerId,
          payload: { kind: 'offer', sdp: 'v=0' },
        }),
      )
      const signal = await callee.next((m) => m.type === 'signal')
      expect(signal).toEqual({
        type: 'signal',
        from: caller.peerId,
        payload: { kind: 'offer', sdp: 'v=0' },
      })
    } finally {
      caller.close()
      callee.close()
    }
  })

  it('announces peer departure to the remaining room', async () => {
    const topic = randomTopic()
    const stayer = await connect(topic)
    const leaver = await connect(topic)
    leaver.close()
    try {
      const left = await stayer.next((m) => m.type === 'peer-left')
      expect(left.peerId).toBe(leaver.peerId)
    } finally {
      stayer.close()
    }
  })

  it('ignores malformed messages without dropping the room', async () => {
    const topic = randomTopic()
    const sender = await connect(topic)
    const receiver = await connect(topic)
    try {
      sender.socket.send('not json')
      sender.socket.send(JSON.stringify({ type: 'unknown' }))
      sender.socket.send(
        JSON.stringify({ type: 'relay', to: receiver.peerId, payload: 'still-on' }),
      )
      const relayed = await receiver.next((m) => m.type === 'relay')
      expect(relayed.payload).toBe('still-on')
    } finally {
      sender.close()
      receiver.close()
    }
  })

  it('rejects connections with an invalid topic', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/?topic=nope`)
    const code = await new Promise<number>((resolve) => {
      socket.addEventListener('close', (event) => resolve(event.code))
    })
    expect(code).toBe(WS_CLOSE_POLICY_VIOLATION)
  })

  it('enforces the origin allowlist when configured', async () => {
    const guarded = await createSignalingServer({
      port: 0,
      allowedOrigins: ['https://allowed.example'],
    })
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${guarded.port}/?topic=${randomTopic()}`)
      const failed = await new Promise<boolean>((resolve) => {
        socket.addEventListener('error', () => resolve(true))
        socket.addEventListener('close', () => resolve(true))
        socket.addEventListener('open', () => resolve(false))
      })
      expect(failed).toBe(true)
    } finally {
      await guarded.close()
    }
  })
})

// ============================================================================
// Liveness (#573)
// ============================================================================

/** Close code and reason of the first close event, for cap assertions. */
function closeInfo(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason }))
  })
}

describe('signaling server — heartbeat', () => {
  it('terminates a socket that stops answering pings, and tells the room', async () => {
    const beating = await createSignalingServer({ port: 0, heartbeatIntervalMs: 50 })
    try {
      const topic = randomTopic()
      const live = await connect(topic, beating.port)
      // `autoPong: false` is the whole point: the global WebSocket (and a stock
      // `ws` client) answers pings at protocol level, so a half-open socket
      // cannot be simulated with either.
      const ghost = new WS(`ws://127.0.0.1:${beating.port}/?topic=${topic}`, {
        autoPong: false,
      })
      try {
        await new Promise((resolve) => ghost.on('open', resolve))
        const joined = await live.next((m) => m.type === 'peer-joined')

        // Round one pings both; round two finds the ghost never answered.
        const left = await live.next((m) => m.type === 'peer-left')
        expect(left.peerId).toBe(joined.peerId)
      } finally {
        live.close()
        ghost.terminate()
      }
    } finally {
      await beating.close()
    }
  })

  // Deliberately slower than the test above: a peer is reaped after two ticks
  // without a pong, so at a 20 ms cadence a CI stall past 40 ms can produce
  // that from a perfectly healthy socket — failing the one test whose job is
  // to prove over-reaping does not happen.
  it('does not terminate a socket that is answering', async () => {
    const beating = await createSignalingServer({ port: 0, heartbeatIntervalMs: 200 })
    try {
      const topic = randomTopic()
      const first = await connect(topic, beating.port)
      const second = await connect(topic, beating.port)
      try {
        // Several heartbeat rounds with nothing else happening.
        await new Promise((resolve) => setTimeout(resolve, 700))
        expect(first.received.filter((m) => m.type === 'peer-left')).toEqual([])

        first.socket.send(JSON.stringify({ type: 'relay', to: second.peerId, payload: 'alive' }))
        const relayed = await second.next((m) => m.type === 'relay')
        expect(relayed.payload).toBe('alive')
      } finally {
        first.close()
        second.close()
      }
    } finally {
      await beating.close()
    }
  })
})

// ============================================================================
// Overload bounds (#575)
// ============================================================================

describe('signaling server — limits', () => {
  it('turns away a peer once the room is full, leaving the room intact', async () => {
    const capped = await createSignalingServer({ port: 0, maxPeersPerRoom: 2 })
    try {
      const topic = randomTopic()
      const first = await connect(topic, capped.port)
      const second = await connect(topic, capped.port)
      try {
        const third = new WebSocket(`ws://127.0.0.1:${capped.port}/?topic=${topic}`)
        // 1013 (try again later), NOT 1008 — the client stops reconnecting on
        // 1008, which is right for a bad topic and wrong for transient load.
        expect((await closeInfo(third)).code).toBe(WS_CLOSE_TRY_AGAIN_LATER)

        // The two already in the room still work.
        first.socket.send(JSON.stringify({ type: 'relay', to: second.peerId, payload: 'ok' }))
        expect((await second.next((m) => m.type === 'relay')).payload).toBe('ok')
      } finally {
        first.close()
        second.close()
      }
    } finally {
      await capped.close()
    }
  })

  it('turns away a peer opening a room past the room cap', async () => {
    const capped = await createSignalingServer({ port: 0, maxRooms: 1 })
    try {
      const resident = await connect(randomTopic(), capped.port)
      try {
        const newcomer = new WebSocket(`ws://127.0.0.1:${capped.port}/?topic=${randomTopic()}`)
        expect((await closeInfo(newcomer)).code).toBe(WS_CLOSE_TRY_AGAIN_LATER)
      } finally {
        resident.close()
      }
    } finally {
      await capped.close()
    }
  })

  it('lets a peer join an existing room even at the room cap', async () => {
    const capped = await createSignalingServer({ port: 0, maxRooms: 1 })
    try {
      const topic = randomTopic()
      const first = await connect(topic, capped.port)
      try {
        // Same room — the cap bounds rooms, not peers.
        const second = await connect(topic, capped.port)
        expect(second.peersAtWelcome).toEqual([first.peerId])
        second.close()
      } finally {
        first.close()
      }
    } finally {
      await capped.close()
    }
  })

  // 1013, not 1008. The client treats a policy close as permanent for the whole
  // page (`lib/src/bus/signaling-transport.ts`), so closing an overrun with 1008
  // would trade one burst for a context that never syncs again — and a full room
  // legitimately bursts, which is what the budget is now sized for.
  it('closes a socket that exceeds its message budget with a retryable code', async () => {
    const capped = await createSignalingServer({
      port: 0,
      messageRateLimit: 3,
      messageRateWindowMs: 60_000,
    })
    try {
      const topic = randomTopic()
      const sender = await connect(topic, capped.port)
      const receiver = await connect(topic, capped.port)
      try {
        const closed = closeInfo(sender.socket)
        for (let i = 0; i < 4; i += 1) {
          sender.socket.send(
            JSON.stringify({ type: 'relay', to: receiver.peerId, payload: `m${i}` }),
          )
        }
        expect((await closed).code).toBe(WS_CLOSE_TRY_AGAIN_LATER)
        // The budget is honoured before it is enforced: three got through.
        await receiver.next((m) => m.payload === 'm2')
        expect(receiver.received.filter((m) => m.type === 'relay')).toHaveLength(3)

        // And the client is welcome back — the whole point of not using 1008.
        const returning = await connect(topic, capped.port)
        returning.socket.send(
          JSON.stringify({ type: 'relay', to: receiver.peerId, payload: 'back' }),
        )
        expect((await receiver.next((m) => m.payload === 'back')).type).toBe('relay')
        returning.close()
      } finally {
        sender.close()
        receiver.close()
      }
    } finally {
      await capped.close()
    }
  })

  // The budget has to clear a full room's join burst: `welcome` makes a newcomer
  // initiate toward every peer already there at once, at an offer plus ~15 ICE
  // candidates each. A flat number that looks generous for a 4-peer room is
  // below what a full room sends in its first seconds — which is why the budget
  // is derived from the room cap rather than fixed.
  it('sizes the default message budget to a full room negotiating', async () => {
    const maxPeersPerRoom = 24
    const capped = await createSignalingServer({ port: 0, maxPeersPerRoom })
    try {
      const topic = randomTopic()
      const receiver = await connect(topic, capped.port)
      const sender = await connect(topic, capped.port)
      try {
        // What negotiating with a full room already in it costs the newcomer.
        const burst = (maxPeersPerRoom - 1) * 16
        for (let i = 0; i < burst; i += 1) {
          sender.socket.send(
            JSON.stringify({ type: 'signal', to: receiver.peerId, payload: { kind: 'ice' } }),
          )
        }
        sender.socket.send(JSON.stringify({ type: 'relay', to: receiver.peerId, payload: 'after' }))
        expect((await receiver.next((m) => m.payload === 'after')).type).toBe('relay')
        expect(sender.socket.readyState).toBe(WebSocket.OPEN)
      } finally {
        sender.close()
        receiver.close()
      }
    } finally {
      await capped.close()
    }
  })

  it('refuses a connection past the global cap before upgrading it', async () => {
    const capped = await createSignalingServer({ port: 0, maxConnections: 1 })
    try {
      const resident = await connect(randomTopic(), capped.port)
      try {
        // Rejected in verifyClient, so the handshake itself fails — there is
        // no WebSocket to carry a close code.
        const socket = new WebSocket(`ws://127.0.0.1:${capped.port}/?topic=${randomTopic()}`)
        const opened = await new Promise<boolean>((resolve) => {
          socket.addEventListener('open', () => resolve(true))
          socket.addEventListener('error', () => resolve(false))
          socket.addEventListener('close', () => resolve(false))
        })
        expect(opened).toBe(false)
      } finally {
        resident.close()
      }
    } finally {
      await capped.close()
    }
  })

  // A refused socket is in no room, so the heartbeat cannot reach it, and `ws`
  // holds it against the connection cap until the peer answers the close frame
  // or 30 s pass. A client that simply never answers would therefore park a
  // capacity slot for half a minute per TCP handshake — cheap enough to refuse
  // every real user with. Hence the terminate behind each refusal.
  it('drops a refused socket that ignores the close frame', async () => {
    const capped = await createSignalingServer({ port: 0 })
    try {
      const rude = await rudeUpgrade(capped.port, 'not-a-topic')
      const dropped = new Promise<boolean>((resolve) => {
        rude.once('close', () => resolve(true))
        setTimeout(() => resolve(false), REFUSAL_DROP_TIMEOUT_MS).unref()
      })
      expect(await dropped).toBe(true)
      rude.destroy()
    } finally {
      await capped.close()
    }
  })
})
