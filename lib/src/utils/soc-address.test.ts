// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Characterization of every SOC chunk address the library derives.
 *
 * A SOC address is `keccak256(identifier ‖ owner)`, and each call site below
 * feeds it a differently-derived identifier. The expected hex is hardcoded and
 * was produced with an independent keccak256 (ethers), so a site that silently
 * changes its derivation — or its owner/identifier byte order — fails here
 * instead of only failing against a live Bee.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import {
  BatchId,
  EthAddress,
  Identifier,
  PrivateKey,
  Topic,
} from "@ethersphere/bee-js"
import { epochSocAddress } from "../proxy/feeds/epochs/updater"
import { EpochIndex } from "../proxy/feeds/epochs/epoch"
import { SyncEpochFinder } from "../proxy/feeds/epochs/finder"
import { AsyncEpochFinder } from "../proxy/feeds/epochs/async-finder"
import { SyncSequentialFinder } from "../proxy/feeds/sequence/finder"
import { downloadSOC } from "../proxy/download-data"
import { uploadSOC, type UploadTarget } from "../proxy/upload"
import {
  intentSocAddress,
  partitionOccupancyAddress,
} from "../sync/partition-intent"
import { statePointerAddress } from "../sync/partition-state"
import { lockSocAddress, lockSocBucket } from "./lock-soc"
import { uint8ArrayToHex } from "./hex"

const OWNER_HEX = "1234567890abcdef1234567890abcdef12345678"
const TOPIC_HEX =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
const IDENTIFIER_HEX =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
const BATCH_ID_HEX =
  "1111111111111111222222222222222233333333333333334444444444444444"
const SIGNER_HEX =
  "634fb5a872396d9693e5c9f9d7233cfa93f395c093371017ff44aa9ae6564cdd"
const SIGNER_ADDRESS_HEX = "8d3766440f0d7b949a5e32995d09619a7f86e632"

const AT = 1700000000n
const PARTITION = 5
const DEVICE_ID = "device-a"
const EPOCH_BUCKET = 42
const EPOCH_LEVEL = 7

const EXPECTED = {
  epochLevel7:
    "344d56e9d4c6793170227ad9db591c0ce26484cc0a1c4c79e90072004954f5d0",
  epochLevel0AtAt:
    "1d27f51ac36ffdfa75acedd6a8d1c26fee5e0cf453133dab409ad4bd7f104888",
  epochRoot: "89b5d0e5747188535a93b10250aab08f1679f9167819d1906a399bc2f2e18bb7",
  sequentialIndex0:
    "6948d229eeb6d868135300aad6e5ea01c4d30bc87d616f27b909d9926739c0e0",
  sequentialIndex1:
    "22c7a14c30b160608acf3dd8dcd359846a2567b9f469ffb11838144b3d12642f",
  lockSoc: "2727899e2cee4b2c96a57c3eb0f92abb29c07af5161caacce024cccec6ce1fed",
  downloadSoc:
    "4f5511b1384f206432b6bb4af39b2e3b95c58ca6528da5a9b978963caa3073ac",
  uploadSoc: "19e92989b9b34ba220aca27c7a36b4f33afe98f060563177795a26fe68bf3a87",
  intentSoc: "a1b608eb2c0d884676829a108dd03a6e5cf32fa8cf144e010811a6a12898336c",
  occupancySoc:
    "75dbe9bfd099c6c40e7fae5c5a0f6ed45a708dae9b470e2e4603cbc4b085ed92",
  statePointer:
    "f2d148c521d48f33412243bb99f50fae44b832343b8d5007f808252d5b2ef20c",
}

const owner = new EthAddress(OWNER_HEX)
const topic = new Topic(TOPIC_HEX)

/** Bee stub that records every requested chunk address and serves none. */
function recordingBee(): { addresses: string[]; bee: unknown } {
  const addresses: string[] = []
  return {
    addresses,
    bee: {
      url: "http://localhost:1633",
      downloadChunk: async (reference: string) => {
        addresses.push(reference.toLowerCase())
        throw new Error("chunk not found")
      },
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("SOC address derivation", () => {
  it("epochSocAddress derives the epoch-feed entry address", async () => {
    const address = await epochSocAddress(
      topic,
      new EpochIndex(AT, EPOCH_LEVEL),
      owner,
    )

    expect(uint8ArrayToHex(address)).toBe(EXPECTED.epochLevel7)
  })

  it("SyncEpochFinder probes the level-0 epoch address first", async () => {
    const { addresses, bee } = recordingBee()
    const finder = new SyncEpochFinder(bee as never, topic, owner)

    await finder.findAt(AT)

    expect(addresses[0]).toBe(EXPECTED.epochLevel0AtAt)
  })

  it("AsyncEpochFinder probes the level-0 and root epoch addresses", async () => {
    const { addresses, bee } = recordingBee()
    const finder = new AsyncEpochFinder(bee as never, topic, owner)

    await finder.findAt(AT)

    expect(addresses).toContain(EXPECTED.epochLevel0AtAt)
    expect(addresses).toContain(EXPECTED.epochRoot)
  })

  it("SyncSequentialFinder walks the per-index addresses in order", async () => {
    const { addresses, bee } = recordingBee()
    const finder = new SyncSequentialFinder(bee as never, topic, owner)

    await finder.findAt(0n)

    expect(addresses[0]).toBe(EXPECTED.sequentialIndex0)
    // Index 0 is read twice (initial + retry) before being called free.
    expect(addresses[1]).toBe(EXPECTED.sequentialIndex0)
    expect(addresses).not.toContain(EXPECTED.sequentialIndex1)
  })

  it("lockSocAddress derives the partition lock SOC address", () => {
    const address = lockSocAddress(PARTITION, owner)

    expect(uint8ArrayToHex(address)).toBe(EXPECTED.lockSoc)
  })

  it("lockSocBucket is the first two bytes of the lock SOC address", () => {
    const FIRST_BYTE_SHIFT = 8

    expect(lockSocBucket(PARTITION, owner)).toBe(
      (parseInt(EXPECTED.lockSoc.slice(0, 2), 16) << FIRST_BYTE_SHIFT) |
        parseInt(EXPECTED.lockSoc.slice(2, 4), 16),
    )
  })

  it("downloadSOC requests the identifier's SOC address", async () => {
    const { addresses, bee } = recordingBee()

    await expect(
      downloadSOC(bee as never, owner, new Identifier(IDENTIFIER_HEX)),
    ).rejects.toThrow()

    expect(addresses[0]).toBe(EXPECTED.downloadSoc)
  })

  it("uploadSOC returns the signer-owned SOC address", async () => {
    const signer = new PrivateKey(SIGNER_HEX)
    expect(signer.publicKey().address().toHex()).toBe(SIGNER_ADDRESS_HEX)

    const requestedUrls: string[] = []
    vi.stubGlobal("fetch", async (url: string) => {
      requestedUrls.push(url)
      return new Response(JSON.stringify({ reference: "" }), { status: 200 })
    })

    const target: UploadTarget = {
      mode: "subsidised",
      gatewayUrl: "https://gateway.example",
    }
    const result = await uploadSOC(
      target,
      signer,
      new Identifier(IDENTIFIER_HEX),
      new Uint8Array([1, 2, 3]),
    )

    expect(uint8ArrayToHex(result.socAddress)).toBe(EXPECTED.uploadSoc)
    expect(requestedUrls[0]).toContain(
      `/soc/${SIGNER_ADDRESS_HEX}/${IDENTIFIER_HEX}`,
    )
  })

  it("intentSocAddress derives the partition intent SOC address", () => {
    const address = intentSocAddress(PARTITION, DEVICE_ID, EPOCH_BUCKET, owner)

    expect(uint8ArrayToHex(address)).toBe(EXPECTED.intentSoc)
  })

  it("partitionOccupancyAddress derives the occupancy beacon address", () => {
    const address = partitionOccupancyAddress(PARTITION, EPOCH_BUCKET, owner)

    expect(uint8ArrayToHex(address)).toBe(EXPECTED.occupancySoc)
  })

  it("statePointerAddress derives the state-pointer SOC address", () => {
    const address = statePointerAddress(
      new BatchId(BATCH_ID_HEX),
      PARTITION,
      owner,
      0,
    )

    expect(uint8ArrayToHex(address)).toBe(EXPECTED.statePointer)
  })
})
