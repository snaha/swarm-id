// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest"
import { EthAddress, PrivateKey } from "@ethersphere/bee-js"
import type { Device } from "../schemas"

// readRosterEntry downloads the device blob via downloadDataWithChunkAPI; mock it
// to decode the index we encode into the SOC reference (see fakeBee below).
const mockDownloadData = vi.fn()
vi.mock("../proxy/download-data", () => ({
  downloadDataWithChunkAPI: (...args: unknown[]) => mockDownloadData(...args),
}))

import {
  readRoster,
  ensureInRoster,
  resetRosterScanCache,
  RosterScanInconclusiveError,
  rosterTopic,
  rosterIdentifier,
} from "./device-roster"

const OWNER = new EthAddress("a".repeat(40))
const ACCOUNT_ID = "b".repeat(40)

// Every test shares one ACCOUNT_ID/OWNER — forget the known-length memo between
// tests so a warm scan in one test can't change another's probing.
beforeEach(() => {
  resetRosterScanCache()
})

function makeDevice(index: number): Device {
  return {
    deviceId: `dev-${index}`,
    name: `dev-${index}`,
    createdAt: 1000,
    lastSignedInAt: 1000,
  }
}

// A reference whose first byte carries the roster index, so the mocked blob
// download can return the right device without a real Swarm round-trip.
function refForIndex(index: number): Uint8Array {
  const ref = new Uint8Array(32)
  ref[0] = index
  return ref
}

// Bee's /soc endpoint returns a real 404 for an absent single-owner chunk — the
// only signal that a roster slot is genuinely empty (end-of-feed).
function notFound404(): Error {
  return Object.assign(new Error("requested chunk cannot be retrieved"), {
    status: 404,
  })
}

// A 5xx is a transient/inconclusive read, NOT a confirmed-empty slot.
function serverError500(): Error {
  return Object.assign(new Error("internal error"), { status: 500 })
}

/**
 * Fake Bee that serves roster SOCs ONLY for `presentIndices`. Reverse-maps the
 * requested identifier back to its index via `rosterIdentifier`, so the windowed
 * scan exercises real gap detection. Pass `probed` to record which indices the
 * scan actually read (in request order).
 */
function fakeBee(presentIndices: Set<number>, probed?: number[]) {
  const topic = rosterTopic(ACCOUNT_ID)
  const identToIndex = new Map<string, number>()
  for (let i = 0; i < 64; i++) {
    identToIndex.set(rosterIdentifier(topic, BigInt(i)).toHex(), i)
  }
  return {
    makeSOCReader: () => ({
      download: async (identifier: { toHex(): string }) => {
        const index = identToIndex.get(identifier.toHex())
        if (index !== undefined) probed?.push(index)
        if (index === undefined || !presentIndices.has(index)) {
          throw notFound404()
        }
        return { payload: { toUint8Array: () => refForIndex(index) } }
      },
    }),
  }
}

describe("readRoster — windowed-parallel scan", () => {
  beforeEach(() => {
    mockDownloadData.mockReset()
    mockDownloadData.mockImplementation((_bee: unknown, refHex: string) => {
      // refHex first byte (chars 0..1) is the index we encoded.
      const index = parseInt(refHex.slice(0, 2), 16)
      return new TextEncoder().encode(JSON.stringify(makeDevice(index)))
    })
  })

  it("reads a contiguous roster (present prefix shorter than one window)", async () => {
    const bee = fakeBee(new Set([0, 1, 2]))
    const devices = await readRoster({
      bee: bee as never,
      accountId: ACCOUNT_ID,
      owner: OWNER,
    })
    expect(devices.map((d) => d.deviceId).sort()).toEqual([
      "dev-0",
      "dev-1",
      "dev-2",
    ])
  })

  it("skips a transient hole and keeps later entries (no truncation)", async () => {
    // 0,1 present, 2 missing (transient read failure), 3 present. A contiguous
    // roster can't have a real entry past a real gap, so index 2 is transient —
    // dev-3 must survive instead of being dropped with the rest of the tail.
    const bee = fakeBee(new Set([0, 1, 3]))
    const devices = await readRoster({
      bee: bee as never,
      accountId: ACCOUNT_ID,
      owner: OWNER,
    })
    expect(devices.map((d) => d.deviceId).sort()).toEqual([
      "dev-0",
      "dev-1",
      "dev-3",
    ])
  })

  it("crosses a full first window into the second before the gap", async () => {
    // ROSTER_SCAN_WINDOW = 16: full window 0..15 present, then 16,17 present, 18 gap.
    const present = new Set<number>()
    for (let i = 0; i <= 17; i++) present.add(i)
    const bee = fakeBee(present)
    const devices = await readRoster({
      bee: bee as never,
      accountId: ACCOUNT_ID,
      owner: OWNER,
    })
    expect(devices).toHaveLength(18)
    expect(devices.some((d) => d.deviceId === "dev-17")).toBe(true)
  })

  it("returns [] for an empty roster (index 0 missing)", async () => {
    const bee = fakeBee(new Set())
    const devices = await readRoster({
      bee: bee as never,
      accountId: ACCOUNT_ID,
      owner: OWNER,
    })
    expect(devices).toEqual([])
  })
})

// The per-read timeout (ROSTER_READ_TIMEOUT_MS) is module-private; the SOC read
// is bounded by it. Driven here with fake timers + a hanging download.
const ROSTER_READ_TIMEOUT_MS = 2500

/**
 * Fake Bee where index `slowOnce` HANGS on its first SOC read (→ a timeout, not
 * a clean miss) then resolves present on retry, and index `alwaysSlow` hangs on
 * every read. A hanging read is what the slow gateway does; a clean miss throws
 * synchronously (as `fakeBee` does), which `readRoster` treats as end-of-feed.
 */
function fakeBeeWithSlow(opts: {
  present: Set<number>
  slowOnce?: number
  alwaysSlow?: number
  serverErrorOnce?: number
  alwaysServerError?: number
}): { readCount: number; bee: unknown } {
  const topic = rosterTopic(ACCOUNT_ID)
  const identToIndex = new Map<string, number>()
  for (let i = 0; i < 64; i++) {
    identToIndex.set(rosterIdentifier(topic, BigInt(i)).toHex(), i)
  }
  const calls = new Map<number, number>()
  const state = { readCount: 0 }
  const bee = {
    makeSOCReader: () => ({
      download: (identifier: { toHex(): string }) => {
        const index = identToIndex.get(identifier.toHex())
        if (index === undefined) throw notFound404()
        state.readCount++
        const n = (calls.get(index) ?? 0) + 1
        calls.set(index, n)
        if (index === opts.alwaysSlow) return new Promise(() => {}) // never settles
        if (index === opts.slowOnce && n === 1) return new Promise(() => {})
        // A 5xx is inconclusive, like a timeout — the scan must not read it as
        // a confirmed-empty slot.
        if (index === opts.alwaysServerError) throw serverError500()
        if (index === opts.serverErrorOnce && n === 1) throw serverError500()
        const present =
          opts.present.has(index) ||
          index === opts.slowOnce ||
          index === opts.serverErrorOnce
        if (!present) throw notFound404() // clean 404 → end of feed
        return Promise.resolve({
          payload: { toUint8Array: () => refForIndex(index) },
        })
      },
    }),
  }
  return {
    get readCount() {
      return state.readCount
    },
    bee,
  }
}

describe("readRoster — a timed-out read is not end-of-feed", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockDownloadData.mockReset()
    mockDownloadData.mockImplementation((_bee: unknown, refHex: string) => {
      const index = parseInt(refHex.slice(0, 2), 16)
      return new TextEncoder().encode(JSON.stringify(makeDevice(index)))
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("retries a timed-out slot once and does NOT report the roster empty", async () => {
    // The roster's only device (index 0) hangs on its first read — without the
    // retry, the empty-looking window 0 would be read as end-of-feed and the
    // roster would come back []. The retry resolves it.
    const { bee } = fakeBeeWithSlow({ present: new Set([0]), slowOnce: 0 })
    const promise = readRoster({
      bee: bee as never,
      accountId: ACCOUNT_ID,
      owner: OWNER,
    })
    await vi.advanceTimersByTimeAsync(ROSTER_READ_TIMEOUT_MS) // fire the hang
    expect((await promise).map((d) => d.deviceId)).toEqual(["dev-0"])
  })

  it("does not truncate the tail when a later window's only device times out once", async () => {
    // Window 0 (0..15) full + index 16 present-but-slow in window 1. The old
    // behaviour read window 1 as all-empty and dropped dev-16.
    const present = new Set<number>()
    for (let i = 0; i <= 15; i++) present.add(i)
    const { bee } = fakeBeeWithSlow({ present, slowOnce: 16 })
    const promise = readRoster({
      bee: bee as never,
      accountId: ACCOUNT_ID,
      owner: OWNER,
    })
    await vi.advanceTimersByTimeAsync(ROSTER_READ_TIMEOUT_MS)
    const devices = await promise
    expect(devices).toHaveLength(17)
    expect(devices.some((d) => d.deviceId === "dev-16")).toBe(true)
  })

  it("throws when index 0 times out on both the read and the retry (nothing folded)", async () => {
    // Index 0 inconclusive on both attempts, zero devices folded: an empty roster
    // and an outage are indistinguishable, so surface it rather than return [].
    const { bee } = fakeBeeWithSlow({ present: new Set(), alwaysSlow: 0 })
    const promise = readRoster({
      bee: bee as never,
      accountId: ACCOUNT_ID,
      owner: OWNER,
    })
    // Attach the rejection assertion before advancing timers so the rejection is
    // handled (no unhandled-rejection noise).
    const assertion = expect(promise).rejects.toBeInstanceOf(
      RosterScanInconclusiveError,
    )
    await vi.advanceTimersByTimeAsync(ROSTER_READ_TIMEOUT_MS) // first read
    await vi.advanceTimersByTimeAsync(ROSTER_READ_TIMEOUT_MS) // the one retry
    await assertion
  })

  it("treats a 5xx like a timeout: retries and does NOT truncate the tail", async () => {
    // Window 0 (0..15) full + index 16 present-but-500-once in window 1. A 5xx is
    // inconclusive (not a confirmed-empty slot), so the retry recovers dev-16
    // instead of reading window 1 as end-of-feed.
    const present = new Set<number>()
    for (let i = 0; i <= 15; i++) present.add(i)
    const { bee } = fakeBeeWithSlow({ present, serverErrorOnce: 16 })
    const devices = await readRoster({
      bee: bee as never,
      accountId: ACCOUNT_ID,
      owner: OWNER,
    })
    expect(devices).toHaveLength(17)
    expect(devices.some((d) => d.deviceId === "dev-16")).toBe(true)
  })

  it("does not retry a cleanly-empty window (clean 404s stop the scan immediately)", async () => {
    // Window 0 present, window 1 all clean misses: end-of-feed with no retry, so
    // each scanned index is read exactly once.
    const present = new Set<number>()
    for (let i = 0; i <= 15; i++) present.add(i)
    const fake = fakeBeeWithSlow({ present })
    const devices = await readRoster({
      bee: fake.bee as never,
      accountId: ACCOUNT_ID,
      owner: OWNER,
    })
    expect(devices).toHaveLength(16)
    // 16 (window 0) + 16 (window 1, all clean miss → stop). No retry round.
    expect(fake.readCount).toBe(32)
  })
})

describe("readRoster / ensureInRoster — inconclusive is not empty", () => {
  beforeEach(() => {
    mockDownloadData.mockReset()
    mockDownloadData.mockImplementation((_bee: unknown, refHex: string) => {
      const index = parseInt(refHex.slice(0, 2), 16)
      return new TextEncoder().encode(JSON.stringify(makeDevice(index)))
    })
  })

  it("throws (not []) when index 0 is persistently inconclusive", async () => {
    // A 5xx on every read of index 0 can't be told apart from an outage — the
    // roster is unknown, not empty. Returning [] would let a caller conclude
    // "no devices" and clobber; instead the scan surfaces the ambiguity.
    const { bee } = fakeBeeWithSlow({
      present: new Set(),
      alwaysServerError: 0,
    })
    await expect(
      readRoster({ bee: bee as never, accountId: ACCOUNT_ID, owner: OWNER }),
    ).rejects.toBeInstanceOf(RosterScanInconclusiveError)
  })

  it("still returns [] for a genuinely empty roster (clean 404 at index 0)", async () => {
    const bee = fakeBee(new Set())
    await expect(
      readRoster({ bee: bee as never, accountId: ACCOUNT_ID, owner: OWNER }),
    ).resolves.toEqual([])
  })

  it("ensureInRoster skips the append when the roster read is inconclusive", async () => {
    // downloadChunk is the sequential finder's read inside appendToRoster. If
    // ensureInRoster wrongly treated the failed read as "device absent", it would
    // start the append and hit downloadChunk. Skipping means it never does.
    const downloadChunk = vi.fn(async () => {
      throw serverError500()
    })
    const bee = {
      makeSOCReader: () => ({
        download: async () => {
          throw serverError500()
        },
      }),
      downloadChunk,
    }
    await ensureInRoster({
      bee: bee as never,
      accountKey: new PrivateKey("11".repeat(32)),
      owner: OWNER,
      encryptionKey: "00".repeat(32),
      accountId: ACCOUNT_ID,
      device: makeDevice(0),
      target: { mode: "stamper" } as never,
    })
    expect(downloadChunk).not.toHaveBeenCalled()
  })
})

/**
 * #457 — on a small cluster, Bee's `/chunks` answers an ABSENT chunk with a
 * persistent 500 ("read chunk failed"), never 404, so the `/chunks`-based SOC
 * read alone can never confirm an empty slot. `readRosterEntry` must then ask
 * `GET /soc/{owner}/{id}` (raw fetch — bee-js has no GET wrapper), whose
 * authoritative JSON 404 confirms absence. Only that validated 404 may stop the
 * scan; a route-missing 404 (the public gateway's plain-text "Not Found"), any
 * other status, or a network failure stays inconclusive (#438 fencing).
 */
describe("readRoster — /soc absence probe on an inconclusive /chunks read (#457)", () => {
  const BEE_URL = "http://bee.test"

  // Factories (a Response body is single-use; the retry round re-fetches).
  type SocProbeResponse = () => Response | Error | "hang"

  /**
   * Small-cluster fake: `makeSOCReader` (the `/chunks` path) throws 500 for
   * every slot NOT in `chunksPresent`; the stubbed global fetch serves
   * `GET /soc/{owner}/{id}` from `socResponses` by roster index (defaulting to
   * bee's authoritative JSON 404). Returns the fetch spy for call assertions.
   */
  function fakeSmallClusterBee(opts: {
    chunksPresent?: Set<number>
    socResponses?: Map<number, SocProbeResponse>
  }) {
    const topic = rosterTopic(ACCOUNT_ID)
    const identToIndex = new Map<string, number>()
    for (let i = 0; i < 64; i++) {
      identToIndex.set(rosterIdentifier(topic, BigInt(i)).toHex(), i)
    }
    const fetchSpy = vi.fn(async (url: string | URL) => {
      const match = /\/soc\/[0-9a-f]+\/([0-9a-f]+)$/.exec(String(url))
      const index = match ? identToIndex.get(match[1]) : undefined
      if (index === undefined) throw new Error(`unexpected fetch: ${url}`)
      const response = (opts.socResponses?.get(index) ?? beeJson404)()
      if (response === "hang") return new Promise<Response>(() => {})
      if (response instanceof Error) throw response
      return response
    })
    vi.stubGlobal("fetch", fetchSpy)
    const bee = {
      url: BEE_URL,
      makeSOCReader: () => ({
        download: async (identifier: { toHex(): string }) => {
          const index = identToIndex.get(identifier.toHex())
          if (index === undefined || !opts.chunksPresent?.has(index)) {
            throw serverError500() // small cluster: absent chunk = 500, never 404
          }
          return { payload: { toUint8Array: () => refForIndex(index) } }
        },
      }),
      downloadChunk: vi.fn(async () => {
        throw serverError500()
      }),
    }
    return { bee, fetchSpy }
  }

  /** Bee's authoritative absent-slot answer on `GET /soc`. */
  function beeJson404(): Response {
    return new Response(
      JSON.stringify({
        code: 404,
        message: "requested chunk cannot be retrieved",
      }),
      {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    )
  }

  /** A router that doesn't know the /soc route (the public gateway). */
  function routeMiss404(): Response {
    return new Response("Not Found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  }

  function socPayload200(index: number): Response {
    return new Response(new Uint8Array(refForIndex(index)), { status: 200 })
  }

  beforeEach(() => {
    mockDownloadData.mockReset()
    mockDownloadData.mockImplementation((_bee: unknown, refHex: string) => {
      const index = parseInt(refHex.slice(0, 2), 16)
      return new TextEncoder().encode(JSON.stringify(makeDevice(index)))
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("confirms an empty roster via /soc 404s: returns [] instead of throwing", async () => {
    // The #457 deadlock: fresh account, every /chunks probe 500s. The /soc
    // probe's JSON 404 confirms every slot empty → [] (today: inconclusive →
    // RosterScanInconclusiveError → bootstrap never happens).
    const { bee } = fakeSmallClusterBee({})
    await expect(
      readRoster({ bee: bee as never, accountId: ACCOUNT_ID, owner: OWNER }),
    ).resolves.toEqual([])
  })

  it("lets ensureInRoster proceed to the bootstrap append on a confirmed-empty roster", async () => {
    // Mirror of the "skips the append" test: with /soc confirming empty, the
    // append must START (its sequential finder reads via downloadChunk).
    const { bee } = fakeSmallClusterBee({})
    await ensureInRoster({
      bee: bee as never,
      accountKey: new PrivateKey("11".repeat(32)),
      owner: OWNER,
      encryptionKey: "00".repeat(32),
      accountId: ACCOUNT_ID,
      device: makeDevice(0),
      target: { mode: "subsidised" } as never, // append stops before uploading
    })
    expect(bee.downloadChunk).toHaveBeenCalled()
  })

  it("folds a device the /chunks blip hid when /soc serves the slot (200)", async () => {
    // Slot 0 present but its /chunks read 500s; /soc returns the payload → the
    // device is recovered, and the clean /soc 404 on the next window ends the scan.
    const { bee } = fakeSmallClusterBee({
      socResponses: new Map([[0, () => socPayload200(0)]]),
    })
    const devices = await readRoster({
      bee: bee as never,
      accountId: ACCOUNT_ID,
      owner: OWNER,
    })
    expect(devices.map((d) => d.deviceId)).toEqual(["dev-0"])
  })

  it("treats a route-missing plain-text 404 as inconclusive, not absent", async () => {
    // A gateway that doesn't route GET /soc 404s EVERY probe. Trusting it would
    // read a mid-outage roster as empty (truncation → clobber); it must stay
    // inconclusive and surface as a scan failure when nothing folded.
    const { bee } = fakeSmallClusterBee({
      socResponses: new Map(
        Array.from({ length: 64 }, (_, i) => [i, routeMiss404] as const),
      ),
    })
    await expect(
      readRoster({ bee: bee as never, accountId: ACCOUNT_ID, owner: OWNER }),
    ).rejects.toBeInstanceOf(RosterScanInconclusiveError)
  })

  it("treats a /soc network error as inconclusive", async () => {
    const { bee } = fakeSmallClusterBee({
      socResponses: new Map(
        Array.from(
          { length: 64 },
          (_, i) => [i, () => new TypeError("fetch failed")] as const,
        ),
      ),
    })
    await expect(
      readRoster({ bee: bee as never, accountId: ACCOUNT_ID, owner: OWNER }),
    ).rejects.toBeInstanceOf(RosterScanInconclusiveError)
  })

  it("treats a hanging /soc probe as inconclusive (timeout)", async () => {
    vi.useFakeTimers()
    try {
      const { bee } = fakeSmallClusterBee({
        socResponses: new Map(
          Array.from(
            { length: 64 },
            (_, i) => [i, () => "hang" as const] as const,
          ),
        ),
      })
      const promise = readRoster({
        bee: bee as never,
        accountId: ACCOUNT_ID,
        owner: OWNER,
      })
      const assertion = expect(promise).rejects.toBeInstanceOf(
        RosterScanInconclusiveError,
      )
      // First round + the one retry, each bounded by the per-read timeout.
      await vi.advanceTimersByTimeAsync(ROSTER_READ_TIMEOUT_MS)
      await vi.advanceTimersByTimeAsync(ROSTER_READ_TIMEOUT_MS)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it("never touches /soc when /chunks answers (present slots and clean 404s)", async () => {
    // The production-gateway hot path: /chunks 200s for present slots and the
    // fakeBee helper's clean 404 ends the scan — the raw probe must not fire.
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const bee = fakeBee(new Set([0, 1]))
    const devices = await readRoster({
      bee: bee as never,
      accountId: ACCOUNT_ID,
      owner: OWNER,
    })
    expect(devices).toHaveLength(2)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("readRoster — known-length memo (#400)", () => {
  const scan = (present: Set<number>, probed?: number[]) =>
    readRoster({
      bee: fakeBee(present, probed) as never,
      accountId: ACCOUNT_ID,
      owner: OWNER,
    })

  beforeEach(() => {
    mockDownloadData.mockReset()
    mockDownloadData.mockImplementation((_bee: unknown, refHex: string) => {
      const index = parseInt(refHex.slice(0, 2), 16)
      return new TextEncoder().encode(JSON.stringify(makeDevice(index)))
    })
  })

  it("keeps the full stop window on a cold scan (no memo yet)", async () => {
    const probed: number[] = []
    await scan(new Set([0, 1]), probed)
    // Window [0..15] (2 present) + full empty stop window [16..31] — the
    // conservative cold-scan margin is unchanged.
    expect(probed).toHaveLength(32)
  })

  it("a warm rescan probes only the known range plus a short tail", async () => {
    await scan(new Set([0, 1])) // cold scan primes the memo (length 2)
    const probed: number[] = []
    const devices = await scan(new Set([0, 1]), probed)
    expect(devices.map((d) => d.deviceId).sort()).toEqual(["dev-0", "dev-1"])
    // Known range [0,1] + ROSTER_TAIL_PROBES (2) past it — not another 32 reads.
    expect(probed).toHaveLength(4)
    expect(Math.max(...probed)).toBe(3)
  })

  it("a warm rescan still discovers entries appended past the memo", async () => {
    await scan(new Set([0, 1])) // memo = 2
    const probed: number[] = []
    const devices = await scan(new Set([0, 1, 2]), probed) // peer appended at 2
    expect(devices).toHaveLength(3)
    expect(devices.some((d) => d.deviceId === "dev-2")).toBe(true)
    // Tail probe hits index 2 → the scan continues past it, still far under a
    // cold scan's 32 reads.
    expect(probed.length).toBeLessThanOrEqual(8)
  })

  it("never shrinks the memo on a stale read (holes inside the known range)", async () => {
    await scan(new Set([0, 1, 2])) // memo = 3
    // A stale endpoint cleanly-404s indices 1 and 2 — holes, folded around.
    const stale = await scan(new Set([0]))
    expect(stale.map((d) => d.deviceId)).toEqual(["dev-0"])
    // The memo must still cover index 2, so a later scan re-reads it directly.
    const probed: number[] = []
    const recovered = await scan(new Set([0, 1, 2]), probed)
    expect(recovered).toHaveLength(3)
    expect(probed).toHaveLength(5) // known range [0..2] + 2 tail probes
  })

  it("persists the length to localStorage and seeds a fresh session from it", async () => {
    const store = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    })
    try {
      await scan(new Set([0, 1])) // memo → localStorage
      resetRosterScanCache() // "page reload": in-memory memo gone
      const probed: number[] = []
      const devices = await scan(new Set([0, 1]), probed)
      expect(devices).toHaveLength(2)
      expect(probed).toHaveLength(4) // seeded from localStorage, warm scan
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
