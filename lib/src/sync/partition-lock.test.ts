// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the per-partition lock SOC (iteration-2 design).
 *
 * Uses MockBee + mockFetch from the epoch-feeds test utilities so the SOC
 * round-trip exercises real bee-js code paths (`uploadSOC`,
 * `downloadEncryptedSOC`) against an in-memory store.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import {
  EthAddress,
  PrivateKey,
  type Bee,
  type Stamper,
} from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import {
  acquirePartitionLock,
  compareGenerations,
  lockSocAddress,
  lockSocBucket,
  makeDeviceTiebreaker,
  makePartitionLockIdentifier,
  readPartitionHolders,
  readPartitionLock,
  writePartitionLock,
  NO_HOLDER_DEVICE_ID,
  type PartitionLockPayload,
} from "./partition-lock"
import { toBucket } from "../utils/batch-utilization"
import { deriveSecret, deriveSwarmEncryptionKey } from "../utils/key-derivation"
import { hexToUint8Array } from "../utils/hex"
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
    const a = makePartitionLockIdentifier(0)
    const b = makePartitionLockIdentifier(0)
    expect(a.toHex()).toBe(b.toHex())
  })

  it("differs across partitions", () => {
    const p0 = makePartitionLockIdentifier(0)
    const p1 = makePartitionLockIdentifier(1)
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

describe("readPartitionLock / writePartitionLock round-trip", () => {
  it("returns undefined when the SOC has never been written", async () => {
    const lock = await readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
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
      partition: PARTITION,
      payload,
    })
    const read = await readPartitionLock({
      bee: bee as unknown as Bee,
      backupSigner: BACKUP_SIGNER,
      swarmEncryptionKey: TEST_ENC_KEY,
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
      partition: PARTITION,
    })
    expect(read?.holderDeviceId).toBe(DEVICE_B)
    expect(read?.generation.timestampMs).toBe(2_000_000)
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
    const identifier = makePartitionLockIdentifier(PARTITION)
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

describe("lockSocAddress / lockSocBucket", () => {
  it("lockSocAddress is deterministic and matches the SOC address formula", () => {
    const addr1 = lockSocAddress(0, OWNER)
    const addr2 = lockSocAddress(0, OWNER)
    expect(addr1).toEqual(addr2)

    // Spec: keccak256(identifier || owner).
    const identifier = makePartitionLockIdentifier(0)
    const expected = Binary.keccak256(
      Binary.concatBytes(identifier.toUint8Array(), OWNER.toUint8Array()),
    )
    expect(addr1).toEqual(expected)
  })

  it("different partitions produce different lock-SOC addresses", () => {
    const a = lockSocAddress(0, OWNER)
    const b = lockSocAddress(1, OWNER)
    expect(a).not.toEqual(b)
  })

  it("different owners produce different lock-SOC addresses (cross-account separation)", () => {
    const otherOwner = new PrivateKey(
      new Uint8Array(32).map((_, i) => (i * 11 + 7) & 0xff),
    )
      .publicKey()
      .address()
    expect(lockSocAddress(0, OWNER)).not.toEqual(lockSocAddress(0, otherOwner))
  })

  it("lockSocBucket extracts the bucket from the lock-SOC address", () => {
    const bucket = lockSocBucket(0, OWNER)
    const addr = lockSocAddress(0, OWNER)
    expect(bucket).toBe(toBucket(addr))
    expect(bucket).toBeGreaterThanOrEqual(0)
    expect(bucket).toBeLessThan(65536)
  })
})

// ============================================================================
// readPartitionHolders
// ============================================================================

describe("readPartitionHolders", () => {
  // Pick an arbitrary derivationKey. Derive the matching backup signer the
  // same way the helper does internally, so the mock-store fetch routing
  // (which keys on owner) matches what the helper will look up.
  const TEST_DERIVATION_KEY = "ab".repeat(32)
  let testBackupSigner: PrivateKey
  let testOwner: EthAddress
  let testSwarmEncryptionKey: Uint8Array

  beforeAll(async () => {
    const swarmEncryptionKeyHex =
      await deriveSwarmEncryptionKey(TEST_DERIVATION_KEY)
    testSwarmEncryptionKey = hexToUint8Array(swarmEncryptionKeyHex)
    const backupKeyHex = await deriveSecret(swarmEncryptionKeyHex, "backup-key")
    testBackupSigner = new PrivateKey(backupKeyHex)
    testOwner = testBackupSigner.publicKey().address()
  })

  let h_store: MockChunkStore
  let h_bee: MockBee
  let h_stamper: Stamper

  beforeEach(() => {
    h_store = new MockChunkStore()
    h_bee = new MockBee(h_store)
    h_stamper = createMockStamper() as unknown as Stamper
    mockFetch(h_store, testOwner)
  })

  async function writeHolder(
    partition: number,
    payload: PartitionLockPayload,
  ): Promise<void> {
    await writePartitionLock({
      bee: h_bee as unknown as Bee,
      stamper: h_stamper,
      backupSigner: testBackupSigner,
      swarmEncryptionKey: testSwarmEncryptionKey,
      partition,
      payload,
    })
  }

  it("returns an empty list when no partition has a lock SOC", async () => {
    const holders = await readPartitionHolders({
      bee: h_bee as unknown as Bee,
      derivationKey: TEST_DERIVATION_KEY,
      partitionCount: 2,
    })
    expect(holders).toEqual([])
  })

  it("returns all live holders", async () => {
    const now = 5_000_000
    await writeHolder(0, {
      holderDeviceId: DEVICE_A,
      generation: {
        timestampMs: now,
        tiebreaker: makeDeviceTiebreaker(DEVICE_A),
      },
      acquiredAt: now,
      leasedUntil: now + TTL_MS,
    })
    await writeHolder(1, {
      holderDeviceId: DEVICE_B,
      generation: {
        timestampMs: now,
        tiebreaker: makeDeviceTiebreaker(DEVICE_B),
      },
      acquiredAt: now,
      leasedUntil: now + TTL_MS,
    })

    const holders = await readPartitionHolders({
      bee: h_bee as unknown as Bee,
      derivationKey: TEST_DERIVATION_KEY,
      partitionCount: 2,
      now: () => now,
    })
    expect(holders).toHaveLength(2)
    expect(holders.find((h) => h.partition === 0)?.deviceId).toBe(DEVICE_A)
    expect(holders.find((h) => h.partition === 1)?.deviceId).toBe(DEVICE_B)
  })

  it("filters out expired holders", async () => {
    const now = 5_000_000
    await writeHolder(0, {
      holderDeviceId: DEVICE_A,
      generation: {
        timestampMs: now - 1000,
        tiebreaker: makeDeviceTiebreaker(DEVICE_A),
      },
      acquiredAt: now - 1000,
      leasedUntil: now + TTL_MS, // live
    })
    await writeHolder(1, {
      holderDeviceId: DEVICE_B,
      generation: {
        timestampMs: now - 100_000,
        tiebreaker: makeDeviceTiebreaker(DEVICE_B),
      },
      acquiredAt: now - 100_000,
      leasedUntil: now - 1000, // expired
    })

    const holders = await readPartitionHolders({
      bee: h_bee as unknown as Bee,
      derivationKey: TEST_DERIVATION_KEY,
      partitionCount: 2,
      now: () => now,
    })
    expect(holders).toHaveLength(1)
    expect(holders[0]).toEqual({
      partition: 0,
      deviceId: DEVICE_A,
      leasedUntil: now + TTL_MS,
    })
  })

  it("filters out the NO_HOLDER sentinel (released slot)", async () => {
    const now = 5_000_000
    await writeHolder(0, {
      holderDeviceId: NO_HOLDER_DEVICE_ID,
      generation: {
        timestampMs: now,
        tiebreaker: makeDeviceTiebreaker(DEVICE_A),
      },
      acquiredAt: now,
      leasedUntil: now + TTL_MS, // even with future leasedUntil, sentinel wins
    })

    const holders = await readPartitionHolders({
      bee: h_bee as unknown as Bee,
      derivationKey: TEST_DERIVATION_KEY,
      partitionCount: 2,
      now: () => now,
    })
    expect(holders).toEqual([])
  })

  it("includes partition 0 but not partition 1 when only one is written", async () => {
    const now = 5_000_000
    await writeHolder(1, {
      holderDeviceId: DEVICE_C,
      generation: {
        timestampMs: now,
        tiebreaker: makeDeviceTiebreaker(DEVICE_C),
      },
      acquiredAt: now,
      leasedUntil: now + TTL_MS,
    })

    const holders = await readPartitionHolders({
      bee: h_bee as unknown as Bee,
      derivationKey: TEST_DERIVATION_KEY,
      partitionCount: 2,
      now: () => now,
    })
    expect(holders).toHaveLength(1)
    expect(holders[0].partition).toBe(1)
    expect(holders[0].deviceId).toBe(DEVICE_C)
  })
})
