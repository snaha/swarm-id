// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * When the proxy publishes the account snapshot. It publishes to the shared
 * sync feed when it first acquires a partition (so the device announces
 * itself — see #336 motivation #4) and when account state changes while a
 * lease is held. This module debounces those triggers, coalesces their
 * reasons, keeps one publish in flight, and retries a partial one with
 * backoff; the proxy does the publishing.
 */

import { rosterRetryDelayMs } from "../sync/device-roster"

/**
 * Debounce window for proxy-side account-state publishing. Coalesces a burst of
 * triggers (lease acquisition + storage changes) into a single feed write.
 */
export const PUBLISH_DEBOUNCE_MS = 1500

/**
 * Why a publish was scheduled. `"acquired"` (announce on lease acquisition) is
 * gated on this device not yet being in the feed, so a plain reload doesn't
 * republish. `"change"` (account-state delta) always publishes.
 */
export type PublishReason = "acquired" | "change"

/** What the feed half of one publish did. */
export type FeedPublishOutcome =
  | { status: "published" }
  | { status: "skipped" }
  /** The roster append was skipped (#920); the announce is retried. */
  | { status: "partial"; warning: string }

export interface AccountStatePublisherHost {
  /** Send the account delta to live peers over the bus. Needs no lease. */
  publishDelta(): void
  /** Write the snapshot to the shared feed, if this publish should. */
  publishToFeed(reason: PublishReason): Promise<FeedPublishOutcome>
}

export class AccountStatePublisher {
  private timer: ReturnType<typeof setTimeout> | undefined
  /** Why the next debounced publish was scheduled. */
  private reason: PublishReason | undefined
  private inFlight = false
  // Re-arms the announce publish after a partial one (roster append skipped
  // on an inconclusive scan, #920); attempt drives the backoff.
  private rosterRetryTimer: ReturnType<typeof setTimeout> | undefined
  private rosterRetryAttempt = 0

  constructor(private readonly host: AccountStatePublisherHost) {}

  /**
   * Schedule a debounced account-state publish. Safe to call from inside the
   * coordinator's lease callbacks: it only arms a timer, so the actual publish
   * runs later, outside any held write lock.
   *
   * A coordinator is NOT a precondition — only the feed half of the publish
   * needs one, and the host checks for it there, after the bus delta has gone
   * out.
   */
  schedule(reason: PublishReason): void {
    // "change" dominates: if a real delta is pending in this debounce window,
    // don't let a coalesced "acquired" downgrade it to the announce-gated path.
    if (this.reason !== "change") this.reason = reason
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      const effectiveReason = this.reason ?? "acquired"
      this.reason = undefined
      void this.run(effectiveReason)
    }, PUBLISH_DEBOUNCE_MS)
  }

  /**
   * Drop a scheduled publish and a pending roster-append retry (#920) with
   * its backoff, so the next session on this proxy starts over at the base
   * delay.
   */
  cancel(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.rosterRetryTimer !== undefined) {
      clearTimeout(this.rosterRetryTimer)
      this.rosterRetryTimer = undefined
    }
    this.rosterRetryAttempt = 0
  }

  /**
   * Publish the account snapshot: the delta to live peers over the bus, then
   * the feed write. Re-arms if a publish is already in flight so the latest
   * state still lands.
   */
  private async run(reason: PublishReason): Promise<void> {
    // The in-flight guard runs before the delta publish below: a message needs
    // no lease, but a re-entrant call while a publish is in flight re-arms the
    // timer instead of sending the delta a second time for one change.
    if (this.inFlight) {
      this.schedule(reason)
      return
    }
    if (reason === "change") this.host.publishDelta()
    this.inFlight = true
    try {
      const outcome = await this.host.publishToFeed(reason)
      if (outcome.status === "partial") {
        // Re-run the announce path with backoff: it re-reads the roster and
        // appends once the scan is clean.
        //
        // Only while this session still holds a partition: the host drops a
        // retry that fires after the lease idled out (the first retry lands
        // at `IDLE_YIELD_MS`), and the retry does not acquire one just to
        // announce. The next acquire's own `onLeaseAcquired` announce
        // re-reads the roster and appends then — the gap is this device's
        // roster entry, not the account, which the identity UI's
        // `syncAccount` retry keeps reachable.
        const delay = rosterRetryDelayMs(this.rosterRetryAttempt++)
        console.warn(`[Proxy] ${outcome.warning}; retrying in ${delay}ms`)
        if (this.rosterRetryTimer !== undefined)
          clearTimeout(this.rosterRetryTimer)
        this.rosterRetryTimer = setTimeout(() => {
          this.rosterRetryTimer = undefined
          this.schedule("acquired")
        }, delay)
        return
      }
      if (outcome.status === "published") this.rosterRetryAttempt = 0
    } catch (error) {
      console.warn("[Proxy] Account-state publish failed:", error)
    } finally {
      this.inFlight = false
    }
  }
}
