// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { BatchId } from "@ethersphere/bee-js"
import {
  resolveStampForApp,
  stampsReachableByApp,
} from "./postage-stamp-association"
import {
  TEST_BATCH_ID_HEX,
  TEST_BATCH_ID_2_HEX,
  createPostageStamp,
} from "../test-fixtures"

const accountBatch = new BatchId(TEST_BATCH_ID_HEX)
const appBatch = new BatchId(TEST_BATCH_ID_2_HEX)
const scratchBatch = new BatchId("ab".repeat(32))
const otherBatch = new BatchId("dd".repeat(32))
const accountStamp = createPostageStamp({ batchID: accountBatch })
const appStamp = createPostageStamp({ batchID: appBatch })
const scratchStamp = createPostageStamp({
  batchID: scratchBatch,
  kind: "scratch",
})
const otherStamp = createPostageStamp({ batchID: otherBatch })
const ALL_STAMPS = [accountStamp, appStamp, scratchStamp, otherStamp]
const withDefault = { defaultPostageStampBatchID: accountBatch }

const hexes = (stamps: { batchID: BatchId }[]): string[] =>
  stamps.map((s) => s.batchID.toHex())

describe("resolveStampForApp", () => {
  it("uses the account default for an app with no grant", () => {
    const result = resolveStampForApp({}, withDefault, ALL_STAMPS)
    expect(result?.batchID.toHex()).toBe(TEST_BATCH_ID_HEX)
  })

  it("uses the account default for an app granted all drives", () => {
    const result = resolveStampForApp({ drives: "all" }, withDefault, [
      appStamp,
      accountStamp,
    ])
    expect(result?.batchID.toHex()).toBe(TEST_BATCH_ID_HEX)
  })

  it("uses the first granted regular drive of a list", () => {
    const result = resolveStampForApp(
      { drives: [scratchBatch, appBatch, otherBatch] },
      withDefault,
      ALL_STAMPS,
    )
    expect(result?.batchID.toHex()).toBe(TEST_BATCH_ID_2_HEX)
  })

  // A list names exactly what the app may spend: a gone drive hands over to
  // the next GRANTED one, never to the account default the app was not given.
  it("moves to the next granted regular drive when the first is deleted", () => {
    const deleted = createPostageStamp({ batchID: appBatch, deletedAt: 1 })
    const result = resolveStampForApp(
      { drives: [appBatch, otherBatch] },
      withDefault,
      [accountStamp, deleted, otherStamp],
    )
    expect(result?.batchID.toHex()).toBe(otherBatch.toHex())
  })

  it("does not fall back to the account default outside the grant", () => {
    const result = resolveStampForApp({ drives: [appBatch] }, withDefault, [
      accountStamp,
    ])
    expect(result).toBeUndefined()
  })

  // Deliberate: expiry does not repoint spending. A tombstone is gone for
  // good, so it is skipped; an expired drive can be renewed, and silently
  // charging another drive is not what the user chose for this app (#745).
  it("does not move past an expired drive", () => {
    const expired = createPostageStamp({
      batchID: appBatch,
      batchTTL: 60,
      updatedAt: Date.now() - 120_000,
    })
    const result = resolveStampForApp(
      { drives: [appBatch, otherBatch] },
      withDefault,
      [expired, otherStamp],
    )
    expect(result?.batchID.toHex()).toBe(TEST_BATCH_ID_2_HEX)
  })

  // Every write to a scratch drive names it, so it never takes an untargeted
  // one (#862).
  it("never resolves a scratch drive", () => {
    const result = resolveStampForApp(
      { drives: [scratchBatch] },
      withDefault,
      ALL_STAMPS,
    )
    expect(result).toBeUndefined()
  })

  it("resolves nothing for an app granted no drives", () => {
    const result = resolveStampForApp({ drives: [] }, withDefault, ALL_STAMPS)
    expect(result).toBeUndefined()
  })

  it("resolves nothing when the account has no default", () => {
    const result = resolveStampForApp(
      {},
      { defaultPostageStampBatchID: undefined },
      ALL_STAMPS,
    )
    expect(result).toBeUndefined()
  })
})

// A partitioned session is handed its account view by the connect popup, and
// before #578 that view carried EVERY stamp with its signer key — in a context
// embedded by an arbitrary dApp page. It holds what its grant names (#578).
describe("stampsReachableByApp", () => {
  it("keeps only the drives a list names", () => {
    const result = stampsReachableByApp(
      { drives: [appBatch, scratchBatch] },
      withDefault,
      ALL_STAMPS,
    )
    expect(hexes(result).sort()).toEqual(
      [TEST_BATCH_ID_2_HEX, scratchBatch.toHex()].sort(),
    )
  })

  it("keeps only the account default for an app with no grant", () => {
    const result = stampsReachableByApp({}, withDefault, ALL_STAMPS)
    expect(hexes(result)).toEqual([TEST_BATCH_ID_HEX])
  })

  it("keeps every stamp for all drives", () => {
    const result = stampsReachableByApp(
      { drives: "all" },
      withDefault,
      ALL_STAMPS,
    )
    expect(result).toHaveLength(ALL_STAMPS.length)
  })

  it("keeps nothing for an app granted no drives", () => {
    const result = stampsReachableByApp({ drives: [] }, withDefault, ALL_STAMPS)
    expect(result).toEqual([])
  })

  // A tombstone for our own stamp is news: it is how the session learns the
  // stamp it was spending is gone.
  it("keeps a tombstoned stamp its grant still names", () => {
    const deleted = createPostageStamp({
      batchID: accountBatch,
      deletedAt: 2_000_000,
    })
    const result = stampsReachableByApp({}, withDefault, [deleted])
    expect(result).toHaveLength(1)
    expect(result[0].deletedAt).toBe(2_000_000)
  })
})
