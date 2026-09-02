// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Who is live on the account bus, as seen from one context.
 *
 * Every context in the room publishes a `presence` on join and every
 * `PRESENCE_INTERVAL_MS`; a receiver notes the time it heard each device. A
 * device unheard for `PRESENCE_MAX_AGE_MS` — three missed beats — is no longer
 * live. That is the whole mechanism: the bus already knows who is in the room,
 * this only ties room membership to a `deviceId`.
 *
 * In memory only, and deliberately never persisted or published as state. A
 * `lastSeenAt` that rode the account snapshot would make every publish a byte
 * change to fold and re-persist, and the unpartitioned proxy answers every
 * storage event with a bus delta and a stamped feed write — a loop that never
 * settles, even on one device. Durable truth (`lastSignedInAt`) keeps meaning
 * "signed in"; liveness lives here and is rebuilt from scratch on every load.
 */

export const PRESENCE_INTERVAL_MS = 20_000
/** Three missed beats. Well inside `KNOWN_DEVICE_MAX_AGE_MS` and past
 *  `LEASE_TTL_MS`, so a closed tab leaves the rival set about when its lease
 *  would have lapsed anyway. */
export const PRESENCE_MAX_AGE_MS = 3 * PRESENCE_INTERVAL_MS

// ponytail: no leave message; absence ages out in PRESENCE_MAX_AGE_MS (#572).
export class PresenceTracker {
  private seen = new Map<string, number>()

  observe(deviceId: string, nowMs: number): void {
    this.seen.set(deviceId, nowMs)
  }

  /** Devices heard within `PRESENCE_MAX_AGE_MS` of `nowMs`. */
  liveDeviceIds(nowMs: number): string[] {
    const cutoff = nowMs - PRESENCE_MAX_AGE_MS
    return [...this.seen].filter(([, at]) => at >= cutoff).map(([id]) => id)
  }

  clear(): void {
    this.seen.clear()
  }
}
