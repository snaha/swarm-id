// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  UtilizationStoreDB,
  UtilizationStoreUnavailableError,
  leaseRecordIn,
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

describe("UtilizationStoreDB.writeRows", () => {
  const row = (chunkIndex: number, fill: number) => ({
    batchId: BATCH,
    chunkIndex,
    data: new Uint8Array(4096).fill(fill),
    contentHash: `hash-${chunkIndex}-${fill}`,
    nonce: 0,
    lastAccess: 0,
  })
  let store: UtilizationStoreDB

  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory())
    store = new UtilizationStoreDB()
  })

  afterEach(() => {
    store.close()
    vi.unstubAllGlobals()
  })

  it("writes the rows and the metadata patch together", async () => {
    await store.updateMetadata(BATCH, () => ({ rowsGeneration: 4 }))
    await store.writeRows(BATCH, [row(0, 1), row(3, 2)], (existing) => ({
      rowsGeneration: (existing?.rowsGeneration ?? 0) + 1,
      rowsPartition: 1,
    }))

    const rows = await store.getAllChunks(BATCH)
    expect(rows.map((r) => [r.chunkIndex, r.data[0]])).toEqual([
      [0, 1],
      [3, 2],
    ])
    expect(await store.getMetadata(BATCH)).toMatchObject({
      rowsGeneration: 5,
      rowsPartition: 1,
    })
  })

  it("writes the published rows in the same step, and keeps them apart from the cache rows", async () => {
    const publishedRow = (chunkIndex: number, fill: number) => ({
      batchId: BATCH,
      chunkIndex,
      data: new Uint8Array(4096).fill(fill),
    })
    await store.writeRows(
      BATCH,
      [row(0, 5)],
      () => ({ stateReference: { partition: 0, referenceHex: "published" } }),
      [publishedRow(0, 2), publishedRow(7, 3)],
    )
    await store.writeRows("ee".repeat(32), [], () => ({}), [
      { ...publishedRow(0, 9), batchId: "ee".repeat(32) },
    ])

    const published = await store.getPublishedRows(BATCH)
    expect(
      published
        .sort((a, b) => a.chunkIndex - b.chunkIndex)
        .map((r) => [r.chunkIndex, r.data[0]]),
    ).toEqual([
      [0, 2],
      [7, 3],
    ])
    expect((await store.getAllChunks(BATCH)).map((r) => r.data[0])).toEqual([5])

    await expect(
      store.writeRows(
        BATCH,
        [],
        () => {
          throw new Error("refused")
        },
        [publishedRow(0, 8)],
      ),
    ).rejects.toThrow("refused")
    expect(
      (await store.getPublishedRows(BATCH)).find((r) => r.chunkIndex === 0)
        ?.data[0],
    ).toBe(2)
  })

  it("writes nothing when the patch refuses", async () => {
    await store.writeRows(BATCH, [row(0, 1)], () => ({ rowsGeneration: 1 }))

    await expect(
      store.writeRows(BATCH, [row(0, 9), row(1, 9)], () => {
        throw new Error("rows changed underneath")
      }),
    ).rejects.toThrow("rows changed underneath")

    const rows = await store.getAllChunks(BATCH)
    expect(rows.map((r) => [r.chunkIndex, r.data[0]])).toEqual([[0, 1]])
    expect((await store.getMetadata(BATCH))?.rowsGeneration).toBe(1)
  })
})

describe("leaseRecordIn", () => {
  const ACCOUNT = "aa".repeat(20)
  const lease = (deviceId: string, batchId = BATCH) => ({
    deviceId,
    batchId,
    self: {
      partition: 1,
      generation: { timestampMs: 7, tiebreaker: deviceId },
      acquiredAt: 7,
      leasedUntil: 30_007,
    },
    referenceHex: "published",
  })
  let store: UtilizationStoreDB

  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory())
    store = new UtilizationStoreDB()
  })

  afterEach(() => {
    store.close()
    vi.unstubAllGlobals()
  })

  it("is one record for every context that opens the same account and batch", async () => {
    const tab = leaseRecordIn(store, BATCH, ACCOUNT)
    const sibling = leaseRecordIn(new UtilizationStoreDB(), BATCH, ACCOUNT)
    expect(await sibling.read()).toBeUndefined()

    await tab.update(() => lease("device"))
    expect(await sibling.read()).toEqual(lease("device"))

    await sibling.update(() => undefined)
    expect(await tab.read()).toBeUndefined()
  })

  it("hands the update what is stored, so a renewal extends the record another tab wrote", async () => {
    const tab = leaseRecordIn(store, BATCH, ACCOUNT)
    const sibling = leaseRecordIn(store, BATCH, ACCOUNT)
    await tab.update(() => lease("device"))

    await sibling.update((existing) => ({
      ...existing!,
      self: { ...existing!.self!, leasedUntil: 60_000 },
    }))

    const stored = await tab.read()
    expect(stored?.self?.leasedUntil).toBe(60_000)
    expect(stored?.referenceHex).toBe("published")
  })

  it("keeps another batch's lease and another account's apart", async () => {
    // An account has a coordinator per drive, and the store is keyed by batch
    const otherBatch = "dd".repeat(32)
    const otherAccount = "bb".repeat(20)
    await leaseRecordIn(store, otherBatch, ACCOUNT).update(() =>
      lease("other-drive", otherBatch),
    )
    await leaseRecordIn(store, BATCH, otherAccount).update(() =>
      lease("other-account"),
    )

    const record = leaseRecordIn(store, BATCH, ACCOUNT)
    expect(await record.read()).toBeUndefined()
    await record.update(() => lease("device"))
    await record.update(() => undefined)

    expect(await leaseRecordIn(store, otherBatch, ACCOUNT).read()).toEqual(
      lease("other-drive", otherBatch),
    )
    expect(await leaseRecordIn(store, BATCH, otherAccount).read()).toEqual(
      lease("other-account"),
    )
  })

  it("leaves the rows' metadata alone", async () => {
    await store.updateMetadata(BATCH, () => ({ rowsPartition: 1 }))
    await leaseRecordIn(store, BATCH, ACCOUNT).update(() => lease("device"))
    expect((await store.getMetadata(BATCH))?.rowsPartition).toBe(1)
  })

  it("reads empty and drops writes where IndexedDB is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined)
    const record = leaseRecordIn(new UtilizationStoreDB(), BATCH, ACCOUNT)
    await record.update(() => lease("device"))
    expect(await record.read()).toBeUndefined()
  })
})
