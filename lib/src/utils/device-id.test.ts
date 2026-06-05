// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, it, expect, vi } from "vitest"
import { detectDeviceName, mergeDevices } from "./device-id"
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
