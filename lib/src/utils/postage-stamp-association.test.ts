// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { BatchId } from "@ethersphere/bee-js"
import {
  resolveStampForApp,
  collectAccountStampBatchIds,
  stampsReachableByApp,
} from "./postage-stamp-association"
import {
  TEST_BATCH_ID_HEX,
  TEST_BATCH_ID_2_HEX,
  createPostageStamp,
  createConnectedApp,
} from "../test-fixtures"

const accountBatch = new BatchId(TEST_BATCH_ID_HEX)
const appBatch = new BatchId(TEST_BATCH_ID_2_HEX)
const accountStamp = createPostageStamp({ batchID: accountBatch })
const appStamp = createPostageStamp({ batchID: appBatch })

describe("resolveStampForApp", () => {
  it("prefers the app's own batch override", () => {
    const result = resolveStampForApp(
      { postageStampBatchID: appBatch },
      { defaultPostageStampBatchID: accountBatch },
      [accountStamp, appStamp],
    )
    expect(result?.batchID.toHex()).toBe(TEST_BATCH_ID_2_HEX)
  })

  it("falls through to the account default when the app override is stale", () => {
    const result = resolveStampForApp(
      { postageStampBatchID: appBatch },
      { defaultPostageStampBatchID: accountBatch },
      [accountStamp], // the app's override batch is missing
    )
    expect(result?.batchID.toHex()).toBe(TEST_BATCH_ID_HEX)
  })

  it("uses the account default when the app has no override", () => {
    const result = resolveStampForApp(
      { postageStampBatchID: undefined },
      { defaultPostageStampBatchID: accountBatch },
      [accountStamp],
    )
    expect(result?.batchID.toHex()).toBe(TEST_BATCH_ID_HEX)
  })

  it("returns undefined when every pointer is stale", () => {
    const result = resolveStampForApp(
      { postageStampBatchID: appBatch },
      { defaultPostageStampBatchID: accountBatch },
      [], // neither stamp exists
    )
    expect(result).toBeUndefined()
  })

  it("returns undefined when neither app nor account has a pointer", () => {
    const result = resolveStampForApp(
      { postageStampBatchID: undefined },
      { defaultPostageStampBatchID: undefined },
      [accountStamp, appStamp],
    )
    expect(result).toBeUndefined()
  })
})

describe("collectAccountStampBatchIds", () => {
  it("collects the default, owned stamps, and per-app overrides", () => {
    const result = collectAccountStampBatchIds({
      defaultPostageStampBatchID: accountBatch,
      postageStamps: [accountStamp, appStamp],
      connectedApps: [createConnectedApp({ postageStampBatchID: appBatch })],
    })
    expect(result.map((b) => b.toHex()).sort()).toEqual(
      [TEST_BATCH_ID_HEX, TEST_BATCH_ID_2_HEX].sort(),
    )
  })

  it("deduplicates a batch referenced multiple ways", () => {
    const result = collectAccountStampBatchIds({
      defaultPostageStampBatchID: accountBatch,
      postageStamps: [accountStamp],
      connectedApps: [
        createConnectedApp({
          postageStampBatchID: new BatchId(TEST_BATCH_ID_HEX),
        }),
      ],
    })
    expect(result.map((b) => b.toHex())).toEqual([TEST_BATCH_ID_HEX])
  })

  it("returns an empty array when nothing references a stamp", () => {
    const result = collectAccountStampBatchIds({
      defaultPostageStampBatchID: undefined,
      postageStamps: [],
      connectedApps: [],
    })
    expect(result).toEqual([])
  })
})

// A partitioned session is handed its account view by the connect popup, and
// before #578 that view carried EVERY stamp with its signer key — in a context
// embedded by an arbitrary dApp page. It can only ever spend the one resolved
// for it, so that is all it should hold (#578).
describe("stampsReachableByApp", () => {
  it("keeps only the app's override and the account default", () => {
    const otherStamp = createPostageStamp({
      batchID: new BatchId("dd".repeat(32)),
    })

    const result = stampsReachableByApp(
      { postageStampBatchID: appBatch },
      { defaultPostageStampBatchID: accountBatch },
      [accountStamp, appStamp, otherStamp],
    )

    expect(result.map((s) => s.batchID.toHex()).sort()).toEqual(
      [TEST_BATCH_ID_HEX, TEST_BATCH_ID_2_HEX].sort(),
    )
  })

  // The default is the fallthrough `resolveStampForApp` takes when the
  // override's stamp is gone, so shipping only the override would turn a
  // recoverable stale pointer into an unusable session.
  it("keeps the default even when the app has a live override", () => {
    const result = stampsReachableByApp(
      { postageStampBatchID: appBatch },
      { defaultPostageStampBatchID: accountBatch },
      [accountStamp, appStamp],
    )
    expect(result).toHaveLength(2)
  })

  it("keeps nothing when neither pointer resolves", () => {
    const result = stampsReachableByApp(
      { postageStampBatchID: undefined },
      { defaultPostageStampBatchID: undefined },
      [accountStamp, appStamp],
    )
    expect(result).toEqual([])
  })

  // A tombstone for our own stamp is news: it is how the session learns the
  // stamp it was spending is gone.
  it("keeps a tombstoned stamp its pointers still name", () => {
    const deleted = createPostageStamp({
      batchID: accountBatch,
      deletedAt: 2_000_000,
    })
    const result = stampsReachableByApp(
      { postageStampBatchID: undefined },
      { defaultPostageStampBatchID: accountBatch },
      [deleted],
    )
    expect(result).toHaveLength(1)
    expect(result[0].deletedAt).toBe(2_000_000)
  })
})
