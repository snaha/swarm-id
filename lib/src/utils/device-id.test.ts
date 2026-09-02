// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, it, expect, vi } from "vitest"
import {
  detectDeviceName,
  deviceRegistryChanged,
  mergeDevices,
  partitionDeviceName,
} from "./device-id"
import { createDevice, TEST_DEVICE_ID } from "../test-fixtures"

describe("mergeDevices", () => {
  it("should add a new device to an empty list", () => {
    const result = mergeDevices([], "new-device-id")

    expect(result).toHaveLength(1)
    expect(result[0].deviceId).toBe("new-device-id")
    expect(result[0].createdAt).toBeGreaterThan(0)
    expect(result[0].lastSignedInAt).toBe(result[0].createdAt)
  })

  it("should update lastSignedInAt for an existing device", () => {
    const existing = [createDevice({ lastSignedInAt: 1000 })]

    const result = mergeDevices(existing, TEST_DEVICE_ID)

    expect(result).toHaveLength(1)
    expect(result[0].deviceId).toBe(TEST_DEVICE_ID)
    expect(result[0].createdAt).toBe(1700000000000) // preserved
    expect(result[0].lastSignedInAt).toBeGreaterThan(1000)
  })

  it("should preserve other devices when adding a new one", () => {
    const existing = [createDevice()]

    const result = mergeDevices(existing, "second-device")

    expect(result).toHaveLength(2)
    expect(result[0].deviceId).toBe(TEST_DEVICE_ID)
    expect(result[1].deviceId).toBe("second-device")
  })

  // Three dApps on one Safari are three partition devices, and until #570 they
  // all announced the bare browser name. Correcting that has to reach the rows
  // already in the registry, not just the next one created — otherwise a user
  // stares at three identical "Safari on Mac" until they expire.
  it("refreshes our own name when it changed", () => {
    const existing = [createDevice({ name: "Safari on Mac" })]

    const result = mergeDevices(
      existing,
      TEST_DEVICE_ID,
      "Safari on Mac · a.example",
    )

    expect(result[0].name).toBe("Safari on Mac · a.example")
  })

  // The label is stable by design: a caller with nothing to say must not blank
  // a name that another context took care to set.
  it("keeps the existing name when no name is supplied", () => {
    const existing = [createDevice({ name: "Safari on Mac · a.example" })]

    const result = mergeDevices(existing, TEST_DEVICE_ID)

    expect(result[0].name).toBe("Safari on Mac · a.example")
  })

  // A background poll is not a sign-in. `mergeDevices` runs on refresh paths
  // ONLY — the proxy's throttled roster poll and the UI's fold — so clearing
  // our own tombstone here undid every removal on the next poll (#611). An
  // expiry that undoes itself is not an expiry. Reactivation moves to the
  // genuine sign-in seams, which is where #337 always meant it to be.
  it("keeps our own tombstone — a poll is not a sign-in", () => {
    const existing = [createDevice({ removedAt: 5000 })]

    const result = mergeDevices(existing, TEST_DEVICE_ID)

    expect(result[0].removedAt).toBe(5000)
  })

  it("should preserve other devices when updating an existing one", () => {
    const existing = [
      createDevice({ deviceId: "device-a" }),
      createDevice({ deviceId: "device-b", lastSignedInAt: 1000 }),
    ]

    const result = mergeDevices(existing, "device-b")

    expect(result).toHaveLength(2)
    expect(result[0].deviceId).toBe("device-a")
    expect(result[0].lastSignedInAt).toBe(1700000000000) // unchanged
    expect(result[1].deviceId).toBe("device-b")
    expect(result[1].lastSignedInAt).toBeGreaterThan(1000)
  })
})

// ============================================================================
// detectDeviceName
// ============================================================================

interface MockBrand {
  brand: string
  version: string
}

interface MockNavigator {
  userAgent: string
  userAgentData?: { brands: MockBrand[] }
}

function stubNavigator(mock: MockNavigator): void {
  vi.stubGlobal("navigator", mock)
}

// Realistic UAs.
const CHROMIUM_LINUX_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
const FIREFOX_LINUX_UA =
  "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0"
const SAFARI_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15"

// Brave masks itself in the UA — UA-level is identical to plain Chrome.
// The only reliable signal is `userAgentData.brands`.
const BRAVE_BRANDS: MockBrand[] = [
  { brand: "Not.A.Brand", version: "99" },
  { brand: "Brave", version: "146" },
  { brand: "Chromium", version: "146" },
]
const EDGE_BRANDS: MockBrand[] = [
  { brand: "Microsoft Edge", version: "146" },
  { brand: "Not.A.Brand", version: "99" },
  { brand: "Chromium", version: "146" },
]
const OPERA_BRANDS: MockBrand[] = [
  { brand: "Opera", version: "115" },
  { brand: "Not.A.Brand", version: "99" },
  { brand: "Chromium", version: "146" },
  { brand: "Google Chrome", version: "146" },
]
const CHROME_BRANDS: MockBrand[] = [
  { brand: "Not.A.Brand", version: "99" },
  { brand: "Google Chrome", version: "146" },
  { brand: "Chromium", version: "146" },
]

describe("detectDeviceName", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe("with userAgentData (Chromium-derived browsers)", () => {
    it("detects Brave even though its UA looks like Chrome", () => {
      stubNavigator({
        userAgent: CHROMIUM_LINUX_UA,
        userAgentData: { brands: BRAVE_BRANDS },
      })
      expect(detectDeviceName()).toBe("Brave on Linux Desktop")
    })

    it("detects Edge from the Microsoft Edge brand", () => {
      stubNavigator({
        userAgent: CHROMIUM_LINUX_UA,
        userAgentData: { brands: EDGE_BRANDS },
      })
      expect(detectDeviceName()).toBe("Edge on Linux Desktop")
    })

    it("detects Opera from the Opera brand (preferred over Google Chrome)", () => {
      stubNavigator({
        userAgent: CHROMIUM_LINUX_UA,
        userAgentData: { brands: OPERA_BRANDS },
      })
      expect(detectDeviceName()).toBe("Opera on Linux Desktop")
    })

    it("labels plain Chrome (Google Chrome + Chromium only)", () => {
      stubNavigator({
        userAgent: CHROMIUM_LINUX_UA,
        userAgentData: { brands: CHROME_BRANDS },
      })
      expect(detectDeviceName()).toBe("Chrome on Linux Desktop")
    })

    it("labels Chromium when only the generic brand is exposed", () => {
      stubNavigator({
        userAgent: CHROMIUM_LINUX_UA,
        userAgentData: {
          brands: [
            { brand: "Not.A.Brand", version: "99" },
            { brand: "Chromium", version: "146" },
          ],
        },
      })
      expect(detectDeviceName()).toBe("Chromium on Linux Desktop")
    })
  })

  describe("UA-sniffing fallback (no userAgentData)", () => {
    it("detects Firefox", () => {
      stubNavigator({ userAgent: FIREFOX_LINUX_UA })
      expect(detectDeviceName()).toBe("Firefox on Linux Desktop")
    })

    it("detects Safari", () => {
      stubNavigator({ userAgent: SAFARI_MAC_UA })
      expect(detectDeviceName()).toBe("Safari on Mac")
    })

    it("falls back to Chrome when UA has Chrome/ and no userAgentData", () => {
      stubNavigator({ userAgent: CHROMIUM_LINUX_UA })
      expect(detectDeviceName()).toBe("Chrome on Linux Desktop")
    })

    it("falls back when userAgentData.brands is empty", () => {
      stubNavigator({
        userAgent: CHROMIUM_LINUX_UA,
        userAgentData: { brands: [] },
      })
      expect(detectDeviceName()).toBe("Chrome on Linux Desktop")
    })

    it("returns 'Unknown Browser on Unknown Device' when nothing matches", () => {
      stubNavigator({ userAgent: "GoatBrowser/1.0 (some-os)" })
      expect(detectDeviceName()).toBe("Unknown Browser on Unknown Device")
    })
  })

  describe("device platform detection", () => {
    it("detects iPhone", () => {
      stubNavigator({
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      })
      expect(detectDeviceName()).toBe("Safari on iPhone")
    })

    it("detects Windows PC", () => {
      stubNavigator({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        userAgentData: { brands: CHROME_BRANDS },
      })
      expect(detectDeviceName()).toBe("Chrome on Windows PC")
    })

    it("detects Android Phone (Mobile token present)", () => {
      stubNavigator({
        userAgent:
          "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36",
        userAgentData: { brands: CHROME_BRANDS },
      })
      expect(detectDeviceName()).toBe("Chrome on Android Phone")
    })

    it("detects Android Tablet (no Mobile token)", () => {
      stubNavigator({
        userAgent:
          "Mozilla/5.0 (Linux; Android 14; Tab) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        userAgentData: { brands: CHROME_BRANDS },
      })
      expect(detectDeviceName()).toBe("Chrome on Android Tablet")
    })
  })

  it("returns 'Unknown Device' when navigator is undefined", () => {
    vi.stubGlobal("navigator", undefined)
    expect(detectDeviceName()).toBe("Unknown Device")
  })
})

// The device-registry refresh used to persist only when the list got LONGER,
// so a merge that refreshed a peer's `lastSignedInAt` or set a tombstone was
// thrown away — and `knownDeviceIds` prunes on exactly those fields, so a peer
// the roster shows as live could still age out of the stored copy and be
// skipped by the partition-intent round (#586).
describe("deviceRegistryChanged", () => {
  const SELF = "self-device"
  const PEER = "peer-device"
  const self = createDevice({ deviceId: SELF, lastSignedInAt: 1000 })
  const peer = createDevice({ deviceId: PEER, lastSignedInAt: 1000 })

  it("is true when a peer's sign-in was refreshed", () => {
    const merged = [self, { ...peer, lastSignedInAt: 5000 }]
    expect(deviceRegistryChanged([self, peer], merged, SELF)).toBe(true)
  })

  it("is true when a peer gained a tombstone", () => {
    const merged = [self, { ...peer, removedAt: 5000 }]
    expect(deviceRegistryChanged([self, peer], merged, SELF)).toBe(true)
  })

  it("is true when a device appeared", () => {
    expect(deviceRegistryChanged([self], [self, peer], SELF)).toBe(true)
  })

  it("is true when a device was replaced, not just counted", () => {
    const other = createDevice({ deviceId: "third-device" })
    expect(deviceRegistryChanged([self, peer], [self, other], SELF)).toBe(true)
  })

  it("is false for an identical registry", () => {
    expect(deviceRegistryChanged([self, peer], [self, peer], SELF)).toBe(false)
  })

  // `mergeDevices` stamps our own `lastSignedInAt` on every call, so counting
  // it would persist on every refresh — a storage event in every other tab,
  // every poll round. Our heartbeat reaches peers through the roster publish,
  // not through this local save.
  it("is false when only our own heartbeat moved", () => {
    const merged = [{ ...self, lastSignedInAt: 9000 }, peer]
    expect(deviceRegistryChanged([self, peer], merged, SELF)).toBe(false)
  })
})

// ============================================================================
// partitionDeviceName
// ============================================================================

describe("partitionDeviceName", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // A partitioned iframe keeps its own device id per storage partition, so one
  // browser with three connected dApps is three devices. The browser name alone
  // cannot tell them apart (#570).
  it("names the dApp the partition belongs to", () => {
    stubNavigator({ userAgent: SAFARI_MAC_UA })
    expect(partitionDeviceName("https://demo.snaha.net")).toBe(
      "Safari on Mac · demo.snaha.net",
    )
  })

  it("keeps the port, which is what distinguishes local dApps", () => {
    stubNavigator({ userAgent: SAFARI_MAC_UA })
    expect(partitionDeviceName("http://localhost:3500")).toBe(
      "Safari on Mac · localhost:3500",
    )
  })

  // Never worth failing a device announce over: an unparseable origin falls
  // back to the plain browser name rather than throwing inside the roster write.
  it("falls back to the bare device name on an unparseable origin", () => {
    stubNavigator({ userAgent: SAFARI_MAC_UA })
    expect(partitionDeviceName("not a url")).toBe("Safari on Mac")
  })
})
