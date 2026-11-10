// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Two tabs of one storage partition on one drive: one device id, one lease
 * record, one set of cache rows, one cross-tab write lock — and a coordinator,
 * a stamper and a `PartitionLease` object each. The lease protocol sees a
 * single holder, so nothing on Swarm arbitrates between them; these tests
 * drive both through real leases against a mock Bee.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BatchId, PrivateKey } from "@ethersphere/bee-js"

// The cross-tab Web Lock: one exclusive section at a time across both tabs.
vi.mock("../utils/batch-write-lock", () => {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    withBatchWriteLock: (_key: string, op: () => Promise<unknown>) => {
      const run = tail.then(op, op)
      tail = run.catch(() => undefined)
      return run
    },
  }
})

// Real leases, minus the two-second claim guard a refresh would sleep out.
vi.mock("./partition-lease", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./partition-lease")>()
  const create = actual.PartitionLease.fromSwarmEncryptionKey.bind(
    actual.PartitionLease,
  )
  actual.PartitionLease.fromSwarmEncryptionKey = (opts) =>
    create({ ...opts, guardMs: 0 })
  return actual
})

import {
  BatchWriteCoordinator,
  type BatchWriteCoordinatorDeps,
} from "./batch-write-coordinator"
import type {
  PartitionLease,
  PartitionLeaseStateSnapshot,
} from "./partition-lease"
import { NO_HOLDER_DEVICE_ID, readPartitionLock } from "./partition-lock"
import { readPartitionState } from "./partition-state"
import {
  IDLE_YIELD_MS,
  PARTITION_COUNT,
  UtilizationAwareStamper,
} from "../utils/batch-utilization"
import { withBatchWriteLock } from "../utils/batch-write-lock"
import { BACKUP_KEY_LABEL, deriveSecret } from "../utils/key-derivation"
import { uint8ArrayToHex } from "../utils/hex"
import {
  MockBee,
  MockChunkStore,
  mockFetch,
} from "../proxy/feeds/epochs/test-utils"

const BATCH_ID = "ab".repeat(32)
const BATCH_DEPTH = 24
const ENC_KEY = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff)
const DEVICE = "device-alpha-1"
const RIVAL = "device-beta-222"
/** Mid-epoch, so a test's few steps share one state-pointer bucket. */
const START_MS = 30_000 * 1000 + 5000
/** A background acquire is a dozen mock-Bee round trips: quick alone, not
 *  under the full suite's parallel load. */
const SETTLE = { timeout: 10_000 }

type Cache = Parameters<typeof UtilizationAwareStamper.create>[3]

/** What a test reaches into a coordinator for: its lease and one tick. */
type Internals = {
  partitionLease: PartitionLease | undefined
  refreshTick(lease: PartitionLease): Promise<void>
}

let clock: number
let bee: MockBee
let backupSigner: PrivateKey
let rowsCache: Cache
let leaseCache: PartitionLeaseStateSnapshot | undefined
let knownDevices: string[]
let coordinators: BatchWriteCoordinator[]
/** Whether the lease record keeps what is written to it (IndexedDB works). */
let leaseCacheWorks: boolean

beforeEach(async () => {
  clock = START_MS
  vi.spyOn(Date, "now").mockImplementation(() => clock)
  backupSigner = new PrivateKey(
    await deriveSecret(uint8ArrayToHex(ENC_KEY), BACKUP_KEY_LABEL),
  )
  const store = new MockChunkStore()
  bee = new MockBee(store)
  mockFetch(store, backupSigner.publicKey().address())
  const rows = new Map<number, unknown>()
  let metadata: object | undefined
  rowsCache = {
    getAllChunks: async () =>
      [...rows.entries()].sort(([a], [b]) => a - b).map(([, row]) => row),
    putChunk: async (entry: { chunkIndex: number }) => {
      rows.set(entry.chunkIndex, { ...entry })
    },
    getMetadata: async () => metadata,
    updateMetadata: async (
      batchId: string,
      patch: (existing: object | undefined) => object,
    ) => {
      metadata = { ...metadata, ...patch(metadata), batchId }
    },
  } as unknown as Cache
  leaseCache = undefined
  leaseCacheWorks = true
  knownDevices = [DEVICE]
  coordinators = []
})

afterEach(() => {
  for (const coordinator of coordinators) coordinator.teardown()
  vi.restoreAllMocks()
})

async function openTab(mode: BatchWriteCoordinatorDeps["mode"] = "persistent") {
  const stamper = await UtilizationAwareStamper.create(
    "11".repeat(32),
    new BatchId(BATCH_ID),
    BATCH_DEPTH,
    rowsCache,
    backupSigner.publicKey().address(),
    ENC_KEY,
  )
  const deps: BatchWriteCoordinatorDeps = {
    bee,
    batchId: BATCH_ID,
    stamper,
    deviceId: DEVICE,
    knownDeviceIds: () => knownDevices,
    intentGuardWindowMs: 0,
    accountId: "account",
    backupSigner,
    swarmEncryptionKey: ENC_KEY,
    partitionCount: PARTITION_COUNT,
    mode,
    leaseRecord: {
      read: async () => leaseCache,
      update: async (next) => {
        if (leaseCacheWorks) leaseCache = next(leaseCache)
      },
    },
    flushStamperState: () => stamper.flush(),
    onLeaseAcquired: () => {
      acquired++
    },
  }
  const coordinator = new BatchWriteCoordinator(deps)
  coordinators.push(coordinator)
  const internals = coordinator as unknown as Internals
  let stamps = 0
  let acquired = 0
  return {
    /** Times the coordinator announced a lease as newly acquired. */
    acquired: () => acquired,
    coordinator,
    /** An upload of one chunk into `bucket`, acked like any other. */
    upload: (bucket: number) =>
      coordinator.withWrite(async () => {
        const address = new Uint8Array(32).fill(++stamps)
        address[0] = bucket >> 8
        address[1] = bucket & 0xff
        stamper.stamp(address)
      }),
    /** Hold the lane without uploading, as a tab that just opened does. */
    hold: async () => {
      coordinator.startLease()
      await vi.waitFor(
        () => expect(coordinator.currentPartition).not.toBeUndefined(),
        SETTLE,
      )
    },
    /** One firing of the refresh timer. */
    tick: async () => {
      const lease = internals.partitionLease
      if (lease) await internals.refreshTick(lease)
    },
    lease: () => internals.partitionLease,
  }
}

/** Everything queued on the write lock so far has run. */
const lockDrained = () => withBatchWriteLock(BATCH_ID, async () => undefined)

function lockHolder(partition: number) {
  return readPartitionLock({
    bee,
    backupSigner,
    swarmEncryptionKey: ENC_KEY,
    batchId: new BatchId(BATCH_ID),
    partition,
  })
}

function publishedCounter(partition: number) {
  return readPartitionState({
    bee,
    owner: backupSigner.publicKey().address(),
    swarmEncryptionKey: ENC_KEY,
    batchId: new BatchId(BATCH_ID),
    partition,
    nowMs: clock,
  })
}

describe("two tabs sharing one lease", () => {
  const BUCKET = 0x0123

  it("an idle tab's heartbeat leaves the state pointer on the sibling's latest publish", async () => {
    const tabA = await openTab()
    const tabB = await openTab()
    await tabA.upload(BUCKET)
    await tabB.hold()
    const partition = tabA.coordinator.currentPartition!
    expect(tabB.coordinator.currentPartition).toBe(partition)

    await tabA.upload(BUCKET) // acked: the lane's published counter is 2
    expect((await publishedCounter(partition)).localCounter?.[BUCKET]).toBe(2)

    await tabB.tick()

    // What the next holder would resume from, were this device to go now
    const resume = await publishedCounter(partition)
    expect(resume.readFailed).toBeUndefined()
    expect(resume.localCounter?.[BUCKET]).toBe(2)
  })

  it("an idle tab's tick leaves the lease record naming the sibling's latest publish", async () => {
    const tabA = await openTab()
    const tabB = await openTab()
    await tabA.upload(BUCKET)
    await tabB.hold()
    await tabA.upload(BUCKET)
    const latest = leaseCache?.referenceHex
    expect(latest).toBeDefined()

    await tabB.tick()

    expect(leaseCache?.referenceHex).toBe(latest)
  })

  it("an idle tab does not release the lane a sibling tab is uploading through", async () => {
    const tabA = await openTab()
    const tabB = await openTab()
    await tabA.upload(BUCKET)
    await tabB.hold()
    const partition = tabA.coordinator.currentPartition!
    const lock = () => lockHolder(partition)

    // Another device appears; tab A goes quiet while tab B keeps uploading
    knownDevices = [DEVICE, RIVAL]
    clock += IDLE_YIELD_MS + 1000
    await tabB.upload(BUCKET)

    await tabA.tick()
    expect((await lock())?.holderDeviceId).not.toBe(NO_HOLDER_DEVICE_ID)

    // Tab B's next upload is acked on a lane this device has not given up
    await tabB.upload(BUCKET)
    expect((await lock())?.holderDeviceId).toBe(DEVICE)
  })

  it("an idle tab picks the lease back up after the sibling's publish, and keeps holding it", async () => {
    const tabA = await openTab()
    const tabB = await openTab()
    await tabA.upload(BUCKET)
    await tabB.hold()
    const partition = tabA.coordinator.currentPartition!
    await tabA.upload(BUCKET)

    await tabB.tick()
    await lockDrained()
    await vi.waitFor(
      () => expect(tabB.coordinator.currentPartition).toBe(partition),
      SETTLE,
    )
    expect(leaseCache?.self?.partition).toBe(partition)

    // ...and its heartbeat from here on carries the latest publish forward
    await tabB.tick()
    expect((await publishedCounter(partition)).localCounter?.[BUCKET]).toBe(2)
  })

  it("a tab does not re-claim the lane its sibling yielded", async () => {
    const tabA = await openTab()
    const tabB = await openTab()
    await tabA.upload(BUCKET)
    await tabB.hold()
    const partition = tabA.coordinator.currentPartition!

    // Both tabs idle, and another device waiting: tab A yields
    knownDevices = [DEVICE, RIVAL]
    clock += IDLE_YIELD_MS + 1000
    await tabA.tick()
    expect((await lockHolder(partition))?.holderDeviceId).toBe(
      NO_HOLDER_DEVICE_ID,
    )

    // Tab B's timer fires with its lease object still saying "held"
    knownDevices = [DEVICE]
    await tabB.tick()
    await lockDrained()
    expect((await lockHolder(partition))?.holderDeviceId).toBe(
      NO_HOLDER_DEVICE_ID,
    )
    expect(tabB.coordinator.currentPartition).toBeUndefined()
  })

  it("two tabs torn down together leave the pointer on the latest publish", async () => {
    // A stamp change or a sign-out reaches both tabs. Each releases; the one
    // whose table is behind must not publish it over the other's.
    const tabA = await openTab()
    const tabB = await openTab()
    await tabA.upload(BUCKET)
    await tabB.hold()
    const partition = tabA.coordinator.currentPartition!
    await tabA.upload(BUCKET)

    tabA.coordinator.teardown()
    tabB.coordinator.teardown()
    await lockDrained()

    expect((await lockHolder(partition))?.holderDeviceId).toBe(
      NO_HOLDER_DEVICE_ID,
    )
    const resume = await publishedCounter(partition)
    expect(resume.readFailed).toBeUndefined()
    expect(resume.localCounter?.[BUCKET]).toBe(2)
  })

  it("a single tab keeps its lease object across ticks and uploads", async () => {
    const tab = await openTab()
    await tab.upload(BUCKET)
    const partition = tab.coordinator.currentPartition!
    const lease = tab.lease()

    await tab.tick()
    await tab.upload(BUCKET)
    await tab.tick()
    await lockDrained()

    expect(tab.lease()).toBe(lease)
    expect((await lockHolder(partition))?.holderDeviceId).toBe(DEVICE)
    expect((await publishedCounter(partition)).localCounter?.[BUCKET]).toBe(2)
  })

  it("a tab whose lease record does not keep its writes still holds its lease", async () => {
    // IndexedDB refused: nothing reads back, and no sibling shares it
    leaseCacheWorks = false
    const tab = await openTab()
    await tab.upload(BUCKET)
    const partition = tab.coordinator.currentPartition!
    const lease = tab.lease()

    await tab.tick()
    await tab.upload(BUCKET)
    await lockDrained()

    expect(tab.lease()).toBe(lease)
    expect((await lockHolder(partition))?.holderDeviceId).toBe(DEVICE)
  })

  it("picking the sibling's lease back up is not announced as an acquisition", async () => {
    // The proxy answers an acquisition by publishing the account snapshot,
    // which is itself a publish the sibling would then have to pick up.
    const tabA = await openTab()
    const tabB = await openTab()
    await tabA.upload(BUCKET)
    await tabB.hold()
    const announced = tabB.acquired()
    await tabA.upload(BUCKET)

    await tabB.tick()
    await lockDrained()
    await vi.waitFor(
      () => expect(tabB.coordinator.currentPartition).not.toBeUndefined(),
      SETTLE,
    )
    expect(tabB.acquired()).toBe(announced)
  })

  it("two tabs on a lane not yet published do not trade claims", async () => {
    // Nothing certifies the rows of an unpublished lane, so a tab cannot
    // adopt it from the cache. It must wait for its next write rather than
    // claim afresh on a timer, or each claim strands the other tab's view.
    const tabA = await openTab()
    const tabB = await openTab()
    await tabA.hold()
    clock += 1000 // a claim's generation is its timestamp
    await tabB.hold()
    await lockDrained()
    const generation = leaseCache?.self?.generation

    for (const tab of [tabA, tabB, tabA]) {
      clock += 1000
      await tab.tick()
      await lockDrained()
    }

    expect(leaseCache?.self?.generation).toEqual(generation)
    // The tab left without a view claims again when it has something to write
    await tabA.upload(BUCKET)
    expect(tabA.coordinator.currentPartition).not.toBeUndefined()
  })

  it("a one-shot writer's publish is the one an idle tab's heartbeat carries forward", async () => {
    // The SwarmID tab's account sync writes through a one-shot coordinator
    // on the same lane, with no timer of its own.
    const proxyTab = await openTab()
    await proxyTab.upload(BUCKET)
    const partition = proxyTab.coordinator.currentPartition!

    const accountSync = await openTab("oneshot")
    await accountSync.upload(BUCKET)
    expect((await publishedCounter(partition)).localCounter?.[BUCKET]).toBe(2)

    await proxyTab.tick()
    await lockDrained()

    const resume = await publishedCounter(partition)
    expect(resume.readFailed).toBeUndefined()
    expect(resume.localCounter?.[BUCKET]).toBe(2)
  })

  it("a coordinator built after a teardown claims afresh instead of taking the released lease", async () => {
    const first = await openTab()
    await first.upload(BUCKET)
    const released = leaseCache?.self?.generation
    const partition = first.coordinator.currentPartition!

    first.coordinator.teardown()
    clock += 1000 // a claim's generation is its timestamp
    const successor = await openTab()
    await successor.upload(BUCKET)

    expect(leaseCache?.self?.generation).not.toEqual(released)
    expect((await lockHolder(partition))?.holderDeviceId).toBe(DEVICE)
    expect((await publishedCounter(partition)).localCounter?.[BUCKET]).toBe(2)
  })

  it("a tab that disconnects leaves alone the lease a sibling has published under since", async () => {
    const tabA = await openTab()
    const tabB = await openTab()
    await tabA.upload(BUCKET)
    await tabB.hold()
    const partition = tabA.coordinator.currentPartition!
    await tabA.upload(BUCKET)

    tabB.coordinator.teardown()
    await lockDrained()

    expect((await lockHolder(partition))?.holderDeviceId).toBe(DEVICE)
    expect(leaseCache?.self?.partition).toBe(partition)
    expect((await publishedCounter(partition)).localCounter?.[BUCKET]).toBe(2)
    await tabA.upload(BUCKET)
    expect((await publishedCounter(partition)).localCounter?.[BUCKET]).toBe(3)
  })
})
