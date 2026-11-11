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
import * as partitionState from "./partition-state"
import { readPartitionState } from "./partition-state"
import {
  IDLE_YIELD_MS,
  LEASE_REFRESH_MS,
  PARTITION_COUNT,
  PartitionLeaseLostError,
  UtilizationAwareStamper,
} from "../utils/batch-utilization"
import { memoryUtilizationStore } from "../storage/memory-utilization-store"
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
/** Past the lease TTL: the lock on Swarm no longer names a live holder. */
const LAPSED_MS = 31_000

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
  rowsCache = memoryUtilizationStore()
  leaseCache = undefined
  leaseCacheWorks = true
  knownDevices = [DEVICE]
  coordinators = []
})

afterEach(() => {
  for (const coordinator of coordinators) coordinator.teardown()
  vi.restoreAllMocks()
})

async function openTab(
  mode: BatchWriteCoordinatorDeps["mode"] = "persistent",
  /** `flush: false` wires no flush at all: nothing of this context's reaches the rows. */
  wiring: { flush?: boolean } = {},
) {
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
    // As the proxy does: a flush that fails is logged, and the write goes on
    flushStamperState:
      wiring.flush === false
        ? undefined
        : () => stamper.flush().catch(() => undefined),
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
    stamper,
    /** An upload of one chunk into `bucket`, acked like any other. With
     *  `gate`, the upload holds the write lock until it resolves, then
     *  stamps; `started` resolves once it is in. */
    upload: (bucket: number, gate?: Promise<void>, started?: () => void) =>
      coordinator.withWrite(async () => {
        started?.()
        await gate
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

  it("two tabs share a lane that has not been published yet, under one claim", async () => {
    // The lane is in the lease record and the rows describe it; with no
    // publish recorded there is nothing the rows could be behind, so the
    // second tab adopts it and neither claims afresh.
    const tabA = await openTab()
    const tabB = await openTab()
    await tabA.hold()
    const generation = leaseCache?.self?.generation
    clock += 1000 // a fresh claim's generation would be its timestamp
    await tabB.hold()
    await lockDrained()

    for (const tab of [tabA, tabB, tabA]) {
      clock += 1000
      await tab.tick()
      await lockDrained()
    }

    expect(leaseCache?.self?.generation).toEqual(generation)
    const partition = leaseCache?.self?.partition
    expect(tabA.coordinator.currentPartition).toBe(partition)
    expect(tabB.coordinator.currentPartition).toBe(partition)
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

  it("a coordinator built after a teardown resumes from the rows, without downloading the released state", async () => {
    const first = await openTab()
    await first.upload(BUCKET)
    first.coordinator.teardown()
    await lockDrained()

    clock += 1000
    const reads = vi.spyOn(partitionState, "readPartitionState")
    const successor = await openTab()
    await successor.upload(BUCKET)

    const claimRead = await reads.mock.results[0].value
    expect(claimRead.unchanged).toBe(true)
    const partition = successor.coordinator.currentPartition!
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

  it("tabs taking turns publish incrementally, each from the baseline the other left in the store", async () => {
    const tabA = await openTab()
    const tabB = await openTab()
    await tabA.upload(BUCKET)
    await tabB.hold()
    const partition = tabA.coordinator.currentPartition!

    const writeSpy = vi.spyOn(partitionState, "writePartitionState")
    await tabB.upload(BUCKET)
    await tabA.upload(BUCKET)
    await tabB.upload(BUCKET)

    expect(writeSpy).toHaveBeenCalledTimes(3)
    for (const [publish] of writeSpy.mock.calls) {
      expect(publish.previousReferences).toBeDefined()
      expect(publish.previousCounter).toBeDefined()
    }
    const resume = await publishedCounter(partition)
    expect(resume.readFailed).toBeUndefined()
    expect(resume.localCounter?.[BUCKET]).toBe(4)
  })

  it("reads the published state back when the store's baseline is not the publish the lease record names", async () => {
    // Tab A's publish lands and is recorded, but the flush that stores its
    // baseline fails: the store still holds the baseline of the publish
    // before it, whose leaves no longer match what the pointer names.
    const tabA = await openTab()
    const tabB = await openTab()
    await tabA.upload(BUCKET)
    await tabB.hold()
    const partition = tabA.coordinator.currentPartition!

    const writeRows = rowsCache.writeRows.bind(rowsCache)
    let flushes = 0
    rowsCache.writeRows = async (batchId, entries, patch, published) => {
      // The first flush of an upload carries its rows; the second its publish
      if (++flushes === 2) throw new Error("IndexedDB failed")
      await writeRows(batchId, entries, patch, published)
    }
    await tabA.upload(BUCKET)
    rowsCache.writeRows = writeRows

    const writeSpy = vi.spyOn(partitionState, "writePartitionState")
    await tabB.upload(BUCKET)
    // Tab B diffs against the counter it read back from Swarm, not against
    // the store's, which is a publish behind
    expect(writeSpy.mock.calls[0][0].previousCounter?.[BUCKET]).toBe(2)

    const resume = await publishedCounter(partition)
    expect(resume.readFailed).toBeUndefined()
    expect(resume.localCounter?.[BUCKET]).toBe(3)
  })
})

describe("one refresher, one idle clock", () => {
  const BUCKET = 0x0123

  async function twoHolders() {
    const tabA = await openTab()
    const tabB = await openTab()
    await tabA.upload(BUCKET)
    await tabB.hold()
    await lockDrained()
    const refreshes = [tabA, tabB].map((tab) =>
      vi.spyOn(tab.lease()!, "refresh"),
    )
    const count = () => refreshes.reduce((n, s) => n + s.mock.calls.length, 0)
    return { tabA, tabB, refreshes: count }
  }

  it("two tabs ticking in one interval renew the lease on Swarm once", async () => {
    const { tabA, tabB, refreshes } = await twoHolders()

    clock += LEASE_REFRESH_MS
    await tabA.tick()
    clock += 1000
    await tabB.tick()
    expect(refreshes()).toBe(1)

    // A full interval on, whichever tab ticks first renews
    clock += LEASE_REFRESH_MS
    await tabB.tick()
    expect(refreshes()).toBe(2)
  })

  it("a tab that leaves the renewal to its sibling takes the renewed expiry", async () => {
    const { tabA, tabB } = await twoHolders()

    clock += LEASE_REFRESH_MS
    await tabA.tick()
    clock += 1000
    await tabB.tick()

    expect(tabB.lease()?.leasedUntil).toBe(tabA.lease()?.leasedUntil)
    expect(tabB.lease()?.leasedUntil).toBe(leaseCache?.self?.leasedUntil)
  })

  it("a sibling renews itself once the lease nears expiry, whatever the record says", async () => {
    const { tabA, tabB, refreshes } = await twoHolders()
    // Tab A's renewals keep failing; its latest claim on one is moments old
    vi.spyOn(tabA.lease()!, "refresh").mockRejectedValue(new Error("500"))
    clock = tabA.lease()!.leasedUntil! - 3000
    await tabA.tick()
    const before = refreshes()

    clock += 2000
    await tabB.tick()

    expect(refreshes()).toBe(before + 1)
  })

  it("an idle tab renews the lane its sibling uploaded through within the idle period", async () => {
    const { tabA, tabB } = await twoHolders()
    const renewals = vi.spyOn(tabB.lease()!, "refresh")
    knownDevices = [DEVICE, RIVAL]

    clock += IDLE_YIELD_MS
    await tabA.upload(BUCKET)
    clock += 1000
    await tabB.tick()

    expect(renewals).toHaveBeenCalledTimes(1)
  })

  it("an idle tab does not yield under an upload that outlasts the idle period", async () => {
    const { tabA, tabB } = await twoHolders()
    const partition = tabA.coordinator.currentPartition!
    knownDevices = [DEVICE, RIVAL]
    let open!: () => void
    let entered!: () => void
    const inside = new Promise<void>((resolve) => (entered = resolve))
    const uploading = tabA.upload(
      BUCKET,
      new Promise<void>((resolve) => (open = resolve)),
      entered,
    )
    await inside
    const RENEWED_AFTER_MS = 20_000
    clock += RENEWED_AFTER_MS
    await tabA.tick() // renews, so the upload outlives the idle period only

    clock += IDLE_YIELD_MS - RENEWED_AFTER_MS + 1000
    const bTick = tabB.tick() // waits on the write lock behind the upload
    open()
    await Promise.all([uploading, bTick])
    await lockDrained()

    expect((await lockHolder(partition))?.holderDeviceId).toBe(DEVICE)
    expect(tabB.coordinator.currentPartition).toBe(partition)
  })

  it("an uploading tab stops stamping within one tick of its sibling finding the lane taken", async () => {
    const { tabA, tabB } = await twoHolders()
    let open!: () => void
    let entered!: () => void
    const inside = new Promise<void>((resolve) => (entered = resolve))
    const uploading = tabA.upload(
      BUCKET,
      new Promise<void>((resolve) => (open = resolve)),
      entered,
    )
    await inside

    // Tab B renews, and a peer's beacon proves the lane is someone else's
    vi.spyOn(tabB.lease()!, "refresh").mockResolvedValueOnce("displaced")
    clock += LEASE_REFRESH_MS
    const bTick = tabB.tick()
    await vi.waitFor(() => expect(leaseCache?.self).toBeUndefined(), SETTLE)

    // Tab A's own tick, while its upload still holds the write lock
    const invalidated = vi.spyOn(tabA.stamper, "invalidateLease")
    clock += 1000
    const aTick = tabA.tick()
    await vi.waitFor(() => expect(invalidated).toHaveBeenCalled(), SETTLE)

    open()
    await expect(uploading).rejects.toBeInstanceOf(PartitionLeaseLostError)
    await Promise.all([aTick, bTick])
  })

  it("an idle tab yields once the sibling's last upload is an idle period old", async () => {
    const { tabA, tabB } = await twoHolders()
    const partition = tabA.coordinator.currentPartition!
    knownDevices = [DEVICE, RIVAL]
    const SINCE_UPLOAD_MS = 5000

    // Tab A uploads; tab B only notices on its next tick
    clock += IDLE_YIELD_MS - SINCE_UPLOAD_MS
    await tabA.upload(BUCKET)
    clock += SINCE_UPLOAD_MS
    await tabB.tick()
    await lockDrained()

    // An idle period after tab A's upload, not after tab B noticed it
    clock += IDLE_YIELD_MS - SINCE_UPLOAD_MS + 1000
    vi.spyOn(console, "info")
    await tabB.tick()
    await lockDrained()
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining(`Released idle partition ${partition}`),
    )
  })

  it("an upload that finishes after its sibling found the lane taken is not acked, and leaves the record cleared", async () => {
    const { tabA, tabB } = await twoHolders()
    let open!: () => void
    let entered!: () => void
    const inside = new Promise<void>((resolve) => (entered = resolve))
    const uploading = tabA.upload(
      BUCKET,
      new Promise<void>((resolve) => (open = resolve)),
      entered,
    )
    await inside

    // Tab B finds the lane taken, inside tab A's validation throttle
    vi.spyOn(tabB.lease()!, "refresh").mockResolvedValueOnce("displaced")
    clock += LEASE_REFRESH_MS / 2
    const bTick = tabB.tick()
    await vi.waitFor(() => expect(leaseCache?.self).toBeUndefined(), SETTLE)

    // Tab A's upload finishes before its own tick comes round
    open()
    await expect(uploading).rejects.toBeInstanceOf(PartitionLeaseLostError)
    await bTick
    await lockDrained()
    expect(leaseCache?.self).toBeUndefined()
    expect(tabA.coordinator.currentPartition).toBeUndefined()
  })

  it("a renewal claim dated ahead of the clock does not stop the renewals", async () => {
    const { tabB, refreshes } = await twoHolders()
    const AHEAD_MS = 60_000
    leaseCache = { ...leaseCache!, renewingAt: clock + AHEAD_MS }

    clock += LEASE_REFRESH_MS
    await tabB.tick()

    expect(refreshes()).toBe(1)
  })

  it("upload activity dated ahead of the clock does not hold off the idle yield", async () => {
    const { tabA, tabB } = await twoHolders()
    const partition = tabA.coordinator.currentPartition!
    knownDevices = [DEVICE, RIVAL]
    const AHEAD_MS = 3_600_000
    leaseCache = { ...leaseCache!, activeAt: clock + AHEAD_MS }

    clock += IDLE_YIELD_MS + 1000
    vi.spyOn(console, "info")
    await tabB.tick()
    await lockDrained()

    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining(`Released idle partition ${partition}`),
    )
  })

  it("a tab whose timer was held back takes the expiry its sibling renewed, and a failing node does not cost the device its lease", async () => {
    const { tabA, tabB } = await twoHolders()
    const partition = tabA.coordinator.currentPartition!
    const HELD_BACK_INTERVALS = 4
    for (let i = 0; i < HELD_BACK_INTERVALS; i++) {
      clock += LEASE_REFRESH_MS
      await tabA.tick()
    }
    await lockDrained()

    const renewal = vi
      .spyOn(tabB.lease()!, "refresh")
      .mockRejectedValue(new Error("500"))
    renewal.mockClear()
    clock += 1000
    await tabB.tick()
    await lockDrained()

    expect(renewal).not.toHaveBeenCalled()
    expect(leaseCache?.self).toBeDefined()
    expect(tabB.coordinator.currentPartition).toBe(partition)
    expect(tabB.lease()?.leasedUntil).toBe(leaseCache?.self?.leasedUntil)
  })

  it("a heartbeat failure a sibling's heartbeats have since made good does not count against a later one", async () => {
    const { tabA, tabB } = await twoHolders()
    const partition = tabA.coordinator.currentPartition!
    const heartbeat = vi.spyOn(tabA.lease()!, "heartbeatStatePointer")
    vi.spyOn(console, "warn").mockImplementation(() => undefined)

    heartbeat.mockRejectedValueOnce(new Error("500"))
    clock += LEASE_REFRESH_MS
    await tabA.tick()

    // Tab B renews and heartbeats for a while; tab A follows a second behind
    const FOLLOWING_INTERVALS = 4
    for (let i = 0; i < FOLLOWING_INTERVALS; i++) {
      clock += LEASE_REFRESH_MS - 1000
      await tabB.tick()
      clock += 1000
      await tabA.tick()
    }

    // Tab A renews again, and one heartbeat fails
    heartbeat.mockRejectedValueOnce(new Error("500"))
    clock += LEASE_REFRESH_MS
    await tabA.tick()
    await lockDrained()

    expect(heartbeat).toHaveBeenCalledTimes(2)
    expect(leaseCache?.self).toBeDefined()
    expect(tabA.coordinator.currentPartition).toBe(partition)
  })

  it("heartbeats failing in whichever tab renews demote the device within a pointer epoch", async () => {
    const { tabA, tabB } = await twoHolders()
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    for (const tab of [tabA, tabB]) {
      vi.spyOn(tab.lease()!, "heartbeatStatePointer").mockRejectedValue(
        new Error("500"),
      )
    }

    // The renewal alternates, so neither tab alone fails for a whole epoch
    const ALTERNATIONS = 3
    for (let i = 0; i < ALTERNATIONS; i++) {
      clock += LEASE_REFRESH_MS
      await tabA.tick()
      clock += LEASE_REFRESH_MS
      await tabB.tick()
    }
    await lockDrained()

    expect(leaseCache?.self).toBeUndefined()
  })
})

describe("a sibling's stamps that never reached the rows", () => {
  const BUCKET = 0x0123

  it("a tab reads the lane's state from Swarm when a sibling published without flushing", async () => {
    const tabA = await openTab()
    await tabA.upload(BUCKET)
    const partition = tabA.coordinator.currentPartition!

    const unflushed = await openTab("oneshot", { flush: false })
    await unflushed.upload(BUCKET)
    expect((await publishedCounter(partition)).localCounter?.[BUCKET]).toBe(2)

    await tabA.upload(BUCKET)
    expect((await publishedCounter(partition)).localCounter?.[BUCKET]).toBe(3)
  })

  it("a tab reads the lane's state from Swarm when a sibling's flushes failed around its publish", async () => {
    const tabA = await openTab()
    const tabB = await openTab()
    await tabA.upload(BUCKET)
    await tabB.hold()
    await lockDrained()
    const partition = tabA.coordinator.currentPartition!

    const writeRows = rowsCache.writeRows.bind(rowsCache)
    rowsCache.writeRows = async () => {
      throw new Error("IndexedDB failed")
    }
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    await tabA.upload(BUCKET)
    rowsCache.writeRows = writeRows
    expect((await publishedCounter(partition)).localCounter?.[BUCKET]).toBe(2)

    await tabB.upload(BUCKET)
    expect((await publishedCounter(partition)).localCounter?.[BUCKET]).toBe(3)
  })

  it("a one-shot writer taking the recorded lease does not extend it past the lock on Swarm", async () => {
    const tab = await openTab()
    await tab.upload(BUCKET)
    const partition = tab.coordinator.currentPartition!
    // The tab is gone without a release; one-shot writers keep arriving
    const NEAR_EXPIRY_MS = 3000
    clock = (await lockHolder(partition))!.leasedUntil - NEAR_EXPIRY_MS
    await (await openTab("oneshot")).upload(BUCKET)

    clock = leaseCache!.self!.leasedUntil - NEAR_EXPIRY_MS
    await (await openTab("oneshot")).upload(BUCKET)

    // Whenever a writer stamped, the lock on Swarm named this device as live
    expect((await lockHolder(partition))!.leasedUntil).toBeGreaterThan(clock)
  })

  it("a cold acquire never binds below what this device's rows record for the lane", async () => {
    const first = await openTab()
    await first.upload(BUCKET)
    await first.upload(BUCKET)
    const partition = first.coordinator.currentPartition!
    await lockDrained()

    // The pointer ends up on an older state (whatever let that through), the
    // lease lapses and its record is gone: nothing but the rows remembers
    const older = new Uint32Array(first.stamper.getLocalCounter()!.length)
    older[BUCKET] = 1
    await partitionState.writePartitionState({
      bee,
      stamper: first.stamper,
      batchId: new BatchId(BATCH_ID),
      partition,
      localCounter: older,
      backupSigner,
      swarmEncryptionKey: ENC_KEY,
      nowMs: clock,
    })
    coordinators = []
    leaseCache = undefined
    clock += LAPSED_MS

    const successor = await openTab()
    await successor.upload(BUCKET)

    expect(successor.coordinator.currentPartition).toBe(partition)
    expect((await publishedCounter(partition)).localCounter?.[BUCKET]).toBe(3)
  })

  it("an upload whose drive is torn down after its last stamp is not acked", async () => {
    // The teardown's own release publishes those stamps, detached and after
    // the fact: nothing the upload could vouch for.
    const tab = await openTab()
    await tab.upload(BUCKET)
    let open!: () => void
    let stamped!: () => void
    const afterStamp = new Promise<void>((resolve) => (stamped = resolve))
    const gate = new Promise<void>((resolve) => (open = resolve))
    const uploading = tab.coordinator.withWrite(async () => {
      const address = new Uint8Array(32).fill(0x55)
      address[0] = BUCKET >> 8
      address[1] = BUCKET & 0xff
      tab.stamper.stamp(address)
      stamped()
      await gate
    })
    await afterStamp

    tab.coordinator.teardown()
    open()

    await expect(uploading).rejects.toBeInstanceOf(PartitionLeaseLostError)
  })
})
