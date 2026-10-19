// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest"
import type { BatchWriteCoordinator } from "../sync/batch-write-coordinator"
import type { UtilizationAwareStamper } from "../utils/batch-utilization"
import { DriveWritePath } from "./drive-write-path"
import { StampWorkerPool } from "./stamp-worker-pool"

vi.mock("./stamp-worker-pool", () => ({
  StampWorkerPool: { create: vi.fn() },
}))

describe("DriveWritePath", () => {
  const attached = (): DriveWritePath => {
    const drive = new DriveWritePath("aa".repeat(32), "22".repeat(32), {
      createdAt: Date.now(),
    })
    drive.attach(
      { mock: "stamper" } as unknown as UtilizationAwareStamper,
      "fingerprint",
      { teardown: vi.fn() } as unknown as BatchWriteCoordinator,
    )
    return drive
  }

  // `StampWorkerPool.create` spawns N workers and posts each the signer key.
  // A teardown landing in that window must not leave the pool it was building
  // alive: nothing would terminate it, and its workers would hold the key
  // until the iframe unloads.
  it("terminates a worker pool whose build a teardown overtook", async () => {
    const drive = attached()
    const pool = { terminate: vi.fn(), size: 2, stamper: drive.stamper }
    let finishBuild: (() => void) | undefined
    vi.mocked(StampWorkerPool.create).mockReturnValueOnce(
      new Promise((resolve) => {
        finishBuild = () => resolve(pool as unknown as StampWorkerPool)
      }),
    )

    const building = drive.getOrCreateWorkerPool(2)
    await vi.waitFor(() => expect(finishBuild).toBeDefined())
    drive.teardown()
    finishBuild!()

    expect(await building).toBeUndefined()
    expect(pool.terminate).toHaveBeenCalledTimes(1)
    expect(await drive.getOrCreateWorkerPool(2)).toBeUndefined()
  })
})
