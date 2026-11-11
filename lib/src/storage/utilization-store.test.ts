// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  UtilizationStoreDB,
  UtilizationStoreUnavailableError,
} from "./utilization-store"

const BATCH = "ab".repeat(32)

describe("UtilizationStoreDB metadata", () => {
  let store: UtilizationStoreDB

  beforeEach(() => {
    // A fresh factory per test: nothing from the last test's database leaks
    vi.stubGlobal("indexedDB", new IDBFactory())
    store = new UtilizationStoreDB()
  })

  afterEach(() => {
    store.close()
    vi.unstubAllGlobals()
  })

  it("creates the record on the first patch and merges the next into it", async () => {
    await store.updateMetadata(BATCH, () => ({ rowsPartition: 1 }))
    await store.updateMetadata(BATCH, () => ({
      stateReference: { partition: 1, referenceHex: "ref", exact: true },
    }))
    expect(await store.getMetadata(BATCH)).toEqual({
      batchId: BATCH,
      rowsPartition: 1,
      stateReference: { partition: 1, referenceHex: "ref", exact: true },
    })
  })

  it("keeps every field when two patches are in flight at once", async () => {
    await Promise.all([
      store.updateMetadata(BATCH, (existing) => ({
        stateChunkBuckets: { ...existing?.stateChunkBuckets, 0: [11] },
      })),
      store.updateMetadata(BATCH, (existing) => ({
        stateChunkBuckets: { ...existing?.stateChunkBuckets, 1: [22] },
      })),
    ])
    expect((await store.getMetadata(BATCH))?.stateChunkBuckets).toEqual({
      0: [11],
      1: [22],
    })
  })

  it("rejects with the patch's own error and leaves the record as it was", async () => {
    await store.updateMetadata(BATCH, () => ({ rowsPartition: 0 }))
    await expect(
      store.updateMetadata(BATCH, () => {
        throw new Error("bad patch")
      }),
    ).rejects.toThrow("bad patch")
    expect(await store.getMetadata(BATCH)).toEqual({
      batchId: BATCH,
      rowsPartition: 0,
    })
  })

  it("fails to open as unavailable where there is no IndexedDB at all", async () => {
    vi.stubGlobal("indexedDB", undefined)
    await expect(store.getMetadata(BATCH)).rejects.toBeInstanceOf(
      UtilizationStoreUnavailableError,
    )
  })
})
