// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach, vi } from "vitest"
import { BatchId, EthAddress, PrivateKey } from "@ethersphere/bee-js"
import {
  createAccountsStorageManager,
  serializeAccount,
} from "./storage-managers"
import { LocalAccountSchemaV1 } from "../schemas"
import { STORAGE_KEY_ACCOUNTS } from "../types"
import {
  TEST_BATCH_ID_HEX,
  TEST_ETH_ADDRESS_2_HEX,
  TEST_PRIVATE_KEY_HEX,
  createAccount,
  createSignedOutAccount,
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
    const reparsed = LocalAccountSchemaV1.parse(
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
      { type: "eth-wallet", encryptionSalt: "ff" },
      { type: "password", kdfSalt: "aa", kdfIterations: 200000 },
    ] as const) {
      const serialized = serializeAccount(createAccount({ access }))
      const reparsed = LocalAccountSchemaV1.parse(
        JSON.parse(JSON.stringify(serialized)),
      )
      expect(reparsed.access).toEqual(access)
    }
  })

  it("round-trips a signed-out account (vault retained, signedOutAt set)", () => {
    const account = createSignedOutAccount({ signedOutAt: 1700000000123 })

    const serialized = serializeAccount(account)
    const reparsed = LocalAccountSchemaV1.parse(
      JSON.parse(JSON.stringify(serialized)),
    )

    expect(reparsed.access).toEqual(account.access)
    expect(reparsed.encryptedSeed).toBe(account.encryptedSeed)
    expect(reparsed.encryptedState).toBe(account.encryptedState)
    expect(reparsed.signedOutAt).toBe(1700000000123)
  })

  // Pins the sign-out privacy contract: nothing but the vault, the encrypted
  // state snapshot, and the display fields survives in localStorage — no
  // plaintext derivationKey, collections, or clocks.
  it("serializes a signed-out account to exactly the minimal remnant keys", () => {
    const serialized = serializeAccount(createSignedOutAccount())

    expect(Object.keys(serialized).sort()).toEqual([
      "access",
      "createdAt",
      "encryptedSeed",
      "encryptedState",
      "id",
      "name",
      "signedOutAt",
    ])
  })
})

describe("createAccountsStorageManager().load() — invalid records", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function stubLocalStorage(document: unknown) {
    const store = new Map<string, string>([
      [STORAGE_KEY_ACCOUNTS, JSON.stringify(document)],
    ])
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    })
  }

  it("skips an invalid record instead of dropping every account", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const good = createAccount()
    const other = createAccount({
      id: new EthAddress(TEST_ETH_ADDRESS_2_HEX),
      name: "Other Account",
    })
    const corrupt = {
      ...serializeAccount(other),
      // Fails the schema's hex regex — e.g. a malformed write from a dev tool.
      encryptedSeed: "not-hex",
    }
    stubLocalStorage({
      version: 1,
      data: [serializeAccount(good), corrupt],
    })

    const loaded = createAccountsStorageManager().load()

    expect(loaded).toHaveLength(1)
    expect(loaded[0].id.equals(good.id)).toBe(true)
  })

  // Pre-vault-retention releases wiped the vault on sign-out; those records
  // can't be signed back into and are quarantined by the loader (pre-prod,
  // no migration).
  it("skips a vault-less signed-out record from an old release", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const good = createAccount()
    const {
      access: _access,
      encryptedSeed: _encryptedSeed,
      ...oldSignedOut
    } = serializeAccount(
      createAccount({ id: new EthAddress(TEST_ETH_ADDRESS_2_HEX) }),
    )
    stubLocalStorage({
      version: 1,
      data: [
        serializeAccount(good),
        { ...oldSignedOut, signedOutAt: 1700000000001 },
      ],
    })

    const loaded = createAccountsStorageManager().load()

    expect(loaded).toHaveLength(1)
    expect(loaded[0].id.equals(good.id)).toBe(true)
  })

  it("returns [] when the document is not an array", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    stubLocalStorage({ version: 1, data: { not: "an array" } })

    expect(createAccountsStorageManager().load()).toEqual([])
  })
})
