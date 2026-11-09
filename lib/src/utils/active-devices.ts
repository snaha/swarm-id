// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The registry half of the partition-contention rival set: devices that
 * signed in recently enough to plausibly be acquiring RIGHT NOW.
 *
 * The other half is the account bus. A device beating `presence` in the room
 * (`bus/presence.ts`) is alive by construction, and every caller unions that
 * set with this one; this filter is the bootstrap for a context with no bus,
 * and for a device that signed in moments ago and has not beaten yet.
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
 * `lastSignedInAt` advances only on an actual SIGN-IN (a creation or a
 * reactivation), never on a poll (#652) — so a long-running device IS pruned
 * from THIS half after the window; the bus half is what keeps it a rival, and
 * the occupancy channel is what keeps that safe. Pruning only removes the
 * per-acquire absent-read cost of dead ghosts.
 */

import type { Device } from "../schemas"

/**
 * How recently a device must have signed in to count as a contention rival
 * without a bus beat. The stamp is frozen at sign-in (#652), so this bounds the
 * age of the SESSION, not any publish cadence: long enough that a device which
 * just signed in is a rival through its first acquires, far below a prior
 * session, so stale ghosts are dropped. A live device past the window stays a
 * rival through the bus half, not this one.
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
