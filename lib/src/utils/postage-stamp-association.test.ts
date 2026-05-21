// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { BatchId } from "@ethersphere/bee-js"
import {
  resolveStampForIdentity,
  collectAccountStampBatchIds,
} from "./postage-stamp-association"
import {
  TEST_BATCH_ID_HEX,
  TEST_BATCH_ID_2_HEX,
  createPostageStamp,
} from "../test-fixtures"

const accountBatch = new BatchId(TEST_BATCH_ID_HEX)
const identityBatch = new BatchId(TEST_BATCH_ID_2_HEX)
const accountStamp = createPostageStamp({ batchID: accountBatch })
const identityStamp = createPostageStamp({ batchID: identityBatch })

describe("resolveStampForIdentity", () => {
  it("prefers the identity's own stamp", () => {
    const result = resolveStampForIdentity(
      { defaultPostageStampBatchID: identityBatch },
      { defaultPostageStampBatchID: accountBatch },
      [accountStamp, identityStamp],
    )
    expect(result?.batchID.toHex()).toBe(TEST_BATCH_ID_2_HEX)
  })

  it("falls through to the account stamp when the identity pointer is stale", () => {
    const result = resolveStampForIdentity(
      { defaultPostageStampBatchID: identityBatch },
      { defaultPostageStampBatchID: accountBatch },
      [accountStamp], // identity's stamp is missing
    )
    expect(result?.batchID.toHex()).toBe(TEST_BATCH_ID_HEX)
  })

  it("uses the account stamp when the identity has no pointer", () => {
    const result = resolveStampForIdentity(
      { defaultPostageStampBatchID: undefined },
      { defaultPostageStampBatchID: accountBatch },
      [accountStamp],
    )
    expect(result?.batchID.toHex()).toBe(TEST_BATCH_ID_HEX)
  })

  it("returns undefined when every pointer is stale", () => {
    const result = resolveStampForIdentity(
      { defaultPostageStampBatchID: identityBatch },
      { defaultPostageStampBatchID: accountBatch },
      [], // neither stamp exists
    )
    expect(result).toBeUndefined()
  })

  it("returns undefined when neither identity nor account has a pointer", () => {
    const result = resolveStampForIdentity(
      { defaultPostageStampBatchID: undefined },
      { defaultPostageStampBatchID: undefined },
      [accountStamp, identityStamp],
    )
    expect(result).toBeUndefined()
  })
})

describe("collectAccountStampBatchIds", () => {
  it("collects the account stamp and each identity stamp", () => {
    const result = collectAccountStampBatchIds(
      { defaultPostageStampBatchID: accountBatch },
      [
        { defaultPostageStampBatchID: identityBatch },
        { defaultPostageStampBatchID: undefined },
      ],
    )
    expect(result.map((b) => b.toHex())).toEqual([
      TEST_BATCH_ID_HEX,
      TEST_BATCH_ID_2_HEX,
    ])
  })

  it("deduplicates a stamp shared by the account and an identity", () => {
    const result = collectAccountStampBatchIds(
      { defaultPostageStampBatchID: accountBatch },
      [{ defaultPostageStampBatchID: new BatchId(TEST_BATCH_ID_HEX) }],
    )
    expect(result.map((b) => b.toHex())).toEqual([TEST_BATCH_ID_HEX])
  })

  it("returns an empty array when nothing references a stamp", () => {
    const result = collectAccountStampBatchIds(
      { defaultPostageStampBatchID: undefined },
      [{ defaultPostageStampBatchID: undefined }],
    )
    expect(result).toEqual([])
  })
})
