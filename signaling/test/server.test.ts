// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Server } from 'node:http'
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
/** Past the server's 64 KiB `maxPayload`. */
const OVERSIZED_PAYLOAD_BYTES = 70_000
/** How long a client that has blown its budget keeps writing, and how often. */
const OVERRUN_WRITE_WINDOW_MS = 2500
const OVERRUN_WRITE_EVERY_MS = 100

/**
 * Timers currently holding the event loop open. Unref'd timers are invisible
 * here by design — `getActiveResourcesInfo` reports what keeps the loop alive —
 * which is exactly the distinction the leak assertions care about.
 */
function activeTimers(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length
}

/**
 * The listening HTTP server behind a signaling server, found by port.
 *
 * `process._getActiveHandles()` is internal, and used here because there is no
 * other way in: an accept failure is delivered by libuv to the listening
 * server, the server is deliberately not part of the public surface, and the
 * point of the test is what happens when something reports one. Matching on
 * `listening` as well as the port keeps accepted sockets — which share the
 * local port and also answer `address()` — out of the result.
 */
function listeningServerOn(port: number): Server {
  const handles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles()
  const match = handles.find((handle): handle is Server => {
    if (typeof handle !== 'object' || handle === null || !('listening' in handle)) return false
    const address = (handle as Server).address()
    return (
      (handle as Server).listening === true && typeof address === 'object' && address?.port === port
    )
  })
  if (!match) throw new Error(`no listening server on port ${port}`)
  return match
}

/** A masked text frame, as a client must send. A zero mask key is still a mask. */
function clientFrame(payload: string): Buffer {
  const body = Buffer.from(payload)
  return Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), Buffer.alloc(4, 0), body])
}

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
  // Writing to a socket the server has since destroyed is expected here, and an
  // unhandled 'error' on a stream would take the runner down with it.
  socket.on('error', () => {})
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

  // `ws` reports a frame past `maxPayload` by emitting 'error' on the socket,
  // and an unhandled 'error' is an uncaught exception — so before the handler
  // in `connection`, this single frame killed the process, not the connection.
  it('survives a frame past the payload cap without taking the service down', async () => {
    const topic = randomTopic()
    const offender = await connect(topic)
    const bystander = await connect(topic)
    // Asserted directly rather than left to the runner: vitest installs its own
    // `uncaughtException` listener, so the process survives here either way and
    // the room-level assertions below pass with or without the fix. The escaped
    // error is the defect, so it is the thing to assert on.
    const uncaught: unknown[] = []
    const record = (error: unknown): void => {
      uncaught.push(error)
    }
    process.on('uncaughtException', record)
    try {
      offender.socket.send('x'.repeat(OVERSIZED_PAYLOAD_BYTES))
      // The offender goes and the room is told — the connection dies, not us.
      expect((await bystander.next((m) => m.type === 'peer-left')).peerId).toBe(offender.peerId)
      expect(uncaught).toEqual([])
      // And the server is still serving.
      const arrival = await connect(topic)
      expect(arrival.peersAtWelcome).toEqual([bystander.peerId])
      arrival.close()
    } finally {
      process.off('uncaughtException', record)
      offender.close()
      bystander.close()
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

  // The only `clearInterval` lives in the `close` handed out on the success
  // path, so a heartbeat armed before `listen` outlives a bind that fails: the
  // caller gets a rejection and no handle, and the timer holds the event loop
  // open for the life of the process.
  // An accept failure — EMFILE under a flood of bare TCP connections is the
  // realistic one — is reported on the listening server long after `listen`
  // resolved, and `ws` forwards the http server's errors to the
  // `WebSocketServer`. Neither had a listener left, so the flood these bounds
  // exist to survive took the process down through a different door.
  it('survives an accept failure reported after listen', async () => {
    const running = await createSignalingServer({ port: 0 })
    const uncaught: unknown[] = []
    const record = (error: unknown): void => {
      uncaught.push(error)
    }
    process.on('uncaughtException', record)
    try {
      const failure = Object.assign(new Error('accept EMFILE'), { code: 'EMFILE' })
      listeningServerOn(running.port).emit('error', failure)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(uncaught).toEqual([])
      // Still serving.
      const arrival = await connect(randomTopic(), running.port)
      arrival.close()
    } finally {
      process.off('uncaughtException', record)
      await running.close()
    }
  })

  it('leaves no timer behind when the bind fails', async () => {
    const occupied = await createSignalingServer({ port: 0 })
    try {
      const before = activeTimers()
      await expect(
        createSignalingServer({ port: occupied.port, heartbeatIntervalMs: 60_000 }),
      ).rejects.toThrow()
      expect(activeTimers()).toBe(before)
    } finally {
      await occupied.close()
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

  // The budget close has to drop the socket like every other refusal: a client
  // that blows its budget is the one most likely to ignore the close frame and
  // keep writing, and a peer whose socket lingers holds a connection-cap slot
  // the heartbeat will not reclaim for two full intervals. Dropping must not
  // wait for the flood to stop, so this keeps writing well past the linger.
  it('drops a peer that keeps writing after its budget close', async () => {
    const capped = await createSignalingServer({
      port: 0,
      messageRateLimit: 1,
      messageRateWindowMs: 60_000,
    })
    const rude = await rudeUpgrade(capped.port, randomTopic())
    const startedAt = Date.now()
    const dropped = new Promise<number>((resolve) =>
      rude.once('close', () => resolve(Date.now() - startedAt)),
    )
    // The second frame is over budget; everything after it lands post-close.
    const writing = setInterval(() => {
      if (!rude.destroyed) rude.write(clientFrame('{}'))
    }, OVERRUN_WRITE_EVERY_MS)
    try {
      expect(await dropped).toBeLessThan(OVERRUN_WRITE_WINDOW_MS)
    } finally {
      clearInterval(writing)
      rude.destroy()
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
