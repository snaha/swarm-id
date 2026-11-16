// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Who may write on one lane — a (batch, partition) — decided between devices
 * over the account bus. This is the protocol of `models/bus-lease`
 * (`BusLease.tla`), action for action; the names in comments are the model's.
 *
 * - A device writes only while it holds the lane AND its own connection was
 *   confirmed within `LEASE_STOP_MS` (`Holds`).
 * - To take the lane it asks everyone (`StartClaim`). It may take it once
 *   everybody except the devices that answered "free" for THIS claim has been
 *   absent for `LEASE_WAIT_MS` (`Acquire`).
 * - Two devices claiming at once: the lower device id wins.
 * - A holder that is asked hands over when idle and stays silent when busy.
 *
 * Messages may be lost, late, repeated or reordered. Nothing here stores or
 * reads Swarm: what the next holder must read is the caller's, through
 * `beforeHandover`.
 */

/** How long a holder may go without a confirmed connection (`TStop`). */
export const LEASE_STOP_MS = 6000

/**
 * How long everyone else must have been absent before a lane is taken without
 * their answer (`Wait`). The model needs `Wait >= TStop`; the margin covers
 * two clocks that do not tick at quite the same rate.
 */
export const LEASE_WAIT_MS = 8000

const ROUND_BYTES = 8

/** The two questions a lane asks about liveness (`BusTransport`). */
export interface LaneLiveness {
  confirmedAgoMs(): number
  absentExceptMs(deviceIds: ReadonlySet<string>): number
  onConfirmed(handler: (unconfirmedForMs: number) => void): () => void
}

export type LaneMessage =
  | { kind: "claim"; from: string; round: string }
  | { kind: "free"; from: string; to: string; round: string }

export interface BusLaneOptions {
  deviceId: string
  liveness: LaneLiveness
  /** Best effort, to every device on the account. */
  send(message: LaneMessage): void
  /** A write is in progress on this lane: a claim is not answered. */
  isBusy(): boolean
  /**
   * Runs before the lane is handed to a claimant, and must leave on Swarm
   * what the next holder reads. A rejection keeps the lane.
   */
  beforeHandover?(): Promise<void>
  onAcquired?(): void
  /** The lane was held and no longer is: handed over, or the connection went
   *  unconfirmed for too long. Not called for `release()`. */
  onLost?(): void
  /** Override for tests; a fresh value per claim. */
  newRound?: () => string
}

type Mode = "idle" | "claiming" | "holding" | "yielding"

function randomRound(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ROUND_BYTES))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  )
}

export class BusLane {
  private mode: Mode = "idle"
  /** The current claim; an answer counts only if it names it (`MatchRound`). */
  private round = ""
  private acks = new Set<string>()
  private stopListening: () => void

  constructor(private readonly opts: BusLaneOptions) {
    this.stopListening = opts.liveness.onConfirmed((unconfirmedForMs) => {
      // A gap that long means this device was not allowed to write during it,
      // and others may have acted on that: start over (`Heartbeat`).
      if (unconfirmedForMs >= LEASE_STOP_MS) this.lapse()
      if (this.mode === "claiming") {
        // The claim may have been lost; asking again is harmless.
        this.sendClaim()
        this.tryAcquire()
      }
    })
  }

  /** May this device write on the lane right now (`Holds`)? */
  holds(): boolean {
    if (this.mode !== "holding") return false
    if (this.confirmed()) return true
    this.lapse()
    return false
  }

  get claiming(): boolean {
    return this.mode === "claiming"
  }

  /** Ask for the lane (`StartClaim`). False when it cannot be asked for now. */
  claim(): boolean {
    if (this.mode !== "idle" || !this.confirmed()) return false
    this.mode = "claiming"
    this.round = (this.opts.newRound ?? randomRound)()
    this.acks.clear()
    this.sendClaim()
    this.tryAcquire()
    return true
  }

  /** Stop holding, or give up a claim (`StandDown`). */
  release(): void {
    this.mode = "idle"
    this.acks.clear()
  }

  receive(message: LaneMessage): void {
    if (message.from === this.opts.deviceId) return
    if (message.kind === "claim") {
      this.answerClaim(message.from, message.round)
      return
    }
    // `HandleFree`
    if (
      this.mode !== "claiming" ||
      message.to !== this.opts.deviceId ||
      message.round !== this.round
    )
      return
    this.acks.add(message.from)
    this.tryAcquire()
  }

  close(): void {
    this.stopListening()
    this.release()
  }

  private confirmed(): boolean {
    return this.opts.liveness.confirmedAgoMs() < LEASE_STOP_MS
  }

  private sendClaim(): void {
    this.opts.send({
      kind: "claim",
      from: this.opts.deviceId,
      round: this.round,
    })
  }

  private sendFree(to: string, round: string): void {
    this.opts.send({ kind: "free", from: this.opts.deviceId, to, round })
  }

  /** `Acquire`: everybody but the devices that answered has been gone long
   *  enough, and our own connection is confirmed. */
  private tryAcquire(): void {
    if (this.mode !== "claiming" || !this.confirmed()) return
    if (this.opts.liveness.absentExceptMs(this.acks) < LEASE_WAIT_MS) return
    this.mode = "holding"
    this.opts.onAcquired?.()
  }

  /** `HandleClaim` */
  private answerClaim(claimant: string, round: string): void {
    // A holder whose connection lapsed is not writing: free.
    if (this.mode === "holding" && !this.confirmed()) this.lapse()

    switch (this.mode) {
      case "idle":
        this.sendFree(claimant, round)
        return
      case "claiming":
        // Both claiming: the lower id wins, the other stands down.
        if (claimant < this.opts.deviceId) {
          this.release()
          this.sendFree(claimant, round)
        }
        return
      case "holding":
        if (this.opts.isBusy()) return
        void this.handOver(claimant, round)
        return
      case "yielding":
        // Already handing over; this claimant asks again and is answered then.
        return
    }
  }

  private async handOver(claimant: string, round: string): Promise<void> {
    this.mode = "yielding"
    try {
      await this.opts.beforeHandover?.()
    } catch (error) {
      console.warn("[BusLane] Handover not completed; keeping the lane:", error)
      if (this.mode === "yielding") this.mode = "holding"
      return
    }
    if (this.mode === "yielding") {
      this.mode = "idle"
      this.acks.clear()
      this.opts.onLost?.()
    }
    // After a lapse during the handover this device may be claiming again, and
    // "free" would then be untrue; the claimant asks again.
    if (this.mode === "idle") this.sendFree(claimant, round)
  }

  private lapse(): void {
    const wasWriting = this.mode === "holding" || this.mode === "yielding"
    this.mode = "idle"
    this.acks.clear()
    if (wasWriting) this.opts.onLost?.()
  }
}
