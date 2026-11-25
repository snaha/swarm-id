// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Does `bus-lease.ts` keep the promise `models/bus-lease` proves for the
 * protocol: never two writers on a lane at once?
 *
 * Real lanes, account buses and signaling transports run against a simulated
 * signaling server on fake timers, under random schedules with the faults the
 * model allows: a socket that dies without either side noticing at once, a
 * server stream that stalls and comes back on the same socket, and lane
 * messages lost, repeated, or held back and delivered late. Two of the
 * contexts are tabs of one browser and also share a `BroadcastChannel`, which
 * still delivers while their server stream is stalled.
 *
 * After every 100 ms of simulated time, at most one context may get `true`
 * from `holds()`, which is what a writer asks before each write.
 *
 * A failure prints its seed; `BUS_LEASE_SEED=<seed>` runs that schedule
 * alone, and `BUS_LEASE_RUNS=<n>` runs more of them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AccountBus, type BusTransport } from "../bus/account-bus"
import type { BusMessageInput } from "../bus/messages"
import { SignalingTransport } from "../bus/signaling-transport"
import {
  BusLanes,
  LEASE_STOP_MS,
  LEASE_WAIT_MS,
  type BusLane,
} from "./bus-lease"

// What is under test is who may write, not the cipher: the identity envelope
// keeps every delivery a microtask, so a seed replays the same schedule.
vi.mock("../bus/envelope", () => ({
  encryptEnvelope: async (plaintext: string) => plaintext,
  decryptEnvelope: async (ciphertext: string) => ciphertext,
}))

const DEFAULT_RUNS = 60
const STEPS_PER_RUN = 150
const SLICE_MS = 100
const MAX_ADVANCE_MS = 4000
/** One way, client to server or back. */
const LATENCY_MS = 5
/** `signaling/src/server.ts` */
const SERVER_TICK_MS = 2000
const MAX_SILENT_TICKS = 4
const CONTEXTS = 3
/** Contexts 0 and 1 are tabs of one browser. */
const SAME_BROWSER = new Set([0, 1])
const TRACE_TAIL = 60
/** Generous per schedule; one takes about 20 ms. */
const MS_PER_RUN = 200
const MIN_TIMEOUT_MS = 60_000

/** How often each kind of step comes up in a random schedule. */
const STEP_ODDS = {
  advance: 0.3,
  claim: 0.2,
  insist: 0.05,
  release: 0.07,
  toggleBusy: 0.08,
  stall: 0.08,
  resume: 0.08,
  cut: 0.02,
  serverDrops: 0.03,
  reopen: 0.03,
  lateRelay: 0.06,
} as const
type Step = keyof typeof STEP_ODDS
/** Of the claims, how many are gentle. */
const GENTLE_ODDS = 0.2
/** What becomes of a lane relay: lost, held back, or delivered twice. */
const RELAY_DROP_ODDS = 0.1
const RELAY_HOLD_ODDS = 0.1
const RELAY_REPEAT_ODDS = 0.1
/** A message on the BroadcastChannel that a frozen tab misses. */
const LOCAL_LOSS = 0.05

function pickStep(roll: number): Step {
  let cumulative = 0
  for (const [step, odds] of Object.entries(STEP_ODDS)) {
    cumulative += odds
    if (roll < cumulative) return step as Step
  }
  return "advance"
}

const LANE = {
  accountId: "a".repeat(40),
  batchId: "b".repeat(64),
  partition: 1,
}

/** mulberry32: small, seedable, good enough to pick a schedule. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
}

type Listener = (event: { data?: unknown; code?: number }) => void

/** The browser's `WebSocket`, as far as `SignalingTransport` uses it. */
class SimSocket {
  static readonly OPEN = 1
  readyState = 0
  private listeners = new Map<string, Listener[]>()

  constructor(_url: string) {
    sim().connect(this)
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send(data: string): void {
    sim().fromClient(this, data)
  }

  close(): void {
    sim().clientClosed(this)
  }

  emit(type: string, event: { data?: unknown; code?: number } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

interface Connection {
  socket: SimSocket
  peerId?: string
  silentTicks: number
  /** Client to server is lost. */
  upDead: boolean
  /** Server to client: delivered, held until unstalled, or lost. */
  down: "ok" | "stalled" | "dead"
  held: (() => void)[]
  closed: boolean
}

interface HeldRelay {
  to: string
  frame: string
}

/** The signaling server and the network between it and every socket. */
class Sim {
  connections: Connection[] = []
  /** Lane relays held back, to be delivered at some later step or never. */
  limbo: HeldRelay[] = []
  /** What a scenario does to a message: lose it, on either path, or hold
   *  a relay back in `limbo`. */
  fault?: (
    message: BusMessageInput,
    path: "server" | "local",
  ) => "drop" | "hold" | undefined
  private ticker: ReturnType<typeof setInterval>

  constructor(
    readonly random: () => number,
    readonly trace: (line: string) => void,
    /** Lose, repeat and hold back lane relays; lose local messages. */
    readonly lossy: boolean,
    /** Names for the next joiners, before random ones. */
    private names: string[] = [],
  ) {
    this.ticker = setInterval(() => this.tick(), SERVER_TICK_MS)
  }

  stop(): void {
    clearInterval(this.ticker)
  }

  room(): Connection[] {
    return this.connections.filter((c) => c.peerId !== undefined && !c.closed)
  }

  of(socket: SimSocket): Connection | undefined {
    return this.connections.find((c) => c.socket === socket)
  }

  connect(socket: SimSocket): void {
    const connection: Connection = {
      socket,
      silentTicks: 0,
      upDead: false,
      down: "ok",
      held: [],
      closed: false,
    }
    this.connections.push(connection)
    setTimeout(() => {
      socket.readyState = SimSocket.OPEN
      socket.emit("open")
    }, LATENCY_MS)
  }

  /** Server to client, through whatever the link is doing. */
  private toClient(connection: Connection, deliver: () => void): void {
    if (connection.down === "dead") return
    if (connection.down === "stalled") {
      connection.held.push(deliver)
      return
    }
    setTimeout(deliver, LATENCY_MS)
  }

  private send(connection: Connection, message: object): void {
    const data = JSON.stringify(message)
    this.toClient(connection, () => connection.socket.emit("message", { data }))
  }

  fromClient(socket: SimSocket, data: string): void {
    const connection = this.of(socket)
    if (!connection || connection.upDead || connection.closed) return
    setTimeout(() => this.receive(connection, data), LATENCY_MS)
  }

  private receive(connection: Connection, data: string): void {
    if (connection.closed) return
    const message = JSON.parse(data) as {
      type: string
      to?: string
      payload?: string
      nonce?: number
    }
    if (message.type === "join") {
      const others = this.room()
      // Random, as the server's `randomUUID()`: which of two contexts wins a
      // tie must not follow the order they joined in.
      connection.peerId =
        this.names.shift() ??
        Math.floor(this.random() * 2 ** 32)
          .toString(16)
          .padStart(8, "0")
      connection.silentTicks = 0
      this.trace(`server: ${connection.peerId} joins`)
      this.send(connection, {
        type: "welcome",
        peerId: connection.peerId,
        peers: others.map((c) => c.peerId),
      })
      for (const other of others) {
        this.send(other, { type: "peer-joined", peerId: connection.peerId })
      }
      return
    }
    if (connection.peerId === undefined) return
    if (message.type === "ping") {
      connection.silentTicks = 0
      this.send(connection, { type: "pong", nonce: message.nonce })
      return
    }
    if (message.type === "relay" && message.to !== undefined) {
      const frame = JSON.stringify({
        type: "relay",
        from: connection.peerId,
        payload: message.payload,
      })
      this.relay(message.to, frame)
    }
  }

  /** Lane messages may be lost, repeated, or delivered late (the model's
   *  `msgs`); the rest arrive as sent. */
  private relay(to: string, frame: string): void {
    const { payload } = JSON.parse(frame) as { payload: string }
    const fault = this.fault?.(JSON.parse(payload) as BusMessageInput, "server")
    if (fault === "drop") {
      this.trace(`net: scenario drops relay to ${to}`)
      return
    }
    if (fault === "hold") {
      this.trace(`net: scenario holds relay to ${to}`)
      this.limbo.push({ to, frame })
      return
    }
    const roll = this.lossy ? this.random() : 1
    if (roll < RELAY_DROP_ODDS) {
      this.trace(`net: drop relay to ${to}`)
      return
    }
    if (roll < RELAY_DROP_ODDS + RELAY_HOLD_ODDS) {
      this.trace(`net: hold relay to ${to}`)
      this.limbo.push({ to, frame })
      return
    }
    this.deliverRelay(to, frame)
    if (roll < RELAY_DROP_ODDS + RELAY_HOLD_ODDS + RELAY_REPEAT_ODDS) {
      this.deliverRelay(to, frame)
    }
  }

  deliverRelay(to: string, frame: string): void {
    const target = this.room().find((c) => c.peerId === to)
    if (target) {
      this.send(target, JSON.parse(frame) as object)
    }
  }

  private tick(): void {
    for (const connection of this.room()) {
      if (connection.silentTicks >= MAX_SILENT_TICKS) {
        this.trace(`server: reaps ${connection.peerId}`)
        this.drop(connection)
        continue
      }
      connection.silentTicks += 1
      this.send(connection, { type: "tick" })
    }
  }

  /** The server closes the socket and tells the room. */
  private drop(connection: Connection): void {
    connection.closed = true
    for (const other of this.room()) {
      this.send(other, { type: "peer-left", peerId: connection.peerId })
    }
    this.toClient(connection, () =>
      connection.socket.emit("close", { code: 1006 }),
    )
  }

  clientClosed(socket: SimSocket): void {
    const connection = this.of(socket)
    if (!connection || connection.closed) return
    if (!connection.upDead) {
      setTimeout(() => {
        if (!connection.closed) this.drop(connection)
      }, LATENCY_MS)
    }
    connection.down = "dead"
    setTimeout(() => socket.emit("close", { code: 1000 }), LATENCY_MS)
  }

  stall(connection: Connection): void {
    if (connection.down === "ok") connection.down = "stalled"
  }

  unstall(connection: Connection): void {
    if (connection.down !== "stalled") return
    connection.down = "ok"
    const held = connection.held
    connection.held = []
    for (const deliver of held) setTimeout(deliver, LATENCY_MS)
  }

  /** The socket dies; neither side is told. */
  cut(connection: Connection): void {
    connection.upDead = true
    connection.down = "dead"
    connection.held = []
  }

  /** The socket dies and the server sees it at once (an ingress dropping
   *  its side), while the client is not told: the model's `LinkDown`
   *  followed straight by `ServerNotices`. */
  serverDrops(connection: Connection): void {
    this.cut(connection)
    this.drop(connection)
  }
}

let current: Sim | undefined
function sim(): Sim {
  if (!current) throw new Error("no simulation running")
  return current
}

/** `BroadcastChannel` between the tabs of one browser: in order, and lost
 *  only on a tab that is not running (frozen, or in the back-forward cache). */
class SimLocalTransport implements BusTransport {
  readonly local = true
  private handlers = new Set<(raw: unknown) => void>()

  constructor(private peers: SimLocalTransport[]) {
    peers.push(this)
  }

  publish(message: BusMessageInput): void {
    const copy = structuredClone(message)
    for (const peer of this.peers) {
      if (peer === this) continue
      const lost =
        sim().fault?.(message, "local") === "drop" ||
        (sim().lossy && sim().random() < LOCAL_LOSS)
      if (lost) {
        sim().trace(`local: ${message.type} lost`)
        continue
      }
      setTimeout(() => {
        for (const handler of peer.handlers) handler(copy)
      }, LATENCY_MS)
    }
  }

  subscribe(handler: (raw: unknown) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  close(): void {
    this.handlers.clear()
    this.peers.splice(this.peers.indexOf(this), 1)
  }
}

interface Context {
  index: number
  transport: SignalingTransport
  bus: AccountBus
  lanes: BusLanes
  lane: BusLane
  busy: boolean
}

interface WorldOptions {
  seed: number
  lossy: boolean
  names?: string[]
}

/** Contexts in slots, the simulated server, and the exclusion check. */
class World {
  readonly random: () => number
  readonly trace: string[] = []
  /** A slot is empty between a context closing and its successor opening. */
  readonly contexts: (Context | undefined)[] = []
  acquisitions = 0
  readonly everHeld = new Set<number>()
  private local: SimLocalTransport[] = []
  private reopening: ReturnType<typeof setTimeout>[] = []

  constructor(private options: WorldOptions) {
    this.random = rng(options.seed)
    vi.spyOn(Math, "random").mockImplementation(this.random)
    current = new Sim(
      this.random,
      (line) => this.log(line),
      options.lossy,
      options.names,
    )
  }

  log(line: string): void {
    this.trace.push(`${Date.now()}ms ${line}`)
  }

  live(): Context[] {
    return this.contexts.filter((c): c is Context => c !== undefined)
  }

  ctx(index: number): Context {
    const context = this.contexts[index]
    if (!context) throw new Error(`slot ${index} is empty`)
    return context
  }

  open(index: number): Context {
    const transport = new SignalingTransport({
      url: "ws://signaling.invalid",
      topic: "topic",
      encryptionKey: {} as CryptoKey,
    })
    const bus = new AccountBus(
      SAME_BROWSER.has(index) ? [new SimLocalTransport(this.local)] : [],
    )
    bus.addTransport(transport)
    const lanes = new BusLanes(bus)
    const context: Context = {
      index,
      transport,
      bus,
      lanes,
      busy: false,
      lane: lanes.open(LANE, {
        isBusy: () => context.busy,
        onAcquired: () => {
          this.acquisitions += 1
          this.everHeld.add(index)
          this.log(`ctx${index}: acquired as ${transport.selfId()}`)
        },
        onLost: () => this.log(`ctx${index}: lost`),
      }),
    }
    bus.subscribe((message, from) => {
      if (message.type.startsWith("lane-")) {
        const m = message as { type: string; from: string; to?: string }
        this.log(
          `ctx${index} gets ${m.type} from ${m.from}${m.to ? ` to ${m.to}` : ""} via ${from === undefined ? "local" : "server"}`,
        )
      }
    })
    this.contexts[index] = context
    return context
  }

  close(index: number): void {
    const context = this.ctx(index)
    context.lanes.closeAll()
    context.bus.close()
    this.contexts[index] = undefined
  }

  /** Closes the context in `index` and opens a new one there after `gapMs`. */
  reopen(index: number, gapMs: number): void {
    this.close(index)
    this.reopening.push(
      setTimeout(() => {
        this.open(index)
        this.log(`ctx${index}: opens again`)
      }, gapMs),
    )
  }

  /** The context's current socket, if the server still has it. */
  socket(index: number): Connection | undefined {
    const id = this.contexts[index]?.transport.selfId()
    return sim()
      .room()
      .find((c) => c.peerId === id)
  }

  fail(what: string): never {
    throw new Error(
      `seed ${this.options.seed}: ${what}\n` +
        this.trace.slice(-TRACE_TAIL).join("\n"),
    )
  }

  checkExclusion(): void {
    const writers = this.live()
      .filter((c) => c.lane.holds())
      .map((c) => c.index)
    if (writers.length > 1) {
      this.fail(`contexts ${writers.join(" and ")} both hold`)
    }
  }

  async advance(ms: number): Promise<void> {
    for (let elapsed = 0; elapsed < ms; elapsed += SLICE_MS) {
      await vi.advanceTimersByTimeAsync(Math.min(SLICE_MS, ms - elapsed))
      this.checkExclusion()
    }
  }

  end(): void {
    for (const timer of this.reopening) clearTimeout(timer)
    for (const context of this.live()) this.close(context.index)
    sim().stop()
    current = undefined
    vi.mocked(Math.random).mockRestore()
  }
}

/** Old enough a session that an empty room counts, then the lane, busy. */
async function takeLane(world: World, index: number): Promise<Context> {
  const context = world.ctx(index)
  context.busy = true
  await world.advance(LEASE_WAIT_MS + SERVER_TICK_MS)
  expect(context.lane.claim()).toBe(true)
  await world.advance(SLICE_MS)
  expect(context.lane.holds()).toBe(true)
  return context
}

/** One random schedule of `STEPS_PER_RUN` steps. */
async function runSchedule(world: World): Promise<void> {
  const { random } = world
  for (let index = 0; index < CONTEXTS; index++) world.open(index)
  for (let n = 0; n < STEPS_PER_RUN; n++) {
    const step = pickStep(random())
    const present = world.live()
    if (step === "advance" || present.length === 0) {
      await world.advance(
        Math.ceil((random() * MAX_ADVANCE_MS) / SLICE_MS) * SLICE_MS,
      )
      continue
    }
    const { index, lane } = present[Math.floor(random() * present.length)]
    const name = `ctx${index}`
    const socket = world.socket(index)
    switch (step) {
      case "claim": {
        const gentle = random() < GENTLE_ODDS
        if (lane.claim({ gentle })) {
          world.log(`${name}: claims${gentle ? " gently" : ""}`)
        }
        break
      }
      case "insist":
        lane.insist()
        break
      case "release":
        world.log(`${name}: releases`)
        lane.release()
        break
      case "toggleBusy": {
        const context = world.ctx(index)
        context.busy = !context.busy
        world.log(`${name}: busy=${context.busy}`)
        break
      }
      case "stall":
        if (socket?.down === "ok") {
          world.log(`${name}: stream stalls`)
          sim().stall(socket)
        }
        break
      case "resume":
        if (socket?.down === "stalled") {
          world.log(`${name}: stream resumes`)
          sim().unstall(socket)
        }
        break
      case "cut":
        if (socket) {
          world.log(`${name}: socket dies`)
          sim().cut(socket)
        }
        break
      case "serverDrops":
        if (socket) {
          world.log(`${name}: socket dies, the server sees it at once`)
          sim().serverDrops(socket)
        }
        break
      case "reopen":
        // A tab reloads, or is closed and opened again later, in the same
        // browser.
        world.log(`${name}: closes`)
        world.reopen(index, Math.floor(random() * MAX_ADVANCE_MS))
        break
      case "lateRelay": {
        const limbo = sim().limbo
        if (limbo.length === 0) break
        const [held] = limbo.splice(Math.floor(random() * limbo.length), 1)
        world.log(`net: late relay to ${held.to}`)
        sim().deliverRelay(held.to, held.frame)
        break
      }
    }
    world.checkExclusion()
  }
  // Long enough for anything stalled or cut to have played out.
  await world.advance(LEASE_WAIT_MS + LEASE_STOP_MS)
}

describe("bus lease conformance", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
        "performance",
      ],
    })
    vi.stubGlobal("WebSocket", SimSocket)
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it(
    "never lets two contexts hold a lane at once, under random faults",
    async () => {
      const only = process.env.BUS_LEASE_SEED
      const runs = Number(process.env.BUS_LEASE_RUNS ?? DEFAULT_RUNS)
      const seeds =
        only !== undefined
          ? [Number(only)]
          : Array.from({ length: runs }, (_, index) => index + 1)
      let acquisitions = 0
      let handedOn = 0
      for (const seed of seeds) {
        const world = new World({ seed, lossy: true })
        try {
          await runSchedule(world)
        } finally {
          world.end()
        }
        acquisitions += world.acquisitions
        if (world.everHeld.size > 1) handedOn += 1
      }
      // Not vacuous: lanes are taken, and pass between contexts.
      expect(acquisitions).toBeGreaterThan(seeds.length)
      if (only === undefined) expect(handedOn).toBeGreaterThan(seeds.length / 2)
    },
    Math.max(
      MIN_TIMEOUT_MS,
      Number(process.env.BUS_LEASE_RUNS ?? DEFAULT_RUNS) * MS_PER_RUN,
    ),
  )

  // models/bus-lease, NoContactReset.cfg: what `ResetOnContact` prevents.
  // A tab's server stream stalls, and a sibling tab opens meanwhile, which
  // the stalled view does not show. The newcomer claims over the
  // BroadcastChannel, is answered "free", and then its own stream stalls, so
  // it asks nobody again until it resumes. The stalled tab, having heard from
  // the newcomer, must not take the lane on its view of an empty room: the
  // newcomer holds the stalled tab's "free" and acts on it when it resumes.
  it("does not take a lane on a stalled view of a tab it has just heard from", async () => {
    // The newcomer has the lower name, so it does not stand down for the
    // stalled tab's claim.
    const world = new World({ seed: 1, lossy: false, names: ["bb", "aa"] })
    try {
      const stalled = world.open(0)
      stalled.busy = true
      // Old enough a session that the room has looked empty for LEASE_WAIT_MS.
      await world.advance(LEASE_WAIT_MS + SERVER_TICK_MS)
      sim().stall(world.socket(0)!)
      const newcomer = world.open(1)
      await world.advance(SLICE_MS)
      expect(newcomer.lane.claim()).toBe(true)
      await world.advance(SLICE_MS)
      sim().stall(world.socket(1)!)
      stalled.lane.claim()
      // Overdue when its stream resumes, so the claims waiting in it go
      // unanswered; then confirmed again.
      await world.advance(LEASE_STOP_MS + SERVER_TICK_MS / 2)
      sim().unstall(world.socket(0)!)
      // The newcomer's session is LEASE_WAIT_MS old when it resumes.
      await world.advance(LEASE_WAIT_MS - LEASE_STOP_MS)
      sim().unstall(world.socket(1)!)
      await world.advance(LEASE_WAIT_MS + LEASE_STOP_MS)
      expect(world.everHeld.size).toBeGreaterThan(0)
    } finally {
      world.end()
    }
  })

  // models/bus-lease, Acquire without `since[d] < TStop`: a claimant whose
  // stream stalled must not take the lane while unconfirmed. It answers a
  // sibling tab's claim "free", claims itself, and is then frozen: its
  // stream holds everything, and it misses the sibling's BroadcastChannel
  // messages. Its own claim is lost too, so nobody stands down for it. When
  // it thaws, the first message is the answer to a ping sent before the
  // stall: a confirmation too old to write on, which arrives before the news
  // that the sibling joined.
  it("does not take a lane on a confirmation too old to write on", async () => {
    // The stalled tab has the lower name, so its sibling never stands down.
    const world = new World({ seed: 1, lossy: false, names: ["aa", "bb"] })
    let siblingHeard = false
    sim().fault = (message, path) => {
      if (message.type === "lane-claim" && message.from === "aa") return "drop"
      // The frozen tab hears the sibling's first claim, then nothing local.
      if (path === "local" && message.type === "lane-claim") {
        if (!siblingHeard) {
          siblingHeard = true
          return undefined
        }
        return "drop"
      }
      return undefined
    }
    try {
      const stalled = world.open(0)
      stalled.busy = true
      // Old enough a session that the room has looked empty for LEASE_WAIT_MS,
      // and stalled with the answer to its latest ping still on the way.
      await world.advance(LEASE_WAIT_MS + SERVER_TICK_MS)
      await world.advance(LATENCY_MS + LATENCY_MS / 2)
      sim().stall(world.socket(0)!)
      const sibling = world.open(1)
      await world.advance(SLICE_MS / 2)
      expect(sibling.lane.claim()).toBe(true)
      await world.advance(SLICE_MS / 2)
      expect(stalled.lane.claim()).toBe(true)
      // The sibling was last heard from LEASE_WAIT_MS ago when this resumes.
      await world.advance(LEASE_WAIT_MS)
      sim().unstall(world.socket(0)!)
      await world.advance(LEASE_WAIT_MS + LEASE_STOP_MS)
      expect(world.everHeld.size).toBeGreaterThan(0)
    } finally {
      world.end()
    }
  })

  // models/bus-lease, NoRoundMatch.cfg: an answer counts only for the claim
  // it answers. A "free" for an earlier claim, delivered late, says nothing
  // about a claim made since, after which the lane changed hands.
  it("does not count a late answer to an earlier claim", async () => {
    const world = new World({ seed: 1, lossy: false })
    let holdFree = true
    sim().fault = (message) =>
      holdFree && message.type === "lane-free" ? "hold" : undefined
    try {
      const holder = world.open(0)
      const claimant = world.open(2)
      await world.advance(SLICE_MS)
      // Answered "free", but the answer is held back.
      expect(claimant.lane.claim()).toBe(true)
      await world.advance(SLICE_MS)
      claimant.lane.release()
      holdFree = false
      await takeLane(world, 0)
      expect(claimant.lane.claim()).toBe(true)
      await world.advance(SLICE_MS)
      const [late] = sim().limbo.splice(0)
      sim().deliverRelay(late.to, late.frame)
      await world.advance(LEASE_WAIT_MS)
      expect(holder.lane.holds()).toBe(true)
    } finally {
      world.end()
    }
  })

  // The server can drop a socket at once while the client hears nothing
  // (an ingress closing its side). A holder writes only on a confirmation
  // younger than LEASE_STOP_MS, and the room waits LEASE_WAIT_MS, longer,
  // after it left before taking the lane without it.
  it("stops writing before the room takes the lane from a holder it dropped", async () => {
    const world = new World({ seed: 1, lossy: false })
    try {
      world.open(0)
      const other = world.open(2)
      const holder = await takeLane(world, 0)
      sim().serverDrops(world.socket(0)!)
      other.busy = true
      for (let waited = 0; waited < LEASE_WAIT_MS * 2; waited += SLICE_MS) {
        other.lane.claim()
        await world.advance(SLICE_MS)
      }
      expect(other.lane.holds()).toBe(true)
      expect(holder.lane.holds()).toBe(false)
    } finally {
      world.end()
    }
  })

  // A context that joins after the holder's socket was dropped does not see
  // the holder at all, not even leaving. It counts the room empty only from
  // its own join, so it too waits LEASE_WAIT_MS.
  it("waits out its own session before taking a lane from an empty room", async () => {
    const world = new World({ seed: 1, lossy: false })
    try {
      world.open(0)
      const holder = await takeLane(world, 0)
      sim().serverDrops(world.socket(0)!)
      const newcomer = world.open(2)
      newcomer.busy = true
      for (let waited = 0; waited < LEASE_WAIT_MS * 2; waited += SLICE_MS) {
        newcomer.lane.claim()
        await world.advance(SLICE_MS)
      }
      expect(newcomer.lane.holds()).toBe(true)
      expect(holder.lane.holds()).toBe(false)
    } finally {
      world.end()
    }
  })

  // A holder whose stream stalled past LEASE_STOP_MS may not write, and
  // writes again once confirmed. It must not answer "free" meanwhile: the
  // claimant would take the lane on its word.
  it("leaves claims unanswered while overdue, and keeps the lane", async () => {
    const world = new World({ seed: 1, lossy: false })
    try {
      world.open(0)
      const sibling = world.open(1)
      const holder = await takeLane(world, 0)
      sim().stall(world.socket(0)!)
      await world.advance(LEASE_STOP_MS + SLICE_MS)
      expect(holder.lane.holds()).toBe(false)
      // Reaches the holder over the BroadcastChannel.
      sibling.lane.claim()
      await world.advance(SLICE_MS)
      sim().unstall(world.socket(0)!)
      await world.advance(SERVER_TICK_MS * 2)
      expect(holder.lane.holds()).toBe(true)
    } finally {
      world.end()
    }
  })
})
