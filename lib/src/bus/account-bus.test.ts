// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from "vitest"
import { BatchId, PrivateKey } from "@ethersphere/bee-js"

import { AccountBus, BroadcastChannelTransport } from "./account-bus"
import type { BusMessage } from "./messages"
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

const UTILIZATION_MESSAGE = {
  type: "utilization-updated",
  batchId: "ab".repeat(32),
  buckets: [{ index: 3, value: 7 }],
} as const

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
        updatedAt: 2_000_000,
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

  it("drops messages that fail schema validation", async () => {
    const receiver = makeBus()
    const rawChannel = new BroadcastChannel(receiver.channelName)
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

  it("delivers an account delta whose snapshot merges exactly like a device-state feed payload", async () => {
    const sender = makeBus()
    const receiver = makeBus()
    try {
      const received = collect(receiver)
      const remote = makeSnapshot()
      sender.publish({
        type: "account-delta",
        snapshot: serializeAccountStateSnapshot({
          accountId: remote.accountId,
          metadata: remote.metadata,
          connectedApps: remote.connectedApps,
          postageStamps: remote.postageStamps,
          timestamp: remote.timestamp,
        }),
      })
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
