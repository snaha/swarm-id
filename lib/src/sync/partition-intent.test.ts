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
  INTENT_LIVENESS_GRACE_MS,
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

  // Note: no "non-deferred" assertion — Bee's /soc handler hardcodes
  // Deferred:false and ignores the Swarm-Deferred-Upload header (bee 2.8.0
  // pkg/api/soc.go), so SOC writes are always synchronous regardless of the
  // client flag. The deferred flag is only meaningful for /bytes data uploads.
})

describe("readPartitionIntent — a transient 5xx is not 'no intent'", () => {
  // A gateway 500 storm previously read as "rival absent" and let the
  // dual-acquire through. A 5xx is retried once; a 404 is genuine absence.
  it("retries once on a 5xx and returns the payload on the retry", async () => {
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

    const real = bee.downloadChunk.bind(bee)
    let calls = 0
    vi.spyOn(bee, "downloadChunk").mockImplementation(((...args: unknown[]) => {
      calls++
      if (calls === 1) {
        return Promise.reject(
          new Error("Request failed with status code 500"),
        ) as never
      }
      return (real as (...a: unknown[]) => unknown)(...args) as never
    }) as never)

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
    expect(calls).toBe(2) // initial 500 + one retry
  })

  it("does NOT retry a 404 (genuine absence → no intent)", async () => {
    let calls = 0
    vi.spyOn(bee, "downloadChunk").mockImplementation((() => {
      calls++
      return Promise.reject(
        new Error("Request failed with status code 404"),
      ) as never
    }) as never)

    const read = await readPartitionIntent({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: PARTITION,
      deviceId: DEVICE_A,
      epochBucket: intentEpochBucket(NOW),
    })

    expect(read).toBeUndefined()
    expect(calls).toBe(1) // no retry on a 404
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

  it("bounds the round to the guard window when rival reads are slow (no fixed-count overrun)", async () => {
    // Reproduces the "Partition lease timed out after 45000ms" cause: a flaky
    // gateway makes each rival read slow, and the fixed poll-count loop runs the
    // FULL count regardless, so a single round overruns its window by multiples.
    const READ_DELAY_MS = 80
    let reads = 0
    vi.spyOn(bee, "downloadChunk").mockImplementation((() => {
      reads++
      return new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("Request failed with status code 404")),
          READ_DELAY_MS,
        ),
      ) as never
    }) as never)

    const outcome = await resolveIntentRound({
      ...common(),
      timeoutMs: 1000, // longer than READ_DELAY_MS so the mock 404 (absent) wins
      deviceId: DEVICE_B,
      generation: gen(2000, DEVICE_B),
      knownDeviceIds: [DEVICE_A, DEVICE_B], // 1 rival → 2 reads (2 buckets) per sweep
      guardWindowMs: 150,
      guardPollMs: 40,
    })

    expect(outcome).toBe("win") // the rival has no intent → win
    // The fixed-count loop runs floor(150/40)+1 = 4 sweeps no matter how slow the
    // reads are → 4 × 2 = 8 reads. A deadline-bounded round stops once the 150ms
    // window elapses (~2 sweeps at 80ms/read), so it must do strictly fewer reads.
    expect(reads).toBeLessThan(8)
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

  it("polls across a guard window and yields to a live beacon", async () => {
    // A live holder beacon (leasedUntil > now) for DEVICE_A on this partition.
    await writePartitionIntent({
      bee: bee as unknown as Bee,
      stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: PARTITION,
      deviceId: DEVICE_A,
      epochBucket: intentEpochBucket(NOW),
      generation: gen(1000, DEVICE_A),
      leasedUntil: NOW + INTENT_EPOCH_MS,
    })
    const outcome = await resolveIntentRound({
      ...common(),
      deviceId: DEVICE_B,
      generation: gen(2000, DEVICE_B),
      knownDeviceIds: [DEVICE_A, DEVICE_B],
      guardWindowMs: 120,
      guardPollMs: 40,
    })
    expect(outcome).toBe("lose")
  })

  it("yields to a beacon whose leasedUntil lapsed WITHIN the liveness grace", async () => {
    // The propagation-lag case: the holder's freshest beacon hasn't surfaced, so
    // only its previous-bucket beacon (TTL lapsed seconds ago) is retrievable. It
    // must still count as a live holder, or both devices bind the partition.
    await writePartitionIntent({
      bee: bee as unknown as Bee,
      stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: PARTITION,
      deviceId: DEVICE_A,
      epochBucket: intentEpochBucket(NOW),
      generation: gen(1000, DEVICE_A),
      leasedUntil: NOW - 1, // lapsed, but within grace
    })
    const outcome = await resolveIntentRound({
      ...common(),
      deviceId: DEVICE_B,
      generation: gen(2000, DEVICE_B),
      knownDeviceIds: [DEVICE_A, DEVICE_B],
      guardWindowMs: 120,
      guardPollMs: 40,
    })
    expect(outcome).toBe("lose")
  })

  it("wins over a beacon whose leasedUntil lapsed BEYOND the liveness grace", async () => {
    await writePartitionIntent({
      bee: bee as unknown as Bee,
      stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: PARTITION,
      deviceId: DEVICE_A,
      epochBucket: intentEpochBucket(NOW),
      generation: gen(1000, DEVICE_A),
      leasedUntil: NOW - INTENT_LIVENESS_GRACE_MS - 1, // departed
    })
    const outcome = await resolveIntentRound({
      ...common(),
      deviceId: DEVICE_B,
      generation: gen(2000, DEVICE_B),
      knownDeviceIds: [DEVICE_A, DEVICE_B],
      guardWindowMs: 120,
      guardPollMs: 40,
    })
    expect(outcome).toBe("win")
  })

  it("polls the full guard window then wins when no rival surfaces", async () => {
    const t0 = Date.now()
    const outcome = await resolveIntentRound({
      ...common(),
      deviceId: DEVICE_B,
      generation: gen(2000, DEVICE_B),
      knownDeviceIds: [DEVICE_A, DEVICE_B],
      guardWindowMs: 120,
      guardPollMs: 40,
    })
    expect(outcome).toBe("win")
    // It actually waited out the window (didn't bind on the first immediate read).
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100)
  })

  it("wins over a live beacon at or below the release watermark (stale ghost)", async () => {
    // DEVICE_A's lingering presence beacon after it released this partition: a
    // live beacon (leasedUntil > now) carrying the released claim's generation.
    await writePartitionIntent({
      bee: bee as unknown as Bee,
      stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: PARTITION,
      deviceId: DEVICE_A,
      epochBucket: intentEpochBucket(NOW),
      generation: gen(1000, DEVICE_A),
      leasedUntil: NOW + INTENT_EPOCH_MS,
    })
    const outcome = await resolveIntentRound({
      ...common(),
      deviceId: DEVICE_B,
      generation: gen(2000, DEVICE_B),
      knownDeviceIds: [DEVICE_A, DEVICE_B],
      // The caller observed this partition freed by A's release sentinel at
      // exactly this generation — A's lingering beacon is its ghost, not a claim.
      releasedGeneration: gen(1000, DEVICE_A),
    })
    expect(outcome).toBe("win")
  })

  it("loses to a live beacon strictly newer than the release watermark (genuine post-release holder)", async () => {
    // A different device legitimately claimed the partition AFTER the release we
    // observed — its beacon outranks the watermark and must still beat us.
    await writePartitionIntent({
      bee: bee as unknown as Bee,
      stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      partition: PARTITION,
      deviceId: DEVICE_A,
      epochBucket: intentEpochBucket(NOW),
      generation: gen(3000, DEVICE_A),
      leasedUntil: NOW + INTENT_EPOCH_MS,
    })
    const outcome = await resolveIntentRound({
      ...common(),
      deviceId: DEVICE_B,
      generation: gen(2000, DEVICE_B),
      knownDeviceIds: [DEVICE_A, DEVICE_B],
      releasedGeneration: gen(1000, DEVICE_A),
    })
    expect(outcome).toBe("lose")
  })
})
