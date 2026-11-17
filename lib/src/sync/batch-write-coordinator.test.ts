// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PrivateKey } from "@ethersphere/bee-js"

/** What each context's `LaneState` does, set by the test. */
const laneState = vi.hoisted(() => ({
  /** The counter `resume` returns; `undefined` = the state cannot be read. */
  resume: (() => new Uint32Array(8)) as () => Uint32Array | undefined,
  resumed: [] as number[],
  published: [] as number[],
  publishError: undefined as Error | undefined,
  /** Runs inside `resume`, before it returns. */
  duringResume: undefined as (() => void) | undefined,
}))

vi.mock("./lane-state", () => ({
  LaneState: class {
    constructor(private readonly opts: { partition: number }) {}
    async resume(): Promise<Uint32Array | undefined> {
      laneState.resumed.push(this.opts.partition)
      laneState.duringResume?.()
      return laneState.resume()
    }
    async publish(): Promise<void> {
      if (laneState.publishError) throw laneState.publishError
      laneState.published.push(this.opts.partition)
    }
  },
}))

// The write lock is per browser. The contexts of these tests stand for
// different browsers sharing one process, so each gets a lock of its own:
// where the runtime has Web Locks, one context's upload in flight would
// otherwise hold up another's on a different lane.
vi.mock("../utils/batch-write-lock", () => ({
  withBatchWriteLock: <T>(_batchId: string, op: () => Promise<T>) => op(),
}))

import {
  BatchWriteCoordinator,
  NEXT_LANE_AFTER_MS,
  PEER_YIELD_MIN_IDLE_MS,
  PartitionContendedError,
  SLOT_WAIT_TIMEOUT_MS,
  deviceHomePartition,
  type BatchWriteCoordinatorDeps,
} from "./batch-write-coordinator"
import { BusLanes, LEASE_STOP_MS, LEASE_WAIT_MS } from "./bus-lease"
import { makeRoom, type FakeLiveness } from "./bus-lease-test-utils"
import { createTestSigner } from "../proxy/feeds/epochs/test-utils"

// Chosen so the home lane at two partitions is lane 0.
const DEVICE = "device-alpha-1"
const BATCH_ID = "ab".repeat(32)
const ACCOUNT_ID = "aa".repeat(20)
const PARTITION_COUNT = 2
const HOME = 0
const OTHER = 1

/** A controllable stand-in for the bound stamper, recording call order. */
function makeStamper(calls: string[]) {
  return {
    counterDepth: 20,
    invalidateLease: vi.fn(() => calls.push("invalidate")),
    unbindPartition: vi.fn(() => calls.push("unbind")),
    bindPartition: vi.fn((bound: { partition: number }) =>
      calls.push(`bind ${bound.partition}`),
    ),
    setLeaseValidUntil: vi.fn(),
    getLocalCounter: (): Uint32Array | undefined => new Uint32Array(8),
  }
}

interface Context {
  coordinator: BatchWriteCoordinator
  liveness: FakeLiveness
  lanes: BusLanes
  stamper: ReturnType<typeof makeStamper>
  calls: string[]
  changes: { currentPartition: number | undefined; isReadOnly: boolean }[]
}

let join: ReturnType<typeof makeRoom>["join"]

/** A context in the room with a coordinator for the batch. */
function makeContext(
  id: string,
  overrides: Partial<BatchWriteCoordinatorDeps> = {},
): Context {
  const bus = join(id)
  const lanes = new BusLanes(bus)
  const calls: string[] = []
  const stamper = makeStamper(calls)
  const changes: Context["changes"] = []
  const coordinator = new BatchWriteCoordinator({
    bee: {} as BatchWriteCoordinatorDeps["bee"],
    batchId: BATCH_ID,
    stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
    deviceId: DEVICE,
    accountId: ACCOUNT_ID,
    lanes,
    backupSigner: createTestSigner() as PrivateKey,
    swarmEncryptionKey: new Uint8Array(32),
    partitionCount: PARTITION_COUNT,
    mode: "persistent",
    onLeaseChange: (info) => changes.push(info),
    ...overrides,
  })
  return { coordinator, liveness: bus.liveness, lanes, stamper, calls, changes }
}

/** Let promise chains and the claim loop's timers run for `ms`. */
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  vi.useFakeTimers()
  join = makeRoom().join
  laneState.resume = () => new Uint32Array(8)
  laneState.resumed = []
  laneState.published = []
  laneState.publishError = undefined
  laneState.duringResume = undefined
})

afterEach(() => {
  vi.useRealTimers()
})

describe("BatchWriteCoordinator — a context alone in the room", () => {
  it("asks for its device's home lane first", () => {
    expect(deviceHomePartition(DEVICE, PARTITION_COUNT)).toBe(HOME)
  })

  it("takes a lane, binds the resumed counter, and acknowledges only after publishing", async () => {
    const a = makeContext("a")
    const order: string[] = []
    const resumed = new Uint32Array(8).fill(3)
    laneState.resume = () => resumed

    const result = await a.coordinator.withWrite(async () => {
      order.push(`op on ${a.coordinator.currentPartition}`)
      return "uploaded"
    })
    order.push(`published ${laneState.published.join()}`)

    expect(result).toBe("uploaded")
    expect(order).toEqual([`op on ${HOME}`, `published ${HOME}`])
    expect(a.stamper.bindPartition).toHaveBeenCalledWith({
      partition: HOME,
      partitionCount: PARTITION_COUNT,
      localCounter: resumed,
    })
    expect(a.changes.at(-1)).toEqual({
      currentPartition: HOME,
      isReadOnly: false,
    })
  })

  it("reads the lane's counter once for writes that start together, and not again while it holds", async () => {
    const a = makeContext("a")

    await Promise.all([
      a.coordinator.withWrite(async () => 1),
      a.coordinator.withWrite(async () => 2),
    ])
    await a.coordinator.withWrite(async () => 3)

    expect(laneState.resumed).toEqual([HOME])
    expect(laneState.published).toEqual([HOME, HOME, HOME])
  })

  it("fails the upload, unacknowledged, when the counter cannot be published", async () => {
    const a = makeContext("a")
    laneState.publishError = new Error("publish failed")

    await expect(a.coordinator.withWrite(async () => "x")).rejects.toThrow(
      "publish failed",
    )
  })

  it("takes a lane in the background when asked to warm up", async () => {
    const acquired: number[] = []
    const a = makeContext("a", { onLeaseAcquired: (p) => acquired.push(p) })

    a.coordinator.startLease()
    await advance(0)

    expect(a.coordinator.currentPartition).toBe(HOME)
    expect(acquired).toEqual([HOME])
  })

  it("waits for its connection to be confirmed before it writes", async () => {
    const a = makeContext("a")
    a.liveness.confirmedAgo = Infinity

    const write = a.coordinator.withWrite(async () => "x")
    await advance(1000)
    expect(a.coordinator.currentPartition).toBeUndefined()

    a.liveness.confirm(Infinity)
    await advance(1000)
    expect(await write).toBe("x")
  })

  it("waits out the time a newcomer must see everyone else absent", async () => {
    const a = makeContext("a")
    a.liveness.absentFor = 0

    const write = a.coordinator.withWrite(async () => "x")
    await advance(1000)
    expect(a.coordinator.currentPartition).toBeUndefined()

    a.liveness.absentFor = LEASE_WAIT_MS
    a.liveness.confirm()
    await advance(1000)
    expect(await write).toBe("x")
  })
})

describe("BatchWriteCoordinator — without lanes", () => {
  it("writes a batch that is not split into partitions with nobody to ask", async () => {
    const a = makeContext("a", { partitionCount: 1, lanes: undefined })

    expect(await a.coordinator.withWrite(async () => "x")).toBe("x")
    expect(a.stamper.bindPartition).not.toHaveBeenCalled()
    expect(laneState.published).toEqual([])
  })

  it("cannot write a split batch from a context that is not on the bus", async () => {
    const a = makeContext("a", { lanes: undefined })

    await expect(a.coordinator.withWrite(async () => "x")).rejects.toThrow(
      PartitionContendedError,
    )
    expect(a.coordinator.isReadOnly).toBe(true)
  })
})

describe("BatchWriteCoordinator — two contexts", () => {
  it("a newcomer takes the lane nobody holds, and leaves an idle holder where it is", async () => {
    const a = makeContext("a")
    const b = makeContext("b")
    await a.coordinator.withWrite(async () => "x")
    await advance(PEER_YIELD_MIN_IDLE_MS)

    expect(await b.coordinator.withWrite(async () => "y")).toBe("y")

    expect(a.coordinator.currentPartition).toBe(HOME)
    expect(b.coordinator.currentPartition).toBe(OTHER)
  })

  it("with every lane held, an idle holder hands over, and stops stamping first", async () => {
    const a = makeContext("a")
    const b = makeContext("b")
    const c = makeContext("c")
    await a.coordinator.withWrite(async () => "x")
    await b.coordinator.withWrite(async () => "y")
    await advance(PEER_YIELD_MIN_IDLE_MS)
    a.calls.length = 0

    // Both lanes answer "held", so somebody has to move: the holder of C's
    // home lane is asked first.
    expect(await c.coordinator.withWrite(async () => "z")).toBe("z")

    expect(c.coordinator.currentPartition).toBe(HOME)
    expect(a.coordinator.currentPartition).toBeUndefined()
    expect(b.coordinator.currentPartition).toBe(OTHER)
    expect(a.calls).toEqual(["invalidate", "unbind"])
    expect(a.changes.at(-1)).toEqual({
      currentPartition: undefined,
      isReadOnly: false,
    })
  })

  it("asks the next lane's holder when the home lane's holder is writing", async () => {
    const a = makeContext("a")
    const b = makeContext("b")
    const c = makeContext("c")
    let finish: () => void = () => {}
    const upload = a.coordinator.withWrite(
      () => new Promise<string>((resolve) => (finish = () => resolve("x"))),
    )
    await advance(0)
    await b.coordinator.withWrite(async () => "y")
    await advance(PEER_YIELD_MIN_IDLE_MS)

    const write = c.coordinator.withWrite(async () => "z")
    await advance(NEXT_LANE_AFTER_MS - 500)
    expect(b.coordinator.currentPartition).toBe(OTHER)

    await advance(1000)
    expect(await write).toBe("z")
    expect(c.coordinator.currentPartition).toBe(OTHER)
    expect(a.coordinator.currentPartition).toBe(HOME)
    expect(b.coordinator.currentPartition).toBeUndefined()

    finish()
    await upload
  })

  // A context that has only just joined the room has not answered yet. The
  // lane it has said nothing about may well be free.
  it("does not ask a holder to move while someone present has not answered for another lane", async () => {
    const a = makeContext("a")
    const b = makeContext("b")
    await a.coordinator.withWrite(async () => "x")
    await advance(PEER_YIELD_MIN_IDLE_MS)
    // In the room, with nothing answering claims on its behalf.
    join("newcomer")

    const write = b.coordinator.withWrite(async () => "y")
    const failure = expect(write).rejects.toThrow(PartitionContendedError)
    await advance(SLOT_WAIT_TIMEOUT_MS + 1000)
    await failure

    expect(a.coordinator.currentPartition).toBe(HOME)
  })

  it("does not ask a holder to move while another lane is on its way", async () => {
    const a = makeContext("a")
    const b = makeContext("b")
    await a.coordinator.withWrite(async () => "x")
    await advance(PEER_YIELD_MIN_IDLE_MS)
    // B has just joined: the lane nobody holds is not its to take yet.
    b.liveness.absentFor = 1000

    const write = b.coordinator.withWrite(async () => "y")
    await advance(NEXT_LANE_AFTER_MS * 3)
    expect(a.coordinator.currentPartition).toBe(HOME)
    expect(b.coordinator.currentPartition).toBeUndefined()

    b.liveness.absentFor = LEASE_WAIT_MS
    b.liveness.confirm()
    await advance(1000)
    expect(await write).toBe("y")
    expect(a.coordinator.currentPartition).toBe(HOME)
    expect(b.coordinator.currentPartition).toBe(OTHER)
  })

  it("a holder between two uploads keeps its lane, and the claimant takes the other one", async () => {
    const a = makeContext("a")
    const b = makeContext("b")
    await a.coordinator.withWrite(async () => "x")

    const write = b.coordinator.withWrite(async () => "y")
    await advance(NEXT_LANE_AFTER_MS + 500)

    expect(await write).toBe("y")
    expect(a.coordinator.currentPartition).toBe(HOME)
    expect(b.coordinator.currentPartition).toBe(OTHER)
  })

  it("a holder with an upload in flight does not hand over", async () => {
    const a = makeContext("a")
    const b = makeContext("b")
    let finish: () => void = () => {}
    const upload = a.coordinator.withWrite(
      () => new Promise<string>((resolve) => (finish = () => resolve("x"))),
    )
    await advance(PEER_YIELD_MIN_IDLE_MS + 1000)

    const write = b.coordinator.withWrite(async () => "y")
    await advance(NEXT_LANE_AFTER_MS + 500)
    expect(await write).toBe("y")
    expect(b.coordinator.currentPartition).toBe(OTHER)

    finish()
    expect(await upload).toBe("x")
    expect(laneState.published).toContain(HOME)
  })

  it("takes a lane again on its next write after handing one over", async () => {
    const a = makeContext("a")
    const b = makeContext("b")
    const c = makeContext("c")
    await a.coordinator.withWrite(async () => "x")
    await b.coordinator.withWrite(async () => "y")
    await advance(PEER_YIELD_MIN_IDLE_MS)
    const taken = c.coordinator.withWrite(async () => "z")
    await advance(NEXT_LANE_AFTER_MS + 500)
    await taken
    expect(a.coordinator.currentPartition).toBeUndefined()
    await advance(PEER_YIELD_MIN_IDLE_MS)

    const back = a.coordinator.withWrite(async () => "w")
    await advance(NEXT_LANE_AFTER_MS + 500)
    expect(await back).toBe("w")

    expect(a.coordinator.currentPartition).toBe(HOME)
    expect(c.coordinator.currentPartition).toBeUndefined()
  })
})

describe("BatchWriteCoordinator — every lane held by a writer", () => {
  /** Two contexts, each mid-upload on one of the two lanes. */
  async function occupyBothLanes() {
    const finish: (() => void)[] = []
    const hold = (context: Context) =>
      context.coordinator.withWrite(
        () => new Promise<void>((resolve) => finish.push(resolve)),
      )
    const a = makeContext("a")
    const b = makeContext("b")
    const uploads = [hold(a)]
    await advance(0)
    uploads.push(hold(b))
    await advance(NEXT_LANE_AFTER_MS + 500)
    expect(a.coordinator.currentPartition).toBe(HOME)
    expect(b.coordinator.currentPartition).toBe(OTHER)
    return {
      release: async () => {
        for (const done of finish) done()
        await Promise.all(uploads)
      },
    }
  }

  it("a blocking write gives up after its wait, read-only until a lane is taken", async () => {
    const { release } = await occupyBothLanes()
    const c = makeContext("c")

    const write = c.coordinator.withWrite(async () => "z")
    const failure = expect(write).rejects.toThrow(PartitionContendedError)
    await advance(SLOT_WAIT_TIMEOUT_MS + 1000)
    await failure

    expect(c.coordinator.isReadOnly).toBe(true)
    expect(c.changes.at(-1)).toEqual({
      currentPartition: undefined,
      isReadOnly: true,
    })
    await release()
  })

  it("a one-off write gives up much sooner", async () => {
    const { release } = await occupyBothLanes()
    const c = makeContext("c", { mode: "oneshot" })

    const write = c.coordinator.withWrite(async () => "z")
    const failure = expect(write).rejects.toThrow(PartitionContendedError)
    await advance(LEASE_WAIT_MS + 3000)
    await failure

    await release()
  })

  it("a waiting write goes ahead as soon as a holder is done and idle", async () => {
    const { release } = await occupyBothLanes()
    const c = makeContext("c")

    const write = c.coordinator.withWrite(async () => "z")
    await advance(2000)
    await release()
    await advance(PEER_YIELD_MIN_IDLE_MS)
    // The holders did not answer while they were writing. A claim is sent
    // again with every confirmation of the claimant's connection.
    c.liveness.confirm()
    await advance(1000)

    expect(await write).toBe("z")
  })
})

describe("BatchWriteCoordinator — a lane whose state cannot be read", () => {
  it("does not write, and gives the lane back at once", async () => {
    const a = makeContext("a")
    const b = makeContext("b")
    laneState.resume = () => undefined

    await expect(a.coordinator.withWrite(async () => "x")).rejects.toThrow(
      /could not be read/,
    )
    expect(a.stamper.bindPartition).not.toHaveBeenCalled()
    expect(a.coordinator.isReadOnly).toBe(true)

    // The lane is not held by A: B is answered without waiting.
    laneState.resume = () => new Uint32Array(8)
    expect(await b.coordinator.withWrite(async () => "y")).toBe("y")
    expect(b.coordinator.currentPartition).toBe(HOME)
  })

  it("asks again when the lane went while its counter was being read", async () => {
    const a = makeContext("a")
    let lapses = 1
    laneState.duringResume = () => {
      if (lapses-- > 0) a.liveness.confirmedAgo = LEASE_STOP_MS
    }

    const write = a.coordinator.withWrite(async () => "x")
    await advance(1000)
    a.liveness.confirm(LEASE_STOP_MS)
    await advance(1000)
    expect(await write).toBe("x")

    expect(laneState.resumed).toEqual([HOME, HOME])
    expect(a.stamper.bindPartition).toHaveBeenCalledTimes(1)
  })
})

describe("BatchWriteCoordinator — losing the connection", () => {
  it("does not acknowledge an upload that outlived the connection", async () => {
    const a = makeContext("a")
    await a.coordinator.withWrite(async () => "x")
    laneState.published = []
    a.calls.length = 0

    const write = a.coordinator.withWrite(async () => {
      // The connection went and came back as a new one while the upload ran.
      a.liveness.confirmedAgo = LEASE_STOP_MS
      a.liveness.id = "a2"
      return "y"
    })

    await expect(write).rejects.toThrow(/reclaimed/)
    expect(laneState.published).toEqual([])
    // Invalidated at once; unbound only when the upload was over.
    expect(a.calls).toEqual(["invalidate", "unbind"])
    expect(a.coordinator.currentPartition).toBeUndefined()
  })

  it("moves the stamper's deadline forward with every confirmation", async () => {
    const a = makeContext("a")
    await a.coordinator.withWrite(async () => "x")
    a.stamper.setLeaseValidUntil.mockClear()

    a.liveness.confirm()

    expect(a.stamper.setLeaseValidUntil).toHaveBeenCalledWith(
      Date.now() + LEASE_STOP_MS,
    )
  })

  // A busy tab answers the server late. It was in the room throughout and
  // freed nothing, so the lane is still its own.
  it("keeps its lane across a gap on the same connection", async () => {
    const a = makeContext("a")
    await a.coordinator.withWrite(async () => "x")

    a.liveness.confirm(LEASE_STOP_MS)
    expect(a.coordinator.currentPartition).toBe(HOME)

    expect(await a.coordinator.withWrite(async () => "y")).toBe("y")
    expect(laneState.resumed).toEqual([HOME])
  })

  it("waits for the next confirmation when a write finds it overdue", async () => {
    const a = makeContext("a")
    await a.coordinator.withWrite(async () => "x")
    a.liveness.confirmedAgo = LEASE_STOP_MS

    let done = false
    const write = a.coordinator
      .withWrite(async () => "y")
      .then((value) => ((done = true), value))
    await advance(1000)
    expect(done).toBe(false)

    a.liveness.confirm(LEASE_STOP_MS)
    expect(await write).toBe("y")
    expect(laneState.resumed).toEqual([HOME])
  })

  it("acknowledges an upload that ended with the confirmation overdue, once it arrives", async () => {
    const a = makeContext("a")
    await a.coordinator.withWrite(async () => "x")

    const write = a.coordinator.withWrite(async () => {
      a.liveness.confirmedAgo = LEASE_STOP_MS
      return "y"
    })
    await advance(1000)
    a.liveness.confirm(LEASE_STOP_MS)
    expect(await write).toBe("y")
    expect(a.coordinator.currentPartition).toBe(HOME)
  })
})

describe("BatchWriteCoordinator — teardown", () => {
  it("gives its lane up without writing, so the next context is answered at once", async () => {
    const a = makeContext("a")
    const b = makeContext("b")
    await a.coordinator.withWrite(async () => "x")
    laneState.published = []
    a.calls.length = 0

    a.coordinator.teardown()

    expect(a.calls).toEqual(["invalidate", "unbind"])
    expect(laneState.published).toEqual([])
    expect(await b.coordinator.withWrite(async () => "y")).toBe("y")
    expect(b.coordinator.currentPartition).toBe(HOME)
  })

  it("never takes a lane again", async () => {
    const a = makeContext("a")
    a.coordinator.teardown()

    await expect(a.coordinator.withWrite(async () => "x")).rejects.toThrow(
      /torn down/,
    )
    a.coordinator.startLease()
    await advance(1000)
    expect(a.coordinator.currentPartition).toBeUndefined()
  })

  it("stops a write that was waiting for a lane", async () => {
    const a = makeContext("a")
    a.liveness.absentFor = 0
    const write = a.coordinator.withWrite(async () => "x")
    const failure = expect(write).rejects.toThrow()
    await advance(500)

    a.coordinator.teardown()
    await advance(500)

    await failure
    expect(a.stamper.bindPartition).not.toHaveBeenCalled()
  })

  it("can open the same lanes again in a new coordinator", async () => {
    const a = makeContext("a")
    await a.coordinator.withWrite(async () => "x")
    a.coordinator.teardown()

    const again = new BatchWriteCoordinator({
      bee: {} as BatchWriteCoordinatorDeps["bee"],
      batchId: BATCH_ID,
      stamper: a.stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
      deviceId: DEVICE,
      accountId: ACCOUNT_ID,
      lanes: a.lanes,
      backupSigner: createTestSigner() as PrivateKey,
      swarmEncryptionKey: new Uint8Array(32),
      partitionCount: PARTITION_COUNT,
      mode: "oneshot",
    })

    expect(await again.withWrite(async () => "y")).toBe("y")
  })
})
