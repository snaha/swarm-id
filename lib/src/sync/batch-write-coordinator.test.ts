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
// caller queued on the lock. Default is straight pass-through.
const writeLockController: { onGrant?: () => void } = {}
vi.mock("../utils/batch-write-lock", () => ({
  withBatchWriteLock: vi.fn(
    async (_key: string, op: () => Promise<unknown>) => {
      writeLockController.onGrant?.()
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
import { LEASE_REFRESH_MS, LEASE_TTL_MS } from "../utils/batch-utilization"

const SELF = "self-device"
const PEER = "peer-device"
const NOW = 1_000_000
// A valid 32-byte hex batch id (new BatchId(...) validates the hex).
const BATCH_ID = "ab".repeat(32)

/** A controllable stand-in for the bound stamper. Records the order of
 *  invalidate/unbind/bind so the race-fix ordering can be asserted. */
function makeStamper(calls: string[]) {
  return {
    depth: 20,
    invalidateLease: vi.fn(() => calls.push("invalidate")),
    unbindPartition: vi.fn(() => calls.push("unbind")),
    bindPartition: vi.fn(() => calls.push("bind")),
    setLeaseValidUntil: vi.fn(),
    buildLeaseLocalCounter: () => new Uint32Array(8),
    getLocalCounter: () => new Uint32Array(8),
    // Persisted per-partition synced reference; the adopt fast path reads it to
    // seed the lease's heartbeat pointer. Default: none (fresh partition).
    getSyncedReference: vi.fn(async (_partition: number) => undefined),
  }
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
    batchId: BATCH_ID,
    stamper: {} as BatchWriteCoordinatorDeps["stamper"],
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

  it("exposes the injected stamper", () => {
    const stamper = {
      tag: "the-stamper",
    } as unknown as BatchWriteCoordinatorDeps["stamper"]
    const coordinator = new BatchWriteCoordinator(makeDeps({ stamper }))
    expect(coordinator.stamperRef).toBe(stamper)
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
        mode: "oneshot", // no refresh timer to leak in the test
        flushStamperState,
        onLeaseAcquired,
      }),
    )

    const op = vi.fn(async (target: { mode: string }) => {
      expect(target.mode).toBe("stamper")
      return "ok"
    })
    const result = await coordinator.withWrite(op, { wait: "block" })

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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
        mode: "oneshot",
      }),
    )

    const op = vi.fn(async () => "ok")
    await expect(
      coordinator.withWrite(op, { wait: "skip" }),
    ).rejects.toBeInstanceOf(PartitionContendedError)
    expect(op).not.toHaveBeenCalled()
  })

  it("single-partition account: writes without a lease (no acquire)", async () => {
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
        partitionCount: 1,
        mode: "oneshot",
      }),
    )
    const op = vi.fn(async () => "ok")
    await expect(coordinator.withWrite(op, { wait: "skip" })).resolves.toBe(
      "ok",
    )
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
        mode: "oneshot",
      }),
    )

    const op = vi.fn(async () => {
      order.push("op")
      return "ref"
    })
    const result = await coordinator.withWrite(op, { wait: "block" })

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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
        mode: "oneshot",
      }),
    )

    const op = vi.fn(async () => "ref")
    await expect(coordinator.withWrite(op, { wait: "block" })).rejects.toThrow(
      "partition-state publish failed",
    )
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
        mode: "oneshot",
      }),
    )

    const op = vi.fn(async () => "ref")
    await expect(coordinator.withWrite(op, { wait: "block" })).rejects.toThrow(
      /local counter/,
    )
    expect(op).toHaveBeenCalledTimes(1)
    expect(lease.publishState).not.toHaveBeenCalled()
  })

  it("reverse-clobber guard: a lease that lapsed mid-upload is re-read; the upload throws and does NOT publish", async () => {
    const lease = held(0)
    leaseController.lease = lease
    const stamper = makeStamper([])
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
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

    await expect(coordinator.withWrite(op, { wait: "block" })).rejects.toThrow(
      /reclaimed/,
    )
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
        mode: "oneshot",
        refreshKnownDeviceIds,
      }),
    )

    const op = vi.fn(async () => "ok")
    await expect(coordinator.withWrite(op, { wait: "block" })).resolves.toBe(
      "ok",
    )
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
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
    const lease = makeLease({ partition: 1 })
    lease.release.mockImplementation(async () => {
      calls.push("release")
    })
    writeLockController.onGrant = () => calls.push("lock-granted")
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
        mode: "persistent",
      }),
    )

    // Simulate the disconnect/sign-out that lands before the in-flight write
    // reaches its lease check.
    coordinator.teardown()

    const op = vi.fn(async () => "ok")
    await expect(coordinator.withWrite(op, { wait: "block" })).rejects.toThrow(
      /torn down/,
    )
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
        mode: "oneshot",
      }),
    )

    const op = vi.fn(async () => "ok")
    // The caller (sync-account) must see the real error so it reports
    // status:"error" — not PartitionContendedError, which it logs as a quiet
    // "all partitions held" skip.
    await expect(coordinator.withWrite(op, { wait: "skip" })).rejects.toBe(boom)
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
        mode: "oneshot",
      }),
    )

    const op = vi.fn(async () => "ok")
    // The real cause propagates — not the generic "fully leased" message
    // ensureHeldForUpload would emit for genuine contention.
    await expect(coordinator.withWrite(op, { wait: "block" })).rejects.toThrow(
      "lock-SOC write failed",
    )
    expect(op).not.toHaveBeenCalled()
  })
})

describe("BatchWriteCoordinator — idle-yield under the write lock", () => {
  it("yields an idle lease: releases, unbinds, and emits the transition", async () => {
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const onLeaseChange = vi.fn()
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
        onLeaseChange,
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

  it("aborts the yield when an upload slipped in while the tick queued on the lock", async () => {
    const calls: string[] = []
    const stamper = makeStamper(calls)
    const coordinator = new BatchWriteCoordinator(
      makeDeps({
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
        mode: "oneshot", // no refresh timer to leak in the test
      }),
    )

    await coordinator.withWrite(async () => "ok", { wait: "block" })

    expect(stamper.getSyncedReference).toHaveBeenCalledWith(2)
    expect(lease.seedReferenceHex).toHaveBeenCalledWith("deadbeef")
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
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
        stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
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
          stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
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
          stamper: stamper as unknown as BatchWriteCoordinatorDeps["stamper"],
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
