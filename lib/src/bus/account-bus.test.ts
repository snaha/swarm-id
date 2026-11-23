// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from "vitest"
import { BatchId, PrivateKey } from "@ethersphere/bee-js"

import { AccountBus, BroadcastChannelTransport } from "./account-bus"
import type { BusTransport } from "./account-bus"
import { deriveBusContext } from "./bus-context"
import type { BusMessage, BusMessageInput } from "./messages"
import { serializeAccountStateSnapshot } from "../utils/account-state-snapshot"
import { mergeSnapshotWithRemote } from "../sync/merge-snapshot"
import type { AccountStateSnapshot } from "../schemas"

const TOPIC = "test-topic"

function makeBus(topic = TOPIC): AccountBus {
  return new AccountBus([new BroadcastChannelTransport(topic)])
}

function collect(bus: AccountBus): BusMessage[] {
  const received: BusMessage[] = []
  bus.subscribe((message) => received.push(message))
  return received
}

async function waitForMessages(
  received: BusMessage[],
  count: number,
): Promise<void> {
  await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(count))
}

const UTILIZATION_MESSAGE: BusMessageInput = {
  type: "utilization-updated",
  batchId: "ab".repeat(32),
  partition: 0,
  partitionCount: 2,
  buckets: [{ index: 3, value: 7 }],
}

const LANE_CLAIM_MESSAGE: BusMessageInput = {
  type: "lane-claim",
  accountId: "aa".repeat(20),
  batchId: "ab".repeat(32),
  partition: 1,
  from: "peer-remote",
  round: "0123456789abcdef",
}

function makeSnapshot(): AccountStateSnapshot {
  return {
    version: 1,
    timestamp: 1_000_000,
    accountId: "aa".repeat(20),
    metadata: {
      accountName: "test account",
      defaultPostageStampBatchID: "cc".repeat(32),
      publicKey: `02${"ab".repeat(32)}`,
      createdAt: 1_000_000,
      lastModified: 1_000_000,
      devices: [
        {
          deviceId: "device-remote",
          name: "Remote",
          createdAt: 1_000_000,
          lastSignedInAt: 2_000_000,
        },
      ],
      partitionCount: 2,
    },
    connectedApps: [
      {
        appUrl: "https://dapp.example",
        appName: "dApp",
        lastConnectedAt: 2_000_000,
      },
    ],
    postageStamps: [
      {
        batchID: new BatchId("cc".repeat(32)),
        signerKey: new PrivateKey("22".repeat(32)),
        utilization: 0,
        usable: true,
        depth: 24,
        amount: BigInt(100),
        bucketDepth: 16,
        blockNumber: 1,
        immutableFlag: true,
        exists: true,
        createdAt: 1_000_000,
      },
    ],
  }
}

describe("AccountBus over BroadcastChannelTransport", () => {
  it("delivers a published message to another bus on the same topic", async () => {
    const sender = makeBus()
    const receiver = makeBus()
    try {
      const received = collect(receiver)
      sender.publish(UTILIZATION_MESSAGE)
      await waitForMessages(received, 1)
      expect(received[0]).toEqual(UTILIZATION_MESSAGE)
    } finally {
      sender.close()
      receiver.close()
    }
  })

  it("does not deliver a message back to the publishing bus", async () => {
    const sender = makeBus()
    const receiver = makeBus()
    try {
      const senderReceived = collect(sender)
      const received = collect(receiver)
      sender.publish(UTILIZATION_MESSAGE)
      await waitForMessages(received, 1)
      expect(senderReceived).toEqual([])
    } finally {
      sender.close()
      receiver.close()
    }
  })

  it("does not deliver across different topics", async () => {
    const sender = makeBus("topic-a")
    const other = makeBus("topic-b")
    const same = makeBus("topic-a")
    try {
      const otherReceived = collect(other)
      const sameReceived = collect(same)
      sender.publish(UTILIZATION_MESSAGE)
      await waitForMessages(sameReceived, 1)
      expect(otherReceived).toEqual([])
    } finally {
      sender.close()
      other.close()
      same.close()
    }
  })

  // The channel is per account: co-resident accounts must not share one, because
  // an `account-delta` payload carries `postageStamps[].signerKey`.
  it("does not deliver between contexts of different accounts", async () => {
    const mine = await deriveBusContext("11".repeat(32))
    const theirs = await deriveBusContext("22".repeat(32))
    expect(mine.topic).not.toBe(theirs.topic)

    const sender = new AccountBus([new BroadcastChannelTransport(mine.topic)])
    const sameAccount = new AccountBus([
      new BroadcastChannelTransport(mine.topic),
    ])
    const otherAccount = new AccountBus([
      new BroadcastChannelTransport(theirs.topic),
    ])
    try {
      const mineReceived = collect(sameAccount)
      const theirsReceived = collect(otherAccount)

      sender.publish(UTILIZATION_MESSAGE)
      await waitForMessages(mineReceived, 1)
      expect(theirsReceived).toEqual([])
    } finally {
      sender.close()
      sameAccount.close()
      otherAccount.close()
    }
  })

  it("drops messages that fail schema validation", async () => {
    // Straight onto the transport's channel, bypassing `AccountBus.publish`.
    const transport = new BroadcastChannelTransport(TOPIC)
    const receiver = new AccountBus([transport])
    const rawChannel = new BroadcastChannel(transport.channelName)
    const sender = makeBus()
    try {
      const received = collect(receiver)
      rawChannel.postMessage({ type: "garbage" })
      rawChannel.postMessage("not even an object")
      sender.publish(UTILIZATION_MESSAGE)
      await waitForMessages(received, 1)
      expect(received).toEqual([UTILIZATION_MESSAGE])
    } finally {
      rawChannel.close()
      sender.close()
      receiver.close()
    }
  })

  it("stops delivering after unsubscribe", async () => {
    const sender = makeBus()
    const receiver = makeBus()
    try {
      const early: BusMessage[] = []
      const unsubscribe = receiver.subscribe((message) => early.push(message))
      const late = collect(receiver)
      unsubscribe()
      sender.publish(UTILIZATION_MESSAGE)
      await waitForMessages(late, 1)
      expect(early).toEqual([])
    } finally {
      sender.close()
      receiver.close()
    }
  })

  it("keeps notifying other handlers when one throws", async () => {
    const sender = makeBus()
    const receiver = makeBus()
    try {
      receiver.subscribe(() => {
        throw new Error("handler bug")
      })
      const received = collect(receiver)
      sender.publish(UTILIZATION_MESSAGE)
      await waitForMessages(received, 1)
      expect(received).toEqual([UTILIZATION_MESSAGE])
    } finally {
      sender.close()
      receiver.close()
    }
  })

  it("delivers via a transport added after construction, until removed", async () => {
    const sender = makeBus("late-topic")
    const receiver = new AccountBus([])
    try {
      const received = collect(receiver)
      const remove = receiver.addTransport(
        new BroadcastChannelTransport("late-topic"),
      )
      sender.publish(UTILIZATION_MESSAGE)
      await waitForMessages(received, 1)

      remove()
      sender.publish(UTILIZATION_MESSAGE)
      const settle = makeBus("late-topic")
      const settleReceived = collect(settle)
      sender.publish(UTILIZATION_MESSAGE)
      await waitForMessages(settleReceived, 1)
      settle.close()
      expect(received).toHaveLength(1)
    } finally {
      sender.close()
      receiver.close()
    }
  })

  // Every bus join is fire-and-forget (the proxy derives the account's bus key
  // first), so one can land after the context tore down. Attaching then would
  // put a live socket on a dead bus with nothing left holding a handle to it.
  // `utilization-updated` carries per-partition counters, so only a context
  // sharing this device's lane can fold it — never a remote peer. Publishing it
  // off-device is pure waste, and one entry per dirty bucket easily exceeds the
  // signaling server's 64 KB frame cap, which kills the socket (1009).
  it("keeps a localOnly publish off transports that leave the profile", () => {
    const remoteSent: BusMessageInput[] = []
    const remote: BusTransport = {
      local: false,
      publish: (message) => remoteSent.push(message),
      subscribe: () => () => {},
      close: () => {},
    }
    const localSent: BusMessageInput[] = []
    const local: BusTransport = {
      local: true,
      publish: (message) => localSent.push(message),
      subscribe: () => () => {},
      close: () => {},
    }
    const bus = new AccountBus([local, remote])
    try {
      bus.publish(UTILIZATION_MESSAGE, { localOnly: true })
      expect(localSent).toEqual([UTILIZATION_MESSAGE])
      expect(remoteSent).toEqual([])

      // Everything else still fans out to both — the lease messages are the
      // reason the remote transport exists.
      bus.publish(LANE_CLAIM_MESSAGE)
      expect(remoteSent).toEqual([LANE_CLAIM_MESSAGE])
      expect(localSent).toHaveLength(2)
    } finally {
      bus.close()
    }
  })

  it("closes a transport attached after close() instead of adopting it", () => {
    const bus = makeBus()
    bus.close()
    const late = new BroadcastChannelTransport("late-join-topic")
    const closeSpy = vi.spyOn(late, "close")
    const remove = bus.addTransport(late)
    expect(closeSpy).toHaveBeenCalledTimes(1)
    // The remover is inert, and publishing on a closed bus is a no-op rather
    // than an InvalidStateError from a closed BroadcastChannel.
    expect(() => remove()).not.toThrow()
    expect(() => bus.publish(UTILIZATION_MESSAGE)).not.toThrow()
  })

  it("delivers an account delta whose snapshot merges exactly like a device-state feed payload", async () => {
    const sender = makeBus()
    const receiver = makeBus()
    try {
      const received = collect(receiver)
      const remote = makeSnapshot()
      sender.publish({
        type: "account-delta",
        // The serializer returns an untyped record; the wire shape is the
        // schema input, which the receiving bus validates.
        snapshot: serializeAccountStateSnapshot({
          accountId: remote.accountId,
          metadata: remote.metadata,
          connectedApps: remote.connectedApps,
          postageStamps: remote.postageStamps,
          timestamp: remote.timestamp,
        }),
      } as BusMessageInput)
      await waitForMessages(received, 1)

      const message = received[0]
      if (message.type !== "account-delta") {
        throw new Error("expected an account-delta message")
      }
      // Typed values are revived from the wire form.
      expect(message.snapshot.postageStamps[0].batchID).toBeInstanceOf(BatchId)
      expect(message.snapshot.postageStamps[0].amount).toBe(BigInt(100))

      // The received snapshot folds identically to the original payload.
      const local = makeSnapshot()
      local.metadata.devices = [
        {
          deviceId: "device-local",
          name: "Local",
          createdAt: 1_000_000,
          lastSignedInAt: 3_000_000,
        },
      ]
      const viaBus = mergeSnapshotWithRemote(local, message.snapshot)
      const direct = mergeSnapshotWithRemote(local, remote)
      expect(viaBus.metadata.devices).toEqual(direct.metadata.devices)
      expect(viaBus.connectedApps).toEqual(direct.connectedApps)
      expect(viaBus.postageStamps).toEqual(direct.postageStamps)
    } finally {
      sender.close()
      receiver.close()
    }
  })
})

const PRESENCE_MESSAGE: BusMessageInput = {
  type: "presence",
  accountId: "aa".repeat(20),
  fromDeviceId: "device-remote",
}

interface FakeLiveness {
  selfId?: string
  confirmedAgoMs: number
  absentExceptMs: number
}

/** A remote transport whose liveness answers are set by the test. */
function fakeRemote(liveness: FakeLiveness) {
  let deliver: (raw: unknown, from?: string) => void = () => {}
  let confirm: (unconfirmedForMs: number) => void = () => {}
  const heard: string[] = []
  const transport: BusTransport = {
    local: false,
    publish: () => {},
    subscribe: (handler) => {
      deliver = handler
      return () => {}
    },
    confirmedAgoMs: () => liveness.confirmedAgoMs,
    absentExceptMs: () => liveness.absentExceptMs,
    onConfirmed: (handler) => {
      confirm = handler
      return () => {}
    },
    selfId: () => liveness.selfId,
    notePeer: (peerId) => heard.push(peerId),
    close: () => {},
  }
  return {
    transport,
    heard,
    deliver: (raw: unknown, from?: string) => deliver(raw, from),
    confirm: (unconfirmedForMs: number) => confirm(unconfirmedForMs),
  }
}

describe("AccountBus — liveness", () => {
  it("is unconfirmed, and sees nobody absent, without a remote transport", () => {
    const bus = makeBus()
    try {
      expect(bus.confirmedAgoMs()).toBe(Infinity)
      expect(bus.absentExceptMs(new Set())).toBe(0)
    } finally {
      bus.close()
    }
  })

  it("answers from its remote transport", () => {
    const remote = fakeRemote({ confirmedAgoMs: 40, absentExceptMs: 900 })
    const bus = new AccountBus([
      new BroadcastChannelTransport(TOPIC),
      remote.transport,
    ])
    try {
      expect(bus.confirmedAgoMs()).toBe(40)
      expect(bus.absentExceptMs(new Set())).toBe(900)
    } finally {
      bus.close()
    }
  })

  // Each remote transport is its own authority, so the bus believes the more
  // cautious of them on both questions.
  it("takes the more cautious answer of several remote transports", () => {
    const first = fakeRemote({ confirmedAgoMs: 40, absentExceptMs: 900 })
    const second = fakeRemote({ confirmedAgoMs: 700, absentExceptMs: 100 })
    const bus = new AccountBus([first.transport, second.transport])
    try {
      expect(bus.confirmedAgoMs()).toBe(700)
      expect(bus.absentExceptMs(new Set())).toBe(100)
    } finally {
      bus.close()
    }
  })

  it("passes on each confirmation with the gap before it", () => {
    const remote = fakeRemote({ confirmedAgoMs: 0, absentExceptMs: 0 })
    const bus = new AccountBus([remote.transport])
    const gaps: number[] = []
    try {
      bus.onConfirmed((unconfirmedForMs) => gaps.push(unconfirmedForMs))
      remote.confirm(Infinity)
      remote.confirm(2000)
      expect(gaps).toEqual([Infinity, 2000])
    } finally {
      bus.close()
    }
  })

  it("tells a transport which peers it heard a well-formed message from", () => {
    const remote = fakeRemote({ confirmedAgoMs: 0, absentExceptMs: 0 })
    const bus = new AccountBus([remote.transport])
    try {
      remote.deliver(PRESENCE_MESSAGE, "peer-1")
      remote.deliver({ type: "nonsense", fromDeviceId: "device-x" }, "peer-2")
      remote.deliver(PRESENCE_MESSAGE)
      expect(remote.heard).toEqual(["peer-1"])
    } finally {
      bus.close()
    }
  })

  // A lane message over BroadcastChannel has no transport sender, and its
  // sender may not be in the room view yet: the view is behind all the same.
  it("tells every transport about the sender a lane message names, on a path that names none", () => {
    const local = fakeRemote({ confirmedAgoMs: 0, absentExceptMs: 0 })
    const remote = fakeRemote({ confirmedAgoMs: 0, absentExceptMs: 0 })
    const bus = new AccountBus([local.transport, remote.transport])
    try {
      local.deliver({
        type: "lane-claim",
        accountId: "a".repeat(40),
        batchId: "b".repeat(64),
        partition: 0,
        from: "peer-9",
        round: "0".repeat(16),
      })
      expect(remote.heard).toEqual(["peer-9"])
    } finally {
      bus.close()
    }
  })

  it("names the one peer a message is for to each transport", () => {
    const published: [unknown, string | undefined][] = []
    const remote = fakeRemote({ confirmedAgoMs: 0, absentExceptMs: 0 })
    remote.transport.publish = (message, to) => published.push([message, to])
    const bus = new AccountBus([remote.transport])
    try {
      bus.publish(PRESENCE_MESSAGE, { to: "peer-7" })
      expect(published).toEqual([[PRESENCE_MESSAGE, "peer-7"]])
    } finally {
      bus.close()
    }
  })

  it("is named by its remote transport", () => {
    const remote = fakeRemote({
      selfId: "peer-self",
      confirmedAgoMs: 0,
      absentExceptMs: 0,
    })
    const bus = new AccountBus([
      new BroadcastChannelTransport(TOPIC),
      remote.transport,
    ])
    try {
      expect(bus.selfId()).toBe("peer-self")
    } finally {
      bus.close()
    }
  })
})
