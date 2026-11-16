// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from "vitest"

import { BusLane, LEASE_STOP_MS, LEASE_WAIT_MS } from "./bus-lease"
import type { LaneLiveness, LaneMessage } from "./bus-lease"

/** Liveness answers set by the test, standing in for the signaling room. */
class FakeLiveness implements LaneLiveness {
  confirmedAgo = 0
  /** How long everybody outside `present` has been gone. */
  absentFor = Infinity
  /** Devices in the room right now. */
  present = new Set<string>()
  private handlers = new Set<(unconfirmedForMs: number) => void>()

  confirmedAgoMs(): number {
    return this.confirmedAgo
  }

  absentExceptMs(deviceIds: ReadonlySet<string>): number {
    for (const device of this.present) {
      if (!deviceIds.has(device)) return 0
    }
    return this.absentFor
  }

  onConfirmed(handler: (unconfirmedForMs: number) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  /** A round trip with the server completes after `gapMs` without one. */
  confirm(gapMs = 0): void {
    this.confirmedAgo = 0
    for (const handler of this.handlers) handler(gapMs)
  }
}

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
  const liveness = new FakeLiveness()
  const sent: LaneMessage[] = []
  const busy = { value: false }
  const handover = vi.fn<() => Promise<void>>(() => Promise.resolve())
  const lost = vi.fn<() => void>()
  const lane = new BusLane({
    deviceId,
    liveness,
    send: (message) => sent.push(message),
    isBusy: () => busy.value,
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
