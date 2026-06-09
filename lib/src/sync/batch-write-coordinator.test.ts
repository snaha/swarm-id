// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from "vitest"
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
    batchId: "batch-hex",
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
