// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Converting a batch's legacy cache rows (#463) against real IndexedDB
 * semantics: the conversion is the only record of used slots this build can
 * read, so a half-done or racing conversion that lowers a counter would let
 * the next uploads re-issue used slots.
 */

import { IDBFactory } from "fake-indexeddb"
import { BatchId, EthAddress, PrivateKey } from "@ethersphere/bee-js"
import { beforeEach, describe, expect, it } from "vitest"
import { UtilizationStoreDB, type ChunkCacheEntry } from "./utilization-store"
import {
  CACHE_ROW_FORMAT,
  NUM_BUCKETS,
  UtilizationAwareStamper,
  convertLegacyCacheRows,
} from "../utils/batch-utilization"

const BATCH = new BatchId("ab".repeat(32))
const BATCH_HEX = BATCH.toHex()
const DEPTH = 24
const CHUNK_BYTES = 4096
const LEGACY_PER_ROW = 2048
const LEGACY_ROWS = NUM_BUCKETS / LEGACY_PER_ROW
const SIGNER = new PrivateKey(new Uint8Array(32).fill(7)).toHex()
const OWNER = new EthAddress("33".repeat(20))
const ENC_KEY = new Uint8Array(32).fill(0x24)
/** The row a failing conversion breaks on, as a closed tab would stop */
const FAILING_ROW = 10

/** What a device wrote before the fixed layout: `1 + (b mod 7)` per bucket */
function writtenCounters(): Uint32Array {
  return Uint32Array.from({ length: NUM_BUCKETS }, (_unused, b) => 1 + (b % 7))
}

/** The same counters as the legacy uint16 rows a pre-#463 build stored */
function legacyRows(counters: Uint32Array): ChunkCacheEntry[] {
  return Array.from({ length: LEGACY_ROWS }, (_unused, i) => {
    const data = new Uint8Array(CHUNK_BYTES)
    const view = new DataView(data.buffer)
    for (let j = 0; j < LEGACY_PER_ROW; j++) {
      view.setUint16(j * 2, counters[i * LEGACY_PER_ROW + j], true)
    }
    return {
      batchId: BATCH_HEX,
      chunkIndex: i,
      data,
      contentHash: "old",
      nonce: 0,
      lastAccess: 0,
    }
  })
}

async function seed(rows: ChunkCacheEntry[]): Promise<void> {
  const store = new UtilizationStoreDB()
  for (const row of rows) await store.putChunk(row)
}

function load(store: UtilizationStoreDB): Promise<UtilizationAwareStamper> {
  return UtilizationAwareStamper.create(
    SIGNER,
    BATCH,
    DEPTH,
    store,
    OWNER,
    ENC_KEY,
  )
}

beforeEach(() => {
  // A fresh database per test, shared by every store opened in it, as the
  // tabs of one origin share theirs
  globalThis.indexedDB = new IDBFactory()
})

describe("convertBatch", () => {
  it("leaves every legacy row as it was when the conversion fails part way", async () => {
    const counters = writtenCounters()
    await seed(legacyRows(counters))
    const store = new UtilizationStoreDB()

    await expect(
      store.convertBatch(BATCH_HEX, (rows) => {
        const converted = convertLegacyCacheRows(BATCH_HEX, rows, DEPTH, false)!
        // A value IndexedDB cannot store: the put throws part way through
        converted[FAILING_ROW] = {
          ...converted[FAILING_ROW],
          data: (() => 0) as unknown as Uint8Array,
        }
        return converted
      }),
    ).rejects.toThrow()

    const after = await store.getAllChunks(BATCH_HEX)
    expect(after).toHaveLength(LEGACY_ROWS)
    expect(after.every((row) => row.format === undefined)).toBe(true)
    // ...and the next load converts it whole
    const stamper = await load(store)
    expect(stamper.getUtilizationState().dataCounters).toEqual(counters)
  })

  it("hands the next load the counters a tab wrote when that tab closes part way through converting", async () => {
    const counters = writtenCounters()
    await seed(legacyRows(counters))

    // A tab whose row writes stop at the tenth, as a closing tab's would
    class ClosingTab extends UtilizationStoreDB {
      private puts = 0
      override async putChunk(entry: ChunkCacheEntry): Promise<void> {
        if (++this.puts > FAILING_ROW) throw new Error("tab closed")
        return super.putChunk(entry)
      }
    }
    await load(new ClosingTab())

    const next = await load(new UtilizationStoreDB())
    expect(next.getUtilizationState().dataCounters).toEqual(counters)
  })

  it("gives a second tab the counters that were written while the first is converting", async () => {
    const counters = writtenCounters()
    await seed(legacyRows(counters))

    // The second tab loads the moment the first has written ten rows, if
    // the first writes rows one at a time; otherwise once it is done
    let second: Promise<UtilizationAwareStamper> | undefined
    class FirstTab extends UtilizationStoreDB {
      private puts = 0
      override async putChunk(entry: ChunkCacheEntry): Promise<void> {
        if (++this.puts === FAILING_ROW) {
          second = load(new UtilizationStoreDB())
          await second
        }
        return super.putChunk(entry)
      }
    }
    const first = await load(new FirstTab())
    second ??= load(new UtilizationStoreDB())

    expect(first.getUtilizationState().dataCounters).toEqual(counters)
    expect((await second).getUtilizationState().dataCounters).toEqual(counters)
    // ...and what is stored afterwards holds them too
    const rows = await new UtilizationStoreDB().getAllChunks(BATCH_HEX)
    expect(rows.every((row) => row.format === CACHE_ROW_FORMAT)).toBe(true)
    expect(
      (await load(new UtilizationStoreDB())).getUtilizationState().dataCounters,
    ).toEqual(counters)
  })

  it("writes nothing for a batch already in the fixed layout", async () => {
    await seed(legacyRows(writtenCounters()))
    await load(new UtilizationStoreDB())
    const store = new UtilizationStoreDB()
    const before = await store.getAllChunks(BATCH_HEX)
    let called = 0
    await store.convertBatch(BATCH_HEX, (rows) => {
      called++
      return convertLegacyCacheRows(BATCH_HEX, rows, DEPTH, false)
    })
    expect(called).toBe(1)
    expect(await store.getAllChunks(BATCH_HEX)).toEqual(before)
  })
})
