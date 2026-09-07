// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The roster's one accepted loss (see `device-roster.ts`): two devices that
 * pick the same fresh index race, and the later SOC write wins the slot. The
 * design's answer is that the loser "is re-added on its next sync" — never a
 * peer's entry, only its own append. That recovery is the invariant here.
 *
 * One interleaving is provoked: both appends choose their index before either
 * writes. A stale read after one write has already landed is the same loss by
 * another route, and is not modelled here.
 *
 * Kept out of `device-roster.test.ts` because it fakes the write path
 * (`uploadData`/`uploadSOC`) to give the two appends one shared feed, and those
 * tests assert on the real one. The cost of that fake: it answers the finder's
 * probe and the scan's read the way bee-js does today (`chunk.download` at
 * keccak(identifier ‖ owner), `soc.makeReader`), so a change to how either
 * probes fails here for reasons that have nothing to do with the race.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { EthAddress, PrivateKey, Reference } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import type { Device } from "../schemas"
import { withTimeout } from "../utils/promise"

/** Roster slot index → the reference its SOC carries. Later writes clobber. */
const slots = new Map<number, string>()
/** Reference hex → the encrypted device blob it addresses. */
const blobs = new Map<string, Uint8Array>()
/** Held in front of every SOC write, so a test can interleave two appends. */
let socWriteGate: () => Promise<void>

vi.mock("../proxy/download-data", () => ({
  downloadDataWithChunkAPI: async (_bee: unknown, refHex: string) => {
    const blob = blobs.get(refHex)
    if (!blob) throw Object.assign(new Error("not found"), { status: 404 })
    return blob
  },
}))

vi.mock("../proxy/upload", async (importActual) => {
  const actual = await importActual<typeof import("../proxy/upload")>()
  return {
    ...actual,
    uploadData: vi.fn(async (_target: unknown, blob: Uint8Array) => {
      const reference = Binary.uint8ArrayToHex(Binary.keccak256(blob)) as string
      blobs.set(reference, blob)
      return { reference }
    }),
    uploadSOC: vi.fn(
      async (
        _target: unknown,
        _signer: unknown,
        identifier: { toHex(): string },
        payload: Uint8Array,
      ) => {
        await socWriteGate()
        const index = indexOfIdentifier(identifier.toHex())
        slots.set(index, new Reference(payload).toHex())
        return { socAddress: new Uint8Array(32) }
      },
    ),
  }
})

import {
  readRoster,
  ensureInRoster,
  resetRosterScanCache,
  rosterTopic,
  rosterIdentifier,
} from "./device-roster"

const OWNER = new EthAddress("a".repeat(40))
const ACCOUNT_ID = "b".repeat(40)
const ACCOUNT_KEY = new PrivateKey("11".repeat(32))
const STAMPER_TARGET = { mode: "stamper" } as never

/** Enough slots to cover a scan window past the ones these tests write. */
const MAPPED_SLOTS = 32

const topic = rosterTopic(ACCOUNT_ID)
const identifierToIndex = new Map<string, number>()
const addressToIndex = new Map<string, number>()
for (let index = 0; index < MAPPED_SLOTS; index++) {
  const identifier = rosterIdentifier(topic, BigInt(index))
  identifierToIndex.set(identifier.toHex(), index)
  // The address the sequential finder reads: keccak256(identifier ‖ owner).
  addressToIndex.set(
    Binary.uint8ArrayToHex(
      Binary.keccak256(
        Binary.concatBytes(identifier.toUint8Array(), OWNER.toUint8Array()),
      ),
    ),
    index,
  )
}

function indexOfIdentifier(hex: string): number {
  const index = identifierToIndex.get(hex)
  if (index === undefined) throw new Error(`unmapped roster identifier ${hex}`)
  return index
}

function notFound404(): Error {
  return Object.assign(new Error("requested chunk cannot be retrieved"), {
    status: 404,
  })
}

/** Serves both reads a roster append makes: the finder's and the scan's. */
function fakeBee() {
  return {
    // The sequential finder's free-slot probe.
    chunk: {
      download: vi.fn(async (addressHex: string) => {
        const index = addressToIndex.get(addressHex)
        if (index === undefined || !slots.has(index)) throw notFound404()
        return {}
      }),
    },
    // readRoster's slot read.
    soc: {
      makeReader: () => ({
        download: async (identifier: { toHex(): string }) => {
          const index = identifierToIndex.get(identifier.toHex())
          const reference = index === undefined ? undefined : slots.get(index)
          if (!reference) throw notFound404()
          return {
            payload: {
              toUint8Array: () => new Reference(reference).toUint8Array(),
            },
          }
        },
      }),
    },
  }
}

function makeDevice(id: string): Device {
  return { deviceId: id, name: id, createdAt: 1000, lastSignedInAt: 1000 }
}

/** Long enough for any append to reach its write; short of the test timeout. */
const BARRIER_DEADLINE_MS = 2_000

/**
 * Releases SOC writes only once `count` of them are queued, so every racing
 * append has already chosen its index before any of them lands. An append that
 * returns without writing would leave the rest waiting forever, so the wait has
 * a deadline that fails the write — and so the test — with a reason.
 */
function barrierFor(count: number): () => Promise<void> {
  let arrived = 0
  let release = () => {}
  const open = new Promise<void>((resolve) => {
    release = resolve
  })
  return async () => {
    arrived += 1
    if (arrived >= count) release()
    await withTimeout(
      open,
      BARRIER_DEADLINE_MS,
      `only ${arrived} of ${count} racing appends reached the SOC write`,
    )
  }
}

describe("ensureInRoster — two devices racing one fresh index", () => {
  let bee: ReturnType<typeof fakeBee>

  const announce = (device: Device) =>
    ensureInRoster({
      bee: bee as never,
      accountKey: ACCOUNT_KEY,
      owner: OWNER,
      encryptionKey: "00".repeat(32),
      accountId: ACCOUNT_ID,
      device,
      target: STAMPER_TARGET,
    })

  const rosterIds = async () =>
    (
      await readRoster({
        bee: bee as never,
        accountId: ACCOUNT_ID,
        owner: OWNER,
      })
    )
      .map((device) => device.deviceId)
      .sort()

  beforeEach(() => {
    slots.clear()
    blobs.clear()
    socWriteGate = async () => {}
    resetRosterScanCache()
    bee = fakeBee()
  })

  it("loses one append to the slot, and re-adds it past the winner on the next announce", async () => {
    socWriteGate = barrierFor(2)

    await Promise.all([
      announce(makeDevice("dev-a")),
      announce(makeDevice("dev-b")),
    ])

    // Both wrote index 0; the later write took it. One device is missing —
    // this is the documented loss, not a corrupted roster.
    const afterRace = await rosterIds()
    expect(afterRace).toHaveLength(1)
    const winningSlot = slots.get(0)

    // The loser's next sync finds itself absent and appends again. The memo
    // widened to the length the winner's write made real, so the rescan probes
    // past slot 0 rather than clobbering it.
    socWriteGate = async () => {}
    const loser = afterRace[0] === "dev-a" ? "dev-b" : "dev-a"
    await announce(makeDevice(loser))

    expect(slots.get(0)).toBe(winningSlot)
    expect([...slots.keys()].sort()).toEqual([0, 1])
    expect(await rosterIds()).toEqual(["dev-a", "dev-b"])
  })

  it("appends nothing when the device is already in the roster", async () => {
    await announce(makeDevice("dev-a"))
    expect(slots.size).toBe(1)

    await announce(makeDevice("dev-a"))

    expect(slots.size).toBe(1)
  })
})
