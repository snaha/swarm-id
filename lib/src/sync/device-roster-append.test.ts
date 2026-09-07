// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The roster's one accepted loss (see `device-roster.ts`): two devices that
 * pick the same fresh index race, and the later SOC write wins the slot. The
 * design's answer is that the loser "is re-added on its next sync" — never a
 * peer's entry, only its own append. That recovery is the invariant here.
 *
 * Kept out of `device-roster.test.ts` because it fakes the write path
 * (`uploadData`/`uploadSOC`) to give the two appends one shared feed, and those
 * tests assert on the real one.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { EthAddress, PrivateKey, Reference } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import type { Device } from "../schemas"

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
    downloadChunk: vi.fn(async (addressHex: string) => {
      const index = addressToIndex.get(addressHex)
      if (index === undefined || !slots.has(index)) throw notFound404()
      return {}
    }),
    // readRoster's slot read.
    makeSOCReader: () => ({
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
  }
}

function makeDevice(id: string): Device {
  return { deviceId: id, name: id, createdAt: 1000, lastSignedInAt: 1000 }
}

/**
 * Releases SOC writes only once `count` of them are queued, so every racing
 * append has already chosen its index before any of them lands.
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
    await open
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

  it("loses one append to the slot, and re-adds it on the next announce", async () => {
    socWriteGate = barrierFor(2)

    await Promise.all([
      announce(makeDevice("dev-a")),
      announce(makeDevice("dev-b")),
    ])

    // Both wrote index 0; the later write took it. One device is missing —
    // this is the documented loss, not a corrupted roster.
    const afterRace = await rosterIds()
    expect(afterRace).toHaveLength(1)

    // The loser's next sync finds itself absent and appends again.
    socWriteGate = async () => {}
    const loser = afterRace[0] === "dev-a" ? "dev-b" : "dev-a"
    await announce(makeDevice(loser))

    expect(await rosterIds()).toEqual(["dev-a", "dev-b"])
  })

  it("never overwrites the winner's slot on the retry", async () => {
    socWriteGate = barrierFor(2)
    await Promise.all([
      announce(makeDevice("dev-a")),
      announce(makeDevice("dev-b")),
    ])
    const winner = (await rosterIds())[0]
    const winningSlot = slots.get(0)

    socWriteGate = async () => {}
    await announce(makeDevice(winner === "dev-a" ? "dev-b" : "dev-a"))

    expect(slots.get(0)).toBe(winningSlot)
    expect(slots.size).toBe(2)
  })

  // The memo widens to the length the WINNER's write made real, so the loser's
  // rescan still probes past it and finds the free slot it needs.
  it("leaves a memo the loser's rescan can still append past", async () => {
    socWriteGate = barrierFor(2)
    await Promise.all([
      announce(makeDevice("dev-a")),
      announce(makeDevice("dev-b")),
    ])

    socWriteGate = async () => {}
    const present = await rosterIds()
    await announce(makeDevice(present[0] === "dev-a" ? "dev-b" : "dev-a"))

    expect(slots.has(1)).toBe(true)
    expect(await rosterIds()).toEqual(["dev-a", "dev-b"])
  })

  it("appends nothing when the device is already in the roster", async () => {
    await announce(makeDevice("dev-a"))
    expect(slots.size).toBe(1)

    await announce(makeDevice("dev-a"))

    expect(slots.size).toBe(1)
  })
})
