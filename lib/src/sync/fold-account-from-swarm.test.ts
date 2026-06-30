// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Bee } from "@ethersphere/bee-js"
import type { Device } from "../schemas"

// Mock the Swarm-touching reads so the fold runs without a network, and we can
// count how many roster scans two concurrent folds trigger.
const readRoster = vi.fn()
const readLatestDeviceState = vi.fn()
vi.mock("./device-roster", () => ({
  readRoster: (...args: unknown[]) => readRoster(...args),
}))
vi.mock("./device-state", () => ({
  readLatestDeviceState: (...args: unknown[]) => readLatestDeviceState(...args),
  foldAccount: (_views: unknown, _devices: unknown) => ({ folded: true }),
}))

import { foldAccountFromSwarm } from "./fold-account-from-swarm"

const ACCOUNT_ID = "b".repeat(40)
// A real-shaped derivation key (hex) — the fold derives a key from it.
const DERIVATION_KEY = "cd".repeat(32)

function makeDevice(id: string): Device {
  return { deviceId: id, name: id, createdAt: 1, lastSignedInAt: 1 }
}

describe("foldAccountFromSwarm — concurrent coalescing", () => {
  beforeEach(() => {
    readRoster.mockReset()
    readLatestDeviceState.mockReset()
    readLatestDeviceState.mockResolvedValue(undefined)
  })

  it("coalesces concurrent folds into one read set but gives each caller its own result", async () => {
    let resolveRoster!: (devices: Device[]) => void
    readRoster.mockReturnValue(
      new Promise<Device[]>((resolve) => (resolveRoster = resolve)),
    )
    const bee = {} as Bee

    const p1 = foldAccountFromSwarm({
      bee,
      derivationKey: DERIVATION_KEY,
      accountId: ACCOUNT_ID,
    })
    const p2 = foldAccountFromSwarm({
      bee,
      derivationKey: DERIVATION_KEY,
      accountId: ACCOUNT_ID,
    })

    resolveRoster([makeDevice("dev-0")])
    const [r1, r2] = await Promise.all([p1, p2])

    // One roster scan served both callers (coalesced read)...
    expect(readRoster).toHaveBeenCalledTimes(1)
    // ...but each caller gets an independent (deep-cloned) result, so mutating
    // one can't corrupt the other.
    expect(r1).not.toBe(r2)
    expect(r1).toEqual(r2)
    r1!.devices.push(makeDevice("mutant"))
    expect(r2!.devices).toHaveLength(1)
  })

  it("re-reads after the in-flight fold settles (no stale cache)", async () => {
    readRoster.mockResolvedValue([makeDevice("dev-0")])
    const bee = {} as Bee

    await foldAccountFromSwarm({
      bee,
      derivationKey: DERIVATION_KEY,
      accountId: ACCOUNT_ID,
    })
    await foldAccountFromSwarm({
      bee,
      derivationKey: DERIVATION_KEY,
      accountId: ACCOUNT_ID,
    })

    // Sequential (non-overlapping) folds each read fresh — coalescing only
    // dedupes truly concurrent calls, it does not cache across time.
    expect(readRoster).toHaveBeenCalledTimes(2)
  })
})
