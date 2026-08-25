// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket as WS } from 'ws'

import { createSignalingServer } from '../src/server'
import type { SignalingServer } from '../src/server'

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
          return new Promise((resolveNext) => waiters.push({ predicate, resolve: resolveNext }))
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
    expect(code).toBe(1008)
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

  it('does not terminate a socket that is answering', async () => {
    const beating = await createSignalingServer({ port: 0, heartbeatIntervalMs: 20 })
    try {
      const topic = randomTopic()
      const first = await connect(topic, beating.port)
      const second = await connect(topic, beating.port)
      try {
        // Several heartbeat rounds with nothing else happening.
        await new Promise((resolve) => setTimeout(resolve, 150))
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
