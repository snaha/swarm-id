// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BatchId, PrivateKey } from "@ethersphere/bee-js"
import { NUM_BUCKETS } from "../utils/batch-utilization"
import {
  MockBee,
  MockChunkStore,
  createMockStamper,
  createTestSigner,
  mockFetch,
} from "../proxy/feeds/epochs/test-utils"
import { makeDeviceTiebreaker, writePartitionLock } from "./partition-lock"
import { writePartitionState } from "./partition-state"
import { readPublishedCounter } from "./published-counter"

const BATCH_ID = new BatchId("ab".repeat(32))
const BATCH_DEPTH = 24
const ENCRYPTION_KEY = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff)
const BACKUP_SIGNER = createTestSigner() as PrivateKey
const PARTITION = 1
const PUBLISHED_AT = 1_000_000_000_000
const A_DAY_MS = 24 * 60 * 60 * 1000

let bee: MockBee

beforeEach(() => {
  const store = new MockChunkStore()
  bee = new MockBee(store)
  mockFetch(store, BACKUP_SIGNER.publicKey().address())
})

afterEach(() => {
  vi.restoreAllMocks()
})

const read = (known?: Parameters<typeof readPublishedCounter>[1]) =>
  readPublishedCounter(
    {
      bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: ENCRYPTION_KEY,
      batchId: BATCH_ID,
      batchDepth: BATCH_DEPTH,
      partition: PARTITION,
    },
    known,
  )

async function publish(counter: Uint32Array): Promise<void> {
  await writePartitionState({
    bee,
    stamper: createMockStamper(),
    batchId: BATCH_ID,
    batchDepth: BATCH_DEPTH,
    partition: PARTITION,
    localCounter: counter,
    backupSigner: BACKUP_SIGNER,
    swarmEncryptionKey: ENCRYPTION_KEY,
  })
}

describe("readPublishedCounter", () => {
  it("reads a partition that never published as empty", async () => {
    expect(await read()).toEqual({
      dataCounters: new Uint32Array(NUM_BUCKETS),
      referenceHex: undefined,
    })
  })

  it("reads back the counter its holder published", async () => {
    const counter = new Uint32Array(NUM_BUCKETS)
    counter[100] = 5
    counter[200] = 12
    await publish(counter)

    const published = await read()

    expect(published?.dataCounters).toEqual(counter)
    expect(published?.referenceHex).toBeDefined()
  })

  it("finds a long-gone holder's counter through its lock", async () => {
    const counter = new Uint32Array(NUM_BUCKETS)
    counter[7] = 3
    vi.spyOn(Date, "now").mockReturnValue(PUBLISHED_AT)
    await publish(counter)
    await writePartitionLock({
      bee,
      stamper: createMockStamper(),
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: ENCRYPTION_KEY,
      batchId: BATCH_ID,
      partition: PARTITION,
      payload: {
        holderDeviceId: "device-B",
        generation: {
          timestampMs: PUBLISHED_AT,
          tiebreaker: makeDeviceTiebreaker("device-B"),
        },
        acquiredAt: PUBLISHED_AT,
        leasedUntil: PUBLISHED_AT,
      },
    })
    vi.spyOn(Date, "now").mockReturnValue(PUBLISHED_AT + A_DAY_MS)

    expect((await read())?.dataCounters).toEqual(counter)
  })

  it("returns the known counter while the partition still points at it", async () => {
    const counter = new Uint32Array(NUM_BUCKETS)
    counter[1] = 1
    await publish(counter)
    const known = await read()

    expect(await read(known)).toBe(known)
  })
})
