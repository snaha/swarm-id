// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Who is live on the account bus, as seen from one context.
 *
 * Every context in the room publishes a `presence` on join and every
 * `PRESENCE_INTERVAL_MS`; a receiver notes the time it heard each device. A
 * device unheard for `PRESENCE_MAX_AGE_MS` is no longer live. That is the whole
 * mechanism: the bus already knows who is in the room, this only ties room
 * membership to a `deviceId`.
 *
 * A clean departure does not wait for the window. The signaling server sends
 * `peer-left` when a socket closes — including one its own reaper terminated,
 * so a crash and a dropped network count too — and `forgetPeer` drops the
 * device that socket carried (#572). Ageing is the backstop for what that
 * cannot see: a peer the server has not yet reaped, and a device heard only
 * over the local transport. A leave message of our own is not an option — a
 * publish encrypts before it sends, and a page being torn down never gets
 * back to the send.
 *
 * In memory only, and deliberately never persisted or published as state. A
 * `lastSeenAt` that rode the account snapshot would make every publish a byte
 * change to fold and re-persist, and the unpartitioned proxy answers every
 * storage event with a bus delta and a stamped feed write — a loop that never
 * settles, even on one device. Durable truth (`lastSignedInAt`) keeps meaning
 * "signed in"; liveness lives here and is rebuilt from scratch on every load.
 */

export const PRESENCE_INTERVAL_MS = 20_000

/** What a hidden tab's interval decays to: Chrome clamps a backgrounded page's
 *  timers to about once a minute (intensive throttling). */
const THROTTLED_INTERVAL_MS = 60_000

/**
 * Three missed beats — of the THROTTLED interval, not ours. A window of three
 * of our own beats sits exactly at a hidden tab's clamped cadence, so a
 * backgrounded-but-live device would flap in and out of its peers' live sets:
 * a blinking badge, and a coordinator repeatedly re-including the same peer in
 * an idle-yield round. Being slow to drop a device that really left costs only
 * an absent intent read, which is why the window errs long. Still well past
 * `LEASE_TTL_MS` and far inside `KNOWN_DEVICE_MAX_AGE_MS`.
 */
export const PRESENCE_MAX_AGE_MS = 3 * THROTTLED_INTERVAL_MS

/** When a device was last heard, and over which of the room's sockets. */
interface Seen {
  at: number
  peers: Set<string>
}

export class PresenceTracker {
  private seen = new Map<string, Seen>()

  /**
   * Note a beat. `peerId` is the transport's own name for whoever sent it —
   * present on the signaling transport, absent on the local one, which has no
   * peers. It is what lets a departure be attributed to a device (#572).
   */
  observe(deviceId: string, nowMs: number, peerId?: string): void {
    const entry = this.seen.get(deviceId) ?? { at: nowMs, peers: new Set() }
    entry.at = nowMs
    if (peerId !== undefined) entry.peers.add(peerId)
    this.seen.set(deviceId, entry)
  }

  /**
   * A socket left the room, so whatever it carried is gone with it.
   *
   * Only when it was the device's LAST socket: two tabs of one dApp share a
   * partition, and therefore a `deviceId`, while holding a socket each — one
   * of them closing is not the device leaving. A device heard only over the
   * local transport has no socket to lose and is left to age out.
   *
   * Every entry is checked rather than stopping at the first match. Nothing
   * here enforces that one socket only ever beats under one `deviceId`, and a
   * device left holding a dead socket id could only age out — the three-minute
   * wait this exists to remove. The loop is over a handful of entries.
   */
  forgetPeer(peerId: string): void {
    for (const [deviceId, entry] of this.seen) {
      if (!entry.peers.delete(peerId)) continue
      if (entry.peers.size === 0) this.seen.delete(deviceId)
    }
  }

  /** Devices heard within `PRESENCE_MAX_AGE_MS` of `nowMs`. */
  liveDeviceIds(nowMs: number): string[] {
    const cutoff = nowMs - PRESENCE_MAX_AGE_MS
    return [...this.seen]
      .filter(([, entry]) => entry.at >= cutoff)
      .map(([deviceId]) => deviceId)
  }

  clear(): void {
    this.seen.clear()
  }
}
