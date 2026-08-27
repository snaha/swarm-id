// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import { createSignalingServer } from "@swarm-id/signaling"
import type { SignalingServer } from "@swarm-id/signaling"

import { SignalingTransport } from "./signaling-transport"
import { deriveBusContext } from "./bus-context"
import type { BusContext } from "./bus-context"
import type { BusMessageInput } from "./messages"

const DERIVATION_KEY = "11".repeat(32)
const OTHER_DERIVATION_KEY = "99".repeat(32)

const UTILIZATION_MESSAGE: BusMessageInput = {
  type: "utilization-updated",
  batchId: "ab".repeat(32),
  partition: 0,
  partitionCount: 2,
  buckets: [{ index: 1, value: 2 }],
}

let server: SignalingServer
let context: BusContext

beforeAll(async () => {
  server = await createSignalingServer({ port: 0 })
  context = await deriveBusContext(DERIVATION_KEY)
})

afterAll(async () => {
  await server.close()
})

function serverUrl(): string {
  return `ws://127.0.0.1:${server.port}`
}

function makeTransport(
  overrides: Partial<ConstructorParameters<typeof SignalingTransport>[0]> = {},
): SignalingTransport {
  return new SignalingTransport({
    url: serverUrl(),
    topic: context.topic,
    encryptionKey: context.encryptionKey,
    ...overrides,
  })
}

function collect(transport: SignalingTransport): unknown[] {
  const received: unknown[] = []
  transport.subscribe((raw) => received.push(raw))
  return received
}

async function waitForPeers(
  transport: SignalingTransport,
  count: number,
): Promise<void> {
  await vi.waitFor(() => expect(transport.peerCount).toBe(count))
}

describe("deriveBusContext", () => {
  it("derives a stable 64-hex topic per derivation key", async () => {
    const again = await deriveBusContext(DERIVATION_KEY)
    const other = await deriveBusContext(OTHER_DERIVATION_KEY)
    expect(again.topic).toBe(context.topic)
    expect(again.topic).toMatch(/^[0-9a-f]{64}$/)
    expect(other.topic).not.toBe(context.topic)
  })
})

describe("SignalingTransport — relay path", () => {
  it("delivers an encrypted envelope between two contexts of the same account", async () => {
    const sender = makeTransport()
    const receiver = makeTransport()
    try {
      const received = collect(receiver)
      await waitForPeers(sender, 1)
      await waitForPeers(receiver, 1)
      sender.publish(UTILIZATION_MESSAGE)
      await vi.waitFor(() => expect(received.length).toBe(1))
      expect(received[0]).toEqual(UTILIZATION_MESSAGE)
    } finally {
      sender.close()
      receiver.close()
    }
  })

  it("never delivers plaintext to a peer without the account key", async () => {
    const otherContext = await deriveBusContext(OTHER_DERIVATION_KEY)
    const sender = makeTransport()
    const receiver = makeTransport()
    // Same room, wrong key — decryption must fail silently.
    const eavesdropper = makeTransport({
      encryptionKey: otherContext.encryptionKey,
    })
    try {
      const received = collect(receiver)
      const overheard = collect(eavesdropper)
      await waitForPeers(sender, 2)
      sender.publish(UTILIZATION_MESSAGE)
      await vi.waitFor(() => expect(received.length).toBe(1))
      expect(overheard).toEqual([])
    } finally {
      sender.close()
      receiver.close()
      eavesdropper.close()
    }
  })

  // The teardown announcement (`lease-released`) is published and the bus
  // closed in the same synchronous tick, while `deliver` is still awaiting its
  // encryption. Dropping it there costs a waiting peer the full poll interval
  // — the exact latency the message exists to remove.
  it("still delivers an envelope published in the same tick as close()", async () => {
    const sender = makeTransport()
    const receiver = makeTransport()
    try {
      const received = collect(receiver)
      await waitForPeers(sender, 1)
      await waitForPeers(receiver, 1)

      sender.publish(UTILIZATION_MESSAGE)
      sender.close()

      await vi.waitFor(() => expect(received.length).toBe(1))
      expect(received[0]).toEqual(UTILIZATION_MESSAGE)
    } finally {
      sender.close()
      receiver.close()
    }
  })

  // The server closes with 1008 for a topic it refuses, and it will refuse the
  // same topic identically next time — reconnecting is a hot loop against an
  // answer that cannot change.
  it("stops reconnecting after a policy close", async () => {
    const rejected = new SignalingTransport({
      url: serverUrl(),
      topic: "not-a-valid-topic",
      encryptionKey: context.encryptionKey,
    })
    try {
      const closed = () =>
        (rejected as unknown as { closed: boolean }).closed === true
      await vi.waitFor(() => expect(closed()).toBe(true))
      // Well past the 1 s reconnect floor: no new socket was opened.
      await new Promise((resolve) => setTimeout(resolve, 1200))
      expect(closed()).toBe(true)
      expect(rejected.peerCount).toBe(0)
    } finally {
      rejected.close()
    }
  })

  it("publishes nothing when the room has no other peers", async () => {
    const lonely = makeTransport()
    try {
      // No peers — must not throw, must not queue.
      lonely.publish(UTILIZATION_MESSAGE)
      expect(lonely.peerCount).toBe(0)
    } finally {
      lonely.close()
    }
  })
})

describe("SignalingTransport — reconnect backoff", () => {
  // Every client connected when the service restarts schedules its retry from
  // the same instant, so an undithered delay brings them all back together at
  // the moment the server can least take it.
  it("jitters the delay without changing the backoff sequence", () => {
    const transport = makeTransport()
    const internals = transport as unknown as {
      scheduleReconnect(): void
      reconnectDelayMs: number
    }
    // Spy only after construction, so the transport's own connect is unaffected.
    const delays: number[] = []
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: unknown,
      ms?: number,
    ) => {
      void handler
      delays.push(ms ?? 0)
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout)
    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        internals.reconnectDelayMs = 1000
        internals.scheduleReconnect()
      }
      expect(delays).toHaveLength(20)
      // Equal jitter: never longer than the nominal delay, never so short that
      // the backoff stops backing off.
      expect(Math.min(...delays)).toBeGreaterThanOrEqual(500)
      expect(Math.max(...delays)).toBeLessThanOrEqual(1000)
      // The point of the change: no two clients pile up on one instant.
      expect(new Set(delays).size).toBeGreaterThan(1)
    } finally {
      timers.mockRestore()
      transport.close()
    }
  })

  it("still doubles the underlying delay up to the cap", () => {
    const transport = makeTransport()
    const internals = transport as unknown as {
      scheduleReconnect(): void
      reconnectDelayMs: number
    }
    const timers = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(
        (() =>
          0 as unknown as ReturnType<
            typeof setTimeout
          >) as unknown as typeof setTimeout,
      )
    try {
      expect(internals.reconnectDelayMs).toBe(1000)
      internals.scheduleReconnect()
      expect(internals.reconnectDelayMs).toBe(2000)
      internals.scheduleReconnect()
      expect(internals.reconnectDelayMs).toBe(4000)
    } finally {
      timers.mockRestore()
      transport.close()
    }
  })
})

// ============================================================================
// WebRTC upgrade with an in-memory fake RTCPeerConnection pair
// ============================================================================

class FakeDataChannel {
  readyState: RTCDataChannelState = "connecting"
  sentCount = 0
  onmessage: ((event: { data: string }) => void) | undefined
  other: FakeDataChannel | undefined

  send(data: string): void {
    this.sentCount += 1
    const other = this.other
    queueMicrotask(() => other?.onmessage?.({ data }))
  }
}

/**
 * The pair "negotiates" through real signaling: the offer sdp carries the
 * initiator connection's registry id; the responder links a channel pair on
 * setRemoteDescription(offer) and fires ondatachannel, after which both ends
 * are open.
 *
 * ICE is modelled only as far as its ORDERING constraint, which is what #574
 * is about: `addIceCandidate` before a remote description exists rejects, the
 * way a real `RTCPeerConnection` throws `InvalidStateError`. `gate` holds
 * `setRemoteDescription` open so a test can land an `ice` signal in the window
 * the two handlers actually race in. Loopback still needs no real candidates.
 */
class FakePeerConnection {
  static registry = new Map<string, FakePeerConnection>()
  static channels: FakeDataChannel[] = []

  /** Holds every `setRemoteDescription` until resolved; set by a test. */
  static gate: { promise: Promise<void>; release: () => void } | undefined

  static openGate(): void {
    let release = (): void => {}
    const promise = new Promise<void>((resolve) => {
      release = resolve
    })
    FakePeerConnection.gate = { promise, release }
  }

  private id = crypto.randomUUID()
  channel: FakeDataChannel | undefined
  ondatachannel: ((event: { channel: FakeDataChannel }) => void) | undefined
  onicecandidate: unknown
  /** Candidates that actually reached the connection. */
  iceCandidates: unknown[] = []
  remoteDescriptionSet = false
  closed = false

  createDataChannel(_label: string): FakeDataChannel {
    this.channel = new FakeDataChannel()
    FakePeerConnection.channels.push(this.channel)
    return this.channel
  }

  async createOffer(): Promise<{ type: "offer"; sdp: string }> {
    FakePeerConnection.registry.set(this.id, this)
    return { type: "offer", sdp: this.id }
  }

  async createAnswer(): Promise<{ type: "answer"; sdp: string }> {
    return { type: "answer", sdp: this.id }
  }

  async setLocalDescription(_description: unknown): Promise<void> {}

  async setRemoteDescription(description: {
    type: string
    sdp: string
  }): Promise<void> {
    if (FakePeerConnection.gate) await FakePeerConnection.gate.promise
    this.remoteDescriptionSet = true
    if (description.type !== "offer") return
    const initiator = FakePeerConnection.registry.get(description.sdp)
    const remoteChannel = initiator?.channel
    if (!remoteChannel) throw new Error("offer from unknown fake connection")
    const localChannel = new FakeDataChannel()
    FakePeerConnection.channels.push(localChannel)
    localChannel.other = remoteChannel
    remoteChannel.other = localChannel
    localChannel.readyState = "open"
    remoteChannel.readyState = "open"
    this.channel = localChannel
    this.ondatachannel?.({ channel: localChannel })
  }

  async addIceCandidate(candidate: unknown): Promise<void> {
    // What a real connection does before a remote description exists.
    if (!this.remoteDescriptionSet) {
      throw new Error("InvalidStateError: no remote description")
    }
    this.iceCandidates.push(candidate)
  }

  close(): void {
    this.closed = true
  }
}

function fakeRtcFactory(): RTCPeerConnection {
  return new FakePeerConnection() as unknown as RTCPeerConnection
}

// The topic is the room capability, and a query string is recorded by every
// ingress and proxy access log there is. It goes in the first frame instead —
// but a server that predates the change is still out there during a deploy, so
// a refusal has to fall back rather than leave the context bus-less for the
// life of the page (#577).
describe("SignalingTransport — joining a room", () => {
  it("keeps the room topic out of the URL", async () => {
    const urls: string[] = []
    const RealWebSocket = globalThis.WebSocket
    vi.stubGlobal(
      "WebSocket",
      class extends RealWebSocket {
        constructor(url: string | URL) {
          urls.push(String(url))
          super(url)
        }
      },
    )
    const first = makeTransport()
    const second = makeTransport()
    try {
      // The room still forms, so the join frame reached the server.
      await waitForPeers(first, 1)
      expect(urls).toHaveLength(2)
      for (const url of urls) {
        expect(url).not.toContain(context.topic)
      }
    } finally {
      vi.unstubAllGlobals()
      first.close()
      second.close()
    }
  })

  // A server that only reads `?topic=` refuses the frame-only socket with a
  // policy close, which the transport treats as permanent. Retrying once with
  // the legacy URL is what keeps a mid-deploy reload from losing its bus until
  // the page is closed.
  it("falls back to the query string when the server refuses the frame", async () => {
    const opened: { url: string; socket: FakeSocket }[] = []
    class FakeSocket extends EventTarget {
      static OPEN = 1
      readyState = 0
      constructor(readonly url: string) {
        super()
        opened.push({ url, socket: this })
      }
      send(): void {}
      close(): void {}
    }
    vi.stubGlobal("WebSocket", FakeSocket)
    const transport = makeTransport()
    try {
      await vi.waitFor(() => expect(opened).toHaveLength(1))
      expect(opened[0].url).not.toContain(context.topic)

      // The old server's answer to a socket that named no topic.
      opened[0].socket.dispatchEvent(
        Object.assign(new Event("close"), { code: 1008 }),
      )

      await vi.waitFor(() => expect(opened).toHaveLength(2))
      expect(opened[1].url).toContain(`topic=${context.topic}`)
    } finally {
      vi.unstubAllGlobals()
      transport.close()
    }
  })

  // The fallback is the one reconnect path that did not ask whether this
  // transport is still wanted. A close racing a server-initiated 1008 would
  // reopen a socket nothing holds a handle to any more, join the room, and sit
  // there as a ghost peer until the page unloads — every other reconnect goes
  // through `scheduleReconnect`, which returns on `closed`.
  it("does not fall back after the transport is closed", async () => {
    const opened: { url: string; socket: FakeSocket }[] = []
    class FakeSocket extends EventTarget {
      static OPEN = 1
      readyState = 0
      constructor(readonly url: string) {
        super()
        opened.push({ url, socket: this })
      }
      send(): void {}
      close(): void {}
    }
    vi.stubGlobal("WebSocket", FakeSocket)
    const transport = makeTransport()
    try {
      await vi.waitFor(() => expect(opened).toHaveLength(1))
      transport.close()

      opened[0].socket.dispatchEvent(
        Object.assign(new Event("close"), { code: 1008 }),
      )

      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(opened).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
      transport.close()
    }
  })
})

describe("SignalingTransport — WebRTC upgrade", () => {
  // A `send` that throws for one peer used to escape the fan-out loop and
  // starve every peer after it. For a teardown `lease-released` that costs the
  // waiter its whole poll interval — so the peer falls back to the relay and
  // the others are unaffected.
  it("relays past a peer whose data channel send throws", async () => {
    const sender = makeTransport({ createPeerConnection: fakeRtcFactory })
    const receiver = makeTransport({ createPeerConnection: fakeRtcFactory })
    try {
      const received = collect(receiver)
      await waitForPeers(sender, 1)
      await waitForPeers(receiver, 1)
      await vi.waitFor(() =>
        expect(
          FakePeerConnection.channels.filter((c) => c.readyState === "open")
            .length,
        ).toBe(2),
      )
      for (const channel of FakePeerConnection.channels) {
        channel.send = () => {
          throw new Error("channel torn down")
        }
      }

      sender.publish(UTILIZATION_MESSAGE)

      // Delivered anyway — via the server relay this peer fell back to.
      await vi.waitFor(() => expect(received.length).toBe(1))
      expect(received[0]).toEqual(UTILIZATION_MESSAGE)
    } finally {
      sender.close()
      receiver.close()
      FakePeerConnection.registry.clear()
      FakePeerConnection.channels = []
    }
  })

  // `handleServerMessage` fires `void this.handleSignal(...)` per message, so an
  // `ice` message reaches the handler while the sibling `offer` is still
  // awaiting `setRemoteDescription`. A real connection rejects that, and the
  // candidate was gone — there was no queue to replay it from. The pair still
  // "works" (it falls back to the server relay), which is what made this a
  // silent downgrade rather than a visible failure (#574).
  describe("ICE candidates racing the remote description", () => {
    type Internals = {
      peers: Map<string, { connection?: FakePeerConnection }>
      handleSignal(from: string, payload: unknown): Promise<void>
    }

    /** An offer sdp the fake responder will accept (it carries the initiator's
     *  registry id). */
    async function offerFromFakeInitiator(): Promise<string> {
      const initiator = new FakePeerConnection()
      initiator.createDataChannel("data")
      const offer = await initiator.createOffer()
      return offer.sdp
    }

    it("applies a candidate that arrived mid-negotiation", async () => {
      const transport = makeTransport({ createPeerConnection: fakeRtcFactory })
      const internals = transport as unknown as Internals
      try {
        internals.peers.set("peer-1", {})
        const sdp = await offerFromFakeInitiator()

        FakePeerConnection.openGate()
        const negotiating = internals.handleSignal("peer-1", {
          kind: "offer",
          sdp,
        })
        // The window the two handlers actually race in.
        await internals.handleSignal("peer-1", {
          kind: "ice",
          candidate: { candidate: "candidate:1" },
        })
        FakePeerConnection.gate!.release()
        await negotiating

        await vi.waitFor(() =>
          expect(
            internals.peers.get("peer-1")?.connection?.iceCandidates,
          ).toHaveLength(1),
        )
      } finally {
        FakePeerConnection.gate = undefined
        transport.close()
        FakePeerConnection.registry.clear()
        FakePeerConnection.channels = []
      }
    })

    it("still applies a candidate that arrives after negotiation", async () => {
      const transport = makeTransport({ createPeerConnection: fakeRtcFactory })
      const internals = transport as unknown as Internals
      try {
        internals.peers.set("peer-1", {})
        await internals.handleSignal("peer-1", {
          kind: "offer",
          sdp: await offerFromFakeInitiator(),
        })

        await internals.handleSignal("peer-1", {
          kind: "ice",
          candidate: { candidate: "candidate:late" },
        })

        expect(
          internals.peers.get("peer-1")?.connection?.iceCandidates,
        ).toHaveLength(1)
      } finally {
        transport.close()
        FakePeerConnection.registry.clear()
        FakePeerConnection.channels = []
      }
    })

    // A duplicate or renegotiated offer overwrote `peer.connection` without
    // closing what was there, leaking an RTCPeerConnection per offer.
    it("closes the previous connection when a second offer arrives", async () => {
      const transport = makeTransport({ createPeerConnection: fakeRtcFactory })
      const internals = transport as unknown as Internals
      try {
        internals.peers.set("peer-1", {})
        await internals.handleSignal("peer-1", {
          kind: "offer",
          sdp: await offerFromFakeInitiator(),
        })
        const first = internals.peers.get("peer-1")?.connection
        expect(first?.closed).toBe(false)

        await internals.handleSignal("peer-1", {
          kind: "offer",
          sdp: await offerFromFakeInitiator(),
        })

        expect(first?.closed).toBe(true)
        expect(internals.peers.get("peer-1")?.connection).not.toBe(first)
      } finally {
        transport.close()
        FakePeerConnection.registry.clear()
        FakePeerConnection.channels = []
      }
    })
  })

  it("moves delivery onto the data channel once the pair connects", async () => {
    const first = makeTransport({ createPeerConnection: fakeRtcFactory })
    const second = makeTransport({ createPeerConnection: fakeRtcFactory })
    try {
      const received = collect(first)
      await waitForPeers(first, 1)
      await waitForPeers(second, 1)
      // Wait for the newcomer-initiated negotiation to link both ends.
      await vi.waitFor(() =>
        expect(
          FakePeerConnection.channels.filter((c) => c.readyState === "open")
            .length,
        ).toBe(2),
      )

      second.publish(UTILIZATION_MESSAGE)
      await vi.waitFor(() => expect(received.length).toBe(1))
      expect(received[0]).toEqual(UTILIZATION_MESSAGE)
      const totalSent = FakePeerConnection.channels.reduce(
        (sum, channel) => sum + channel.sentCount,
        0,
      )
      expect(totalSent).toBeGreaterThanOrEqual(1)
    } finally {
      first.close()
      second.close()
      FakePeerConnection.registry.clear()
      FakePeerConnection.channels = []
    }
  })
})
