// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Device ID Utilities
 *
 * Manages a per-browser device identifier stored in localStorage and
 * provides helpers for merging device lists across sync/restore.
 */

import type { Device } from "../schemas"

const DEVICE_ID_KEY = "swarm-id-device-id"

/**
 * Get the current device ID, creating one if it doesn't exist.
 */
export function getOrCreateDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_KEY)
  if (existing) return existing

  const id = crypto.randomUUID()
  localStorage.setItem(DEVICE_ID_KEY, id)
  return id
}

/**
 * Get the current device ID without creating one.
 */
export function getDeviceId(): string | undefined {
  return localStorage.getItem(DEVICE_ID_KEY) ?? undefined
}

/**
 * Merge a device list with the current device.
 *
 * Upserts the current device (updates lastSignedInAt if present,
 * creates a new entry if not). The `name` set at first registration is
 * intentionally preserved on subsequent sign-ins so the label is stable.
 *
 * Signing in clears any `removedAt` tombstone on the current device: a genuine
 * sign-in re-activates a device that was removed elsewhere (#337).
 */
export function mergeDevices(
  existing: Device[],
  currentDeviceId: string,
  deviceName?: string,
): Device[] {
  const now = Date.now()
  const found = existing.some((d) => d.deviceId === currentDeviceId)

  if (found) {
    return existing.map((d) =>
      d.deviceId === currentDeviceId
        ? { ...d, lastSignedInAt: now, removedAt: undefined }
        : d,
    )
  }

  return [
    ...existing,
    {
      deviceId: currentDeviceId,
      createdAt: now,
      lastSignedInAt: now,
      name: deviceName,
    },
  ]
}

/**
 * Probe `navigator.userAgentData.brands` for a recognisable browser brand.
 * Returns `undefined` when Client Hints aren't exposed (Firefox, Safari),
 * letting the caller fall back to UA sniffing.
 *
 * Order matters: Brave, Edge, and Opera all also publish `Chromium` and
 * `Google Chrome` brands alongside their own, so check the most-specific
 * brand first. Plain Chrome publishes `Google Chrome` + `Chromium` only.
 */
function detectBrowserFromUAData(): string | undefined {
  const data = (
    navigator as Navigator & {
      userAgentData?: { brands?: Array<{ brand: string }> }
    }
  ).userAgentData
  const brands = data?.brands?.map((b) => b.brand)
  if (!brands || brands.length === 0) return undefined
  if (brands.includes("Brave")) return "Brave"
  if (brands.includes("Microsoft Edge")) return "Edge"
  if (brands.includes("Opera")) return "Opera"
  if (brands.includes("Google Chrome")) return "Chrome"
  if (brands.includes("Chromium")) return "Chromium"
  return undefined
}

/**
 * Detect a human-readable name for the current device and browser.
 * Returns a string like "Chrome on Linux Desktop" or "Safari on iPhone".
 */
export function detectDeviceName(): string {
  if (typeof navigator === "undefined") return "Unknown Device"
  const ua = navigator.userAgent

  let device: string
  if (/iPhone/.test(ua)) device = "iPhone"
  else if (/iPad/.test(ua)) device = "iPad"
  else if (/Android/.test(ua))
    device = /Mobile/.test(ua) ? "Android Phone" : "Android Tablet"
  else if (/Macintosh|Mac OS X/.test(ua)) device = "Mac"
  else if (/Windows/.test(ua)) device = "Windows PC"
  else if (/Linux/.test(ua)) device = "Linux Desktop"
  else device = "Unknown Device"

  // Prefer UA Client Hints — Brave masks itself in the UA string for
  // privacy, so UA sniffing alone reports it as Chrome. Chromium-derived
  // browsers expose their identity via `navigator.userAgentData.brands`.
  const brandedBrowser = detectBrowserFromUAData()
  if (brandedBrowser) return `${brandedBrowser} on ${device}`

  // Fallback: UA sniffing. Order matters: Edge and Chrome both contain
  // "Chrome"; OPR is Opera. Brave is indistinguishable from Chrome here.
  let browser: string
  if (/Edg\//.test(ua)) browser = "Edge"
  else if (/OPR\/|Opera/.test(ua)) browser = "Opera"
  else if (/Firefox\//.test(ua)) browser = "Firefox"
  else if (/Chrome\//.test(ua)) browser = "Chrome"
  else if (/Safari\//.test(ua)) browser = "Safari"
  else browser = "Unknown Browser"

  return `${browser} on ${device}`
}
