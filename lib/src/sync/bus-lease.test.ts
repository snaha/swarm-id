// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from "vitest"

import { BusLane, BusLanes, LEASE_STOP_MS, LEASE_WAIT_MS } from "./bus-lease"
import type { LaneMessage } from "./bus-lease"
import { FakeLiveness, makeRoom } from "./bus-lease-test-utils"

interface Device {
  lane: BusLane
  liveness: FakeLiveness
  sent: LaneMessage[]
  busy: { value: boolean }
  handover: ReturnType<typeof vi.fn<() => Promise<void>>>
  lost: ReturnType<typeof vi.fn<() => void>>
}

let roundCounter = 0

function makeDevice(deviceId: string): Device {
  const liveness = new FakeLiveness(deviceId)
  const sent: LaneMessage[] = []
  const busy = { value: false }
  const handover = vi.fn<() => Promise<void>>(() => Promise.resolve())
  const lost = vi.fn<() => void>()
  const lane = new BusLane({
    liveness,
    send: (message) => sent.push(message),
    isBusy: (gentle) => gentle || busy.value,
    beforeHandover: handover,
    onLost: lost,
    newRound: () => `round-${++roundCounter}`,
  })
  return { lane, liveness, sent, busy, handover, lost }
}

/** Deliver everything `from` has sent so far to `to`, in order, once. */
function deliver(from: Device, to: Device): void {
  for (const message of from.sent.splice(0)) to.lane.receive(message)
}

/** Let a handover's `beforeHandover` settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Put `device` in possession of the lane, alone in the room. */
function holdAlone(device: Device): void {
  expect(device.lane.claim()).toBe(true)
  expect(device.lane.holds()).toBe(true)
  device.sent.length = 0
}

describe("BusLane — a device on its own", () => {
  it("takes the lane once everyone has been absent long enough", () => {
    const a = makeDevice("a")
    a.liveness.absentFor = LEASE_WAIT_MS - 1
    expect(a.lane.claim()).toBe(true)
    expect(a.lane.holds()).toBe(false)

    a.liveness.absentFor = LEASE_WAIT_MS
    a.liveness.confirm()
    expect(a.lane.holds()).toBe(true)
  })

  it("does not claim while its connection is unconfirmed", () => {
    const a = makeDevice("a")
    a.liveness.confirmedAgo = LEASE_STOP_MS
    expect(a.lane.claim()).toBe(false)
    expect(a.sent).toEqual([])
  })

  it("does not take the lane while its connection is unconfirmed", () => {
    const a = makeDevice("a")
    a.liveness.absentFor = 0
    a.lane.claim()
    a.liveness.absentFor = Infinity
    a.liveness.confirmedAgo = LEASE_STOP_MS
    a.lane.receive({ kind: "free", from: "b", to: "a", round: "nope" })
    expect(a.lane.holds()).toBe(false)
  })

  it("asks again on every confirmation while it waits", () => {
    const a = makeDevice("a")
    a.liveness.absentFor = 0
    a.lane.claim()
    a.liveness.confirm()
    expect(a.sent.filter((m) => m.kind === "claim")).toHaveLength(2)
    expect(a.sent[0]).toEqual(a.sent[1])
  })
})

describe("BusLane — holding", () => {
  it("stops holding once its connection has gone unconfirmed too long", () => {
    const a = makeDevice("a")
    holdAlone(a)
    a.liveness.confirmedAgo = LEASE_STOP_MS - 1
    expect(a.lane.holds()).toBe(true)
    a.liveness.confirmedAgo = LEASE_STOP_MS
    expect(a.lane.holds()).toBe(false)
    expect(a.lost).toHaveBeenCalledTimes(1)
  })

  // Nothing may have asked during the gap, and the connection is fine again
  // by the time something does: the gap still ended the hold.
  it("does not resume a hold after a gap nobody observed", () => {
    const a = makeDevice("a")
    holdAlone(a)
    a.liveness.confirm(LEASE_STOP_MS)
    expect(a.lane.holds()).toBe(false)
    expect(a.lost).toHaveBeenCalledTimes(1)
  })

  it("keeps holding across a gap shorter than the limit", () => {
    const a = makeDevice("a")
    holdAlone(a)
    a.liveness.confirm(LEASE_STOP_MS - 1)
    expect(a.lane.holds()).toBe(true)
  })

  it("gives the lane up on release, without reporting a loss", () => {
    const a = makeDevice("a")
    holdAlone(a)
    a.lane.release()
    expect(a.lane.holds()).toBe(false)
    expect(a.lost).not.toHaveBeenCalled()
  })
})

describe("BusLane — two devices", () => {
  function pair(): { a: Device; b: Device } {
    const a = makeDevice("a")
    const b = makeDevice("b")
    a.liveness.present.add("b")
    b.liveness.present.add("a")
    return { a, b }
  }

  it("takes the lane when the other device says it is free", () => {
    const { a, b } = pair()
    a.lane.claim()
    expect(a.lane.holds()).toBe(false)
    deliver(a, b)
    deliver(b, a)
    expect(a.lane.holds()).toBe(true)
  })

  it("does not take the lane while a present device has not answered", () => {
    const { a } = pair()
    a.lane.claim()
    a.liveness.confirm()
    expect(a.lane.holds()).toBe(false)
  })

  it("hands over when idle, after leaving its state for the next holder", async () => {
    const { a, b } = pair()
    a.liveness.present.clear()
    holdAlone(a)
    a.liveness.present.add("b")

    b.lane.claim()
    deliver(b, a)
    // Not writing any more, and not yet free: the state is being published.
    expect(a.lane.holds()).toBe(false)
    expect(a.sent).toEqual([])
    await flush()
    expect(a.handover).toHaveBeenCalledTimes(1)
    expect(a.lost).toHaveBeenCalledTimes(1)

    deliver(a, b)
    expect(b.lane.holds()).toBe(true)
  })

  it("keeps the lane when its state could not be published", async () => {
    const { a, b } = pair()
    a.liveness.present.clear()
    holdAlone(a)
    a.liveness.present.add("b")
    a.handover.mockRejectedValueOnce(new Error("swarm unavailable"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    b.lane.claim()
    deliver(b, a)
    await flush()
    warn.mockRestore()

    expect(a.sent).toEqual([])
    expect(a.lane.holds()).toBe(true)
    expect(a.lost).not.toHaveBeenCalled()
  })

  it("stays silent while it is writing", async () => {
    const { a, b } = pair()
    a.liveness.present.clear()
    holdAlone(a)
    a.liveness.present.add("b")
    a.busy.value = true

    b.lane.claim()
    deliver(b, a)
    await flush()

    expect(a.sent).toEqual([])
    expect(a.lane.holds()).toBe(true)
    expect(b.lane.holds()).toBe(false)
  })

  it("lets the lower device id win when both claim at once", () => {
    const { a, b } = pair()
    a.lane.claim()
    b.lane.claim()
    deliver(a, b)
    deliver(b, a)
    expect(a.lane.holds()).toBe(true)
    expect(b.lane.holds()).toBe(false)
    expect(b.lane.claiming).toBe(false)
  })

  it("answers a claim as free once its own hold has lapsed", () => {
    const { a, b } = pair()
    a.liveness.present.clear()
    holdAlone(a)
    a.liveness.present.add("b")
    a.liveness.confirmedAgo = LEASE_STOP_MS

    b.lane.claim()
    deliver(b, a)
    expect(a.sent.map((m) => m.kind)).toEqual(["free"])
    deliver(a, b)
    expect(b.lane.holds()).toBe(true)
  })
})

// Each of these removes a rule the model shows to be necessary
// (ShortWait / NoRoundMatch / NoContactReset in `models/bus-lease`).
describe("BusLane — rules the model depends on", () => {
  it("waits at least as long as a holder may stay unconfirmed", () => {
    expect(LEASE_WAIT_MS).toBeGreaterThanOrEqual(LEASE_STOP_MS)
  })

  it("ignores an answer to an earlier claim", () => {
    const a = makeDevice("a")
    const b = makeDevice("b")
    a.liveness.present.add("b")

    a.lane.claim()
    deliver(a, b)
    const stale = b.sent.splice(0)
    a.lane.release()
    a.lane.claim()
    for (const message of stale) a.lane.receive(message)

    expect(a.lane.holds()).toBe(false)
  })

  it("ignores an answer addressed to another device", () => {
    const a = makeDevice("a")
    a.liveness.present.add("b")
    a.lane.claim()
    const round = a.sent[0].round
    a.lane.receive({ kind: "free", from: "b", to: "c", round })
    expect(a.lane.holds()).toBe(false)
  })

  it("counts a device it has never heard of as present", () => {
    const a = makeDevice("a")
    const b = makeDevice("b")
    a.liveness.present.add("b")
    a.liveness.present.add("stranger")

    a.lane.claim()
    deliver(a, b)
    deliver(b, a)
    expect(a.lane.holds()).toBe(false)
  })
})

describe("BusLane — a gentle claim", () => {
  it("leaves an idle holder where it is, until the claimant insists", async () => {
    const a = makeDevice("a")
    const b = makeDevice("b")
    holdAlone(a)
    a.liveness.present.add("b")
    b.liveness.present.add("a")
    const asked: boolean[] = []

    expect(b.lane.claim({ gentle: true })).toBe(true)
    asked.push(b.sent[0].kind === "claim" && b.sent[0].gentle === true)
    deliver(b, a)
    await flush()
    expect(a.lane.holds()).toBe(true)
    expect(a.sent).toEqual([])

    b.lane.insist()
    asked.push(b.sent[0].kind === "claim" && b.sent[0].gentle === true)
    deliver(b, a)
    await flush()
    deliver(a, b)

    expect(asked).toEqual([true, false])
    expect(a.lane.holds()).toBe(false)
    expect(b.lane.holds()).toBe(true)
  })

  it("takes a lane nobody holds at once", () => {
    const a = makeDevice("a")
    const b = makeDevice("b")
    a.liveness.present.add("b")
    b.liveness.present.add("a")

    expect(b.lane.claim({ gentle: true })).toBe(true)
    deliver(b, a)
    deliver(a, b)

    expect(b.lane.holds()).toBe(true)
  })
})

describe("BusLane — a connection that is replaced", () => {
  it("holds nothing under a new name", () => {
    const a = makeDevice("a")
    holdAlone(a)

    a.liveness.id = "a-again"

    expect(a.lane.holds()).toBe(false)
    expect(a.lost).toHaveBeenCalledTimes(1)
  })

  it("drops a claim made under its earlier name when an answer arrives", () => {
    const a = makeDevice("a")
    const b = makeDevice("b")
    a.liveness.present.add("b")
    b.liveness.present.add("a")
    expect(a.lane.claim()).toBe(true)
    deliver(a, b)

    a.liveness.id = "a-again"
    deliver(b, a)

    // The claim was made on a connection that is gone: it is dropped.
    expect(a.lane.holds()).toBe(false)
    expect(a.lane.claiming).toBe(false)
  })

  it("cannot claim without a name", () => {
    const a = makeDevice("a")
    a.liveness.id = undefined
    expect(a.lane.claim()).toBe(false)
  })
})

const LANE = { accountId: "aa".repeat(20), batchId: "bb".repeat(32) }
const idle = { isBusy: () => false }

describe("BusLanes", () => {
  it("answers a claim of a lane it never opened, so the claimant is not kept waiting", () => {
    const { join } = makeRoom()
    const lanes = new BusLanes(join("a"))
    new BusLanes(join("b"))

    const lane = lanes.open({ ...LANE, partition: 0 }, idle)
    expect(lane.claim()).toBe(true)

    expect(lane.holds()).toBe(true)
  })

  it("keeps the lanes of one bus apart", () => {
    const { join } = makeRoom()
    const a = new BusLanes(join("a"))
    const b = new BusLanes(join("b"))
    const held = b.open({ ...LANE, partition: 0 }, { isBusy: () => true })
    b.open({ ...LANE, partition: 1 }, idle)
    expect(held.claim()).toBe(true)
    expect(held.holds()).toBe(true)

    // Lane 0 is held by a busy context; lane 1 is not held.
    const zero = a.open({ ...LANE, partition: 0 }, idle)
    const one = a.open({ ...LANE, partition: 1 }, idle)
    expect(zero.claim()).toBe(true)
    expect(one.claim()).toBe(true)

    expect(zero.holds()).toBe(false)
    expect(one.holds()).toBe(true)
    expect(held.holds()).toBe(true)
  })

  it("drops a message that names a sender other than the one that delivered it", () => {
    const { join, deliverTo } = makeRoom()
    const a = new BusLanes(join("a"))
    new BusLanes(join("b"))
    const held = a.open({ ...LANE, partition: 0 }, idle)
    expect(held.claim()).toBe(true)
    expect(held.holds()).toBe(true)

    const claim = {
      type: "lane-claim" as const,
      ...LANE,
      partition: 0,
      from: "c",
      round: "0".repeat(16),
    }
    // Delivered by B but naming C: A must not hand over for it.
    deliverTo("a", claim, "b")
    expect(held.holds()).toBe(true)

    // The same claim from the context it names is answered.
    deliverTo("a", claim, "c")
    expect(held.holds()).toBe(false)
  })

  it("gives up a lane when it is closed", () => {
    const { join } = makeRoom()
    const a = new BusLanes(join("a"))
    const b = new BusLanes(join("b"))
    const key = { ...LANE, partition: 0 }
    const held = a.open(key, { isBusy: () => true })
    expect(held.claim()).toBe(true)

    a.close(key)
    const next = b.open(key, idle)
    expect(next.claim()).toBe(true)

    expect(next.holds()).toBe(true)
  })
})
