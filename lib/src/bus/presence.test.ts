// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"

import { PRESENCE_MAX_AGE_MS, PresenceTracker } from "./presence"

describe("PresenceTracker", () => {
  it("lists a device it has just heard", () => {
    const presence = new PresenceTracker()
    presence.observe("a", 1000)
    expect(presence.liveDeviceIds(1000)).toEqual(["a"])
  })

  it("keeps a device until PRESENCE_MAX_AGE_MS has passed, not longer", () => {
    const presence = new PresenceTracker()
    presence.observe("a", 1000)
    expect(presence.liveDeviceIds(1000 + PRESENCE_MAX_AGE_MS)).toEqual(["a"])
    expect(presence.liveDeviceIds(1000 + PRESENCE_MAX_AGE_MS + 1)).toEqual([])
  })

  it("a later beat extends the device", () => {
    const presence = new PresenceTracker()
    presence.observe("a", 1000)
    presence.observe("a", 5000)
    expect(presence.liveDeviceIds(5000 + PRESENCE_MAX_AGE_MS)).toEqual(["a"])
  })

  it("clear forgets everyone", () => {
    const presence = new PresenceTracker()
    presence.observe("a", 1000)
    presence.observe("b", 1000)
    presence.clear()
    expect(presence.liveDeviceIds(1000)).toEqual([])
  })
})
