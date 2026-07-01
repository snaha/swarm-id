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
  foldAccount: (_views: unknown, _devices: unknown) => ({
    folded: true,
    devices: [],
    connectedApps: [],
    postageStamps: [],
  }),
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

  it("coalesces concurrent folds for the same account into one read set", async () => {
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

    // One roster scan served both callers, and they share the same result.
    expect(readRoster).toHaveBeenCalledTimes(1)
    expect(r1).toBe(r2)
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

  it("freezes the result arrays so coalesced callers can't corrupt each other", async () => {
    readRoster.mockResolvedValue([makeDevice("dev-0")])
    // A readable device feed so `views` is non-empty — otherwise the
    // `views.length === 0` short-circuit returns undefined before the fold.
    // `foldAccount` is mocked here, so the view's contents don't matter.
    readLatestDeviceState.mockResolvedValue({ deviceId: "dev-0" })
    const bee = {} as Bee

    const result = await foldAccountFromSwarm({
      bee,
      derivationKey: DERIVATION_KEY,
      accountId: ACCOUNT_ID,
    })

    // Coalesced callers share one result; a mutation must fail loud, not
    // silently corrupt a concurrent caller's view.
    expect(Object.isFrozen(result!.devices)).toBe(true)
    expect(Object.isFrozen(result!.account.connectedApps)).toBe(true)
    expect(Object.isFrozen(result!.account.postageStamps)).toBe(true)
    expect(() => result!.devices.push(makeDevice("dev-1"))).toThrow()
  })
})
