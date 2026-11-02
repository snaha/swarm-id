// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The drive registry without a proxy: which write paths it builds, when it
 * drops them, and what a superseded build leaves behind.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { BatchId, EthAddress, PrivateKey } from "@ethersphere/bee-js"
import type { BatchWriteCoordinator } from "../sync/batch-write-coordinator"
import type { PostageStamp } from "../types"
import { DriveRegistry, type DriveAccount } from "./drive-registry"

vi.mock("virtual:stamp-worker-code", () => ({ default: "" }))

const stamperCreate = vi.hoisted(() => vi.fn())

vi.mock("../utils/batch-utilization", async (importActual) => ({
  ...(await importActual<typeof import("../utils/batch-utilization")>()),
  UtilizationAwareStamper: { create: stamperCreate },
}))
vi.mock("../storage/utilization-store", () => ({
  UtilizationStoreDB: class {},
}))

const PRIMARY = "aa".repeat(32)
const OTHER = "bb".repeat(32)
const UNGRANTED = "cc".repeat(32)
const SIGNER = new PrivateKey("11".repeat(32))
const ROTATED_SIGNER = new PrivateKey("22".repeat(32))
const ACCOUNT: DriveAccount = {
  owner: new EthAddress("a1".repeat(20)),
  encryptionKey: new Uint8Array(32),
  accountId: "account",
  partitionCount: 2,
}
const DEPTH = 22

function makeStamp(
  batchHex: string,
  extra: Partial<PostageStamp> = {},
): PostageStamp {
  return {
    batchID: new BatchId(batchHex),
    signerKey: SIGNER,
    utilization: 0,
    usable: true,
    depth: DEPTH,
    amount: BigInt(100),
    bucketDepth: 16,
    blockNumber: 1,
    immutableFlag: true,
    exists: true,
    createdAt: 1_000_000,
    ...extra,
  }
}

describe("DriveRegistry", () => {
  let granted: PostageStamp[]
  let primary: PostageStamp | undefined
  let account: () => Promise<DriveAccount | undefined>
  let tornDown: string[]
  let leases: string[]
  let registry: DriveRegistry

  beforeEach(() => {
    stamperCreate.mockReset()
    stamperCreate.mockImplementation(async (_key, batchId: BatchId) => ({
      batchId,
    }))
    granted = [makeStamp(PRIMARY), makeStamp(OTHER)]
    primary = granted[0]
    account = async () => ACCOUNT
    tornDown = []
    leases = []
    registry = new DriveRegistry({
      lookupDrivesForApp: () => ({ primary, granted }),
      lookupAccountForApp: () => account(),
      createCoordinator: (drive) =>
        ({
          startLease: () => leases.push(drive.batchId),
          teardown: () => {},
        }) as unknown as BatchWriteCoordinator,
      onTeardown: (batchId) => tornDown.push(batchId),
    })
  })

  it("builds the primary's write path on reconcile, and no other", async () => {
    await registry.reconcile()

    expect(registry.primary?.batchId).toBe(PRIMARY)
    expect(registry.primary?.stamper).toBeDefined()
    expect(registry.all().map((drive) => drive.batchId)).toEqual([PRIMARY])
    expect(leases).toEqual([PRIMARY])
  })

  it("builds another granted drive on its first write, once", async () => {
    await registry.reconcile()

    const drive = await registry.writePathFor(OTHER)

    expect(drive.batchId).toBe(OTHER)
    expect(await registry.writePathFor(OTHER)).toBe(drive)
    expect(stamperCreate).toHaveBeenCalledTimes(2)
    expect(stamperCreate.mock.calls[1][7]).toEqual({ scratch: false })
  })

  it("builds a scratch drive's stamper as a ring", async () => {
    granted = [makeStamp(PRIMARY, { kind: "scratch" })]
    primary = granted[0]

    await registry.reconcile()

    expect(stamperCreate.mock.calls[0][7]).toEqual({ scratch: true })
  })

  it("refuses a write to a drive the app was not granted", async () => {
    await expect(registry.writePathFor(UNGRANTED)).rejects.toMatchObject({
      code: "drive-not-granted",
    })
  })

  it("tears down only the drive that leaves the grant", async () => {
    await registry.reconcile()
    await registry.writePathFor(OTHER)

    granted = [granted[0]]
    await registry.reconcile()

    expect(tornDown).toEqual([OTHER])
    expect(registry.all().map((drive) => drive.batchId)).toEqual([PRIMARY])
  })

  it("rebuilds a drive whose signer key rotates", async () => {
    await registry.reconcile()
    const before = registry.primary

    granted = [makeStamp(PRIMARY, { signerKey: ROTATED_SIGNER })]
    primary = granted[0]
    await registry.reconcile()

    expect(tornDown).toEqual([PRIMARY])
    expect(registry.primary).not.toBe(before)
    expect(registry.primary?.signerKey).toBe(ROTATED_SIGNER.toHex())
  })

  it("leaves no stamper when the account cannot be found", async () => {
    account = async () => undefined
    vi.spyOn(console, "warn").mockImplementation(() => {})

    await registry.reconcile()

    expect(registry.primary?.stamper).toBeUndefined()
    expect(stamperCreate).not.toHaveBeenCalled()
  })

  it("attaches nothing from a build superseded while it awaited", async () => {
    let finishLookup: (value: DriveAccount) => void = () => {}
    account = () =>
      new Promise((resolve) => {
        finishLookup = resolve
      })
    const first = registry.add(granted[0])
    registry.teardownAll()

    finishLookup(ACCOUNT)
    await first.ready

    expect(first.stamper).toBeUndefined()
    expect(stamperCreate).not.toHaveBeenCalled()
    expect(registry.primary).toBeUndefined()
  })
})
