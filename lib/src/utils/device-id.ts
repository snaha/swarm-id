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
 * creates a new entry if not). Preserves all other device entries.
 */
export function mergeDevices(
  existing: Device[],
  currentDeviceId: string,
): Device[] {
  const now = Date.now()
  const found = existing.some((d) => d.deviceId === currentDeviceId)

  if (found) {
    return existing.map((d) =>
      d.deviceId === currentDeviceId ? { ...d, lastSignedInAt: now } : d,
    )
  }

  return [
    ...existing,
    { deviceId: currentDeviceId, createdAt: now, lastSignedInAt: now },
  ]
}
