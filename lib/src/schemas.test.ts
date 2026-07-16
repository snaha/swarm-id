// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, expectTypeOf } from "vitest"
import { BatchId, PrivateKey } from "@ethersphere/bee-js"
import {
  LocalAccountSchemaV1,
  isLocalAccount,
  isSignedOutAccount,
  type AccessMethod,
  type Account,
} from "./schemas"
import {
  TEST_BATCH_ID_HEX,
  TEST_BATCH_ID_2_HEX,
  TEST_PRIVATE_KEY_HEX,
  TEST_PUBLIC_KEY_HEX,
  createAccount,
  createSignedOutAccount,
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

describe("LocalAccountSchemaV1 encryptedSeed", () => {
  // A serialized (plain-string) account — the wire shape LocalAccountSchemaV1
  // parses, before its transforms produce bee-js runtime types. Only
  // `encryptedSeed` varies; the array fields default to [] so they can be
  // omitted.
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
  // the identity UI (ui/src/lib/crypto/). Here we just pin the schema constraint
  // itself: valid even-length hex passes, everything else is rejected.
  it("accepts a valid even-length hex value", () => {
    expect(
      LocalAccountSchemaV1.safeParse(serializedAccount("aabbccdd")).success,
    ).toBe(true)
  })

  it.each([
    ["an empty string", ""],
    ["an odd-length hex string", "abc"],
    ["a non-hex string", "zzzz"],
    ["uppercase hex", "AABB"],
  ])("rejects %s", (_label, encryptedSeed) => {
    expect(
      LocalAccountSchemaV1.safeParse(serializedAccount(encryptedSeed)).success,
    ).toBe(false)
  })
})

describe("LocalAccountSchemaV1 signed-in/signed-out union", () => {
  // Same wire shape as above; the vault group (`access` + `encryptedSeed` +
  // `signedOutAt`) varies per case.
  function serializedAccount(vault: Record<string, unknown>) {
    return {
      id: "a".repeat(40),
      name: "Test Account",
      createdAt: 1700000000000,
      derivationKey: "f".repeat(64),
      publicKey: TEST_PUBLIC_KEY_HEX,
      ...vault,
    }
  }

  const VAULT = {
    access: { type: "password", kdfSalt: "00", kdfIterations: 100000 },
    encryptedSeed: "aabbccdd",
  }
  // The remnant a sign-out persists beyond the vault: the AES-encrypted
  // snapshot of the synced state, restored on sign-back-in.
  const SIGNED_OUT = {
    ...VAULT,
    encryptedState: '{"format":"test-snapshot","payload":"aabb"}',
    signedOutAt: 1700000000001,
  }

  it("accepts a signed-out record that retains the vault and state snapshot", () => {
    const result = LocalAccountSchemaV1.safeParse(serializedAccount(SIGNED_OUT))
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.signedOutAt).toBe(1700000000001)
      expect(result.data.access).toEqual(VAULT.access)
      expect(result.data.encryptedSeed).toBe(VAULT.encryptedSeed)
      expect(result.data.encryptedState).toBe(SIGNED_OUT.encryptedState)
    }
  })

  it("rejects a signed-out record without the encrypted state snapshot", () => {
    expect(
      LocalAccountSchemaV1.safeParse(
        serializedAccount({ ...VAULT, signedOutAt: 1700000000001 }),
      ).success,
    ).toBe(false)
  })

  // A record written before the sign-out shrank to the minimal remnant (full
  // synced fields + signedOutAt) still parses — under the signed-out arm, which
  // strips the synced fields (incl. the plaintext derivationKey) on parse.
  it("strips the synced fields off a signed-out record", () => {
    const result = LocalAccountSchemaV1.safeParse(
      serializedAccount({
        ...SIGNED_OUT,
        postageStamps: [],
      }),
    )
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).not.toHaveProperty("derivationKey")
      expect(result.data).not.toHaveProperty("publicKey")
      expect(result.data).not.toHaveProperty("postageStamps")
    }
  })

  // The storage-warning remnant captured at sign-out: a flag for drives that
  // already needed attention, and the soonest estimated drive expiry so the
  // "expires soon" warning can keep developing while signed out.
  it("carries the storage-warning fields on a signed-out record", () => {
    const result = LocalAccountSchemaV1.safeParse(
      serializedAccount({
        ...SIGNED_OUT,
        storageWarning: true,
        soonestDriveExpiry: 1707776000000,
      }),
    )
    expect(result.success).toBe(true)
    expect(result.success && result.data).toMatchObject({
      storageWarning: true,
      soonestDriveExpiry: 1707776000000,
    })
  })

  it("accepts a signed-out record without the storage-warning fields", () => {
    expect(
      LocalAccountSchemaV1.safeParse(serializedAccount(SIGNED_OUT)).success,
    ).toBe(true)
  })

  it("rejects a vault-less signed-out record (pre-retention shape)", () => {
    expect(
      LocalAccountSchemaV1.safeParse(
        serializedAccount({ signedOutAt: 1700000000001 }),
      ).success,
    ).toBe(false)
  })

  it("rejects a record with neither vault nor signedOutAt", () => {
    expect(LocalAccountSchemaV1.safeParse(serializedAccount({})).success).toBe(
      false,
    )
  })

  it.each([
    ["access", { access: VAULT.access }],
    ["encryptedSeed", { encryptedSeed: VAULT.encryptedSeed }],
  ])("rejects a signed-in record missing %s", (_label, partialVault) => {
    expect(
      LocalAccountSchemaV1.safeParse(serializedAccount(partialVault)).success,
    ).toBe(false)
  })

  it.each([
    ["access", { access: VAULT.access }],
    ["encryptedSeed", { encryptedSeed: VAULT.encryptedSeed }],
  ])(
    "rejects a signed-out record with only %s of the vault",
    (_label, partialVault) => {
      expect(
        LocalAccountSchemaV1.safeParse(
          serializedAccount({
            ...partialVault,
            encryptedState: SIGNED_OUT.encryptedState,
            signedOutAt: 1700000000001,
          }),
        ).success,
      ).toBe(false)
    },
  )
})

describe("isSignedOutAccount", () => {
  it("is signed out when signedOutAt is set (vault retained)", () => {
    expect(isSignedOutAccount(createSignedOutAccount())).toBe(true)
  })

  it("is signed in without signedOutAt", () => {
    expect(isSignedOutAccount(createAccount({}))).toBe(false)
  })

  // The point of the union model: the guard narrows, so the signed-out branch
  // sees a non-optional `signedOutAt` — and BOTH branches keep the vault, so
  // the sign-back-in unlock can read it without `!`/`??` juggling.
  it("narrows each union variant", () => {
    const account: Account = createSignedOutAccount()
    if (isSignedOutAccount(account)) {
      expectTypeOf(account.signedOutAt).toEqualTypeOf<number>()
    }
    expectTypeOf(account.access).toEqualTypeOf<AccessMethod>()
    expectTypeOf(account.encryptedSeed).toEqualTypeOf<string>()
  })
})
