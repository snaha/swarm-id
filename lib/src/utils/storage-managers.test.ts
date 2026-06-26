// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { BatchId, PrivateKey } from "@ethersphere/bee-js"
import { serializeAccount } from "./storage-managers"
import { AccountSchemaV1 } from "../schemas"
import {
  TEST_BATCH_ID_HEX,
  TEST_PRIVATE_KEY_HEX,
  createAccount,
  createPostageStamp,
} from "../test-fixtures"

describe("serializeAccount — device-local seed vault", () => {
  it("round-trips a seed-vault account through serialize + Zod parse", () => {
    const account = createAccount({
      access: { type: "passkey", credentialId: "cred-xyz" },
      encryptedSeed: "0011223344",
      defaultPostageStampBatchID: new BatchId(TEST_BATCH_ID_HEX),
      postageStamps: [
        createPostageStamp({
          batchID: new BatchId(TEST_BATCH_ID_HEX),
          signerKey: new PrivateKey(TEST_PRIVATE_KEY_HEX),
        }),
      ],
    })

    const serialized = serializeAccount(account)

    // Survives a JSON file round-trip (no class instances leak into storage).
    const reparsed = AccountSchemaV1.parse(
      JSON.parse(JSON.stringify(serialized)),
    )

    expect(reparsed.access).toEqual({
      type: "passkey",
      credentialId: "cred-xyz",
    })
    expect(reparsed.encryptedSeed).toBe("0011223344")
    expect(reparsed.id.equals(account.id)).toBe(true)
    expect(reparsed.derivationKey).toBe(account.derivationKey)
    expect(
      reparsed.postageStamps[0].batchID.equals(new BatchId(TEST_BATCH_ID_HEX)),
    ).toBe(true)
  })

  it("persists each access method shape", () => {
    for (const access of [
      { type: "passkey", credentialId: "c" },
      { type: "eth-wallet", walletAddress: "0xabc", encryptionSalt: "ff" },
      { type: "password", kdfSalt: "aa", kdfIterations: 200000 },
    ] as const) {
      const serialized = serializeAccount(createAccount({ access }))
      const reparsed = AccountSchemaV1.parse(
        JSON.parse(JSON.stringify(serialized)),
      )
      expect(reparsed.access).toEqual(access)
    }
  })

  it("omits the seed vault for accounts that do not cache a seed", () => {
    const serialized = serializeAccount(
      createAccount({ access: undefined, encryptedSeed: undefined }),
    )
    const reparsed = AccountSchemaV1.parse(
      JSON.parse(JSON.stringify(serialized)),
    )
    expect(reparsed.access).toBeUndefined()
    expect(reparsed.encryptedSeed).toBeUndefined()
  })
})
