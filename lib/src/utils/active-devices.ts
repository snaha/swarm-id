// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bound the partition-contention rival set to devices that could plausibly be
 * acquiring RIGHT NOW.
 *
 * The intent round reads every known device's per-device intent address to
 * deconflict simultaneous fresh claims. If that set is "all devices the account
 * ever saw", long-dead devices (ghosts from old sessions — the device list is
 * append-only and never pruned) each add an absent network read to every
 * acquire; on a flaky gateway that cost can push a single acquire past its
 * timeout, so a live device can't even claim a FREE partition. A non-active
 * device must not be able to influence an active one.
 *
 * Filtering by `lastSignedInAt` recency is SAFE (not a correctness mechanism):
 * a genuinely-live holder is still detected by the deviceId-INDEPENDENT
 * occupancy beacon (`PartitionLease.refreshHoldersFromOccupancy`), which is not
 * gated on this set; and a true simultaneous claimer is active right now, so its
 * `lastSignedInAt` is fresh and it is never pruned. Pruning only removes the
 * dead-device cost.
 */

import type { Device } from "../schemas"

/**
 * How recently a device must have signed in to count as a contention rival.
 * Comfortably above a live session's publish/refresh cadence (lease refresh is
 * ~10s; a device republishes on acquire/change) yet far below a prior session,
 * so current devices are always kept and stale ghosts are dropped.
 */
export const KNOWN_DEVICE_MAX_AGE_MS = 30 * 60 * 1000 // 30 minutes

/**
 * Device ids that are (a) not removed and (b) signed in within `maxAgeMs` of
 * `nowMs`. A missing `lastSignedInAt` counts as stale.
 */
export function activeDeviceIds(
  devices: Device[],
  nowMs: number,
  maxAgeMs: number,
): string[] {
  const cutoff = nowMs - maxAgeMs
  return devices
    .filter((d) => !d.removedAt && (d.lastSignedInAt ?? 0) >= cutoff)
    .map((d) => d.deviceId)
}
