// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the per-device partition-intent SOCs (Phase 2 of the
 * partition-lock hardening). Uses MockBee + mockFetch from the epoch-feeds
 * test utilities so the SOC round-trip exercises real bee-js code paths
 * (`uploadSOC`, `downloadEncryptedSOC`) against an in-memory store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PrivateKey, type Bee, type Stamper } from "@ethersphere/bee-js"
import {
  INTENT_EPOCH_MS,
  intentEpochBucket,
  makePartitionIntentIdentifier,
  readPartitionIntent,
  resolveIntentRound,
  writePartitionIntent,
} from "./partition-intent"
import { makeDeviceTiebreaker } from "./partition-lock"
import {
  MockBee,
  MockChunkStore,
  createMockStamper,
  createTestSigner,
  mockFetch,
} from "../proxy/feeds/epochs/test-utils"

const DEVICE_A = "device-alpha-111"
const DEVICE_B = "device-beta-222"
const TEST_ENC_KEY = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff)
const BACKUP_SIGNER = createTestSigner() as PrivateKey
const OWNER = BACKUP_SIGNER.publicKey().address()

const PARTITION = 0
const NOW = 5 * INTENT_EPOCH_MS + 1234 // arbitrary point inside an epoch

let store: MockChunkStore
let bee: MockBee
let stamper: Stamper

beforeEach(() => {
  store = new MockChunkStore()
  bee = new MockBee(store)
  stamper = createMockStamper() as unknown as Stamper
  mockFetch(store, OWNER)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function gen(timestampMs: number, deviceId: string) {
  return { timestampMs, tiebreaker: makeDeviceTiebreaker(deviceId) }
}

describe("intentEpochBucket", () => {
  it("is floor(now / INTENT_EPOCH_MS)", () => {
    expect(intentEpochBucket(0)).toBe(0)
    expect(intentEpochBucket(INTENT_EPOCH_MS - 1)).toBe(0)
    expect(intentEpochBucket(INTENT_EPOCH_MS)).toBe(1)
    expect(intentEpochBucket(NOW)).toBe(5)
  })
})

describe("makePartitionIntentIdentifier", () => {
  it("is deterministic for the same (partition, device, epoch)", () => {
    expect(makePartitionIntentIdentifier(0, DEVICE_A, 5).toHex()).toBe(
      makePartitionIntentIdentifier(0, DEVICE_A, 5).toHex(),
    )
  })

  it("rotates across epoch buckets, devices, and partitions", () => {
    const base = makePartitionIntentIdentifier(0, DEVICE_A, 5).toHex()
    expect(makePartitionIntentIdentifier(0, DEVICE_A, 6).toHex()).not.toBe(base)
    expect(makePartitionIntentIdentifier(0, DEVICE_B, 5).toHex()).not.toBe(base)
    expect(makePartitionIntentIdentifier(1, DEVICE_A, 5).toHex()).not.toBe(base)
  })
})

describe("readPartitionIntent / writePartitionIntent round-trip", () => {
  it("returns undefined when the intent was never written", async () => {
    const read = await readPartitionIntent({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: PARTITION,
      deviceId: DEVICE_A,
      epochBucket: intentEpochBucket(NOW),
    })
    expect(read).toBeUndefined()
  })

  it("reads back the exact payload that was written", async () => {
    await writePartitionIntent({
      bee: bee as unknown as Bee,
      stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: PARTITION,
      deviceId: DEVICE_A,
      epochBucket: intentEpochBucket(NOW),
      generation: gen(1000, DEVICE_A),
    })
    const read = await readPartitionIntent({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: PARTITION,
      deviceId: DEVICE_A,
      epochBucket: intentEpochBucket(NOW),
    })
    expect(read).toEqual({
      deviceId: DEVICE_A,
      generation: gen(1000, DEVICE_A),
    })
  })

  it("treats a slow read as 'no intent' (returns undefined on timeout)", async () => {
    // Make the chunk download hang so the client-side timeout fires.
    vi.spyOn(bee, "downloadChunk").mockImplementation(
      () => new Promise(() => {}) as never,
    )
    const read = await readPartitionIntent({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: PARTITION,
      deviceId: DEVICE_A,
      epochBucket: intentEpochBucket(NOW),
      timeoutMs: 20,
    })
    expect(read).toBeUndefined()
  })

  it("writes the intent non-deferred so a peer's gateway can retrieve it", async () => {
    // Regression: a deferred write stays on the writer's gateway and is never
    // push-synced into the neighborhood, so a peer's retrieval of the fresh
    // address finds nothing → the intent round is a no-op and both devices win.
    const fetchSpy = vi.spyOn(global, "fetch")
    await writePartitionIntent({
      bee: bee as unknown as Bee,
      stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: PARTITION,
      deviceId: DEVICE_A,
      epochBucket: intentEpochBucket(NOW),
      generation: gen(1000, DEVICE_A),
    })
    const socCall = fetchSpy.mock.calls.find(([u]) =>
      (typeof u === "string" ? u : String(u)).includes("/soc/"),
    )
    expect(socCall).toBeDefined()
    const headers = (socCall![1]?.headers ?? {}) as Record<string, string>
    expect(headers["swarm-deferred-upload"]).toBe("false")
  })
})

describe("resolveIntentRound", () => {
  const common = () => ({
    bee: bee as unknown as Bee,
    stamper,
    backupSigner: BACKUP_SIGNER,
    swarmEncryptionKey: TEST_ENC_KEY,
    partition: PARTITION,
    now: NOW,
    timeoutMs: 50,
  })

  it("wins by default when there are no known rivals", async () => {
    const outcome = await resolveIntentRound({
      ...common(),
      deviceId: DEVICE_A,
      generation: gen(1000, DEVICE_A),
      knownDeviceIds: [DEVICE_A],
    })
    expect(outcome).toBe("win")
  })

  it("wins when the only rival has no intent present", async () => {
    const outcome = await resolveIntentRound({
      ...common(),
      deviceId: DEVICE_B,
      generation: gen(2000, DEVICE_B),
      knownDeviceIds: [DEVICE_A, DEVICE_B],
    })
    expect(outcome).toBe("win")
  })

  it("loses to a rival advertising an earlier (smaller) generation", async () => {
    // DEVICE_A advertised first (smaller timestamp) in the same epoch.
    await writePartitionIntent({
      bee: bee as unknown as Bee,
      stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: PARTITION,
      deviceId: DEVICE_A,
      epochBucket: intentEpochBucket(NOW),
      generation: gen(1000, DEVICE_A),
    })

    const outcome = await resolveIntentRound({
      ...common(),
      deviceId: DEVICE_B,
      generation: gen(2000, DEVICE_B),
      knownDeviceIds: [DEVICE_A, DEVICE_B],
    })
    expect(outcome).toBe("lose")
  })

  it("wins over a rival advertising a later (greater) generation", async () => {
    await writePartitionIntent({
      bee: bee as unknown as Bee,
      stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: PARTITION,
      deviceId: DEVICE_A,
      epochBucket: intentEpochBucket(NOW),
      generation: gen(3000, DEVICE_A),
    })

    const outcome = await resolveIntentRound({
      ...common(),
      deviceId: DEVICE_B,
      generation: gen(2000, DEVICE_B),
      knownDeviceIds: [DEVICE_A, DEVICE_B],
    })
    expect(outcome).toBe("win")
  })

  it("sees a rival's intent from the previous epoch bucket (boundary)", async () => {
    // DEVICE_A advertised in the previous bucket; DEVICE_B contends now.
    await writePartitionIntent({
      bee: bee as unknown as Bee,
      stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: PARTITION,
      deviceId: DEVICE_A,
      epochBucket: intentEpochBucket(NOW) - 1,
      generation: gen(1000, DEVICE_A),
    })

    const outcome = await resolveIntentRound({
      ...common(),
      deviceId: DEVICE_B,
      generation: gen(2000, DEVICE_B),
      knownDeviceIds: [DEVICE_A, DEVICE_B],
    })
    expect(outcome).toBe("lose")
  })

  it("exactly one of two symmetric contenders wins", async () => {
    // Both run the round against each other in the same epoch. Whichever
    // advertises the smaller generation wins; the other loses. Run A first so
    // its intent is visible when B reads.
    const a = await resolveIntentRound({
      ...common(),
      deviceId: DEVICE_A,
      generation: gen(1000, DEVICE_A),
      knownDeviceIds: [DEVICE_A, DEVICE_B],
    })
    const b = await resolveIntentRound({
      ...common(),
      deviceId: DEVICE_B,
      generation: gen(2000, DEVICE_B),
      knownDeviceIds: [DEVICE_A, DEVICE_B],
    })
    expect([a, b].filter((o) => o === "win")).toHaveLength(1)
    expect(a).toBe("win")
    expect(b).toBe("lose")
  })
})
