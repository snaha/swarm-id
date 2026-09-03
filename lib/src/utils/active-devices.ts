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
 * Filtering by `lastSignedInAt` recency is SAFE (not a correctness mechanism)
 * because the deviceId-INDEPENDENT occupancy beacon, which is NOT gated on this
 * set, is the real dual-acquire backstop for a live peer that this prune drops:
 *   - `PartitionLease.refreshHoldersFromOccupancy` (in `acquire`) catches a peer
 *     that already HOLDS a partition; and
 *   - `PartitionLease.occupancyBeaconBeatsUs` (in `refresh`) resolves a symmetric
 *     fresh-claim dual-acquire with such a peer.
 * Note `lastSignedInAt` advances only on an actual SIGN-IN, not on a device's
 * ongoing publish/lease-refresh — so a long-running device IS eventually pruned
 * here; the occupancy channel (not this set) is what keeps that safe. Pruning
 * only removes the per-acquire absent-read cost of dead ghosts.
 */

import type { Device } from "../schemas"

/**
 * How recently a device must have signed in to count as a contention rival.
 * The stamp is frozen at sign-in (#652), so this bounds the age of the SESSION,
 * not any publish cadence: a live device drops out once its sign-in is this
 * old. Safe for the reason above — the occupancy beacon, not this set, is the
 * dual-acquire backstop — and the bus presence union (#655) is what puts a
 * live long-running peer back in.
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
