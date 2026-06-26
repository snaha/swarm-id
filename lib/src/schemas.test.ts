// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { BatchId, PrivateKey } from "@ethersphere/bee-js"
import { isLocalAccount } from "./schemas"
import {
  TEST_BATCH_ID_HEX,
  TEST_PRIVATE_KEY_HEX,
  createAccount,
  createPostageStamp,
} from "./test-fixtures"

function drive(overrides?: Parameters<typeof createPostageStamp>[0]) {
  return createPostageStamp({
    batchID: new BatchId(TEST_BATCH_ID_HEX),
    signerKey: new PrivateKey(TEST_PRIVATE_KEY_HEX),
    exists: true,
    usable: true,
    ...overrides,
  })
}

describe("isLocalAccount", () => {
  it("is local when it owns no postage stamps", () => {
    expect(isLocalAccount(createAccount({ postageStamps: [] }))).toBe(true)
  })

  it("is not local once it owns a usable, on-chain stamp", () => {
    const account = createAccount({ postageStamps: [drive()] })
    expect(isLocalAccount(account)).toBe(false)
  })

  it("stays local while its only stamp is not yet usable", () => {
    const account = createAccount({
      postageStamps: [drive({ usable: false })],
    })
    expect(isLocalAccount(account)).toBe(true)
  })

  it("stays local while its only stamp does not yet exist on-chain", () => {
    const account = createAccount({
      postageStamps: [drive({ exists: false })],
    })
    expect(isLocalAccount(account)).toBe(true)
  })

  it("treats a tombstoned (deleted) stamp as no drive", () => {
    const account = createAccount({
      postageStamps: [drive({ deletedAt: 1700000000001 })],
    })
    expect(isLocalAccount(account)).toBe(true)
  })
})
