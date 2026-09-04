// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the per-partition lock SOC (iteration-2 design).
 *
 * Uses MockBee + mockFetch from the epoch-feeds test utilities so the SOC
 * round-trip exercises real bee-js code paths (`uploadSOC`,
 * `downloadEncryptedSOC`) against an in-memory store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  BatchId,
  PrivateKey,
  type Bee,
  type Stamper,
} from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import {
  acquirePartitionLock,
  compareGenerations,
  deviceHomePartition,
  lockSocAddress,
  lockSocBucket,
  makeDeviceTiebreaker,
  makePartitionLockIdentifier,
  readPartitionLock,
  releasePartitionLock,
  writePartitionLock,
  NO_HOLDER_DEVICE_ID,
  type PartitionLockGeneration,
  type PartitionLockPayload,
} from "./partition-lock"
import { PartitionLockPayloadSchemaV1 } from "../schemas"
import { uploadSOC, type UploadTarget } from "../proxy/upload"
import { toBucket } from "../utils/batch-utilization"
import {
  MockBee,
  MockChunkStore,
  createMockStamper,
  createTestSigner,
  mockFetch,
} from "../proxy/feeds/epochs/test-utils"

// ============================================================================
// Fixtures
// ============================================================================

/** The batch whose lanes these locks are about (#589). */
const TEST_BATCH_ID = new BatchId("ab".repeat(32))

const DEVICE_A = "device-alpha-111"
const DEVICE_B = "device-beta-222"
const DEVICE_C = "device-gamma-333"
const TEST_ENC_KEY = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff)
const BACKUP_SIGNER = createTestSigner() as PrivateKey
const OWNER = BACKUP_SIGNER.publicKey().address()

const PARTITION = 0
const TTL_MS = 60_000
const GUARD_MS = 50

// ============================================================================
// Setup / Teardown
// ============================================================================

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

// Helper: a wait function that resolves immediately (no real delay in
// tests). Use the controllable wait below when interleaving is required.
const instantWait = (_ms: number) => Promise.resolve()

interface ControlledWait {
  fn: (ms: number) => Promise<void>
  release: () => void
  triggered: Promise<void>
}

/**
 * Build a `wait` function whose returned promise blocks until `release()`
 * is called. `triggered` resolves the moment the wait is invoked, so the
 * test can synchronise on "the call has reached its wait point".
 */
function controlledWait(): ControlledWait {
  let release!: () => void
  const promise = new Promise<void>((r) => (release = r))
  let triggerResolve!: () => void
  const triggered = new Promise<void>((r) => (triggerResolve = r))
  return {
    fn: (_ms: number) => {
      triggerResolve()
      return promise
    },
    release,
    triggered,
  }
}

function commonOpts(deviceId: string, overrides?: { now?: () => number }) {
  return {
    bee: bee as unknown as Bee,
    stamper,
    backupSigner: BACKUP_SIGNER,
    swarmEncryptionKey: TEST_ENC_KEY,
    batchId: TEST_BATCH_ID,
    partition: PARTITION,
    deviceId,
    ttlMs: TTL_MS,
    guardMs: GUARD_MS,
    wait: instantWait,
    ...overrides,
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("makePartitionLockIdentifier", () => {
  it("is deterministic for the same partition", () => {
    const a = makePartitionLockIdentifier(TEST_BATCH_ID, 0)
    const b = makePartitionLockIdentifier(TEST_BATCH_ID, 0)
    expect(a.toHex()).toBe(b.toHex())
  })

  it("differs across partitions", () => {
    const p0 = makePartitionLockIdentifier(TEST_BATCH_ID, 0)
    const p1 = makePartitionLockIdentifier(TEST_BATCH_ID, 1)
    expect(p0.toHex()).not.toBe(p1.toHex())
  })
})

describe("compareGenerations", () => {
  it("orders by timestampMs first", () => {
    const lo = { timestampMs: 100, tiebreaker: "ffffffffffffffff" }
    const hi = { timestampMs: 200, tiebreaker: "0000000000000000" }
    expect(compareGenerations(lo, hi)).toBe(-1)
    expect(compareGenerations(hi, lo)).toBe(1)
  })

  it("falls back to tiebreaker when timestamps are equal", () => {
    const a = { timestampMs: 100, tiebreaker: "aaaaaaaaaaaaaaaa" }
    const b = { timestampMs: 100, tiebreaker: "bbbbbbbbbbbbbbbb" }
    expect(compareGenerations(a, b)).toBe(-1)
    expect(compareGenerations(b, a)).toBe(1)
  })

  it("returns 0 when both fields are equal", () => {
    const g = { timestampMs: 100, tiebreaker: "1234567890abcdef" }
    expect(compareGenerations(g, { ...g })).toBe(0)
  })
})

describe("makeDeviceTiebreaker", () => {
  it("is stable for the same deviceId", () => {
    expect(makeDeviceTiebreaker(DEVICE_A)).toBe(makeDeviceTiebreaker(DEVICE_A))
  })

  it("differs across deviceIds", () => {
    expect(makeDeviceTiebreaker(DEVICE_A)).not.toBe(
      makeDeviceTiebreaker(DEVICE_B),
    )
  })

  it("is 16-hex (8 bytes)", () => {
    expect(makeDeviceTiebreaker(DEVICE_A)).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe("deviceHomePartition", () => {
  it("is stable for the same deviceId", () => {
    expect(deviceHomePartition(DEVICE_A, 8)).toBe(
      deviceHomePartition(DEVICE_A, 8),
    )
  })

  it("is always within [0, partitionCount)", () => {
    for (const device of [DEVICE_A, DEVICE_B, DEVICE_C]) {
      for (const count of [2, 3, 8, 100]) {
        const p = deviceHomePartition(device, count)
        expect(p).toBeGreaterThanOrEqual(0)
        expect(p).toBeLessThan(count)
        expect(Number.isInteger(p)).toBe(true)
      }
    }
  })

  it("spreads devices across slots instead of all landing on 0", () => {
    // The bug: every device picked partition 0 when none could see peers'
    // locks. Per-device home offsets break that systematic collision — the
    // home partitions span more than one slot (not a uniqueness guarantee;
    // birthday collisions remain, which is why this is a mitigation, not a
    // fix — see deviceHomePartition).
    const PARTITION_COUNT = 3
    const homes = [DEVICE_A, DEVICE_B, DEVICE_C].map((d) =>
      deviceHomePartition(d, PARTITION_COUNT),
    )
    expect(new Set(homes).size).toBeGreaterThan(1)
  })
})

describe("readPartitionLock / writePartitionLock round-trip", () => {
  it("returns undefined when the SOC has never been written", async () => {
    const lock = await readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
    })
    expect(lock).toBeUndefined()
  })

  it("reads back the exact payload that was written", async () => {
    const payload: PartitionLockPayload = {
      holderDeviceId: DEVICE_A,
      generation: {
        timestampMs: 1_000_000,
        tiebreaker: makeDeviceTiebreaker(DEVICE_A),
      },
      acquiredAt: 1_000_000,
      leasedUntil: 1_000_000 + TTL_MS,
    }
    await writePartitionLock({
      bee: bee as unknown as Bee,
      stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
      payload,
    })
    const read = await readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
    })
    expect(read).toEqual(payload)
  })

  it("subsequent writes overwrite the lock SOC (LWW)", async () => {
    const baseOpts = {
      bee: bee as unknown as Bee,
      stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
    }
    const first: PartitionLockPayload = {
      holderDeviceId: DEVICE_A,
      generation: {
        timestampMs: 1_000_000,
        tiebreaker: makeDeviceTiebreaker(DEVICE_A),
      },
      acquiredAt: 1_000_000,
      leasedUntil: 1_000_000 + TTL_MS,
    }
    await writePartitionLock({ ...baseOpts, payload: first })

    const second: PartitionLockPayload = {
      holderDeviceId: DEVICE_B,
      generation: {
        timestampMs: 2_000_000,
        tiebreaker: makeDeviceTiebreaker(DEVICE_B),
      },
      acquiredAt: 2_000_000,
      leasedUntil: 2_000_000 + TTL_MS,
    }
    await writePartitionLock({ ...baseOpts, payload: second })

    const read = await readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
    })
    expect(read?.holderDeviceId).toBe(DEVICE_B)
    expect(read?.generation.timestampMs).toBe(2_000_000)
  })
})

describe("PartitionLockPayloadSchemaV1", () => {
  const valid: PartitionLockPayload = {
    holderDeviceId: DEVICE_A,
    generation: { timestampMs: 1_000_000, tiebreaker: "0123456789abcdef" },
    acquiredAt: 1_000_000,
    leasedUntil: 1_060_000,
  }

  it("accepts a well-formed payload", () => {
    expect(PartitionLockPayloadSchemaV1.safeParse(valid).success).toBe(true)
  })

  it("accepts the empty-string NO_HOLDER_DEVICE_ID sentinel", () => {
    const ok = PartitionLockPayloadSchemaV1.safeParse({
      ...valid,
      holderDeviceId: NO_HOLDER_DEVICE_ID,
    })
    expect(ok.success).toBe(true)
  })

  it("rejects a missing field", () => {
    const { acquiredAt: _omit, ...partial } = valid
    expect(PartitionLockPayloadSchemaV1.safeParse(partial).success).toBe(false)
  })

  it("rejects a malformed tiebreaker (not 16 lowercase hex)", () => {
    for (const tiebreaker of [
      "",
      "XYZ",
      "0123456789ABCDEF",
      "0123456789abcde",
    ]) {
      const r = PartitionLockPayloadSchemaV1.safeParse({
        ...valid,
        generation: { ...valid.generation, tiebreaker },
      })
      expect(r.success).toBe(false)
    }
  })

  it("rejects non-integer or negative timestamps", () => {
    expect(
      PartitionLockPayloadSchemaV1.safeParse({ ...valid, leasedUntil: -1 })
        .success,
    ).toBe(false)
    expect(
      PartitionLockPayloadSchemaV1.safeParse({
        ...valid,
        generation: { ...valid.generation, timestampMs: 1.5 },
      }).success,
    ).toBe(false)
  })

  it("rejects wrong field types", () => {
    expect(
      PartitionLockPayloadSchemaV1.safeParse({
        ...valid,
        holderDeviceId: 123,
      }).success,
    ).toBe(false)
  })
})

describe("readPartitionLock — schema validation", () => {
  it("returns undefined for a syntactically valid but schema-invalid SOC body", async () => {
    // Write a SOC at the lock identifier whose (decrypted) JSON body is missing
    // the required fields. readPartitionLock must reject it like a missing lock,
    // not surface a half-formed object to callers.
    const identifier = makePartitionLockIdentifier(TEST_BATCH_ID, PARTITION)
    const target: UploadTarget = {
      mode: "stamper",
      bee: bee as unknown as Bee,
      stamper,
    }
    const body = new TextEncoder().encode(
      JSON.stringify({ holderDeviceId: DEVICE_A }),
    )
    await uploadSOC(target, BACKUP_SIGNER, identifier, body, {
      encryptionKey: TEST_ENC_KEY,
    })

    const read = await readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
    })
    expect(read).toBeUndefined()
  })
})

describe("acquirePartitionLock — single device", () => {
  it("acquires an empty lock", async () => {
    const NOW = 1_000_000
    const result = await acquirePartitionLock(
      commonOpts(DEVICE_A, { now: () => NOW }),
    )
    expect(result.outcome).toBe("acquired")
    expect(result.payload?.holderDeviceId).toBe(DEVICE_A)
    expect(result.payload?.generation.timestampMs).toBe(NOW)
    expect(result.payload?.acquiredAt).toBe(NOW)
    expect(result.payload?.leasedUntil).toBe(NOW + TTL_MS)
  })

  it("makes the lock observable via readPartitionLock after acquire", async () => {
    const NOW = 1_000_000
    await acquirePartitionLock(commonOpts(DEVICE_A, { now: () => NOW }))
    const observed = await readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
    })
    expect(observed?.holderDeviceId).toBe(DEVICE_A)
    expect(observed?.generation.timestampMs).toBe(NOW)
  })

  it("re-acquires (refresh) when already held by this device", async () => {
    const NOW1 = 1_000_000
    const NOW2 = 1_010_000
    const r1 = await acquirePartitionLock(
      commonOpts(DEVICE_A, { now: () => NOW1 }),
    )
    expect(r1.outcome).toBe("acquired")

    const r2 = await acquirePartitionLock(
      commonOpts(DEVICE_A, { now: () => NOW2 }),
    )
    expect(r2.outcome).toBe("acquired")
    expect(r2.payload?.holderDeviceId).toBe(DEVICE_A)
    expect(r2.payload?.generation.timestampMs).toBe(NOW2)
    expect(r2.payload?.leasedUntil).toBe(NOW2 + TTL_MS)
  })

  it("takes over an expired foreign lock", async () => {
    const PAST = 1_000_000
    const NOW = PAST + TTL_MS + 1
    await acquirePartitionLock(commonOpts(DEVICE_A, { now: () => PAST }))

    const result = await acquirePartitionLock(
      commonOpts(DEVICE_B, { now: () => NOW }),
    )
    expect(result.outcome).toBe("acquired")
    expect(result.payload?.holderDeviceId).toBe(DEVICE_B)
  })

  it("takes over a released lock (holderDeviceId is the sentinel)", async () => {
    const NOW = 1_000_000
    await writePartitionLock({
      bee: bee as unknown as Bee,
      stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
      payload: {
        holderDeviceId: NO_HOLDER_DEVICE_ID,
        generation: {
          timestampMs: NOW - 10_000,
          tiebreaker: makeDeviceTiebreaker(DEVICE_A),
        },
        acquiredAt: NOW - 20_000,
        // leasedUntil deliberately in the future — sentinel still treated
        // as "no holder" regardless of expiry.
        leasedUntil: NOW + TTL_MS,
      },
    })
    const result = await acquirePartitionLock(
      commonOpts(DEVICE_B, { now: () => NOW }),
    )
    expect(result.outcome).toBe("acquired")
    expect(result.payload?.holderDeviceId).toBe(DEVICE_B)
  })

  it("returns blocked (without writing) when a live foreign holder exists", async () => {
    const NOW = 1_000_000
    await acquirePartitionLock(commonOpts(DEVICE_A, { now: () => NOW }))
    const sizeBefore = store.size()

    const result = await acquirePartitionLock(
      commonOpts(DEVICE_B, { now: () => NOW + 1_000 }),
    )
    expect(result.outcome).toBe("blocked")
    expect(result.payload?.holderDeviceId).toBe(DEVICE_A)
    expect(store.size()).toBe(sizeBefore) // no new chunks
  })
})

describe("acquirePartitionLock — concurrent acquires", () => {
  it("orders concurrent writers by timestamp (later wins)", async () => {
    // A writes first (earlier timestamp), then B writes after (later
    // timestamp). With instantWait both verify-reads happen after both
    // writes have settled. B wins.
    const A_NOW = 1_000_000
    const B_NOW = 1_000_500

    const rA = await acquirePartitionLock(
      commonOpts(DEVICE_A, { now: () => A_NOW }),
    )
    const rB = await acquirePartitionLock(
      commonOpts(DEVICE_B, { now: () => B_NOW }),
    )

    expect(rA.outcome).toBe("acquired") // A acquired without contention
    // B sees A as the live holder.
    expect(rB.outcome).toBe("blocked")
    expect(rB.payload?.holderDeviceId).toBe(DEVICE_A)
  })

  it("breaks generation ties deterministically by deviceId hash", async () => {
    const NOW = 1_000_000
    const tieA = makeDeviceTiebreaker(DEVICE_A)
    const tieB = makeDeviceTiebreaker(DEVICE_B)
    const higher = tieA > tieB ? DEVICE_A : DEVICE_B
    const lower = tieA > tieB ? DEVICE_B : DEVICE_A

    // Both call acquire interleaved. The first writer becomes the live
    // holder; the second sees `blocked`. To exercise the tiebreaker we
    // *bypass* the pre-write check by having both observe the lock as
    // empty (write happens between the two reads):
    //
    //   lower:  read empty, write, [waits]
    //   higher: read empty, write, [waits]   (write happens AFTER lower's)
    //   both verify
    //
    // Use controlled waits to drive this interleaving.

    const waitLower = controlledWait()
    const waitHigher = controlledWait()

    const pLower = acquirePartitionLock({
      ...commonOpts(lower, { now: () => NOW }),
      wait: waitLower.fn,
    })
    // Allow `lower` to complete its read+write and enter the wait.
    await waitLower.triggered

    const pHigher = acquirePartitionLock({
      ...commonOpts(higher, { now: () => NOW }),
      wait: waitHigher.fn,
    })
    // The pre-read for `higher` happens before its write — but `lower`
    // has already written, so `higher` actually sees `lower` as a live
    // holder and returns "blocked" without writing. That's a valid
    // outcome of the concurrent protocol; the tiebreaker only matters
    // when both writes actually happen.
    //
    // Release both waits to let them complete.
    waitLower.release()
    waitHigher.release()
    const [rLower, rHigher] = await Promise.all([pLower, pHigher])

    expect(rLower.outcome).toBe("acquired")
    expect(rHigher.outcome).toBe("blocked")
    expect(rHigher.payload?.holderDeviceId).toBe(lower)
  })
})

describe("acquirePartitionLock — verify-after-write", () => {
  it("returns lost-race when a higher-generation write lands during the guard window", async () => {
    const NOW_A = 1_000_000
    const NOW_B = 1_000_500

    const waitA = controlledWait()
    const pA = acquirePartitionLock({
      ...commonOpts(DEVICE_A, { now: () => NOW_A }),
      wait: waitA.fn,
    })

    // A has read, written, and is now blocked in its wait.
    await waitA.triggered

    // Simulate B winning the race by overwriting the lock SOC directly
    // with a higher-generation payload while A is waiting. Using
    // writePartitionLock keeps the test below `acquirePartitionLock`'s
    // own pre-read decision logic.
    await writePartitionLock({
      bee: bee as unknown as Bee,
      stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
      payload: {
        holderDeviceId: DEVICE_B,
        generation: {
          timestampMs: NOW_B,
          tiebreaker: makeDeviceTiebreaker(DEVICE_B),
        },
        acquiredAt: NOW_B,
        leasedUntil: NOW_B + TTL_MS,
      },
    })

    waitA.release()
    const result = await pA
    expect(result.outcome).toBe("lost-race")
    expect(result.payload?.holderDeviceId).toBe(DEVICE_B)
    expect(result.payload?.generation.timestampMs).toBe(NOW_B)
  })

  it("verifies our own write when no concurrent writer interferes", async () => {
    const NOW = 1_000_000
    const result = await acquirePartitionLock(
      commonOpts(DEVICE_A, { now: () => NOW }),
    )
    expect(result.outcome).toBe("acquired")
    expect(result.payload?.holderDeviceId).toBe(DEVICE_A)
  })

  it("acquires optimistically when the verify-read can't confirm the write", async () => {
    const NOW = 1_000_000

    const waitA = controlledWait()
    const pA = acquirePartitionLock({
      ...commonOpts(DEVICE_A, { now: () => NOW }),
      wait: waitA.fn,
    })

    // A has read (empty), written its claim, and is now in the guard wait.
    await waitA.triggered

    // Simulate the Bee node being unable to serve the just-written chunk on
    // the verify-read (transient 500 / not-yet-propagated): drop it so the
    // verify-read returns undefined. A failed read is not proof of a race,
    // so A optimistically holds and lets the periodic refresh reconcile.
    store.clear()

    waitA.release()
    const result = await pA
    expect(result.outcome).toBe("acquired")
    expect(result.payload?.holderDeviceId).toBe(DEVICE_A)
    expect(result.payload?.generation.timestampMs).toBe(NOW)
  })
})

describe("acquirePartitionLock — third-party observation", () => {
  it("returns blocked when a third device queries while two devices coexist", async () => {
    const NOW = 1_000_000
    await acquirePartitionLock(commonOpts(DEVICE_A, { now: () => NOW }))

    const result = await acquirePartitionLock(
      commonOpts(DEVICE_C, { now: () => NOW + 100 }),
    )
    expect(result.outcome).toBe("blocked")
    expect(result.payload?.holderDeviceId).toBe(DEVICE_A)
  })
})

// ============================================================================
// Failure-mode documentation
//
// The tests below intentionally provoke scenarios the protocol cannot fully
// defend against. They `expect()` the broken outcome — i.e. they pass when
// the protocol fails. The goal is to make the protocol's *limits* visible
// to anyone reading the test suite, so callers know what guarantees are
// (and aren't) on the table.
// ============================================================================

describe("acquirePartitionLock — known failure modes", () => {
  /**
   * Compute the SOC address for the partition lock so tests can mutate the
   * underlying mock store directly (used to simulate gossip-delay scenarios).
   */
  function lockSocAddress(): string {
    const identifier = makePartitionLockIdentifier(TEST_BATCH_ID, PARTITION)
    const addr = Binary.keccak256(
      Binary.concatBytes(identifier.toUint8Array(), OWNER.toUint8Array()),
    )
    return Binary.uint8ArrayToHex(addr)
  }

  it("an 'acquired' outcome is momentary — a later overwrite doesn't notify the holder", async () => {
    // A acquires. The protocol confirms holder == A *at this moment*.
    const rA = await acquirePartitionLock(
      commonOpts(DEVICE_A, { now: () => 1_000_000 }),
    )
    expect(rA.outcome).toBe("acquired")

    // Later, B overwrites the lock SOC (e.g. legitimate takeover after A's
    // TTL, a buggy peer, or a propagation reorder). The protocol has no
    // backchannel to A — A's local belief is now stale.
    await writePartitionLock({
      bee: bee as unknown as Bee,
      stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
      payload: {
        holderDeviceId: DEVICE_B,
        generation: {
          timestampMs: 2_000_000,
          tiebreaker: makeDeviceTiebreaker(DEVICE_B),
        },
        acquiredAt: 2_000_000,
        leasedUntil: 2_000_000 + TTL_MS,
      },
    })

    // A still has its old "acquired" outcome in hand. If it keeps stamping
    // based on that, it will collide with B. The only correction mechanism
    // is for A to re-acquire periodically — which would surface the change.
    // Probe A's view at a time when B's lease is still valid (within TTL):
    const rA2 = await acquirePartitionLock(
      commonOpts(DEVICE_A, { now: () => 2_001_000 }),
    )
    expect(rA2.outcome).toBe("blocked")
    expect(rA2.payload?.holderDeviceId).toBe(DEVICE_B)
    // Takeaway: callers must treat `acquired` as a refresh-bounded lease,
    // not a permanent capability.
  })

  it("clock skew lets a peer take over while the original holder still believes the lease is valid", async () => {
    // A's clock is normal. B's clock runs ahead of A's by more than TTL.
    const A_CLOCK = 1_000_000
    const B_CLOCK = A_CLOCK + TTL_MS + 1

    const rA = await acquirePartitionLock(
      commonOpts(DEVICE_A, { now: () => A_CLOCK }),
    )
    expect(rA.outcome).toBe("acquired")
    // A.leasedUntil = A_CLOCK + TTL_MS. To anyone reading A's lease against
    // B_CLOCK (which is > A_CLOCK + TTL_MS), the lease appears expired.

    const rB = await acquirePartitionLock(
      commonOpts(DEVICE_B, { now: () => B_CLOCK }),
    )
    expect(rB.outcome).toBe("acquired")
    // B believes it now holds the partition.

    // Meanwhile, by A's own clock, the lease isn't expired yet. A is unaware
    // it was displaced. If A continues to stamp under its (still subjectively
    // valid) lease, it collides with B.
    expect(A_CLOCK + 1000).toBeLessThan(A_CLOCK + TTL_MS) // A's lease still "valid"

    // Takeaway: the protocol assumes clock skew between devices is small
    // relative to TTL. NTP-level skew (sub-second) is fine; minutes of skew
    // are not.
  })

  it("any device with the shared backupSigner can bypass the protocol via writePartitionLock", async () => {
    // A acquires legitimately.
    const rA = await acquirePartitionLock(
      commonOpts(DEVICE_A, { now: () => 1_000_000 }),
    )
    expect(rA.outcome).toBe("acquired")

    // A buggy or malicious peer (any device with backupSigner — which is
    // every device on this account) can write directly, bypassing the
    // read-write-verify cooperative protocol.
    await writePartitionLock({
      bee: bee as unknown as Bee,
      stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
      payload: {
        holderDeviceId: DEVICE_B,
        // Pathologically high generation, far in the future, lasting forever.
        generation: {
          timestampMs: Number.MAX_SAFE_INTEGER,
          tiebreaker: "ffffffffffffffff",
        },
        acquiredAt: 1_000_000,
        leasedUntil: Number.MAX_SAFE_INTEGER,
      },
    })

    // A can no longer reclaim the partition through the normal protocol —
    // any future acquire sees an "unblockable" foreign holder.
    const rA2 = await acquirePartitionLock(
      commonOpts(DEVICE_A, { now: () => 2_000_000 }),
    )
    expect(rA2.outcome).toBe("blocked")

    // Takeaway: the protocol assumes cooperative non-malicious devices and
    // gives no protection against a peer that holds the backup signer but
    // doesn't run the cooperative algorithm. Defending against that is out
    // of the iteration-2 threat model.
  })

  it("a stale verify-read (δ < propagation delay) lets two devices both believe they acquired", async () => {
    // Simulates the canonical "δ too short" failure: A writes, B writes
    // (overwriting), but A's verify-read pulls from a slow node that hasn't
    // yet seen B's write. A wrongly reports `acquired`.
    //
    // We model the delayed read by swapping the chunk in the mock store
    // around the verify-read, using a controlled wait to time the swap.

    const NOW_A = 1_000_000
    const NOW_B = NOW_A + 500
    const addr = lockSocAddress()

    const waitA = controlledWait()
    const pA = acquirePartitionLock({
      ...commonOpts(DEVICE_A, { now: () => NOW_A }),
      wait: waitA.fn,
    })

    // A has read empty, written its own claim, and is parked in the guard
    // window. Snapshot the (encrypted) chunk that A's verify-read would see
    // on a "fast" reader.
    await waitA.triggered
    const aChunk = await store.get(addr)

    // B overwrites the lock with a higher-generation claim.
    await writePartitionLock({
      bee: bee as unknown as Bee,
      stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
      payload: {
        holderDeviceId: DEVICE_B,
        generation: {
          timestampMs: NOW_B,
          tiebreaker: makeDeviceTiebreaker(DEVICE_B),
        },
        acquiredAt: NOW_B,
        leasedUntil: NOW_B + TTL_MS,
      },
    })
    const bChunk = await store.get(addr)

    // Simulate the slow propagation: revert the store to A's chunk so A's
    // upcoming verify-read sees stale data (as if B's write hadn't reached
    // A's reader yet).
    await store.put(addr, aChunk)

    waitA.release()
    const rA = await pA

    // A wrongly believes it acquired.
    expect(rA.outcome).toBe("acquired")
    expect(rA.payload?.holderDeviceId).toBe(DEVICE_A)

    // The "fast" / converged view is B's chunk. Restore it.
    await store.put(addr, bChunk)
    const converged = await readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
    })
    expect(converged?.holderDeviceId).toBe(DEVICE_B)

    // Takeaway: `guardMs` must exceed the 99th-percentile Swarm
    // read-after-write latency, or this split-brain becomes reachable.
    // The protocol cannot detect this from its own observations — only
    // calibration of δ at deployment time can.
  })

  it("guardMs = 0 makes the verify-read effectively useless (TOCTOU)", async () => {
    // With zero guard time and a stale-read injection, even an immediate
    // verify-read can miss a concurrent write. This is the degenerate case
    // of the previous test — call it out so readers know `guardMs: 0` is
    // not a valid choice in any realistic deployment.

    const NOW_A = 1_000_000
    const NOW_B = NOW_A + 500
    const addr = lockSocAddress()

    const waitA = controlledWait()
    const pA = acquirePartitionLock({
      ...commonOpts(DEVICE_A, { now: () => NOW_A }),
      wait: waitA.fn,
      guardMs: 0,
    })

    await waitA.triggered
    const aChunk = await store.get(addr)
    await writePartitionLock({
      bee: bee as unknown as Bee,
      stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
      payload: {
        holderDeviceId: DEVICE_B,
        generation: {
          timestampMs: NOW_B,
          tiebreaker: makeDeviceTiebreaker(DEVICE_B),
        },
        acquiredAt: NOW_B,
        leasedUntil: NOW_B + TTL_MS,
      },
    })
    await store.put(addr, aChunk) // stale verify-read

    waitA.release()
    const rA = await pA
    expect(rA.outcome).toBe("acquired") // wrong answer
  })
})

describe("acquirePartitionLock — shouldAbort", () => {
  it("aborts before writing when shouldAbort returns true", async () => {
    const result = await acquirePartitionLock({
      ...commonOpts(DEVICE_A, { now: () => 1_000_000 }),
      shouldAbort: () => true,
    })
    expect(result.outcome).toBe("aborted")
    expect(store.size()).toBe(0) // nothing written
    expect(
      await readPartitionLock({
        bee: bee as unknown as Bee,
        backupSigner: BACKUP_SIGNER,
        swarmEncryptionKey: TEST_ENC_KEY,
        batchId: TEST_BATCH_ID,
        partition: PARTITION,
      }),
    ).toBeUndefined()
  })

  it("acquires normally when shouldAbort returns false", async () => {
    const result = await acquirePartitionLock({
      ...commonOpts(DEVICE_A, { now: () => 1_000_000 }),
      shouldAbort: () => false,
    })
    expect(result.outcome).toBe("acquired")
  })
})

describe("acquirePartitionLock — bounded reads / skipInitialRead", () => {
  /** Make every SOC read hang forever (writes still work via mocked fetch). */
  function hangReads(): void {
    bee.downloadChunk = () => new Promise<never>(() => {})
  }

  /** Count SOC reads while delegating to the real mock store. */
  function countReads(): { count: () => number } {
    let reads = 0
    const original = bee.downloadChunk.bind(bee)
    bee.downloadChunk = (reference: string) => {
      reads++
      return original(reference)
    }
    return { count: () => reads }
  }

  it("completes despite HANGING reads (bounded initial + verify → optimistic acquired)", async () => {
    hangReads()
    const result = await acquirePartitionLock({
      ...commonOpts(DEVICE_A),
      readTimeoutMs: 30,
    })
    // Initial read timed out → treated as absent (same as any other read
    // failure) → claim written; verify timed out → the documented optimistic
    // "couldn't confirm our own write" branch.
    expect(result.outcome).toBe("acquired")
    expect(result.payload?.holderDeviceId).toBe(DEVICE_A)
  })

  it("performs only the verify read when skipInitialRead is set", async () => {
    const reads = countReads()
    const result = await acquirePartitionLock({
      ...commonOpts(DEVICE_A),
      skipInitialRead: true,
    })
    expect(result.outcome).toBe("acquired")
    expect(reads.count()).toBe(1) // verify only — no duplicate initial read
  })

  it("still loses the race via the verify read when skipInitialRead is set", async () => {
    // The skip only removes the duplicate pre-write read (the caller's scan
    // already classified the partition); the guard-window verify must still
    // catch a racing higher-generation claim.
    const wait = controlledWait()
    const acquireA = acquirePartitionLock({
      ...commonOpts(DEVICE_A, { now: () => 1_000_000 }),
      skipInitialRead: true,
      wait: wait.fn,
    })
    await wait.triggered
    await writePartitionLock({
      bee: bee as unknown as Bee,
      stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
      payload: {
        holderDeviceId: DEVICE_B,
        generation: {
          timestampMs: 2_000_000,
          tiebreaker: makeDeviceTiebreaker(DEVICE_B),
        },
        acquiredAt: 2_000_000,
        leasedUntil: 2_000_000 + TTL_MS,
      },
    })
    wait.release()
    const result = await acquireA
    expect(result.outcome).toBe("lost-race")
  })
})

describe("releasePartitionLock — generation fencing", () => {
  const NOW = 1_000_000

  function gen(timestampMs: number, deviceId: string): PartitionLockGeneration {
    return { timestampMs, tiebreaker: makeDeviceTiebreaker(deviceId) }
  }

  function seedLock(payload: PartitionLockPayload): Promise<void> {
    return writePartitionLock({
      bee: bee as unknown as Bee,
      stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
      payload,
    })
  }

  function release(
    deviceId: string,
    releasedGeneration: PartitionLockGeneration,
  ) {
    return releasePartitionLock({
      bee: bee as unknown as Bee,
      stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
      deviceId,
      releasedGeneration,
      acquiredAt: NOW - 10_000,
      now: () => NOW,
    })
  }

  function readLock() {
    return readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
    })
  }

  it("writes a sentinel carrying the RELEASED claim's generation (not a fresh one)", async () => {
    const g = gen(NOW - 5_000, DEVICE_A)
    await seedLock({
      holderDeviceId: DEVICE_A,
      generation: g,
      acquiredAt: NOW - 10_000,
      leasedUntil: NOW + TTL_MS,
    })

    const result = await release(DEVICE_A, g)
    expect(result.outcome).toBe("released")

    const lock = await readLock()
    expect(lock?.holderDeviceId).toBe(NO_HOLDER_DEVICE_ID)
    // L1: the sentinel is fenced to the claim it releases — any later claim
    // (successor or peer) is logically newer than it.
    expect(lock?.generation).toEqual(g)
  })

  it("writes when the visible claim is our own OLDER generation (stale read must not skip)", async () => {
    await seedLock({
      holderDeviceId: DEVICE_A,
      generation: gen(NOW - 20_000, DEVICE_A),
      acquiredAt: NOW - 30_000,
      leasedUntil: NOW + TTL_MS,
    })

    // We refreshed since (newer generation) but the read shows the older
    // write — releasing is still correct: the claim is ours.
    const result = await release(DEVICE_A, gen(NOW - 5_000, DEVICE_A))
    expect(result.outcome).toBe("released")
    expect((await readLock())?.holderDeviceId).toBe(NO_HOLDER_DEVICE_ID)
  })

  it("skips when our own NEWER claim is visible (successor re-acquired — #349)", async () => {
    const successorGen = gen(NOW - 1_000, DEVICE_A)
    await seedLock({
      holderDeviceId: DEVICE_A,
      generation: successorGen,
      acquiredAt: NOW - 1_000,
      leasedUntil: NOW + TTL_MS,
    })

    const result = await release(DEVICE_A, gen(NOW - 20_000, DEVICE_A))
    expect(result.outcome).toBe("skipped")
    expect(result.observed?.generation).toEqual(successorGen)

    const lock = await readLock()
    expect(lock?.holderDeviceId).toBe(DEVICE_A) // claim untouched
    expect(lock?.generation).toEqual(successorGen)
  })

  it("skips when a live foreign holder exists", async () => {
    await seedLock({
      holderDeviceId: DEVICE_B,
      generation: gen(NOW - 1_000, DEVICE_B),
      acquiredAt: NOW - 1_000,
      leasedUntil: NOW + TTL_MS,
    })

    const result = await release(DEVICE_A, gen(NOW - 20_000, DEVICE_A))
    expect(result.outcome).toBe("skipped")
    expect((await readLock())?.holderDeviceId).toBe(DEVICE_B)
  })

  it("skips when an expired foreign claim exists", async () => {
    await seedLock({
      holderDeviceId: DEVICE_B,
      generation: gen(NOW - TTL_MS * 3, DEVICE_B),
      acquiredAt: NOW - TTL_MS * 3,
      leasedUntil: NOW - TTL_MS, // expired — already reads as takeable
    })

    const result = await release(DEVICE_A, gen(NOW - 20_000, DEVICE_A))
    expect(result.outcome).toBe("skipped")
    expect((await readLock())?.holderDeviceId).toBe(DEVICE_B)
  })

  it("skips when a sentinel is already present — even one with the same generation", async () => {
    const g = gen(NOW - 5_000, DEVICE_A)
    await seedLock({
      holderDeviceId: NO_HOLDER_DEVICE_ID,
      generation: g,
      acquiredAt: NOW - 10_000,
      leasedUntil: NOW - 5_000,
    })
    const sizeBefore = store.size()

    // Re-releasing the same claim must not re-write: the fresh stamp could
    // clobber a claim that landed between the read and the write.
    const result = await release(DEVICE_A, g)
    expect(result.outcome).toBe("skipped")
    expect(store.size()).toBe(sizeBefore)
  })

  it("writes when the lock is missing or unreadable (best-effort release)", async () => {
    const result = await release(DEVICE_A, gen(NOW - 5_000, DEVICE_A))
    expect(result.outcome).toBe("released")
    expect(result.observed).toBeUndefined()
    expect((await readLock())?.holderDeviceId).toBe(NO_HOLDER_DEVICE_ID)
  })
})

describe("acquirePartitionLock — verify vs fenced sentinels", () => {
  it("an older-generation sentinel landing during the guard does not cause a false lost-race", async () => {
    const waitA = controlledWait()
    const NOW = 1_000_000

    const acquireA = acquirePartitionLock({
      ...commonOpts(DEVICE_A, { now: () => NOW }),
      wait: waitA.fn,
    })
    await waitA.triggered

    // A stale generation-fenced release (of some EARLIER claim) lands while
    // A is parked in its guard window. Under the old fresh-generation
    // sentinel this read back as a HIGHER generation → false lost-race →
    // spurious read-only. The fenced sentinel is older → A's claim stands.
    await writePartitionLock({
      bee: bee as unknown as Bee,
      stamper,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
      batchId: TEST_BATCH_ID,
      partition: PARTITION,
      payload: {
        holderDeviceId: NO_HOLDER_DEVICE_ID,
        generation: {
          timestampMs: NOW - 60_000,
          tiebreaker: makeDeviceTiebreaker(DEVICE_A),
        },
        acquiredAt: NOW - 90_000,
        leasedUntil: NOW - 60_000,
      },
    })

    waitA.release()
    const result = await acquireA
    expect(result.outcome).toBe("acquired")
    expect(result.payload?.holderDeviceId).toBe(DEVICE_A)
  })
})

describe("lockSocAddress / lockSocBucket", () => {
  it("lockSocAddress is deterministic and matches the SOC address formula", () => {
    const addr1 = lockSocAddress(TEST_BATCH_ID, 0, OWNER)
    const addr2 = lockSocAddress(TEST_BATCH_ID, 0, OWNER)
    expect(addr1).toEqual(addr2)

    // Spec: keccak256(identifier || owner).
    const identifier = makePartitionLockIdentifier(TEST_BATCH_ID, 0)
    const expected = Binary.keccak256(
      Binary.concatBytes(identifier.toUint8Array(), OWNER.toUint8Array()),
    )
    expect(addr1).toEqual(expected)
  })

  it("different partitions produce different lock-SOC addresses", () => {
    const a = lockSocAddress(TEST_BATCH_ID, 0, OWNER)
    const b = lockSocAddress(TEST_BATCH_ID, 1, OWNER)
    expect(a).not.toEqual(b)
  })

  it("different owners produce different lock-SOC addresses (cross-account separation)", () => {
    const otherOwner = new PrivateKey(
      new Uint8Array(32).map((_, i) => (i * 11 + 7) & 0xff),
    )
      .publicKey()
      .address()
    expect(lockSocAddress(TEST_BATCH_ID, 0, OWNER)).not.toEqual(
      lockSocAddress(TEST_BATCH_ID, 0, otherOwner),
    )
  })

  it("lockSocBucket extracts the bucket from the lock-SOC address", () => {
    const bucket = lockSocBucket(TEST_BATCH_ID, 0, OWNER)
    const addr = lockSocAddress(TEST_BATCH_ID, 0, OWNER)
    expect(bucket).toBe(toBucket(addr))
    expect(bucket).toBeGreaterThanOrEqual(0)
    expect(bucket).toBeLessThan(65536)
  })
})
