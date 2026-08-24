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
 * are open. ICE is skipped entirely — loopback needs none.
 */
class FakePeerConnection {
  static registry = new Map<string, FakePeerConnection>()
  static channels: FakeDataChannel[] = []

  private id = crypto.randomUUID()
  channel: FakeDataChannel | undefined
  ondatachannel: ((event: { channel: FakeDataChannel }) => void) | undefined
  onicecandidate: unknown

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

  async addIceCandidate(_candidate: unknown): Promise<void> {}

  close(): void {}
}

function fakeRtcFactory(): RTCPeerConnection {
  return new FakePeerConnection() as unknown as RTCPeerConnection
}

describe("SignalingTransport — WebRTC upgrade", () => {
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
