// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { BatchId, PrivateKey } from "@ethersphere/bee-js"
import { AccountSchemaV1, isLocalAccount } from "./schemas"
import {
  TEST_BATCH_ID_HEX,
  TEST_BATCH_ID_2_HEX,
  TEST_PRIVATE_KEY_HEX,
  TEST_PUBLIC_KEY_HEX,
  createAccount,
  createPostageStamp,
} from "./test-fixtures"

const DEFAULT_BATCH = new BatchId(TEST_BATCH_ID_HEX)

function drive(overrides?: Parameters<typeof createPostageStamp>[0]) {
  return createPostageStamp({
    batchID: DEFAULT_BATCH,
    signerKey: new PrivateKey(TEST_PRIVATE_KEY_HEX),
    exists: true,
    usable: true,
    ...overrides,
  })
}

/** Account whose default drive is the given stamp. */
function withDefaultDrive(stamp: ReturnType<typeof drive>) {
  return createAccount({
    defaultPostageStampBatchID: DEFAULT_BATCH,
    postageStamps: [stamp],
  })
}

describe("isLocalAccount", () => {
  it("is local when it has no default drive", () => {
    expect(
      isLocalAccount(
        createAccount({
          defaultPostageStampBatchID: undefined,
          postageStamps: [],
        }),
      ),
    ).toBe(true)
  })

  it("is local when the default points at a batch it does not own", () => {
    const account = createAccount({
      defaultPostageStampBatchID: new BatchId(TEST_BATCH_ID_2_HEX),
      postageStamps: [drive()],
    })
    expect(isLocalAccount(account)).toBe(true)
  })

  it("is not local once its default drive is a usable, on-chain stamp", () => {
    expect(isLocalAccount(withDefaultDrive(drive()))).toBe(false)
  })

  it("stays local while the default drive is not yet usable", () => {
    expect(isLocalAccount(withDefaultDrive(drive({ usable: false })))).toBe(
      true,
    )
  })

  it("stays local while the default drive does not yet exist on-chain", () => {
    expect(isLocalAccount(withDefaultDrive(drive({ exists: false })))).toBe(
      true,
    )
  })

  it("treats a tombstoned (deleted) default drive as no drive", () => {
    expect(
      isLocalAccount(withDefaultDrive(drive({ deletedAt: 1700000000001 }))),
    ).toBe(true)
  })
})

describe("AccountSchemaV1 encryptedSeed", () => {
  // A serialized (plain-string) account — the wire shape AccountSchemaV1 parses,
  // before its transforms produce bee-js runtime types. Only `encryptedSeed`
  // varies; the array fields default to [] so they can be omitted.
  function serializedAccount(encryptedSeed: string) {
    return {
      id: "a".repeat(40),
      name: "Test Account",
      createdAt: 1700000000000,
      derivationKey: "f".repeat(64),
      publicKey: TEST_PUBLIC_KEY_HEX,
      access: { type: "password", kdfSalt: "00", kdfIterations: 100000 },
      encryptedSeed,
    }
  }

  // The format/length of real encrypted seeds (88 hex for a 12-word phrase, 120
  // for 24-word) is covered end-to-end against the actual encryption pipeline in
  // swarm-ui/src/lib/crypto/encrypted-seed.test.ts. Here we just pin the schema
  // constraint itself: valid even-length hex passes, everything else is rejected.
  it("accepts a valid even-length hex value", () => {
    expect(
      AccountSchemaV1.safeParse(serializedAccount("aabbccdd")).success,
    ).toBe(true)
  })

  it.each([
    ["an empty string", ""],
    ["an odd-length hex string", "abc"],
    ["a non-hex string", "zzzz"],
    ["uppercase hex", "AABB"],
  ])("rejects %s", (_label, encryptedSeed) => {
    expect(
      AccountSchemaV1.safeParse(serializedAccount(encryptedSeed)).success,
    ).toBe(false)
  })
})
