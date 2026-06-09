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

import {
  BatchWriteCoordinator,
  PartitionContendedError,
  isDisplaced,
  type BatchWriteCoordinatorDeps,
} from "./batch-write-coordinator"
import { NO_HOLDER_DEVICE_ID } from "./partition-lock"

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
    buildLeaseLocalCounter: () => new Uint32Array(8),
    getLocalCounter: () => new Uint32Array(8),
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
    refreshResult?: boolean
  } = {},
) {
  let partition = opts.partition
  return {
    hydrate: vi.fn(),
    adoptIfLive: vi.fn(() => undefined),
    acquire: vi.fn(async () => {
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
    refresh: vi.fn(async () => opts.refreshResult ?? true),
    release: vi.fn(async () => {}),
    bumpLocalLease: vi.fn(),
    serialize: vi.fn(() => ({ v: 1 })),
    get currentPartition() {
      return partition
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

/** Cast helper for poking at private state in the race-fix test. */
type Internals = {
  partitionLease: unknown
  lastLeaseActivityAt: number
  activeUploadCount: number
  pendingAcquire: boolean
  refreshTick: (lease: unknown) => Promise<void>
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
    const lease = makeLease({ partition: 0, refreshResult: false })
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
    const lease = makeLease({ partition: 0, refreshResult: false })
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
})
