// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Who may write on one lane — a (batch, partition) — decided between the
 * contexts of an account over the account bus. This is the protocol of
 * `models/bus-lease` (`BusLease.tla`), action for action; the names in
 * comments are the model's.
 *
 * A participant (the model's "device") is one context's connection: a tab or
 * an iframe, for as long as its socket lasts. Two tabs of one browser are two
 * participants, and a context that reconnects is a new one, holding nothing.
 *
 * - A context writes only while it holds the lane AND its own connection was
 *   confirmed within `LEASE_STOP_MS` (`Holds`).
 * - To take the lane it asks everyone (`StartClaim`). It may take it once
 *   everybody except the contexts that answered "free" for THIS claim has
 *   been absent for `LEASE_WAIT_MS` (`Acquire`).
 * - Two contexts claiming at once: the lower id wins.
 * - A holder that is asked hands over when idle and keeps the lane when busy.
 *   It then says so ("held"). No rule reads that answer: it only tells the
 *   claimant that waiting will not free this lane, so that it knows when
 *   asking someone to move is the only way left.
 *
 * Messages may be lost, late, repeated or reordered. Nothing here stores or
 * reads Swarm: what the next holder must read is the caller's, through
 * `beforeHandover`.
 */

import type { BusMessage, BusMessageInput } from "../bus/messages"

/** How long a holder may go without a confirmed connection (`TStop`). */
export const LEASE_STOP_MS = 6000

/**
 * How long everyone else must have been absent before a lane is taken without
 * their answer (`Wait`). The model needs `Wait >= TStop`; the margin covers
 * two clocks that do not tick at quite the same rate.
 */
export const LEASE_WAIT_MS = 8000

const ROUND_BYTES = 8

/** What the lanes need from the account bus (`AccountBus` is one). */
export interface LaneBus extends LaneLiveness {
  publish(message: BusMessageInput): void
  subscribe(handler: (message: BusMessage, from?: string) => void): () => void
}

/** A lane: one partition of one batch of one account. */
export interface LaneKey {
  accountId: string
  batchId: string
  partition: number
}

/** The two questions a lane asks about liveness (`BusTransport`). */
export interface LaneLiveness {
  /** This context's name for its current connection; undefined without one. */
  selfId(): string | undefined
  confirmedAgoMs(): number
  absentExceptMs(ids: ReadonlySet<string>): number
  onConfirmed(handler: (unconfirmedForMs: number) => void): () => void
}

export type LaneMessage =
  | { kind: "claim"; from: string; round: string; gentle?: boolean }
  | { kind: "free"; from: string; to: string; round: string }
  | { kind: "held"; from: string; to: string; round: string }

export interface BusLaneOptions {
  liveness: LaneLiveness
  /** Best effort, to every context on the account. */
  send(message: LaneMessage): void
  /**
   * Should a holder keep the lane when asked for it? True while a write is in
   * progress. A `gentle` claim asks only whether the lane is held at all, so
   * a holder keeps the lane however idle it is.
   */
  isBusy(gentle: boolean): boolean
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
  /** The name this context claimed or holds under. A different name now
   *  means the connection it was made on is gone. */
  private self = ""
  /** The current claim; an answer counts only if it names it (`MatchRound`). */
  private round = ""
  /** The current claim takes the lane only if nobody holds it. */
  private gentle = false
  private acks = new Set<string>()
  /** Who answered the current claim "held". */
  private refusals = new Set<string>()
  private stopListening: () => void

  constructor(private readonly opts: BusLaneOptions) {
    this.stopListening = opts.liveness.onConfirmed(() => {
      // A new connection holds nothing. A late confirmation of the same one
      // ends nothing: this device stayed in the room and freed no claim.
      if (this.mode === "holding") this.holds()
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
    if (this.self !== this.opts.liveness.selfId()) {
      this.lapse()
      return false
    }
    return this.confirmed()
  }

  /**
   * Holding, but not allowed to write until the connection is confirmed
   * again. Claims go unanswered meanwhile; the hold ends only when the
   * connection is replaced.
   */
  get suspended(): boolean {
    return (
      this.mode === "holding" &&
      this.self === this.opts.liveness.selfId() &&
      !this.confirmed()
    )
  }

  get claiming(): boolean {
    return this.mode === "claiming"
  }

  /**
   * Ask for the lane (`StartClaim`). False when it cannot be asked for now.
   * A `gentle` claim leaves a holder where it is; `insist()` turns it into
   * one a holder that is not writing hands over for.
   */
  claim(options?: { gentle?: boolean }): boolean {
    const self = this.opts.liveness.selfId()
    if (this.mode !== "idle" || self === undefined || !this.confirmed()) {
      return false
    }
    this.self = self
    this.gentle = options?.gentle === true
    this.refusals.clear()
    this.mode = "claiming"
    this.round = (this.opts.newRound ?? randomRound)()
    this.acks.clear()
    this.sendClaim()
    this.tryAcquire()
    return true
  }

  /**
   * Somebody answered the current claim "held" and is still there: the lane
   * will not come to this context by waiting.
   */
  get knownHeld(): boolean {
    return (
      this.mode === "claiming" &&
      this.refusals.size > 0 &&
      this.opts.liveness.absentExceptMs(this.acks) === 0
    )
  }

  /** Ask a holder to hand over, for a claim that began gentle. */
  insist(): void {
    if (this.mode !== "claiming" || !this.gentle) return
    this.gentle = false
    this.sendClaim()
  }

  /** Stop holding, or give up a claim (`StandDown`). */
  release(): void {
    this.mode = "idle"
    this.acks.clear()
    this.refusals.clear()
  }

  receive(message: LaneMessage): void {
    const self = this.opts.liveness.selfId()
    if (self === undefined || message.from === self) return
    if (message.kind === "claim") {
      this.answerClaim(message.from, message.round, message.gentle === true)
      return
    }
    if (
      this.mode !== "claiming" ||
      message.to !== this.self ||
      message.round !== this.round
    )
      return
    if (message.kind === "held") {
      this.refusals.add(message.from)
      return
    }
    // `HandleFree`
    this.refusals.delete(message.from)
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
      from: this.self,
      round: this.round,
      ...(this.gentle ? { gentle: true } : {}),
    })
  }

  private sendFree(to: string, round: string): void {
    const from = this.opts.liveness.selfId()
    if (from !== undefined) this.opts.send({ kind: "free", from, to, round })
  }

  /** `Acquire`: everybody but the devices that answered has been gone long
   *  enough, and our own connection is confirmed. */
  private tryAcquire(): void {
    if (this.mode !== "claiming" || !this.confirmed()) return
    if (this.self !== this.opts.liveness.selfId()) {
      // Claimed on a connection that is gone; its answers name nobody.
      this.release()
      return
    }
    if (this.opts.liveness.absentExceptMs(this.acks) < LEASE_WAIT_MS) return
    this.mode = "holding"
    this.opts.onAcquired?.()
  }

  /** `HandleClaim` */
  private answerClaim(claimant: string, round: string, gentle: boolean): void {
    // Overdue, on the same connection: say nothing. The claimant asks again
    // with every confirmation, and takes the lane unanswered only from a
    // context that has left the room. (`holds()` ends it on a new connection.)
    if (this.mode === "holding" && !this.holds() && this.suspended) return

    switch (this.mode) {
      case "idle":
        this.sendFree(claimant, round)
        return
      case "claiming":
        // Both claiming: the lower id wins, the other stands down.
        if (claimant < this.self) {
          this.release()
          this.sendFree(claimant, round)
        }
        return
      case "holding":
        if (this.opts.isBusy(gentle)) {
          const from = this.opts.liveness.selfId()
          if (from !== undefined) {
            this.opts.send({ kind: "held", from, to: claimant, round })
          }
          return
        }
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
    this.refusals.clear()
    if (wasWriting) this.opts.onLost?.()
  }
}

function laneName(key: LaneKey): string {
  return `${key.accountId}:${key.batchId}:${key.partition}`
}

/**
 * A context's lanes on one account bus, and its answer to every claim.
 *
 * Every context in the room must have one, whether it writes or not: a
 * claimant waits for an answer from everyone present, so a context that never
 * answers keeps every lane from being taken for as long as it stays. A claim
 * of a lane this context has not opened is answered "free" from here.
 */
export class BusLanes {
  private lanes = new Map<string, BusLane>()
  private stopListening: () => void

  constructor(private readonly bus: LaneBus) {
    this.stopListening = bus.subscribe((message, from) => {
      if (
        message.type !== "lane-claim" &&
        message.type !== "lane-free" &&
        message.type !== "lane-held"
      )
        return
      // Named by the transport as someone else: not what it says it is.
      if (from !== undefined && from !== message.from) return
      const lane = this.lanes.get(laneName(message))
      if (lane) {
        lane.receive(
          message.type === "lane-claim"
            ? {
                kind: "claim",
                from: message.from,
                round: message.round,
                gentle: message.gentle,
              }
            : {
                kind: message.type === "lane-free" ? "free" : "held",
                from: message.from,
                to: message.to,
                round: message.round,
              },
        )
        return
      }
      if (message.type !== "lane-claim") return
      const self = bus.selfId()
      if (self === undefined || self === message.from) return
      bus.publish({
        type: "lane-free",
        accountId: message.accountId,
        batchId: message.batchId,
        partition: message.partition,
        from: self,
        to: message.from,
        round: message.round,
      })
    })
  }

  /** How long ago this context's connection was confirmed. */
  confirmedAgoMs(): number {
    return this.bus.confirmedAgoMs()
  }

  onConfirmed(handler: (unconfirmedForMs: number) => void): () => void {
    return this.bus.onConfirmed(handler)
  }

  /** Take part in a lane. One per lane; `close` it to stop. */
  open(
    key: LaneKey,
    hooks: Pick<BusLaneOptions, "isBusy" | "onAcquired" | "onLost">,
  ): BusLane {
    const name = laneName(key)
    if (this.lanes.has(name)) throw new Error(`Lane ${name} is already open`)
    const lane = new BusLane({
      ...hooks,
      liveness: this.bus,
      send: (message) =>
        this.bus.publish(
          message.kind === "claim"
            ? {
                type: "lane-claim",
                ...key,
                from: message.from,
                round: message.round,
                gentle: message.gentle,
              }
            : {
                type: message.kind === "free" ? "lane-free" : "lane-held",
                ...key,
                from: message.from,
                to: message.to,
                round: message.round,
              },
        ),
    })
    this.lanes.set(name, lane)
    return lane
  }

  /** Stop taking part in a lane: held or claimed, it is given up. */
  close(key: LaneKey): void {
    const name = laneName(key)
    this.lanes.get(name)?.close()
    this.lanes.delete(name)
  }

  closeAll(): void {
    this.stopListening()
    for (const lane of this.lanes.values()) lane.close()
    this.lanes.clear()
  }
}
