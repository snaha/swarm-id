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

  // The room tells us when a socket goes (`peer-left`), which is the only
  // departure signal that survives a tab being closed — a leave published on
  // unload never finishes encrypting (#572).
  it("forgets a device when the peer it was heard from leaves", () => {
    const presence = new PresenceTracker()
    presence.observe("a", 1000, "peer-1")
    presence.forgetPeer("peer-1")
    expect(presence.liveDeviceIds(1000)).toEqual([])
  })

  // Two tabs of one dApp share a partition, so they share a `deviceId` and hold
  // a socket each. One closing is not the device leaving.
  it("keeps a device while another of its peers is still here", () => {
    const presence = new PresenceTracker()
    presence.observe("a", 1000, "peer-1")
    presence.observe("a", 1000, "peer-2")
    presence.forgetPeer("peer-1")
    expect(presence.liveDeviceIds(1000)).toEqual(["a"])
    presence.forgetPeer("peer-2")
    expect(presence.liveDeviceIds(1000)).toEqual([])
  })

  // A beat heard with no peer behind it came over the local transport, which
  // has no sockets to lose. Only ageing can drop it.
  it("leaves a locally-heard device alone", () => {
    const presence = new PresenceTracker()
    presence.observe("a", 1000)
    presence.forgetPeer("peer-1")
    expect(presence.liveDeviceIds(1000)).toEqual(["a"])
  })

  it("ignores a departure it never heard from", () => {
    const presence = new PresenceTracker()
    presence.observe("a", 1000, "peer-1")
    presence.forgetPeer("peer-9")
    expect(presence.liveDeviceIds(1000)).toEqual(["a"])
  })

  it("clear forgets everyone", () => {
    const presence = new PresenceTracker()
    presence.observe("a", 1000)
    presence.observe("b", 1000)
    presence.clear()
    expect(presence.liveDeviceIds(1000)).toEqual([])
  })
})
