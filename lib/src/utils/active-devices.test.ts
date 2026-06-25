// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { activeDeviceIds, KNOWN_DEVICE_MAX_AGE_MS } from "./active-devices"
import type { Device } from "../schemas"

const NOW = 1_000_000_000_000

function device(
  id: string,
  lastSignedInAt: number,
  removedAt?: number,
): Device {
  return {
    deviceId: id,
    name: id,
    createdAt: lastSignedInAt,
    lastSignedInAt,
    removedAt,
  }
}

describe("activeDeviceIds", () => {
  it("keeps a recently-active device", () => {
    const devices = [device("fresh", NOW - 1000)]
    expect(activeDeviceIds(devices, NOW, KNOWN_DEVICE_MAX_AGE_MS)).toEqual([
      "fresh",
    ])
  })

  it("excludes a device whose lastSignedInAt is older than the window (ghost from an old session)", () => {
    const devices = [
      device("fresh", NOW - 1000),
      device("ghost", NOW - KNOWN_DEVICE_MAX_AGE_MS - 1),
    ]
    expect(activeDeviceIds(devices, NOW, KNOWN_DEVICE_MAX_AGE_MS)).toEqual([
      "fresh",
    ])
  })

  it("excludes removed (tombstoned) devices regardless of recency", () => {
    const devices = [device("removed", NOW, NOW)]
    expect(activeDeviceIds(devices, NOW, KNOWN_DEVICE_MAX_AGE_MS)).toEqual([])
  })

  it("keeps a device exactly at the window boundary", () => {
    const devices = [device("edge", NOW - KNOWN_DEVICE_MAX_AGE_MS)]
    expect(activeDeviceIds(devices, NOW, KNOWN_DEVICE_MAX_AGE_MS)).toEqual([
      "edge",
    ])
  })

  it("returns empty for no devices", () => {
    expect(activeDeviceIds([], NOW, KNOWN_DEVICE_MAX_AGE_MS)).toEqual([])
  })

  it("treats a missing lastSignedInAt as stale (excluded)", () => {
    const devices = [{ deviceId: "no-ts", name: "x", createdAt: NOW } as Device]
    expect(activeDeviceIds(devices, NOW, KNOWN_DEVICE_MAX_AGE_MS)).toEqual([])
  })
})
