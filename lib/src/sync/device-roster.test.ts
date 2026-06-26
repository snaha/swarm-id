// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest"
import { EthAddress } from "@ethersphere/bee-js"
import type { Device } from "../schemas"

// readRosterEntry downloads the device blob via downloadDataWithChunkAPI; mock it
// to decode the index we encode into the SOC reference (see fakeBee below).
const mockDownloadData = vi.fn()
vi.mock("../proxy/download-data", () => ({
  downloadDataWithChunkAPI: (...args: unknown[]) => mockDownloadData(...args),
}))

import { readRoster, rosterTopic, rosterIdentifier } from "./device-roster"

const OWNER = new EthAddress("a".repeat(40))
const ACCOUNT_ID = "b".repeat(40)

function makeDevice(index: number): Device {
  return {
    deviceId: `dev-${index}`,
    name: `dev-${index}`,
    createdAt: 1000,
    lastSignedInAt: 1000,
  }
}

// A reference whose first byte carries the roster index, so the mocked blob
// download can return the right device without a real Swarm round-trip.
function refForIndex(index: number): Uint8Array {
  const ref = new Uint8Array(32)
  ref[0] = index
  return ref
}

/**
 * Fake Bee that serves roster SOCs ONLY for `presentIndices`. Reverse-maps the
 * requested identifier back to its index via `rosterIdentifier`, so the windowed
 * scan exercises real gap detection.
 */
function fakeBee(presentIndices: Set<number>) {
  const topic = rosterTopic(ACCOUNT_ID)
  const identToIndex = new Map<string, number>()
  for (let i = 0; i < 64; i++) {
    identToIndex.set(rosterIdentifier(topic, BigInt(i)).toHex(), i)
  }
  return {
    makeSOCReader: () => ({
      download: async (identifier: { toHex(): string }) => {
        const index = identToIndex.get(identifier.toHex())
        if (index === undefined || !presentIndices.has(index)) {
          throw new Error("empty slot")
        }
        return { payload: { toUint8Array: () => refForIndex(index) } }
      },
    }),
  }
}

describe("readRoster — windowed-parallel scan", () => {
  beforeEach(() => {
    mockDownloadData.mockReset()
    mockDownloadData.mockImplementation((_bee: unknown, refHex: string) => {
      // refHex first byte (chars 0..1) is the index we encoded.
      const index = parseInt(refHex.slice(0, 2), 16)
      return new TextEncoder().encode(JSON.stringify(makeDevice(index)))
    })
  })

  it("reads a contiguous roster (present prefix shorter than one window)", async () => {
    const bee = fakeBee(new Set([0, 1, 2]))
    const devices = await readRoster({
      bee: bee as never,
      accountId: ACCOUNT_ID,
      owner: OWNER,
    })
    expect(devices.map((d) => d.deviceId).sort()).toEqual([
      "dev-0",
      "dev-1",
      "dev-2",
    ])
  })

  it("skips a transient hole and keeps later entries (no truncation)", async () => {
    // 0,1 present, 2 missing (transient read failure), 3 present. A contiguous
    // roster can't have a real entry past a real gap, so index 2 is transient —
    // dev-3 must survive instead of being dropped with the rest of the tail.
    const bee = fakeBee(new Set([0, 1, 3]))
    const devices = await readRoster({
      bee: bee as never,
      accountId: ACCOUNT_ID,
      owner: OWNER,
    })
    expect(devices.map((d) => d.deviceId).sort()).toEqual([
      "dev-0",
      "dev-1",
      "dev-3",
    ])
  })

  it("crosses a full first window into the second before the gap", async () => {
    // ROSTER_SCAN_WINDOW = 16: full window 0..15 present, then 16,17 present, 18 gap.
    const present = new Set<number>()
    for (let i = 0; i <= 17; i++) present.add(i)
    const bee = fakeBee(present)
    const devices = await readRoster({
      bee: bee as never,
      accountId: ACCOUNT_ID,
      owner: OWNER,
    })
    expect(devices).toHaveLength(18)
    expect(devices.some((d) => d.deviceId === "dev-17")).toBe(true)
  })

  it("returns [] for an empty roster (index 0 missing)", async () => {
    const bee = fakeBee(new Set())
    const devices = await readRoster({
      bee: bee as never,
      accountId: ACCOUNT_ID,
      owner: OWNER,
    })
    expect(devices).toEqual([])
  })
})
