// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from "vitest"

// The lease primitive and the lock-SOC read are mocked so the coordinator's
// acquire / refresh / demote paths are unit-testable without a live Bee node.
const leaseController: { lease: unknown } = { lease: undefined }
vi.mock("./partition-lease", () => ({
  PartitionLease: {
    fromSwarmEncryptionKey: vi.fn(async () => leaseController.lease),
  },
}))
const lockController: {
  payload: { holderDeviceId: string; leasedUntil: number } | undefined
} = { payload: undefined }
vi.mock("./partition-lock", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    readPartitionLock: vi.fn(async () => lockController.payload),
  }
})
// The cross-tab Web Lock, with an interleaving hook: a test can run code at
// the moment the lock is granted (i.e. after the caller decided to lock but
// before the locked section runs) to simulate work that slipped in while the
// caller queued on the lock. Default is straight pass-through. `lastKey`
// records the lock key so the account-scoping can be asserted.
const writeLockController: {
  onGrant?: () => void
  lastKey?: string
  lastLegacyIds?: string[]
} = {}
vi.mock("../utils/account-write-lock", () => ({
  withAccountWriteLock: vi.fn(
    async (key: string, op: () => Promise<unknown>, legacyIds?: string[]) => {
      writeLockController.lastKey = key
      writeLockController.lastLegacyIds = legacyIds
      writeLockController.onGrant?.()
      // The real Web Locks API always invokes the callback asynchronously —
      // code scheduled synchronously after `lock(...)` runs BEFORE the locked
      // section. Mirror that, or ordering bugs (e.g. reading stamper state a
      // synchronous teardown already cleared) stay invisible to these tests.
      await Promise.resolve()
      return op()
    },
  ),
}))

import {
  BatchWriteCoordinator,
  PartitionContendedError,
  isDisplaced,
  type BatchWriteCoordinatorDeps,
} from "./batch-write-coordinator"
import { NO_HOLDER_DEVICE_ID } from "./partition-lock"
import type { LeaseRefreshOutcome } from "./partition-lease"
import { STATE_POINTER_EPOCH_MS } from "./partition-state"
import {
  LEASE_REFRESH_MS,
  LEASE_TTL_MS,
  PartitionLeaseLostError,
} from "../utils/batch-utilization"

const SELF = "self-device"
const PEER = "peer-device"
const NOW = 1_000_000
// Valid 32-byte hex batch ids. BATCH_ID is the lease (default) batch;
// BATCH_ID_2 a second owned batch targeted per write.
const BATCH_ID = "ab".repeat(32)
const BATCH_ID_2 = "cd".repeat(32)

/** A controllable stand-in for a bound stamper. Records the order of
 *  invalidate/unbind/bind so the race-fix ordering can be asserted. Pass a
 *  `label` when a test binds several stampers and needs to tell their calls
 *  apart; `batchIdHex` names the stamper's batch (default: the lease batch). */
function makeStamper(calls: string[], label = "", batchIdHex = BATCH_ID) {
  const tag = (name: string) => (label ? `${label}:${name}` : name)
  // Mirrors the real stamper: `getLocalCounter()` returns a counter only
  // while a partition is bound (`undefined` after `unbindPartition`).
  let bound = false
  return {
    batchId: { toHex: () => batchIdHex },
    depth: 20,
    invalidateLease: vi.fn(() => calls.push(tag("invalidate"))),
    unbindPartition: vi.fn(() => {
      bound = false
      calls.push(tag("unbind"))
    }),
    bindPartition: vi.fn(() => {
      bound = true
      calls.push(tag("bind"))
    }),
    setLeaseValidUntil: vi.fn(),
    buildLeaseLocalCounter: () => new Uint32Array(8),
    getLocalCounter: vi.fn(() => (bound ? new Uint32Array(8) : undefined)),
    // Persisted per-partition synced reference; the adopt fast path reads it to
    // seed the lease's heartbeat pointer. Default: none (fresh partition).
    getSyncedReference: vi.fn(async (_partition: number) => undefined),
  }
}

/** Cast a `makeStamper` double to the deps' stamper type. */
function asStamper(
  s: ReturnType<typeof makeStamper>,
): BatchWriteCoordinatorDeps["leaseStamper"] {
  return s as unknown as BatchWriteCoordinatorDeps["leaseStamper"]
}

/** A controllable PartitionLease double. */
function makeLease(
  opts: {
    partition?: number
    acquireResult?: {
      partition: number | undefined
      partitionCount: number
      localCounter?: Uint32Array
      isReadOnly: boolean
    }
    /** Make `acquire` reject — an operational failure, not contention. */
    acquireError?: Error
    refreshResult?: LeaseRefreshOutcome
    /** Local lease expiry, drives `leaseNearExpiry` in the reverse-clobber guard. */
    leasedUntil?: number
  } = {},
) {
  let partition = opts.partition
  let leasedUntil = opts.leasedUntil
  return {
    hydrate: vi.fn(),
    adoptIfLive: vi.fn(() => undefined),
    acquire: vi.fn(async () => {
      if (opts.acquireError) throw opts.acquireError
      const r = opts.acquireResult ?? {
        partition: undefined,
        partitionCount: 4,
        isReadOnly: true,
      }
      // The real PartitionLease binds its current partition on a successful
      // acquire; mirror that so `currentPartition` reflects the result.
      if (r.partition !== undefined) partition = r.partition
      return r
    }),
    refresh: vi.fn(async () => opts.refreshResult ?? "held"),
    release: vi.fn(async () => {}),
    joinBatch: vi.fn(async () => new Uint32Array(8)),
    publishState: vi.fn(async () => {}),
    heartbeatStatePointer: vi.fn(async () => {}),
    seedReferenceHex: vi.fn(),
    bumpLocalLease: vi.fn(),
    serialize: vi.fn(() => ({ v: 1 })),
    get currentPartition() {
      return partition
    },
    get leasedUntil() {
      return leasedUntil
    },
    /** Test helper: simulate the lease lapsing mid-upload. */
    setLeasedUntil(v: number) {
      leasedUntil = v
    },
  }
}

describe("isDisplaced", () => {
  it("is true only for a different, live device", () => {
    expect(
      isDisplaced({ holderDeviceId: PEER, leasedUntil: NOW + 1 }, NOW, SELF),
    ).toBe(true)
  })

  it("is false for our own id", () => {
    expect(
      isDisplaced({ holderDeviceId: SELF, leasedUntil: NOW + 1 }, NOW, SELF),
    ).toBe(false)
  })

  it("is false for the release sentinel", () => {
    expect(
      isDisplaced(
        { holderDeviceId: NO_HOLDER_DEVICE_ID, leasedUntil: NOW + 1 },
        NOW,
        SELF,
      ),
    ).toBe(false)
  })

  it("is false for an expired foreign holder", () => {
    expect(
      isDisplaced({ holderDeviceId: PEER, leasedUntil: NOW - 1 }, NOW, SELF),
    ).toBe(false)
  })

  it("is false for a missing/unreadable payload", () => {
    expect(isDisplaced(undefined, NOW, SELF)).toBe(false)
  })
})

describe("PartitionContendedError", () => {
  it("is an Error with a stable name and optional accountId", () => {
    const err = new PartitionContendedError(undefined, "acct-1")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("PartitionContendedError")
    expect(err.accountId).toBe("acct-1")
  })
})

// Minimal deps for the shell — the lease/write methods (Steps B/C) are not yet
// exercised here, so the Swarm-touching deps can be opaque doubles.
function makeDeps(
  overrides: Partial<BatchWriteCoordinatorDeps> = {},
): BatchWriteCoordinatorDeps {
  return {
    bee: {} as BatchWriteCoordinatorDeps["bee"],
    leaseStamper: asStamper(makeStamper([])),
    deviceId: SELF,
    accountId: "acct-1",
    backupSigner: {} as BatchWriteCoordinatorDeps["backupSigner"],
    swarmEncryptionKey: new Uint8Array(32),
    partitionCount: 4,
    mode: "persistent",
    ...overrides,
  }
}

describe("BatchWriteCoordinator (Step A shell)", () => {
  it("starts with no held partition and not read-only", () => {
    const coordinator = new BatchWriteCoordinator(makeDeps())
    expect(coordinator.currentPartition).toBeUndefined()
    expect(coordinator.isReadOnly).toBe(false)
  })

  it("exposes the injected lease stamper", () => {
    const leaseStamper = {
      tag: "the-stamper",
    } as unknown as BatchWriteCoordinatorDeps["leaseStamper"]
    const coordinator = new BatchWriteCoordinator(makeDeps({ leaseStamper }))
    expect(coordinator.stamperRef).toBe(leaseStamper)
  })

  it("teardown clears the lease cache and notifies onLeaseChange", () => {
    const writeLeaseCache = vi.fn()
    const onLeaseChange = vi.fn()
    const coordinator = new BatchWriteCoordinator(
      makeDeps({ writeLeaseCache, onLeaseChange }),
    )
    coordinator.teardown()
    expect(writeLeaseCache).toHaveBeenCalledWith(undefined)
    expect(onLeaseChange).toHaveBeenCalledWith({
      currentPartition: undefined,
      isReadOnly: false,
    })
  })

  it("teardown is safe with no optional hooks provided", () => {
    const coordinator = new BatchWriteCoordinator(makeDeps())
    expect(() => coordinator.teardown()).not.toThrow()
  })
})

/** Cast helper for poking at private state in the race-fix tests. */
type Internals = {
  partitionLease: unknown
  lastLeaseActivityAt: number
  lastLeaseValidatedAt: number
  activeUploadCount: number
  pendingAcquire: boolean
  pointerHeartbeatFailingSince: number | undefined
  readOnly: boolean
  refreshTick: (lease: unknown) => Promise<void>
  ensureLeaseStillValid: () => Promise<void>
  acquire: () => Promise<void>
  acquireWithSlotWait: () => Promise<void>
  pauseLeaseBackgroundWork: () => void
  joinedSecondaries: Map<string, unknown>
  secondaryHeartbeatFailingSince: Map<string, number>
}

describe("BatchWriteCoordinator.withWrite — wait fork", () => {
  it("block mode (proxy): acquires a free slot, runs op, flushes", async () => {
    leaseController.lease = makeLease({
      acquireResult: {
        partition: 1,
        partitionCount: 4,
        localCounter: new Uint32Array(8),
        isReadOnly: false,
      },
    })
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const flushStamperState = vi.fn(async () => {})
    const onLeaseAcquired = vi.fn()
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        mode: "oneshot", // no refresh timer to leak in the test
        flushStamperState,
        onLeaseAcquired,
      }),
    )

    const op = vi.fn(async (target: { mode: string }) => {
      expect(target.mode).toBe("stamper")
      return "ok"
    })
    const result = await coordinator.withWrite(asStamper(stamper), op, {
      wait: "block",
    })

    expect(result).toBe("ok")
    expect(op).toHaveBeenCalledTimes(1)
    expect(stamper.bindPartition).toHaveBeenCalled()
    expect(coordinator.currentPartition).toBe(1)
    expect(onLeaseAcquired).toHaveBeenCalledWith(1)
    expect(flushStamperState).toHaveBeenCalledTimes(1)
  })

  it("skip mode (sync-account): throws PartitionContendedError and never runs op", async () => {
    leaseController.lease = makeLease({
      acquireResult: {
        partition: undefined,
        partitionCount: 4,
        isReadOnly: true,
      },
    })
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        mode: "oneshot",
      }),
    )

    const op = vi.fn(async () => "ok")
    await expect(
      coordinator.withWrite(asStamper(stamper), op, { wait: "skip" }),
    ).rejects.toBeInstanceOf(PartitionContendedError)
    expect(op).not.toHaveBeenCalled()
  })

  it("single-partition account: writes without a lease (no acquire)", async () => {
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        partitionCount: 1,
        mode: "oneshot",
      }),
    )
    const op = vi.fn(async () => "ok")
    await expect(
      coordinator.withWrite(asStamper(stamper), op, { wait: "skip" }),
    ).resolves.toBe("ok")
    expect(op).toHaveBeenCalledTimes(1)
    expect(stamper.bindPartition).not.toHaveBeenCalled()
  })
})

describe("BatchWriteCoordinator.withWrite — commit-ordered ack", () => {
  function held(partition: number) {
    return makeLease({
      acquireResult: {
        partition,
        partitionCount: 4,
        localCounter: new Uint32Array(8),
        isReadOnly: false,
      },
      // Comfortably valid so the post-op freshness check stays throttled.
      leasedUntil: Date.now() + LEASE_TTL_MS,
    })
  }

  it("publishes partition state AFTER op resolves and BEFORE withWrite resolves", async () => {
    const order: string[] = []
    const lease = held(1)
    lease.publishState = vi.fn(async (lc: Uint32Array) => {
      order.push("publish")
      // The publish carries the stamper's current counter (its resume point).
      expect(lc).toBeInstanceOf(Uint32Array)
    }) as typeof lease.publishState
    leaseController.lease = lease
    const stamper = makeStamper([])
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        mode: "oneshot",
      }),
    )

    const op = vi.fn(async () => {
      order.push("op")
      return "ref"
    })
    const result = await coordinator.withWrite(asStamper(stamper), op, {
      wait: "block",
    })

    expect(result).toBe("ref")
    // Ack-after-publish: op's chunks are written, THEN the slot-reserving state
    // is published, THEN the upload resolves durable.
    expect(order).toEqual(["op", "publish"])
    expect(lease.publishState).toHaveBeenCalledTimes(1)
  })

  it("a publish failure rejects the upload (never reported durable)", async () => {
    const lease = held(1)
    lease.publishState = vi.fn(async () => {
      throw new Error("partition-state publish failed")
    }) as typeof lease.publishState
    leaseController.lease = lease
    const stamper = makeStamper([])
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        mode: "oneshot",
      }),
    )

    const op = vi.fn(async () => "ref")
    await expect(
      coordinator.withWrite(asStamper(stamper), op, { wait: "block" }),
    ).rejects.toThrow("partition-state publish failed")
    expect(op).toHaveBeenCalledTimes(1)
  })

  it("a held partition with no local counter rejects (never acks without publishing the slot reservation)", async () => {
    const lease = held(1)
    leaseController.lease = lease
    const stamper = makeStamper([])
    // Held a partition lease, but the stamper exposes no local counter — the
    // commit publish would be silently skipped, acking an upload whose slots
    // were never reserved on Swarm. The coordinator must fail loudly instead.
    stamper.getLocalCounter = (() =>
      undefined) as typeof stamper.getLocalCounter
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        mode: "oneshot",
      }),
    )

    const op = vi.fn(async () => "ref")
    await expect(
      coordinator.withWrite(asStamper(stamper), op, { wait: "block" }),
    ).rejects.toThrow(/local counter/)
    expect(op).toHaveBeenCalledTimes(1)
    expect(lease.publishState).not.toHaveBeenCalled()
  })

  it("reverse-clobber guard: a lease that lapsed mid-upload is re-read; the upload throws and does NOT publish", async () => {
    const lease = held(0)
    leaseController.lease = lease
    const stamper = makeStamper([])
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        mode: "oneshot",
      }),
    )
    // No live foreign holder at the start-of-write check (it's throttled anyway).
    lockController.payload = undefined

    const op = vi.fn(async () => {
      // The upload ran long enough that our lease lapsed AND a peer took the
      // slot — the reverse hazard the commit rule cannot cover.
      lease.setLeasedUntil(Date.now() - 1)
      lockController.payload = {
        holderDeviceId: PEER,
        leasedUntil: Date.now() + 10_000,
      }
      return "ref"
    })

    await expect(
      coordinator.withWrite(asStamper(stamper), op, { wait: "block" }),
    ).rejects.toThrow(/reclaimed/)
    expect(op).toHaveBeenCalledTimes(1)
    // Never ack slots a new holder now owns.
    expect(lease.publishState).not.toHaveBeenCalled()
    expect(coordinator.isReadOnly).toBe(true)
  })
})

describe("BatchWriteCoordinator — acquire does not block on the device-registry refresh", () => {
  it("completes acquire while refreshKnownDeviceIds is still pending (non-blocking)", async () => {
    leaseController.lease = makeLease({
      acquireResult: {
        partition: 1,
        partitionCount: 4,
        localCounter: new Uint32Array(8),
        isReadOnly: false,
      },
    })
    const stamper = makeStamper([])
    // A refresh that never settles — modelling the slow gateway roster fold.
    // If `acquire` awaited it (the old bug), `withWrite` would hang to the 45s
    // cap; non-blocking, the acquire binds the partition immediately.
    let settleRefresh!: () => void
    const refreshKnownDeviceIds = vi.fn(
      () => new Promise<void>((resolve) => (settleRefresh = resolve)),
    )
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        mode: "oneshot",
        refreshKnownDeviceIds,
      }),
    )

    const op = vi.fn(async () => "ok")
    await expect(
      coordinator.withWrite(asStamper(stamper), op, { wait: "block" }),
    ).resolves.toBe("ok")
    expect(refreshKnownDeviceIds).toHaveBeenCalledTimes(1)
    expect(coordinator.currentPartition).toBe(1)
    settleRefresh() // let the detached refresh resolve so no promise leaks
  })
})

describe("BatchWriteCoordinator — displacement-during-upload race fix", () => {
  it("invalidates the lease BEFORE unbinding, so an in-flight stamp aborts", async () => {
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const onLeaseChange = vi.fn()
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        onLeaseChange,
      }),
    )
    const internals = coordinator as unknown as Internals

    // Seed a held lease on partition 0 that fails its refresh (so the tick
    // falls back to the displacement read), and make the lock SOC name a live
    // peer. Keep the lease "active" so the idle-yield branch is skipped.
    const lease = makeLease({ partition: 0, refreshResult: "lost" })
    internals.partitionLease = lease
    internals.lastLeaseActivityAt = Date.now()
    internals.activeUploadCount = 1
    lockController.payload = {
      holderDeviceId: PEER,
      leasedUntil: Date.now() + 10_000,
    }

    await internals.refreshTick(lease)

    // The fix: invalidateLease() fires first (arming the stamp() circuit
    // breaker while the partition is still bound), THEN unbindPartition().
    expect(calls).toEqual(["invalidate", "unbind"])
    expect(stamper.invalidateLease).toHaveBeenCalledTimes(1)
    expect(stamper.unbindPartition).toHaveBeenCalledTimes(1)
    expect(coordinator.currentPartition).toBeUndefined()
    expect(coordinator.isReadOnly).toBe(true)
    expect(internals.pendingAcquire).toBe(true)
    expect(onLeaseChange).toHaveBeenLastCalledWith({
      currentPartition: undefined,
      isReadOnly: true,
    })
  })

  it("a live self-held lock SOC is NOT a displacement — keeps the lease", async () => {
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
      }),
    )
    const internals = coordinator as unknown as Internals
    const lease = makeLease({ partition: 0, refreshResult: "lost" })
    internals.partitionLease = lease
    internals.lastLeaseActivityAt = Date.now()
    internals.activeUploadCount = 1
    lockController.payload = {
      holderDeviceId: SELF,
      leasedUntil: Date.now() + 10_000,
    }

    await internals.refreshTick(lease)

    expect(stamper.invalidateLease).not.toHaveBeenCalled()
    expect(stamper.unbindPartition).not.toHaveBeenCalled()
    expect(coordinator.currentPartition).toBe(0)
    expect(lease.bumpLocalLease).toHaveBeenCalled()
  })

  it("demotes on a beacon-confirmed displacement, even though the static lock SOC still shows us live", async () => {
    // The refresh-time deconfliction backstop: `PartitionLease.refresh()` reads
    // a rival's presence beacon at a fresh per-epoch address — the channel that
    // stays readable on a disjoint gateway where the static lock SOC is frozen —
    // and, finding an earlier-generation foreign holder, reports `"displaced"`.
    //
    // Regression guard for the no-op the backstop existed to avoid: `refresh()`
    // ALSO just rewrote our own claim to the static lock SOC, so re-gating the
    // demote on `readPartitionLock` would read SELF (live) and never confirm —
    // and the device would keep a partition a peer already holds (dual-hold →
    // silent overstamp). The coordinator must trust the beacon verdict directly.
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const onLeaseChange = vi.fn()
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        onLeaseChange,
      }),
    )
    const internals = coordinator as unknown as Internals
    const lease = makeLease({ partition: 0, refreshResult: "displaced" })
    internals.partitionLease = lease
    internals.lastLeaseActivityAt = Date.now()
    internals.activeUploadCount = 1
    // The frozen-gateway view: the static lock SOC shows OURSELVES as the live
    // holder (we just rewrote it on this very refresh). Pre-fix, the coordinator
    // re-gated on this read and so kept the lease — the bug.
    lockController.payload = {
      holderDeviceId: SELF,
      leasedUntil: Date.now() + 10_000,
    }

    await internals.refreshTick(lease)

    // Mirrors the displacement-race fix: invalidate the breaker, then unbind.
    expect(calls).toEqual(["invalidate", "unbind"])
    expect(coordinator.currentPartition).toBeUndefined()
    expect(coordinator.isReadOnly).toBe(true)
    expect(internals.pendingAcquire).toBe(true)
    expect(onLeaseChange).toHaveBeenLastCalledWith({
      currentPartition: undefined,
      isReadOnly: true,
    })
  })
})

describe("BatchWriteCoordinator — sentinel re-assert at upload start", () => {
  function setup(lease: ReturnType<typeof makeLease>) {
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const writeLeaseCache = vi.fn()
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        writeLeaseCache,
      }),
    )
    const internals = coordinator as unknown as Internals
    internals.partitionLease = lease
    internals.lastLeaseValidatedAt = 0 // age past the freshness throttle
    lockController.payload = {
      holderDeviceId: NO_HOLDER_DEVICE_ID,
      leasedUntil: Date.now() - 1_000,
    }
    return { coordinator, internals, stamper, writeLeaseCache }
  }

  it("re-asserts the claim when a sentinel is visible while holding", async () => {
    const lease = makeLease({ partition: 0, refreshResult: "held" })
    const { internals, stamper, writeLeaseCache } = setup(lease)

    await internals.ensureLeaseStillValid()

    expect(lease.refresh).toHaveBeenCalledTimes(1)
    expect(stamper.invalidateLease).not.toHaveBeenCalled()
    expect(internals.lastLeaseValidatedAt).toBeGreaterThan(0)
    expect(writeLeaseCache).toHaveBeenCalled()
  })

  it("demotes and throws when the re-assert loses to a peer", async () => {
    const lease = makeLease({ partition: 0, refreshResult: "lost" })
    const { coordinator, internals, stamper } = setup(lease)

    await expect(internals.ensureLeaseStillValid()).rejects.toThrow(/reclaimed/)
    // Same breaker-before-unbind ordering as the displaced branch.
    expect(stamper.invalidateLease).toHaveBeenCalledTimes(1)
    expect(stamper.unbindPartition).toHaveBeenCalledTimes(1)
    expect(coordinator.isReadOnly).toBe(true)
  })

  it("keeps the lease (and retries next upload) when the re-assert throws", async () => {
    const lease = makeLease({ partition: 0 })
    lease.refresh.mockRejectedValueOnce(new Error("bee hiccup"))
    const { internals, stamper } = setup(lease)

    await expect(internals.ensureLeaseStillValid()).resolves.toBeUndefined()

    expect(stamper.invalidateLease).not.toHaveBeenCalled()
    // lastLeaseValidatedAt NOT bumped — the next upload re-checks.
    expect(internals.lastLeaseValidatedAt).toBe(0)
  })
})

describe("BatchWriteCoordinator — teardown safety", () => {
  it("invalidates the held lease BEFORE unbinding (off-lock teardown race)", () => {
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        mode: "oneshot",
      }),
    )
    const internals = coordinator as unknown as Internals
    internals.partitionLease = makeLease({ partition: 2 })

    coordinator.teardown()

    // Same ordering as the displacement fix: an in-flight stamp() aborts via
    // the breaker instead of silently falling back to legacy slot-picking.
    expect(calls).toEqual(["invalidate", "unbind"])
  })

  it("runs the teardown release under the batch write lock (#349)", async () => {
    const calls: string[] = []
    const stamper = makeStamper(calls)
    stamper.bindPartition() // held lease ⇒ bound stamper (counter available)
    const lease = makeLease({ partition: 1 })
    lease.release.mockImplementation(async () => {
      calls.push("release")
    })
    writeLockController.onGrant = () => calls.push("lock-granted")
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        mode: "oneshot",
      }),
    )
    ;(coordinator as unknown as Internals).partitionLease = lease

    coordinator.teardown()
    await vi.waitFor(() => expect(lease.release).toHaveBeenCalledTimes(1))
    writeLockController.onGrant = undefined

    // The release goes THROUGH the origin-wide lock — a successor's acquire
    // (which queues on the same lock) cannot interleave with it, so the
    // sentinel's stamp is always minted before the successor's claim stamp.
    expect(calls.indexOf("lock-granted")).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf("lock-granted")).toBeLessThan(calls.indexOf("release"))
  })

  it("a withWrite that resumes after teardown does NOT re-acquire and never runs op", async () => {
    leaseController.lease = makeLease({
      acquireResult: {
        partition: 1,
        partitionCount: 4,
        localCounter: new Uint32Array(8),
        isReadOnly: false,
      },
    })
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        mode: "persistent",
      }),
    )

    // Simulate the disconnect/sign-out that lands before the in-flight write
    // reaches its lease check.
    coordinator.teardown()

    const op = vi.fn(async () => "ok")
    await expect(
      coordinator.withWrite(asStamper(stamper), op, { wait: "block" }),
    ).rejects.toThrow(/torn down/)
    expect(op).not.toHaveBeenCalled()
    // No ghost lease: the disposed coordinator never re-binds a partition.
    expect(stamper.bindPartition).not.toHaveBeenCalled()
    expect(coordinator.currentPartition).toBeUndefined()
  })

  it("startLease is a no-op after teardown", () => {
    const coordinator = new BatchWriteCoordinator(
      makeDeps({ mode: "persistent" }),
    )
    coordinator.teardown()
    // Would otherwise warm up a lease + arm a refresh interval.
    expect(() => coordinator.startLease()).not.toThrow()
    expect(coordinator.currentPartition).toBeUndefined()
  })
})

describe("BatchWriteCoordinator — error classification", () => {
  it("skip mode: an operational acquire failure propagates as-is, NOT as contention", async () => {
    const boom = new Error("Bee 500 during lock-SOC scan")
    leaseController.lease = makeLease({ acquireError: boom })
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        mode: "oneshot",
      }),
    )

    const op = vi.fn(async () => "ok")
    // The caller (sync-account) must see the real error so it reports
    // status:"error" — not PartitionContendedError, which it logs as a quiet
    // "all partitions held" skip.
    await expect(
      coordinator.withWrite(asStamper(stamper), op, { wait: "skip" }),
    ).rejects.toBe(boom)
    expect(op).not.toHaveBeenCalled()
    expect(coordinator.currentPartition).toBeUndefined()
  })

  it("block mode: an operational acquire failure pauses and fails the upload", async () => {
    leaseController.lease = makeLease({
      acquireError: new Error("lock-SOC write failed"),
    })
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        mode: "oneshot",
      }),
    )

    const op = vi.fn(async () => "ok")
    // The real cause propagates — not the generic "fully leased" message
    // ensureHeldForUpload would emit for genuine contention.
    await expect(
      coordinator.withWrite(asStamper(stamper), op, { wait: "block" }),
    ).rejects.toThrow("lock-SOC write failed")
    expect(op).not.toHaveBeenCalled()
  })
})

describe("BatchWriteCoordinator — idle-yield under the write lock", () => {
  // The idle-yield exists to hand the slot to a WAITING PEER; it is gated on a
  // rival being known (a solo device re-paying the cold acquire after every
  // 30s pause was pure UX cost). These tests declare one.
  const RIVAL_DEPS = { knownDeviceIds: () => [SELF, "device-rival-1"] }

  it("yields an idle lease: releases, unbinds, and emits the transition", async () => {
    const calls: string[] = []
    const stamper = makeStamper(calls)
    stamper.bindPartition() // held lease ⇒ bound stamper (counter available)
    const onLeaseChange = vi.fn()
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        onLeaseChange,
        ...RIVAL_DEPS,
      }),
    )
    const internals = coordinator as unknown as Internals
    const lease = makeLease({ partition: 0 })
    internals.partitionLease = lease
    internals.activeUploadCount = 0
    internals.lastLeaseActivityAt = 0 // idle for longer than IDLE_YIELD_MS

    await internals.refreshTick(lease)

    expect(lease.release).toHaveBeenCalledTimes(1)
    expect(stamper.unbindPartition).toHaveBeenCalledTimes(1)
    expect(coordinator.currentPartition).toBeUndefined()
    expect(onLeaseChange).toHaveBeenLastCalledWith({
      currentPartition: undefined,
      isReadOnly: false,
    })
  })

  it("a failed joined-batch flush does not abort the release (sentinel still lands)", async () => {
    const calls: string[] = []
    const stamper = makeStamper(calls)
    stamper.bindPartition()
    const secondary = makeStamper(calls, "b2", BATCH_ID_2)
    secondary.bindPartition()
    const coordinator = new BatchWriteCoordinator(
      makeDeps({ leaseStamper: asStamper(stamper), ...RIVAL_DEPS }),
    )
    const internals = coordinator as unknown as Internals & {
      joinedSecondaries: Map<string, unknown>
    }
    const lease = makeLease({ partition: 0 })
    // The joined batch's final flush fails (only secondary publishes carry a
    // stamper arg); without per-batch isolation this would skip the release
    // and peers would wait out the full lease TTL for the slot.
    lease.publishState = vi.fn(async (_counter: Uint32Array, s?: unknown) => {
      if (s) throw new Error("swarm write failed")
    }) as typeof lease.publishState
    internals.partitionLease = lease
    internals.joinedSecondaries.set(BATCH_ID_2, secondary)
    internals.activeUploadCount = 0
    internals.lastLeaseActivityAt = 0 // idle for longer than IDLE_YIELD_MS

    await internals.refreshTick(lease)

    expect(lease.publishState).toHaveBeenCalledWith(
      expect.any(Uint32Array),
      secondary,
    )
    expect(lease.release).toHaveBeenCalledTimes(1)
    expect(coordinator.currentPartition).toBeUndefined()
  })

  it("keeps an idle lease when no rival is known (solo device)", async () => {
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        // knownDeviceIds omitted — no rival could take the freed slot, so a
        // yield would only force this device back through the cold acquire.
      }),
    )
    const internals = coordinator as unknown as Internals
    const lease = makeLease({ partition: 0 })
    internals.partitionLease = lease
    internals.activeUploadCount = 0
    internals.lastLeaseActivityAt = 0 // idle for longer than IDLE_YIELD_MS

    await internals.refreshTick(lease)

    expect(lease.release).not.toHaveBeenCalled()
    expect(stamper.unbindPartition).not.toHaveBeenCalled()
    expect(coordinator.currentPartition).toBe(0)
    // The tick fell through to the normal renewal instead.
    expect(lease.refresh).toHaveBeenCalled()
  })

  it("aborts the yield when an upload slipped in while the tick queued on the lock", async () => {
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        ...RIVAL_DEPS,
      }),
    )
    const internals = coordinator as unknown as Internals
    const lease = makeLease({ partition: 0 })
    internals.partitionLease = lease
    internals.activeUploadCount = 0
    internals.lastLeaseActivityAt = 0 // idle → tick decides to yield

    // An upload finishes (bumping activity) in the window between the tick's
    // off-lock idle check and the lock grant. The re-check inside the locked
    // section must abort the yield — otherwise the release sentinel + unbind
    // land underneath the next stamp() (the displacement-race corruption).
    writeLockController.onGrant = () => {
      internals.lastLeaseActivityAt = Date.now()
    }
    try {
      await internals.refreshTick(lease)
    } finally {
      writeLockController.onGrant = undefined
    }

    expect(lease.release).not.toHaveBeenCalled()
    expect(stamper.unbindPartition).not.toHaveBeenCalled()
    expect(coordinator.currentPartition).toBe(0)
  })

  it("aborts the yield when the lease was demoted/replaced while queued on the lock", async () => {
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        ...RIVAL_DEPS,
      }),
    )
    const internals = coordinator as unknown as Internals
    const lease = makeLease({ partition: 0 })
    internals.partitionLease = lease
    internals.activeUploadCount = 0
    internals.lastLeaseActivityAt = 0

    writeLockController.onGrant = () => {
      internals.partitionLease = undefined // demoted meanwhile
    }
    try {
      await internals.refreshTick(lease)
    } finally {
      writeLockController.onGrant = undefined
    }

    expect(lease.release).not.toHaveBeenCalled()
    expect(stamper.unbindPartition).not.toHaveBeenCalled()
  })
})

describe("BatchWriteCoordinator — adopt fast path seeds the heartbeat pointer", () => {
  it("seeds lastReferenceHex from the persisted synced reference on re-adopt", async () => {
    // The cached-lease re-adopt path binds from local state and skips
    // `claimPartition`, so without this seed an adopted-but-idle holder never
    // heartbeats the inherited pointer forward (it ages out of the takeover
    // lookup span → resume-from-zero). The coordinator must read the partition's
    // persisted synced reference and seed it into the lease.
    const lease = makeLease({ partition: 2 })
    lease.adoptIfLive = vi.fn(() => 2)
    leaseController.lease = lease
    const calls: string[] = []
    const stamper = makeStamper(calls)
    stamper.getSyncedReference = vi.fn(async () => "deadbeef")
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        mode: "oneshot", // no refresh timer to leak in the test
      }),
    )

    await coordinator.withWrite(asStamper(stamper), async () => "ok", {
      wait: "block",
    })

    expect(stamper.getSyncedReference).toHaveBeenCalledWith(2)
    expect(lease.seedReferenceHex).toHaveBeenCalledWith("deadbeef")
  })

  it("re-binds the batches joined before a reload so their pointers keep beating", async () => {
    // `joinedSecondaries` is memory-only. Without restoring it from the cached
    // snapshot, a reloaded holder heartbeats ONLY the lease batch; batch 2's
    // pointer ages out of the ~90s takeover span and a peer taking the
    // partition over resumes that batch from a zero counter.
    const lease = makeLease({ partition: 2 })
    lease.adoptIfLive = vi.fn(() => 2)
    leaseController.lease = lease
    const calls: string[] = []
    const leaseStamper = makeStamper(calls, "lease")
    const secondary = makeStamper(calls, "b2", BATCH_ID_2)
    secondary.getSyncedReference = vi.fn(async () => "cafe")
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(leaseStamper),
        mode: "oneshot",
        readLeaseCache: () => ({
          deviceId: SELF,
          batchId: BATCH_ID,
          self: {
            partition: 2,
            generation: { timestampMs: NOW, tiebreaker: SELF },
            acquiredAt: NOW,
            leasedUntil: Date.now() + LEASE_TTL_MS,
          },
          joinedBatchIds: [BATCH_ID_2],
        }),
        resolveStamperForBatch: async () => asStamper(secondary),
      }),
    )
    const internals = coordinator as unknown as Internals

    await coordinator.withWrite(asStamper(leaseStamper), async () => "ok", {
      wait: "block",
    })
    await coordinator.joinedRestoreSettled

    expect(secondary.bindPartition).toHaveBeenCalledWith(
      expect.objectContaining({ partition: 2, partitionCount: 4 }),
    )
    expect(lease.seedReferenceHex).toHaveBeenCalledWith(
      "cafe",
      asStamper(secondary),
    )
    expect(internals.joinedSecondaries.get(BATCH_ID_2)).toBe(
      asStamper(secondary),
    )

    // The payload: the refresh tick now heartbeats BOTH batches' pointers.
    lease.heartbeatStatePointer.mockClear()
    await internals.refreshTick(lease)
    expect(lease.heartbeatStatePointer).toHaveBeenCalledTimes(2)
  })

  it("abandons the restore when the lease is lost while resolving the stamper", async () => {
    const lease = makeLease({ partition: 2 })
    lease.adoptIfLive = vi.fn(() => 2)
    leaseController.lease = lease
    const calls: string[] = []
    const leaseStamper = makeStamper(calls, "lease")
    const secondary = makeStamper(calls, "b2", BATCH_ID_2)
    let releaseResolve: (() => void) | undefined
    const gate = new Promise<void>((r) => (releaseResolve = r))
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(leaseStamper),
        mode: "oneshot",
        readLeaseCache: () => ({
          deviceId: SELF,
          batchId: BATCH_ID,
          self: {
            partition: 2,
            generation: { timestampMs: NOW, tiebreaker: SELF },
            acquiredAt: NOW,
            leasedUntil: Date.now() + LEASE_TTL_MS,
          },
          joinedBatchIds: [BATCH_ID_2],
        }),
        resolveStamperForBatch: async () => {
          await gate
          return asStamper(secondary)
        },
      }),
    )
    const internals = coordinator as unknown as Internals

    await coordinator.withWrite(asStamper(leaseStamper), async () => "ok", {
      wait: "block",
    })
    // The partition went away while the resolve was in flight. Binding now
    // would clear `leaseStale` on a partition a peer may already own.
    coordinator.teardown()
    releaseResolve!()
    await coordinator.joinedRestoreSettled

    expect(secondary.bindPartition).not.toHaveBeenCalled()
    expect(internals.joinedSecondaries.size).toBe(0)
  })

  it("is a no-op for an old snapshot with no joined batches", async () => {
    const lease = makeLease({ partition: 2 })
    lease.adoptIfLive = vi.fn(() => 2)
    leaseController.lease = lease
    const calls: string[] = []
    const leaseStamper = makeStamper(calls, "lease")
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(leaseStamper),
        mode: "oneshot",
        readLeaseCache: () => ({
          deviceId: SELF,
          batchId: BATCH_ID,
          self: {
            partition: 2,
            generation: { timestampMs: NOW, tiebreaker: SELF },
            acquiredAt: NOW,
            leasedUntil: Date.now() + LEASE_TTL_MS,
          },
        }),
      }),
    )
    const internals = coordinator as unknown as Internals

    await coordinator.withWrite(asStamper(leaseStamper), async () => "ok", {
      wait: "block",
    })
    await coordinator.joinedRestoreSettled

    expect(internals.joinedSecondaries.size).toBe(0)
    lease.heartbeatStatePointer.mockClear()
    await internals.refreshTick(lease)
    expect(lease.heartbeatStatePointer).toHaveBeenCalledTimes(1)
  })

  it("adopts across a default-stamp change, seeding the NEW lease batch from the network", async () => {
    // The claim adoption is free (account-scoped SOCs) — but local state
    // describes the OLD batch, so the new lease batch's counter must come from
    // `joinBatch`'s network read (bounded by the restored prior-holder span),
    // never `buildLeaseLocalCounter`. Binding local here could full-publish
    // (near) zero over a prior holder's resume point.
    const networkCounter = new Uint32Array(8)
    networkCounter[5] = 9
    const lease = makeLease({ partition: 2 })
    lease.adoptIfLive = vi.fn(() => 2)
    lease.joinBatch = vi.fn(async () => networkCounter)
    leaseController.lease = lease
    const calls: string[] = []
    // The coordinator was rebuilt under batch 2; the snapshot was written
    // under batch 1 (the previous default).
    const leaseStamper = makeStamper(calls, "lease", BATCH_ID_2)
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(leaseStamper),
        mode: "oneshot",
        readLeaseCache: () => ({
          deviceId: SELF,
          batchId: BATCH_ID,
          self: {
            partition: 2,
            generation: { timestampMs: NOW, tiebreaker: SELF },
            acquiredAt: NOW,
            leasedUntil: Date.now() + LEASE_TTL_MS,
          },
        }),
      }),
    )

    await coordinator.withWrite(asStamper(leaseStamper), async () => "ok", {
      wait: "block",
    })

    // Adopted (no cold acquire) — and seeded from the network.
    expect(lease.acquire).not.toHaveBeenCalled()
    expect(lease.joinBatch).toHaveBeenCalledWith(asStamper(leaseStamper))
    expect(leaseStamper.bindPartition).toHaveBeenCalledWith(
      expect.objectContaining({ partition: 2, localCounter: networkCounter }),
    )
    // joinBatch seeded the pointer state itself — no local override.
    expect(lease.seedReferenceHex).not.toHaveBeenCalled()
  })

  it("falls back to a COLD acquire when the cross-batch adopt's state read fails", async () => {
    // An inconclusive read must never degrade to a zero-seed bind; the cold
    // acquire's claimPartition re-reads (with its own retry/read-only
    // handling) instead.
    const lease = makeLease({
      partition: 2,
      acquireResult: {
        partition: 2,
        partitionCount: 4,
        localCounter: new Uint32Array(8),
        isReadOnly: false,
      },
      leasedUntil: Date.now() + LEASE_TTL_MS,
    })
    lease.adoptIfLive = vi.fn(() => 2)
    lease.joinBatch = vi.fn(async () => {
      throw new Error("partition state read failed")
    })
    leaseController.lease = lease
    const calls: string[] = []
    const leaseStamper = makeStamper(calls, "lease", BATCH_ID_2)
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(leaseStamper),
        mode: "oneshot",
        readLeaseCache: () => ({
          deviceId: SELF,
          batchId: BATCH_ID,
          self: {
            partition: 2,
            generation: { timestampMs: NOW, tiebreaker: SELF },
            acquiredAt: NOW,
            leasedUntil: Date.now() + LEASE_TTL_MS,
          },
        }),
      }),
    )

    await coordinator.withWrite(asStamper(leaseStamper), async () => "ok", {
      wait: "block",
    })

    expect(lease.acquire).toHaveBeenCalledTimes(1)
    expect(coordinator.currentPartition).toBe(2)
  })

  it("re-joins persisted batches after a COLD acquire, seeding from the NETWORK", async () => {
    // The cached lease was not adoptable (lapsed, or the lease batch changed),
    // so a peer may have held the partition meanwhile and advanced these
    // batches past our local state — local seeding could later full-publish a
    // LOWER counter over the peer's resume point. The restore must go through
    // `joinBatch` (a real partition-state read), and must skip the id that is
    // the CURRENT lease batch (bound by the acquire itself).
    const networkCounter = new Uint32Array(8)
    networkCounter[3] = 7
    const lease = makeLease({
      acquireResult: {
        partition: 1,
        partitionCount: 4,
        localCounter: new Uint32Array(8),
        isReadOnly: false,
      },
      leasedUntil: Date.now() + LEASE_TTL_MS,
    })
    lease.joinBatch = vi.fn(async () => networkCounter)
    leaseController.lease = lease
    const calls: string[] = []
    const leaseStamper = makeStamper(calls, "lease")
    const secondary = makeStamper(calls, "b2", BATCH_ID_2)
    const writes: unknown[] = []
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(leaseStamper),
        mode: "oneshot",
        readLeaseCache: () => ({
          deviceId: SELF,
          batchId: BATCH_ID,
          self: undefined, // not adoptable → cold acquire
          // The writing session's list includes ITS lease batch (BATCH_ID) —
          // here that is still the lease batch, so only BATCH_ID_2 restores.
          joinedBatchIds: [BATCH_ID, BATCH_ID_2],
        }),
        writeLeaseCache: (snap) => writes.push(snap),
        resolveStamperForBatch: async () => asStamper(secondary),
      }),
    )
    const internals = coordinator as unknown as Internals

    await coordinator.withWrite(asStamper(leaseStamper), async () => "ok", {
      wait: "block",
    })
    await coordinator.joinedRestoreSettled

    expect(lease.joinBatch).toHaveBeenCalledTimes(1)
    expect(lease.joinBatch).toHaveBeenCalledWith(asStamper(secondary))
    expect(secondary.bindPartition).toHaveBeenCalledWith(
      expect.objectContaining({ partition: 1, localCounter: networkCounter }),
    )
    expect(internals.joinedSecondaries.get(BATCH_ID_2)).toBe(
      asStamper(secondary),
    )
    // The restore re-persists the snapshot so a SECOND reload inside the next
    // refresh tick's window doesn't lose the joined list again.
    expect(writes.length).toBeGreaterThanOrEqual(2)
  })

  it("does not clobber a batch a targeted write joined while the restore was resolving", async () => {
    const lease = makeLease({ partition: 2 })
    lease.adoptIfLive = vi.fn(() => 2)
    leaseController.lease = lease
    const calls: string[] = []
    const leaseStamper = makeStamper(calls, "lease")
    // The write's instance (fresh network join + publish) vs the restore's.
    const writeStamper = makeStamper(calls, "write", BATCH_ID_2)
    const restoreStamper = makeStamper(calls, "restore", BATCH_ID_2)
    let releaseResolve: (() => void) | undefined
    const gate = new Promise<void>((r) => (releaseResolve = r))
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(leaseStamper),
        mode: "oneshot",
        readLeaseCache: () => ({
          deviceId: SELF,
          batchId: BATCH_ID,
          self: {
            partition: 2,
            generation: { timestampMs: NOW, tiebreaker: SELF },
            acquiredAt: NOW,
            leasedUntil: Date.now() + LEASE_TTL_MS,
          },
          joinedBatchIds: [BATCH_ID_2],
        }),
        resolveStamperForBatch: async () => {
          await gate
          return asStamper(restoreStamper)
        },
      }),
    )
    const internals = coordinator as unknown as Internals

    // First write kicks off the adopt (and the gated restore)…
    await coordinator.withWrite(asStamper(leaseStamper), async () => "ok", {
      wait: "block",
    })
    // …then a targeted write joins BATCH_ID_2 properly (fresh read + publish).
    await coordinator.withWrite(asStamper(writeStamper), async () => "ok", {
      wait: "block",
    })
    lease.seedReferenceHex.mockClear()

    // The straggling restore must yield: committing its pre-publish state now
    // would regress the heartbeat pointer below what the write acked.
    releaseResolve!()
    await coordinator.joinedRestoreSettled

    expect(restoreStamper.bindPartition).not.toHaveBeenCalled()
    expect(lease.seedReferenceHex).not.toHaveBeenCalledWith(
      expect.anything(),
      asStamper(restoreStamper),
    )
    expect(internals.joinedSecondaries.get(BATCH_ID_2)).toBe(
      asStamper(writeStamper),
    )
  })

  it("does not re-join a batch a targeted write joined while a NETWORK restore was resolving", async () => {
    // The network-path twin of the test above. `joinBatch` is not just a read:
    // it seeds the lease's per-batch publish baseline and heartbeat pointer
    // from ITS read the moment it resolves. A restore whose read lands after a
    // targeted write's join + publish would overwrite that batch's state with
    // pre-publish values — every later heartbeat then republishes the STALE
    // pointer, and a takeover following it resumes below the acked counter.
    // So once the batch is joined, the restore must not call `joinBatch` at
    // all — not merely skip the bind afterwards.
    const lease = makeLease({
      acquireResult: {
        partition: 1,
        partitionCount: 4,
        localCounter: new Uint32Array(8),
        isReadOnly: false,
      },
      leasedUntil: Date.now() + LEASE_TTL_MS,
    })
    leaseController.lease = lease
    const calls: string[] = []
    const leaseStamper = makeStamper(calls, "lease")
    const writeStamper = makeStamper(calls, "write", BATCH_ID_2)
    const restoreStamper = makeStamper(calls, "restore", BATCH_ID_2)
    let releaseResolve: (() => void) | undefined
    const gate = new Promise<void>((r) => (releaseResolve = r))
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(leaseStamper),
        mode: "oneshot",
        readLeaseCache: () => ({
          deviceId: SELF,
          batchId: BATCH_ID,
          self: undefined, // not adoptable → cold acquire → NETWORK restore
          joinedBatchIds: [BATCH_ID_2],
        }),
        resolveStamperForBatch: async () => {
          await gate
          return asStamper(restoreStamper)
        },
      }),
    )
    const internals = coordinator as unknown as Internals

    // First write kicks off the cold acquire (and the gated restore)…
    await coordinator.withWrite(asStamper(leaseStamper), async () => "ok", {
      wait: "block",
    })
    // …then a targeted write joins BATCH_ID_2 properly (fresh read + publish).
    await coordinator.withWrite(asStamper(writeStamper), async () => "ok", {
      wait: "block",
    })
    expect(lease.joinBatch).toHaveBeenCalledTimes(1) // the write's join

    releaseResolve!()
    await coordinator.joinedRestoreSettled

    expect(lease.joinBatch).toHaveBeenCalledTimes(1) // no straggler re-join
    expect(restoreStamper.bindPartition).not.toHaveBeenCalled()
    expect(internals.joinedSecondaries.get(BATCH_ID_2)).toBe(
      asStamper(writeStamper),
    )
  })

  it("keeps a batch whose restore failed in the snapshot and retries it on the refresh tick", async () => {
    // `serialize()` only knows successfully seeded batches, so a transient
    // resolver failure (e.g. the account store momentarily unreadable) must
    // not let the next persisted snapshot drop the batch id — a second reload
    // would then never attempt it again and its state pointer would age out
    // of the takeover lookup span (resume-from-zero for peers). The id stays
    // in every persisted snapshot and the refresh tick retries the restore.
    const networkCounter = new Uint32Array(8)
    networkCounter[3] = 7
    const lease = makeLease({
      acquireResult: {
        partition: 1,
        partitionCount: 4,
        localCounter: new Uint32Array(8),
        isReadOnly: false,
      },
      leasedUntil: Date.now() + LEASE_TTL_MS,
    })
    lease.joinBatch = vi.fn(async () => networkCounter)
    leaseController.lease = lease
    const calls: string[] = []
    const leaseStamper = makeStamper(calls, "lease")
    const secondary = makeStamper(calls, "b2", BATCH_ID_2)
    const writes: unknown[] = []
    let resolverHealthy = false
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(leaseStamper),
        mode: "oneshot",
        readLeaseCache: () => ({
          deviceId: SELF,
          batchId: BATCH_ID,
          self: undefined, // not adoptable → cold acquire
          joinedBatchIds: [BATCH_ID_2],
        }),
        writeLeaseCache: (snap) => writes.push(snap),
        resolveStamperForBatch: async () =>
          resolverHealthy ? asStamper(secondary) : undefined,
      }),
    )
    const internals = coordinator as unknown as Internals

    await coordinator.withWrite(asStamper(leaseStamper), async () => "ok", {
      wait: "block",
    })
    await coordinator.joinedRestoreSettled

    // Transient failure: nothing joined, but the id survives in the snapshot.
    expect(internals.joinedSecondaries.size).toBe(0)
    const last = writes.at(-1) as { joinedBatchIds?: string[] } | undefined
    expect(last?.joinedBatchIds).toContain(BATCH_ID_2)

    // The refresh tick retries once the resolver recovers.
    resolverHealthy = true
    await internals.refreshTick(lease)
    await coordinator.joinedRestoreSettled

    expect(lease.joinBatch).toHaveBeenCalledWith(asStamper(secondary))
    expect(internals.joinedSecondaries.get(BATCH_ID_2)).toBe(
      asStamper(secondary),
    )
  })
})

describe("BatchWriteCoordinator — state-pointer heartbeat vs in-flight upload", () => {
  // The refresh tick runs OFF the write lock; `withWrite`'s publish (which also
  // calls `writeStatePointer`) holds it. Both go through the stamper's single
  // `intentSoc` slot, so an off-lock heartbeat firing while an upload's publish
  // is in flight clobbers that reservation and mis-stamps a pointer SOC into a
  // data slot. The tick must skip the heartbeat while an upload is in flight —
  // the concurrent publish already refreshes the pointer to the current bucket.
  it("does NOT heartbeat the state pointer while an upload is in flight", async () => {
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
      }),
    )
    const internals = coordinator as unknown as Internals
    const lease = makeLease({ partition: 0 })
    internals.partitionLease = lease
    internals.activeUploadCount = 1 // an upload is in flight (publish may run)
    internals.lastLeaseActivityAt = Date.now() // recent → no idle-yield

    await internals.refreshTick(lease)

    expect(lease.heartbeatStatePointer).not.toHaveBeenCalled()
  })

  it("heartbeats the state pointer when alive and no upload is in flight", async () => {
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
      }),
    )
    const internals = coordinator as unknown as Internals
    const lease = makeLease({ partition: 0 })
    internals.partitionLease = lease
    internals.activeUploadCount = 0
    internals.lastLeaseActivityAt = Date.now() // recent → no idle-yield, reach tail

    await internals.refreshTick(lease)

    expect(lease.heartbeatStatePointer).toHaveBeenCalledTimes(1)
  })

  it("does NOT heartbeat when an upload slips in while the tick queues on the lock", async () => {
    // The outer `activeUploadCount === 0` gate is a TOCTOU: an upload can start
    // AFTER the gate passes and run its publish concurrently with an off-lock
    // heartbeat, clobbering the shared `intentSoc` slot. The heartbeat must run
    // UNDER the write lock and re-check the count once granted, so an upload that
    // slipped in aborts it (the concurrent publish already refreshes the pointer).
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
      }),
    )
    const internals = coordinator as unknown as Internals
    const lease = makeLease({ partition: 0 })
    internals.partitionLease = lease
    internals.activeUploadCount = 0 // passes the outer gate
    internals.lastLeaseActivityAt = Date.now() // recent → reach the heartbeat tail

    // An upload enters `withWrite` (bumping the count) in the window between the
    // tick's outer gate and the heartbeat winning the lock. Only an under-lock
    // re-check catches it.
    writeLockController.onGrant = () => {
      internals.activeUploadCount = 1
    }
    try {
      await internals.refreshTick(lease)
    } finally {
      writeLockController.onGrant = undefined
    }

    expect(lease.heartbeatStatePointer).not.toHaveBeenCalled()
  })
})

describe("BatchWriteCoordinator — self-demote on un-renewed lease expiry", () => {
  // A refresh tick that could NOT renew on Swarm (transient throw, or a "lost"
  // with no confirmable peer) must not extend the local lease forever. Once the
  // lease lapses past skew the holder can no longer assert it holds the slot —
  // it must fence in-flight writes (invalidate) and demote, or a stale holder's
  // long upload keeps clobbering a new holder's acked slots (only the ack is
  // guarded post-op, not the writes already made).
  it("a lapsed lease whose renewal keeps failing fences writes and demotes", async () => {
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
      }),
    )
    const internals = coordinator as unknown as Internals
    const lease = makeLease({ partition: 0, leasedUntil: Date.now() - 1 })
    lease.refresh = vi.fn(async () => {
      throw new Error("gateway 500")
    }) as typeof lease.refresh
    internals.partitionLease = lease
    internals.activeUploadCount = 1 // an upload is in flight; skip idle-yield
    internals.lastLeaseActivityAt = Date.now()
    lockController.payload = undefined // no confirmable foreign holder

    await internals.refreshTick(lease)

    expect(stamper.invalidateLease).toHaveBeenCalled() // in-flight stamp aborts
    expect(coordinator.isReadOnly).toBe(true) // demoted
    expect(lease.bumpLocalLease).not.toHaveBeenCalled() // never extended
  })

  it("a within-TTL transient blip keeps the lease but does NOT extend it", async () => {
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
      }),
    )
    const internals = coordinator as unknown as Internals
    // Lease still comfortably within TTL — a single failed renewal is tolerated.
    const lease = makeLease({ partition: 0, leasedUntil: Date.now() + 10_000 })
    lease.refresh = vi.fn(async () => {
      throw new Error("gateway 500")
    }) as typeof lease.refresh
    internals.partitionLease = lease
    internals.activeUploadCount = 1
    internals.lastLeaseActivityAt = Date.now()
    lockController.payload = undefined

    await internals.refreshTick(lease)

    expect(stamper.invalidateLease).not.toHaveBeenCalled()
    expect(coordinator.isReadOnly).toBe(false)
    expect(coordinator.currentPartition).toBe(0)
    // Not renewed on Swarm → the local lease must NOT be bumped (it counts down
    // from the last successful renewal until it genuinely lapses).
    expect(lease.bumpLocalLease).not.toHaveBeenCalled()
  })
})

describe("BatchWriteCoordinator — self-demote on persistently failing pointer heartbeats", () => {
  // The state-pointer heartbeat is what keeps a takeover able to FIND the
  // resume point: the pointer lookup scans only ~(LEASE_TTL + slack) of buckets
  // below the lock's `leasedUntil`, while lock renewals extend `leasedUntil`
  // indefinitely and are independent of the (best-effort) heartbeat. A holder
  // whose heartbeats keep failing while its lock keeps renewing walks its last
  // durable pointer out of the lookup span — a takeover then finds NO pointer
  // on a clean scan and zero-seeds, re-issuing every acked slot. Once the
  // failure streak exceeds one pointer epoch the holder must stop holding
  // (demote; the next upload re-acquires and re-publishes) instead of letting
  // the gap grow toward the scan floor.
  function setupFailingHeartbeat() {
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
      }),
    )
    const internals = coordinator as unknown as Internals
    const lease = makeLease({ partition: 0, leasedUntil: Date.now() + 30_000 })
    lease.heartbeatStatePointer = vi.fn(async () => {
      throw new Error("gateway 500")
    }) as typeof lease.heartbeatStatePointer
    internals.partitionLease = lease
    internals.activeUploadCount = 0 // idle → the tick attempts the heartbeat
    internals.lastLeaseActivityAt = Date.now() // recent → no idle-yield
    return { coordinator, internals, lease, stamper }
  }

  it("keeps the lease on a fresh heartbeat-failure streak", async () => {
    const { coordinator, internals, lease, stamper } = setupFailingHeartbeat()

    await internals.refreshTick(lease)

    expect(stamper.invalidateLease).not.toHaveBeenCalled()
    expect(coordinator.isReadOnly).toBe(false)
    expect(coordinator.currentPartition).toBe(0)
    // The streak is armed so a persisting failure can demote later.
    expect(internals.pointerHeartbeatFailingSince).toBeDefined()
  })

  it("demotes once the heartbeat-failure streak exceeds one pointer epoch", async () => {
    const { coordinator, internals, lease, stamper } = setupFailingHeartbeat()

    // The streak started more than one pointer epoch ago and the heartbeat is
    // still failing on this tick.
    internals.pointerHeartbeatFailingSince =
      Date.now() - (STATE_POINTER_EPOCH_MS + 1)
    await internals.refreshTick(lease)

    expect(stamper.invalidateLease).toHaveBeenCalled() // in-flight stamp fence
    expect(coordinator.isReadOnly).toBe(true) // demoted
    expect(coordinator.currentPartition).toBeUndefined()
  })

  it("a failing SECONDARY heartbeat never demotes the account lease", async () => {
    // The fan-out heartbeats every joined batch. One sick batch (e.g. expired
    // on-chain) must not take the whole account's write path down: the demote
    // streak protects the LEASE batch's pointer, and teardown/idle-yield treat
    // per-batch flushes as best-effort — the tick must too.
    const calls: string[] = []
    const leaseStamper = makeStamper(calls, "lease")
    const sick = makeStamper(calls, "sick", BATCH_ID_2)
    const coordinator = new BatchWriteCoordinator(
      makeDeps({ leaseStamper: asStamper(leaseStamper) }),
    )
    const internals = coordinator as unknown as Internals
    const lease = makeLease({ partition: 0, leasedUntil: Date.now() + 30_000 })
    lease.heartbeatStatePointer = vi.fn(async (_c?: unknown, ctx?: unknown) => {
      if (ctx) throw new Error("batch expired on-chain")
    }) as typeof lease.heartbeatStatePointer
    internals.partitionLease = lease
    internals.activeUploadCount = 0
    internals.lastLeaseActivityAt = Date.now()
    internals.joinedSecondaries.set(BATCH_ID_2, asStamper(sick))
    // Even with a long-armed global streak, a healthy LEASE heartbeat clears it.
    internals.pointerHeartbeatFailingSince =
      Date.now() - (STATE_POINTER_EPOCH_MS + 1)

    await internals.refreshTick(lease)

    expect(coordinator.isReadOnly).toBe(false)
    expect(coordinator.currentPartition).toBe(0)
    expect(leaseStamper.invalidateLease).not.toHaveBeenCalled()
    expect(internals.pointerHeartbeatFailingSince).toBeUndefined()
  })

  it("evicts a persistently failing secondary instead of demoting", async () => {
    const calls: string[] = []
    const leaseStamper = makeStamper(calls, "lease")
    const sick = makeStamper(calls, "sick", BATCH_ID_2)
    const coordinator = new BatchWriteCoordinator(
      makeDeps({ leaseStamper: asStamper(leaseStamper) }),
    )
    const internals = coordinator as unknown as Internals
    const lease = makeLease({ partition: 0, leasedUntil: Date.now() + 30_000 })
    lease.heartbeatStatePointer = vi.fn(async (_c?: unknown, ctx?: unknown) => {
      if (ctx) throw new Error("batch expired on-chain")
    }) as typeof lease.heartbeatStatePointer
    internals.partitionLease = lease
    internals.activeUploadCount = 0
    internals.lastLeaseActivityAt = Date.now()
    internals.joinedSecondaries.set(BATCH_ID_2, asStamper(sick))

    // First failing tick arms the per-batch streak but keeps the batch joined.
    await internals.refreshTick(lease)
    expect(internals.joinedSecondaries.has(BATCH_ID_2)).toBe(true)

    // Streak older than one pointer epoch + still failing → evict the batch,
    // fencing its in-flight stamps like a lease loss would (invalidate first).
    internals.secondaryHeartbeatFailingSince.set(
      BATCH_ID_2,
      Date.now() - (STATE_POINTER_EPOCH_MS + 1),
    )
    await internals.refreshTick(lease)

    expect(internals.joinedSecondaries.has(BATCH_ID_2)).toBe(false)
    expect(sick.invalidateLease).toHaveBeenCalled()
    expect(sick.unbindPartition).toHaveBeenCalled()
    // The account lease is untouched.
    expect(coordinator.isReadOnly).toBe(false)
    expect(coordinator.currentPartition).toBe(0)
  })

  it("a successful heartbeat resets the failure streak", async () => {
    const { coordinator, internals, lease } = setupFailingHeartbeat()
    lease.heartbeatStatePointer = vi.fn(
      async () => {},
    ) as typeof lease.heartbeatStatePointer
    // A previous tick's failure armed the streak; this tick's success must
    // clear it so an unrelated later failure starts a fresh streak.
    internals.pointerHeartbeatFailingSince = Date.now() - 10_000

    await internals.refreshTick(lease)

    expect(internals.pointerHeartbeatFailingSince).toBeUndefined()
    expect(coordinator.isReadOnly).toBe(false)
  })
})

describe("BatchWriteCoordinator — upload publish resets the heartbeat streak", () => {
  // An upload's commit publish (`publishState`) durably re-writes the state
  // pointer to the current bucket — exactly what a successful heartbeat does. A
  // failure streak armed during an idle blip must therefore be cleared by a
  // successful upload publish; otherwise the streak keeps counting from the old
  // (now-stale) timestamp across the fresh publish and can demote a healthy
  // holder prematurely (measuring drift the upload already repaired).
  it("clears pointerHeartbeatFailingSince after a successful publish", async () => {
    leaseController.lease = makeLease({
      acquireResult: {
        partition: 1,
        partitionCount: 4,
        localCounter: new Uint32Array(8),
        isReadOnly: false,
      },
      leasedUntil: Date.now() + LEASE_TTL_MS, // stays throttled post-op
    })
    const stamper = makeStamper([])
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        mode: "oneshot", // no refresh timer to leak
      }),
    )
    const internals = coordinator as unknown as Internals

    // First write establishes the held lease (acquire resets the streak).
    await coordinator.withWrite(asStamper(stamper), async () => "ok", {
      wait: "block",
    })
    // An idle heartbeat blip armed the streak more than one epoch ago.
    internals.pointerHeartbeatFailingSince =
      Date.now() - (STATE_POINTER_EPOCH_MS + 1)

    // A second write publishes the pointer afresh — this must clear the streak.
    await coordinator.withWrite(asStamper(stamper), async () => "ok", {
      wait: "block",
    })

    expect(internals.pointerHeartbeatFailingSince).toBeUndefined()
  })
})

describe("BatchWriteCoordinator — acquire-epoch guard", () => {
  it("a late-completing acquire does not resurrect a cleared lease", async () => {
    const calls: string[] = []
    const stamper = makeStamper(calls)
    let resolveAcquire!: (r: {
      partition: number
      partitionCount: number
      localCounter: Uint32Array
      isReadOnly: boolean
    }) => void
    const lease = makeLease()
    lease.acquire = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveAcquire = resolve
        }),
    ) as typeof lease.acquire
    leaseController.lease = lease
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        mode: "oneshot",
      }),
    )
    const internals = coordinator as unknown as Internals

    const inFlight = internals.acquire()
    // Let the acquire get in flight (reach the pending lease.acquire call).
    await vi.waitFor(() => expect(lease.acquire).toHaveBeenCalled())
    // The acquire timeout fires: ensureLease pauses background work, which
    // bumps the epoch. The still-running acquire must then discard its result.
    internals.pauseLeaseBackgroundWork()
    resolveAcquire({
      partition: 1,
      partitionCount: 4,
      localCounter: new Uint32Array(8),
      isReadOnly: false,
    })
    await inFlight

    expect(stamper.bindPartition).not.toHaveBeenCalled()
    expect(coordinator.currentPartition).toBeUndefined()
    expect(coordinator.isReadOnly).toBe(false)
  })

  it("a late-failing acquire does not clobber a newer lease's state", async () => {
    const calls: string[] = []
    const stamper = makeStamper(calls)
    let rejectAcquire!: (e: Error) => void
    const staleLease = makeLease()
    staleLease.acquire = vi.fn(
      () =>
        new Promise((_, reject) => {
          rejectAcquire = reject
        }),
    ) as typeof staleLease.acquire
    leaseController.lease = staleLease
    const writeLeaseCache = vi.fn()
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        mode: "oneshot",
        writeLeaseCache,
      }),
    )
    const internals = coordinator as unknown as Internals

    const inFlight = internals.acquire()
    await vi.waitFor(() => expect(staleLease.acquire).toHaveBeenCalled())
    // The acquire timeout fires: ensureLease pauses background work, which
    // bumps the epoch and detaches the still-pending acquire.
    internals.pauseLeaseBackgroundWork()

    // A later write re-acquires successfully — a new live lease owns the state.
    const liveLease = makeLease({
      acquireResult: {
        partition: 1,
        partitionCount: 4,
        localCounter: new Uint32Array(8),
        isReadOnly: false,
      },
    })
    leaseController.lease = liveLease
    await internals.acquire()
    expect(coordinator.currentPartition).toBe(1)
    writeLeaseCache.mockClear()

    // The detached acquire finally rejects. The failure must propagate, but
    // it must NOT clear the live lease's in-memory state or wipe its cache.
    rejectAcquire(new Error("lock SOC scan failed"))
    await expect(inFlight).rejects.toThrow("lock SOC scan failed")

    expect(coordinator.currentPartition).toBe(1)
    expect(internals.partitionLease).toBe(liveLease)
    expect(writeLeaseCache).not.toHaveBeenCalledWith(undefined)
  })
})

describe("BatchWriteCoordinator — stale refresh-tick guards", () => {
  it("a tick whose refresh straddles teardown does not resurrect the lease cache", async () => {
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const writeLeaseCache = vi.fn()
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        writeLeaseCache,
      }),
    )
    const internals = coordinator as unknown as Internals

    // Held lease whose refresh is pending when teardown lands.
    let resolveRefresh!: (ok: boolean) => void
    const lease = makeLease({ partition: 0 })
    lease.refresh = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRefresh = resolve
        }),
    ) as typeof lease.refresh
    internals.partitionLease = lease
    internals.lastLeaseActivityAt = Date.now()
    internals.activeUploadCount = 1 // skip the idle-yield branch

    const tick = internals.refreshTick(lease)
    await vi.waitFor(() => expect(lease.refresh).toHaveBeenCalled())

    // Sign-out mid-tick: clears state and the cache.
    coordinator.teardown()
    writeLeaseCache.mockClear()

    resolveRefresh(true)
    await tick

    // The stale tick's tail must not re-write a live-looking snapshot into
    // the cache (a future acquire would hydrate + adoptIfLive it without any
    // Swarm round-trip) nor bump the local heartbeat.
    expect(writeLeaseCache).not.toHaveBeenCalled()
    expect(lease.bumpLocalLease).not.toHaveBeenCalled()
  })

  it("a displaced tick that lost the lock race does not demote a re-acquired lease", async () => {
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const writeLeaseCache = vi.fn()
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(stamper),
        writeLeaseCache,
      }),
    )
    const internals = coordinator as unknown as Internals

    // Lease A on partition 0: refresh fails, lock SOC names a live peer →
    // the tick confirms displacement and queues finalizeDemote on the lock.
    const leaseA = makeLease({ partition: 0, refreshResult: "lost" })
    internals.partitionLease = leaseA
    internals.lastLeaseActivityAt = Date.now()
    internals.activeUploadCount = 1 // skip the idle-yield branch
    lockController.payload = {
      holderDeviceId: PEER,
      leasedUntil: Date.now() + 10_000,
    }

    // While the tick queues on the write lock, a withWrite already demoted and
    // re-acquired lease B on another partition.
    const leaseB = makeLease({ partition: 1 })
    writeLockController.onGrant = () => {
      internals.partitionLease = leaseB
      internals.readOnly = false
    }
    try {
      await internals.refreshTick(leaseA)
    } finally {
      writeLockController.onGrant = undefined
    }

    // The stale demote must be skipped: lease B keeps its partition, its
    // stamper binding, and its cache; the coordinator does not flip read-only.
    expect(stamper.unbindPartition).not.toHaveBeenCalled()
    expect(coordinator.currentPartition).toBe(1)
    expect(coordinator.isReadOnly).toBe(false)
    expect(writeLeaseCache).not.toHaveBeenCalledWith(undefined)
  })
})

describe("BatchWriteCoordinator — acquire failure cleanup", () => {
  it("a consumer callback throwing after bind unwinds the stamper and the timer", async () => {
    vi.useFakeTimers()
    try {
      const calls: string[] = []
      const stamper = makeStamper(calls)
      const lease = makeLease({
        acquireResult: {
          partition: 1,
          partitionCount: 4,
          localCounter: new Uint32Array(8),
          isReadOnly: false,
        },
      })
      leaseController.lease = lease
      const coordinator = new BatchWriteCoordinator(
        makeDeps({
          leaseStamper: asStamper(stamper),
          mode: "persistent", // arms the refresh timer before onLeaseAcquired
          onLeaseAcquired: () => {
            throw new Error("consumer callback exploded")
          },
        }),
      )
      const internals = coordinator as unknown as Internals

      await expect(internals.acquire()).rejects.toThrow(
        "consumer callback exploded",
      )

      // The partial commit is unwound: breaker armed before unbind, no lease
      // record left behind.
      expect(calls).toEqual(["bind", "invalidate", "unbind"])
      expect(coordinator.currentPartition).toBeUndefined()

      // And the refresh interval armed before the throw must not leak.
      await vi.advanceTimersByTimeAsync(LEASE_TTL_MS * 2)
      expect(lease.refresh).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("BatchWriteCoordinator — slot-wait epoch exit", () => {
  it("does not claim again after the acquire timeout paused background work", async () => {
    vi.useFakeTimers()
    try {
      const calls: string[] = []
      const stamper = makeStamper(calls)
      // Every acquire completes read-only (all partitions held by live peers),
      // so the slot-wait loop polls.
      const lease = makeLease()
      leaseController.lease = lease
      const coordinator = new BatchWriteCoordinator(
        makeDeps({
          leaseStamper: asStamper(stamper),
          mode: "oneshot",
        }),
      )
      const internals = coordinator as unknown as Internals

      const inFlight = internals.acquireWithSlotWait()
      await vi.advanceTimersByTimeAsync(0)
      expect(lease.acquire).toHaveBeenCalledTimes(1)

      // The 45s race timeout fires while the loop sleeps between polls.
      internals.pauseLeaseBackgroundWork()

      // Wake the loop past its poll sleep: it must exit without another
      // lock-SOC claim (a fresh acquire would commit under the new epoch).
      await vi.advanceTimersByTimeAsync(LEASE_REFRESH_MS * 3)
      await inFlight
      expect(lease.acquire).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("BatchWriteCoordinator — per-write batch targeting (account-scoped lease)", () => {
  function heldLease() {
    return makeLease({
      acquireResult: {
        partition: 1,
        partitionCount: 4,
        localCounter: new Uint32Array(8),
        isReadOnly: false,
      },
      // Comfortably valid so post-op freshness checks stay throttled.
      leasedUntil: Date.now() + LEASE_TTL_MS,
    })
  }

  async function setupJoined(
    overrides: Partial<BatchWriteCoordinatorDeps> = {},
  ) {
    const calls: string[] = []
    const lease = heldLease()
    leaseController.lease = lease
    const leaseStamper = makeStamper(calls, "lease")
    const target2 = makeStamper(calls, "b2", BATCH_ID_2)
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        leaseStamper: asStamper(leaseStamper),
        mode: "oneshot", // no refresh timer to leak in tests
        ...overrides,
      }),
    )
    await coordinator.withWrite(asStamper(target2), async () => "ok", {
      wait: "block",
    })
    return { calls, lease, leaseStamper, target2, coordinator }
  }

  it("joins a second batch once, binds it to the SAME partition, and publishes with its stamper", async () => {
    const { lease, leaseStamper, target2, coordinator } = await setupJoined()

    // The account lease was acquired once, under the lease stamper.
    expect(leaseStamper.bindPartition).toHaveBeenCalledWith(
      expect.objectContaining({ partition: 1 }),
    )
    // The targeted batch joined the SAME partition — no lock activity of its own.
    expect(lease.joinBatch).toHaveBeenCalledTimes(1)
    expect(lease.joinBatch).toHaveBeenCalledWith(asStamper(target2))
    expect(target2.bindPartition).toHaveBeenCalledWith(
      expect.objectContaining({ partition: 1, partitionCount: 4 }),
    )
    expect(target2.setLeaseValidUntil).toHaveBeenCalled()
    // The commit publish routed the WRITE's counter with the WRITE's stamper.
    expect(lease.publishState).toHaveBeenLastCalledWith(
      expect.any(Uint32Array),
      asStamper(target2),
    )

    // A second targeted write reuses the join (no re-join), and a lease-batch
    // write never joins.
    await coordinator.withWrite(asStamper(target2), async () => "ok", {
      wait: "block",
    })
    await coordinator.withWrite(asStamper(leaseStamper), async () => "ok", {
      wait: "block",
    })
    expect(lease.joinBatch).toHaveBeenCalledTimes(1)
    // Zero teardown/release churn across the batch alternation.
    expect(lease.release).not.toHaveBeenCalled()
  })

  it("joins a REBUILT lease-batch stamper instead of stamping it unbound", async () => {
    const calls: string[] = []
    const lease = heldLease()
    leaseController.lease = lease
    const leaseStamper = makeStamper(calls, "lease")
    const coordinator = new BatchWriteCoordinator(
      makeDeps({ leaseStamper: asStamper(leaseStamper), mode: "oneshot" }),
    )
    // The proxy rebuilt the DEFAULT batch's stamper (a failed create left the
    // old coordinator alive, so `resolveUploadStamper` built a fresh instance
    // for the same batch id). Matching on batch id alone would skip the join
    // and hand an UNBOUND stamper to the write, whose `stamp()` falls back to
    // partition 0's slot lane and corrupts a peer's slots.
    const rebuilt = makeStamper(calls, "rebuilt", BATCH_ID)
    await coordinator.withWrite(asStamper(rebuilt), async () => "ok", {
      wait: "block",
    })

    expect(lease.joinBatch).toHaveBeenCalledWith(asStamper(rebuilt))
    expect(rebuilt.bindPartition).toHaveBeenCalledWith(
      expect.objectContaining({ partition: 1, partitionCount: 4 }),
    )
    expect(calls).toContain("rebuilt:bind")
  })

  it("takes the write lock under the ACCOUNT key, nesting the legacy per-batch keys", async () => {
    await setupJoined()
    expect(writeLockController.lastKey).toBe("acct-1")
    // Rollover transition guard: the legacy `swarm-write-<batchId>` locks for
    // every batch this write may stamp under — the lease batch AND the
    // targeted batch — so a pre-account-scoped tab is still excluded.
    expect(writeLockController.lastLegacyIds).toEqual(
      expect.arrayContaining([BATCH_ID, BATCH_ID_2]),
    )
  })

  it("flushes BOTH the write's stamper and the lease stamper after a targeted write", async () => {
    const flushStamperState = vi.fn(async () => {})
    const { leaseStamper, target2 } = await setupJoined({ flushStamperState })
    expect(flushStamperState).toHaveBeenCalledWith(asStamper(leaseStamper))
    expect(flushStamperState).toHaveBeenCalledWith(asStamper(target2))
  })

  it("a lease-loss fans invalidate/unbind out over EVERY joined stamper (invalidate-all first)", async () => {
    const { calls, lease, coordinator } = await setupJoined()
    const internals = coordinator as unknown as {
      refreshTick: (lease: unknown) => Promise<void>
      lastLeaseActivityAt: number
      activeUploadCount: number
    }
    lease.refresh = vi.fn(async () => "displaced") as typeof lease.refresh
    internals.lastLeaseActivityAt = Date.now()
    internals.activeUploadCount = 1 // skip the idle-yield branch
    calls.splice(0)

    await internals.refreshTick(lease)

    // An in-flight stamp on EITHER batch aborts before any unbind resets the
    // breaker: all invalidates strictly precede all unbinds.
    expect(calls).toEqual([
      "lease:invalidate",
      "b2:invalidate",
      "lease:unbind",
      "b2:unbind",
    ])
  })

  it("re-joins a targeted batch after a demote + re-acquire (new lease session)", async () => {
    const { lease, target2, coordinator } = await setupJoined()
    const internals = coordinator as unknown as {
      signalLeaseLost: () => void
      finalizeDemote: () => void
    }
    internals.signalLeaseLost()
    internals.finalizeDemote()

    // The next targeted write re-acquires and must re-join (the new session
    // may hold a different partition; the join seeds against it afresh).
    await coordinator.withWrite(asStamper(target2), async () => "ok", {
      wait: "block",
    })
    expect(lease.joinBatch).toHaveBeenCalledTimes(2)
  })

  it("aborts a targeted write when the lease is signalled lost mid-join", async () => {
    // `refreshTick` signals lease-lost OFF the write lock; a write for a
    // not-yet-joined batch already holds the lock, so its stamper misses the
    // invalidate fan-out and `bindPartition` would reset the breaker
    // (`leaseStale = false`) on a partition a peer now owns. The join must
    // abort instead of binding.
    const calls: string[] = []
    const lease = heldLease()
    leaseController.lease = lease
    const leaseStamper = makeStamper(calls, "lease")
    const target2 = makeStamper(calls, "b2", BATCH_ID_2)
    let releaseJoin!: (counter: Uint32Array) => void
    lease.joinBatch = vi.fn(
      () =>
        new Promise<Uint32Array>((resolve) => {
          releaseJoin = resolve
        }),
    ) as typeof lease.joinBatch
    const coordinator = new BatchWriteCoordinator(
      makeDeps({ leaseStamper: asStamper(leaseStamper), mode: "oneshot" }),
    )
    const op = vi.fn(async () => "ok")
    const inFlight = coordinator.withWrite(asStamper(target2), op, {
      wait: "block",
    })
    await vi.waitFor(() => expect(lease.joinBatch).toHaveBeenCalledTimes(1))

    // Displacement confirmed while the join is in flight (fanned out over the
    // lease stamper only — target2 is not in `joinedSecondaries` yet).
    ;(
      coordinator as unknown as { signalLeaseLost: () => void }
    ).signalLeaseLost()
    releaseJoin(new Uint32Array(8))

    await expect(inFlight).rejects.toThrow(PartitionLeaseLostError)
    expect(target2.bindPartition).not.toHaveBeenCalled()
    expect(op).not.toHaveBeenCalled()
  })

  it("teardown publishes each joined batch's final counter before the release sentinel", async () => {
    const { calls, lease, target2, coordinator } = await setupJoined()
    calls.splice(0)
    lease.publishState = vi.fn(async (_c: Uint32Array, s?: unknown) => {
      calls.push(s === asStamper(target2) ? "publish:b2" : "publish:lease")
    }) as typeof lease.publishState
    lease.release = vi.fn(async () => {
      calls.push("release")
    }) as typeof lease.release

    coordinator.teardown()
    await vi.waitFor(() => expect(lease.release).toHaveBeenCalledTimes(1))

    // A peer's takeover resumes EVERY batch at its acked counter: the joined
    // batch's state flushes before the sentinel frees the partition.
    expect(calls.indexOf("publish:b2")).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf("publish:b2")).toBeLessThan(calls.indexOf("release"))
  })
})
