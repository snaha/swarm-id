// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The lock SOC's address derivation. What it must encode is the scope of the
 * thing it locks: one partition of ONE postage batch (#589).
 */

import { describe, expect, it } from "vitest"
import { BatchId } from "@ethersphere/bee-js"

import {
  lockSocAddress,
  lockSocBucket,
  makePartitionLockIdentifier,
} from "./lock-soc"
import { createTestSigner } from "../proxy/feeds/epochs/test-utils"

const BATCH_X = new BatchId("aa".repeat(32))
const BATCH_Y = new BatchId("bb".repeat(32))
const OWNER = createTestSigner().publicKey().address()

const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")

describe("partition lock identity", () => {
  // The state a lock protects is per (batch, partition) — that is what
  // `makePartitionStateTopic` hashes, and the slot space `dataSlot` computes
  // within. The lock was per (partition) alone, so lane p of batch X and lane p
  // of batch Y resolved to ONE chunk address: two writers that share no slot
  // took turns anyway, and with per-app stamp overrides an account has two live
  // coordinators on two batches today (#589).
  it("gives one partition of two batches two different locks", () => {
    expect(makePartitionLockIdentifier(BATCH_X, 0).toHex()).not.toBe(
      makePartitionLockIdentifier(BATCH_Y, 0).toHex(),
    )
    expect(hex(lockSocAddress(BATCH_X, 0, OWNER))).not.toBe(
      hex(lockSocAddress(BATCH_Y, 0, OWNER)),
    )
  })

  it("still separates partitions within one batch", () => {
    expect(makePartitionLockIdentifier(BATCH_X, 0).toHex()).not.toBe(
      makePartitionLockIdentifier(BATCH_X, 1).toHex(),
    )
  })

  it("is stable for the same (batch, partition, owner)", () => {
    expect(hex(lockSocAddress(BATCH_X, 2, OWNER))).toBe(
      hex(lockSocAddress(BATCH_X, 2, OWNER)),
    )
    expect(lockSocBucket(BATCH_X, 2, OWNER)).toBe(
      lockSocBucket(BATCH_X, 2, OWNER),
    )
  })

  // The bucket is what the stamper reserves from data uploads. Two batches
  // reserving the same bucket is harmless; a batch reserving a bucket its own
  // lock does not land in is not, so this rides the same derivation.
  it("reserves the bucket its own lock address lands in", () => {
    const address = lockSocAddress(BATCH_Y, 1, OWNER)
    expect(lockSocBucket(BATCH_Y, 1, OWNER)).toBe(
      (address[0] << 8) | address[1],
    )
  })
})
