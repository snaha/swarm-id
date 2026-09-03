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
 * Upserts the current device: creates the entry if absent, otherwise leaves it
 * as it is apart from the name. A `deviceName` we are given REPLACES the stored
 * one, so a caller that learns a better label — the partition naming of #570 —
 * corrects the row already in the registry instead of only the next one
 * created. A caller with nothing to say passes nothing and the stored label
 * stands: the name must not be blanked by a context that does not know it.
 *
 * A replacement carries `nameUpdatedAt`, the name's own merge clock, without
 * which the correction never left this device: `mergeDevicesList` ranks records
 * on sign-in recency, a rename moves none of it, and a tie favours the local
 * copy — so every other context kept its stale label forever (#663). Only an
 * ACTUAL change stamps it. Both callers are polls, and a clock that moved every
 * time a caller passed the name it already stored would make every quiet round
 * a byte change to persist, which is the churn #652 removed.
 *
 * Touches neither `removedAt` nor `lastSignedInAt` on an existing entry. Both
 * callers are refresh paths — the proxy's throttled roster poll and the UI's
 * periodic fold — and a poll is not a sign-in: clearing our own tombstone here
 * undid every removal on the next round (#611), and stamping `lastSignedInAt`
 * here (#652) made every fold a byte change to persist, which a proxy holding
 * a partition answered with a bus delta and a stamped feed write. #337's "a
 * genuine sign-in re-activates a device removed elsewhere" still holds; it
 * lives at the sign-in seams instead (`reactivateThisDevice`), which is the
 * only place that can tell a user unlocking their account from a timer firing.
 * Liveness is not this field's job either — the bus carries it.
 */
export function mergeDevices(
  existing: Device[],
  currentDeviceId: string,
  deviceName?: string,
): Device[] {
  const found = existing.some((d) => d.deviceId === currentDeviceId)

  if (found) {
    return existing.map((d) =>
      d.deviceId === currentDeviceId &&
      deviceName !== undefined &&
      deviceName !== d.name
        ? { ...d, name: deviceName, nameUpdatedAt: Date.now() }
        : d,
    )
  }

  const now = Date.now()
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

/**
 * The device name a STORAGE-PARTITIONED proxy iframe announces itself under.
 *
 * A partitioned iframe keeps its own `swarm-id-device-id` in the partition, and
 * a partition is one (top-level site, iframe origin) pair — so two tabs of one
 * dApp are one device, while two different dApps on the same browser are two.
 * `detectDeviceName()` alone therefore hands a Safari user with three connected
 * dApps three indistinguishable "Safari on Mac" rows (#570). The dApp host is
 * what tells them apart, and the port comes with it: locally the dApps differ
 * by port alone.
 *
 * Only for the partitioned case. An UNPARTITIONED proxy reads the trusted
 * domain's first-party store, so it shares `swarm-id-device-id` with the
 * identity UI — it is the same device, and naming that after whichever dApp
 * happened to load it would be wrong.
 *
 * The host is deliberately finer-grained than the partition key, which is
 * schemeful site (eTLD+1) and may drop the port. Two same-site dApps —
 * `app1.foo.com` and `app2.foo.com`, or two localhost ports — therefore share
 * ONE partition and one device row, whose name flips to whichever announced
 * last.
 *
 * Each flip now costs more than it did. While the name carried no clock of its
 * own the flip lost every remote tie and stayed local (a save and a storage
 * event); with `nameUpdatedAt` (#663) it wins the overlay everywhere, so an
 * alternation is a registry save, a feed publish, and a fold-and-persist on
 * every peer — the churn class #652 went hunting for, in a config rare enough
 * that it has never been observed. Still cosmetic, and the alternative (naming
 * by site) would label the common case uselessly, so the finer name wins. If
 * it ever matters, the fix is to key the name on the partition rather than the
 * origin, which makes the two announcers agree instead of alternating.
 */
export function partitionDeviceName(appOrigin: string): string {
  const deviceName = detectDeviceName()
  try {
    // Never worth failing a device announce over: this name is decoration on a
    // roster write, so an origin we cannot parse falls back to the plain name.
    return `${deviceName} · ${new URL(appOrigin).host}`
  } catch {
    return deviceName
  }
}

/**
 * Whether a merged device registry is worth persisting over the stored one.
 *
 * The old test was "did the list get LONGER", which threw away every merge that
 * only refreshed a peer's `lastSignedInAt` or set a `removedAt` tombstone — and
 * those are exactly the fields `activeDeviceIds` prunes the rival set on. A peer
 * the roster shows as live could therefore age out of the stored copy, drop out
 * of the rival set, and never get an intent read: the dual-acquire the registry
 * refresh exists to prevent (#586).
 *
 * Every field counts, our own included. `mergeDevices` no longer stamps our
 * `lastSignedInAt` on a poll (#652), so when it moves it is a genuine sign-in
 * (a reactivation) and worth a save. Until then this excluded it, because
 * counting a stamp that moved on every call meant a save and a storage event in
 * every other tab, every poll round.
 */
export function deviceRegistryChanged(
  stored: Device[],
  merged: Device[],
  selfDeviceId: string,
): boolean {
  if (stored.length !== merged.length) return true
  const before = new Map(stored.map((device) => [device.deviceId, device]))
  return merged.some((device) => {
    const previous = before.get(device.deviceId)
    if (!previous) return true
    const isSelf = device.deviceId === selfDeviceId
    return DEVICE_COMPARED_FIELDS.some(([field, scope]) =>
      isSelf && scope === "peers-only"
        ? false
        : previous[field] !== device[field],
    )
  })
}

/**
 * Every field of `DeviceSchemaV1`, classified for the comparison above.
 *
 * Typed as a full `Record<keyof Device, …>` on purpose: a field added to the
 * schema fails to compile here until it is classified, because the alternative
 * failure is silent — an unlisted field simply never triggers a persist, and
 * what is lost is a registry write nobody is watching for.
 *
 * `deviceId` is in the list though it is the map key: keeping the record total
 * is what makes the compiler the check. The `"peers-only"` scope is kept for
 * the next field a poll has to write on ourselves; nothing uses it today.
 */
const DEVICE_COMPARED_FIELDS = Object.entries({
  deviceId: "all",
  createdAt: "all",
  name: "all",
  // Cannot move without `name` moving (`mergeDevices` stamps it only on an
  // actual change), so counting it changes nothing today. Listed as "all"
  // because a rename IS worth a save, and because the record must stay total.
  nameUpdatedAt: "all",
  removedAt: "all",
  lastSignedInAt: "all",
} satisfies Record<keyof Device, "all" | "peers-only">) as [
  keyof Device,
  "all" | "peers-only",
][]
