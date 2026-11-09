// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The pool re-implements the signing half of core-sdk's `stamp` — the 80-byte
 * signing message and the nanosecond timestamp on the main thread, ECDSA
 * signing in a worker — so a slip in any of them ships a stamp Bee accepts but
 * that no longer matches what the sync `Stamper` writes. These tests hold the
 * two to the same bytes in every field but the signature, and hold the
 * signature to what Bee checks: that it recovers to the batch owner over the
 * very message core-sdk signs.
 *
 * The slot is not the pool's to pick: it comes from the stamper the pool signs
 * for. The second suite holds a pooled stamp to the slot, the lease fence and
 * the counters `UtilizationAwareStamper.stamp` would have given it.
 *
 * The signature bytes themselves cannot be compared. Both signers are
 * deterministic, but cafe-utility derives its nonce as
 * keccak256(keccak256(key) || hash) while core-sdk signs through noble with
 * RFC 6979, so the same digest yields two different, equally valid
 * signatures. (bee-js 11 signed with cafe-utility too, which is why the two
 * paths used to agree byte for byte.)
 *
 * Node has no `Worker`, so the pool runs against a fake that hands each
 * message to the real worker handler in-process and echoes the response on
 * a microtask, the way a worker would.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { BatchId, PrivateKey, Stamper } from "@ethersphere/bee-js"
import type { EnvelopeWithBatchId } from "@ethersphere/bee-js"
import { stamp, convertEnvelopeToMarshaledStamp } from "@ethersphere/core-sdk"
import { Binary } from "cafe-utility"
import { StampWorkerPool } from "./stamp-worker-pool"
import { uploadData } from "./upload"
import { CHUNK_SIZE } from "./chunking"
import { MockBee, MockChunkStore } from "./feeds/epochs/test-utils"
import {
  NUM_BUCKETS,
  PARTITION_COUNT,
  PartitionLeaseLostError,
  UtilizationAwareStamper,
  dataSlot,
  partitionCapacity,
} from "../utils/batch-utilization"
import {
  handleMessage,
  type StampWorkerMessage,
  type StampWorkerResponse,
} from "./stamp-worker-handler"

vi.mock("virtual:stamp-worker-code", () => ({ default: "" }))

const SIGNER_KEY_HEX =
  "634fb5a872396d9693e5c9f9d7233cfa93f395c093371017ff44aa9ae6564cdd"
const BATCH_ID_HEX =
  "1f2e3d4c5b6a79880706050403020100ffeeddccbbaa99887766554433221100"
// The smallest depth a batch can have: 2 ** (17 - 16) = 2 slots per bucket
const DEPTH = 17
const FIXED_TIMESTAMP_MS = 1_757_961_600_123
const NANOSECONDS_PER_MILLISECOND = 1_000_000n
const WORKER_COUNT = 2
const ADDRESS_LENGTH = 32
// batchId (32) || index (8) || timestamp (8) precede the signature on the wire
const MARSHALED_UNSIGNED_LENGTH = 48
const SLOT_OFFSET = 4

/** A 32-byte address whose first two bytes pick the bucket. */
function addressInBucket(bucket: number, fill: number): Uint8Array {
  const address = new Uint8Array(ADDRESS_LENGTH).fill(fill)
  address[0] = bucket >> 8
  address[1] = bucket & 0xff
  return address
}

/** Drives the real worker handler in-process, echoing on a microtask. */
class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: MessageEvent<StampWorkerResponse>) => void) | undefined
  onerror: ((event: ErrorEvent) => void) | undefined
  terminated = false

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(message: StampWorkerMessage): void {
    const response = handleMessage(message)
    queueMicrotask(() => {
      this.onmessage?.({ data: response } as MessageEvent<StampWorkerResponse>)
    })
  }

  terminate(): void {
    this.terminated = true
  }
}

/** The slot half of an envelope's index: bucket (4 BE) || slot (4 BE). */
function slotOf(envelope: EnvelopeWithBatchId): number {
  return new DataView(
    envelope.index.buffer,
    envelope.index.byteOffset,
    envelope.index.byteLength,
  ).getUint32(SLOT_OFFSET, false)
}

/** The stamp fields Bee reads off the wire, minus the signature. */
function unsignedFieldsHex(envelope: EnvelopeWithBatchId): string {
  return Binary.uint8ArrayToHex(
    Binary.concatBytes(
      envelope.batchId.toUint8Array(),
      envelope.index,
      envelope.timestamp,
    ),
  )
}

/** The 80-byte message a stamp signs: address || batchId || index || timestamp. */
function signedMessage(
  address: Uint8Array,
  envelope: EnvelopeWithBatchId,
): Uint8Array {
  return Binary.concatBytes(
    address,
    envelope.batchId.toUint8Array(),
    envelope.index,
    envelope.timestamp,
  )
}

/** Fails unless the envelope's signature recovers to its issuer, as Bee checks. */
function expectSignedByIssuer(
  address: Uint8Array,
  envelope: EnvelopeWithBatchId,
): void {
  const recovered = envelope.signature
    .recoverPublicKey(signedMessage(address, envelope))
    .address()
  expect(recovered.toHex()).toBe(envelope.issuer.toHex())
}

/** Same unsigned fields, and a signature the batch owner could have produced. */
function expectEquivalentStamps(
  address: Uint8Array,
  actual: EnvelopeWithBatchId,
  expected: EnvelopeWithBatchId,
): void {
  expect(unsignedFieldsHex(actual)).toBe(unsignedFieldsHex(expected))
  expect(actual.issuer.toHex()).toBe(expected.issuer.toHex())
  expectSignedByIssuer(address, actual)
  expectSignedByIssuer(address, expected)
}

describe("StampWorkerPool", () => {
  let stamper: Stamper
  let pool: StampWorkerPool

  beforeEach(async () => {
    FakeWorker.instances = []
    vi.stubGlobal("Worker", FakeWorker)
    stamper = Stamper.fromBlank(SIGNER_KEY_HEX, BATCH_ID_HEX, DEPTH)
    pool = await StampWorkerPool.create(SIGNER_KEY_HEX, stamper, WORKER_COUNT)
  })

  afterEach(() => {
    pool.terminate()
    vi.unstubAllGlobals()
  })

  it("produces the envelope core-sdk's stamp() produces", async () => {
    const address = addressInBucket(0x1234, 0xab)

    const actual = await pool.stampChunkData(address, FIXED_TIMESTAMP_MS)
    const expected = stamp(
      SIGNER_KEY_HEX,
      BATCH_ID_HEX,
      address,
      0,
      FIXED_TIMESTAMP_MS,
    )

    expect(actual.batchId.toHex()).toBe(expected.batchId.toHex())
    expect(actual.index).toEqual(expected.index)
    expect(actual.timestamp).toEqual(expected.timestamp)
    expect(actual.issuer.toHex()).toBe(expected.issuer.toHex())
    expectSignedByIssuer(address, actual)
    expectSignedByIssuer(address, expected)
  })

  it("marshals to the wire layout core-sdk marshals to", async () => {
    const address = addressInBucket(0x4321, 0xcd)

    const actual = convertEnvelopeToMarshaledStamp(
      await pool.stampChunkData(address, FIXED_TIMESTAMP_MS),
    ).toUint8Array()
    const expected = convertEnvelopeToMarshaledStamp(
      stamp(SIGNER_KEY_HEX, BATCH_ID_HEX, address, 0, FIXED_TIMESTAMP_MS),
    ).toUint8Array()

    // batchId (32) || index (8) || timestamp (8) || signature (65)
    expect(actual).toHaveLength(expected.length)
    expect(actual.subarray(0, MARSHALED_UNSIGNED_LENGTH)).toEqual(
      expected.subarray(0, MARSHALED_UNSIGNED_LENGTH),
    )
  })

  it("signs the same bytes twice to the same signature", async () => {
    const address = addressInBucket(0x0abc, 0xef)
    const first = await pool.stampChunkData(address, FIXED_TIMESTAMP_MS)
    // Reset bucket A so the second stamp lands on the same slot and message
    stamper.buckets[0x0abc] = 0
    const second = await pool.stampChunkData(address, FIXED_TIMESTAMP_MS)

    expect(second.signature.toHex()).toBe(first.signature.toHex())
  })

  it("writes the timestamp as big-endian nanoseconds", async () => {
    const envelope = await pool.stampChunkData(
      addressInBucket(0x0001, 0x01),
      FIXED_TIMESTAMP_MS,
    )

    const view = new DataView(envelope.timestamp.buffer)
    expect(view.getBigUint64(0, false)).toBe(
      BigInt(FIXED_TIMESTAMP_MS) * NANOSECONDS_PER_MILLISECOND,
    )
  })

  it("stamps with the current time by default", async () => {
    const before = BigInt(Date.now()) * NANOSECONDS_PER_MILLISECOND
    const envelope = await pool.stampChunkData(addressInBucket(0x0002, 0x02))
    const after = BigInt(Date.now()) * NANOSECONDS_PER_MILLISECOND

    const written = new DataView(envelope.timestamp.buffer).getBigUint64(
      0,
      false,
    )
    expect(written).toBeGreaterThanOrEqual(before)
    expect(written).toBeLessThanOrEqual(after)
  })

  it("shares bucket state with the wrapped stamper, slot for slot", async () => {
    // A second, untouched core-sdk Stamper walks the same sequence: every
    // envelope must agree whichever side handed out the slot.
    const reference = Stamper.fromBlank(SIGNER_KEY_HEX, BATCH_ID_HEX, DEPTH)
    const inBucketA = addressInBucket(0xbeef, 0x11)
    const alsoInBucketA = addressInBucket(0xbeef, 0x22)
    const inBucketB = addressInBucket(0xcafe, 0x33)

    expectEquivalentStamps(
      inBucketA,
      await pool.stampChunkData(inBucketA, FIXED_TIMESTAMP_MS),
      reference.stamp(inBucketA, FIXED_TIMESTAMP_MS),
    )
    expectEquivalentStamps(
      alsoInBucketA,
      stamper.stamp(alsoInBucketA, FIXED_TIMESTAMP_MS),
      reference.stamp(alsoInBucketA, FIXED_TIMESTAMP_MS),
    )
    expectEquivalentStamps(
      inBucketB,
      await pool.stampChunkData(inBucketB, FIXED_TIMESTAMP_MS),
      reference.stamp(inBucketB, FIXED_TIMESTAMP_MS),
    )

    // Depth 17 leaves two slots per bucket, both spent on bucket A above
    await expect(
      pool.stampChunkData(addressInBucket(0xbeef, 0x44), FIXED_TIMESTAMP_MS),
    ).rejects.toThrow("Bucket is full")
    expect(() => reference.stamp(addressInBucket(0xbeef, 0x44))).toThrow()
  })

  it("rejects the signs still in flight when it is terminated", async () => {
    for (const worker of FakeWorker.instances) {
      vi.spyOn(worker, "postMessage").mockImplementation(() => undefined)
    }
    const inFlight = pool.stampChunkData(addressInBucket(0x0003, 0x03))

    pool.terminate()

    await expect(inFlight).rejects.toThrow("terminated")
  })

  it("refuses to stamp after it is terminated, without spending a slot", async () => {
    pool.terminate()

    await expect(
      pool.stampChunkData(addressInBucket(0x0004, 0x04)),
    ).rejects.toThrow("terminated")
    expect(stamper.buckets[0x0004]).toBe(0)
  })

  it("spreads signing round-robin over the workers it created", async () => {
    expect(FakeWorker.instances).toHaveLength(WORKER_COUNT)
    const postMessage = FakeWorker.instances.map((worker) =>
      vi.spyOn(worker, "postMessage"),
    )

    for (let i = 0; i < WORKER_COUNT * 2; i++) {
      await pool.stampChunkData(addressInBucket(i, 0x55), FIXED_TIMESTAMP_MS)
    }

    for (const spy of postMessage) {
      expect(spy).toHaveBeenCalledTimes(2)
    }

    pool.terminate()
    expect(FakeWorker.instances.every((worker) => worker.terminated)).toBe(true)
  })
})

describe("StampWorkerPool over a partition-bound UtilizationAwareStamper", () => {
  const PARTITION = 1
  const BUCKET = 0x2468
  const LANE_DEPTH = 20
  let stamper: UtilizationAwareStamper
  let pool: StampWorkerPool

  beforeEach(async () => {
    FakeWorker.instances = []
    vi.stubGlobal("Worker", FakeWorker)
    const cache = {
      getAllChunks: async () => [],
      putChunk: async () => undefined,
    } as unknown as Parameters<typeof UtilizationAwareStamper.create>[3]
    stamper = await UtilizationAwareStamper.create(
      SIGNER_KEY_HEX,
      new BatchId(BATCH_ID_HEX),
      LANE_DEPTH,
      cache,
      new PrivateKey(SIGNER_KEY_HEX).publicKey().address(),
      new Uint8Array(ADDRESS_LENGTH).fill(0x07),
    )
    stamper.bindPartition({
      partition: PARTITION,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })
    pool = await StampWorkerPool.create(SIGNER_KEY_HEX, stamper, WORKER_COUNT)
  })

  afterEach(() => {
    pool.terminate()
    vi.unstubAllGlobals()
  })

  it("stamps in the partition's data lane and advances its counter", async () => {
    const first = await pool.stampChunkData(
      addressInBucket(BUCKET, 0x01),
      FIXED_TIMESTAMP_MS,
    )
    const second = await pool.stampChunkData(
      addressInBucket(BUCKET, 0x02),
      FIXED_TIMESTAMP_MS,
    )

    expect(slotOf(first)).toBe(dataSlot(PARTITION, 0, PARTITION_COUNT))
    expect(slotOf(second)).toBe(dataSlot(PARTITION, 1, PARTITION_COUNT))

    expect(stamper.getLocalCounter()?.[BUCKET]).toBe(2)
    expect(stamper.getBucketUpdatesForBroadcast()).toEqual([
      { index: BUCKET, value: 2 },
    ])
  })

  it("shares one lane with the stamper's own stamp()", async () => {
    const slots = [
      await pool.stampChunkData(addressInBucket(BUCKET, 0x01)),
      stamper.stamp(addressInBucket(BUCKET, 0x02)),
      await pool.stampChunkData(addressInBucket(BUCKET, 0x03)),
    ].map(slotOf)

    expect(slots).toEqual(
      [0, 1, 2].map((j) => dataSlot(PARTITION, j, PARTITION_COUNT)),
    )
  })

  it("gives concurrent stamps into one bucket distinct slots", async () => {
    const envelopes = await Promise.all(
      [0x01, 0x02, 0x03, 0x04].map((fill) =>
        pool.stampChunkData(addressInBucket(BUCKET, fill)),
      ),
    )

    expect(envelopes.map(slotOf)).toEqual(
      [0, 1, 2, 3].map((j) => dataSlot(PARTITION, j, PARTITION_COUNT)),
    )
  })

  it("routes a reserved chunk to its reserved slot without spending a data slot", async () => {
    const reserved = addressInBucket(BUCKET, 0x0a)
    stamper.markReservedUtilizationChunk(reserved)

    expect(slotOf(await pool.stampChunkData(reserved))).toBe(PARTITION)
    expect(stamper.getLocalCounter()?.[BUCKET]).toBe(0)
    expect(stamper.getBucketUpdatesForBroadcast()).toEqual([])
  })

  it("refuses to stamp once the partition lease is lost", async () => {
    stamper.invalidateLease()

    await expect(
      pool.stampChunkData(addressInBucket(BUCKET, 0x01)),
    ).rejects.toBeInstanceOf(PartitionLeaseLostError)
    expect(stamper.getLocalCounter()?.[BUCKET]).toBe(0)
  })

  it("follows a counter another tab moved", async () => {
    const MOVED_TO = 5
    stamper.applyUtilizationUpdate([{ index: BUCKET, value: MOVED_TO }])

    const envelope = await pool.stampChunkData(addressInBucket(BUCKET, 0x01))

    expect(slotOf(envelope)).toBe(
      dataSlot(PARTITION, MOVED_TO, PARTITION_COUNT),
    )
  })

  it("throws 'Bucket is full' at the end of the lane, like stamp()", async () => {
    const capacity = partitionCapacity(LANE_DEPTH, PARTITION_COUNT)
    for (let j = 0; j < capacity; j++) {
      await pool.stampChunkData(addressInBucket(BUCKET, j))
    }

    await expect(
      pool.stampChunkData(addressInBucket(BUCKET, 0xff)),
    ).rejects.toThrow("Bucket is full")
    expect(() => stamper.stamp(addressInBucket(BUCKET, 0xfe))).toThrow(
      "Bucket is full",
    )
    expect(stamper.getLocalCounter()?.[BUCKET]).toBe(capacity)
  })
})

describe("uploadData through a StampWorkerPool", () => {
  const PARTITION = 1
  const LANE_DEPTH = 20
  // Two leaves and the intermediate chunk that joins them
  const DATA_LENGTH = CHUNK_SIZE + 1
  const UPLOADED_CHUNKS = 3

  beforeEach(() => {
    FakeWorker.instances = []
    vi.stubGlobal("Worker", FakeWorker)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("stamps every chunk in the stamper's lane and leaves them for flush()", async () => {
    const cache = {
      getAllChunks: async () => [],
      putChunk: async () => undefined,
    } as unknown as Parameters<typeof UtilizationAwareStamper.create>[3]
    const stamper = await UtilizationAwareStamper.create(
      SIGNER_KEY_HEX,
      new BatchId(BATCH_ID_HEX),
      LANE_DEPTH,
      cache,
      new PrivateKey(SIGNER_KEY_HEX).publicKey().address(),
      new Uint8Array(ADDRESS_LENGTH).fill(0x07),
    )
    stamper.bindPartition({
      partition: PARTITION,
      partitionCount: PARTITION_COUNT,
      localCounter: new Uint32Array(NUM_BUCKETS),
    })
    const workerPool = await StampWorkerPool.create(
      SIGNER_KEY_HEX,
      stamper,
      WORKER_COUNT,
    )
    const bee = new MockBee(new MockChunkStore())
    const stamped: EnvelopeWithBatchId[] = []
    const upload = bee.chunk.upload
    bee.chunk.upload = (envelope, ...rest) => {
      stamped.push(envelope as EnvelopeWithBatchId)
      return upload(envelope, ...rest)
    }

    try {
      await uploadData(
        { mode: "stamper", bee, stamper, workerPool },
        new Uint8Array(DATA_LENGTH).map((_, i) => i & 0xff),
      )
    } finally {
      workerPool.terminate()
    }

    expect(stamped).toHaveLength(UPLOADED_CHUNKS)
    for (const envelope of stamped) {
      expect(slotOf(envelope) % PARTITION_COUNT).toBe(PARTITION)
      expect(slotOf(envelope)).toBeGreaterThanOrEqual(PARTITION_COUNT)
    }
    const counted = stamper
      .getBucketUpdatesForBroadcast()
      .reduce((sum, { value }) => sum + value, 0)
    expect(counted).toBe(UPLOADED_CHUNKS)
  })
})
