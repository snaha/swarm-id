// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { readLeaseCache, writeLeaseCache } from "./lease-cache"
import type { PartitionLeaseStateSnapshot } from "./partition-lease"

const ACCOUNT = "ab".repeat(20)
const BATCH = "cd".repeat(32)
const DEVICE = "device-a"
const NOW = 1_000_000

function snapshot(
  generationMs: number,
  leasedUntil: number,
): PartitionLeaseStateSnapshot {
  return {
    deviceId: DEVICE,
    batchId: BATCH,
    self: {
      partition: 1,
      generation: { timestampMs: generationMs, tiebreaker: "00" },
      acquiredAt: generationMs,
      leasedUntil,
    },
  }
}

describe("lease cache", () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it("round-trips a snapshot and clears on undefined", () => {
    writeLeaseCache(ACCOUNT, BATCH, snapshot(NOW - 100, NOW + 100))
    expect(readLeaseCache(ACCOUNT, BATCH)).toEqual(
      snapshot(NOW - 100, NOW + 100),
    )
    writeLeaseCache(ACCOUNT, BATCH, undefined)
    expect(readLeaseCache(ACCOUNT, BATCH)).toBeUndefined()
  })

  it("keeps a sibling's newer live claim over an older one", () => {
    const sibling = snapshot(NOW - 10, NOW + 100)
    writeLeaseCache(ACCOUNT, BATCH, sibling, () => NOW)
    writeLeaseCache(ACCOUNT, BATCH, snapshot(NOW - 500, NOW + 100), () => NOW)
    expect(readLeaseCache(ACCOUNT, BATCH)).toEqual(sibling)
  })

  it("replaces a newer claim once it has lapsed, and any older one", () => {
    writeLeaseCache(ACCOUNT, BATCH, snapshot(NOW - 10, NOW - 1), () => NOW)
    const older = snapshot(NOW - 500, NOW + 100)
    writeLeaseCache(ACCOUNT, BATCH, older, () => NOW)
    expect(readLeaseCache(ACCOUNT, BATCH)).toEqual(older)

    const newer = snapshot(NOW - 5, NOW + 100)
    writeLeaseCache(ACCOUNT, BATCH, newer, () => NOW)
    expect(readLeaseCache(ACCOUNT, BATCH)).toEqual(newer)
  })
})
