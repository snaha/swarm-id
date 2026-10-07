// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest"

import {
  PASSWORD_KDF_ITERATIONS,
  decryptSeed,
  deriveKeyFromPassword,
  deriveKeyFromPrf,
  deriveKeyFromSignature,
  encryptSeed,
  randomSalt,
} from "./seed-encryption"

// Fast KDF settings for tests only.
const TEST_ITERATIONS = 10

const ENTROPY = new Uint8Array([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
])

describe("seed encryption round-trips", () => {
  it("with a password-derived key", async () => {
    const salt = randomSalt()
    const key = await deriveKeyFromPassword(
      "correct horse battery staple",
      salt,
      TEST_ITERATIONS,
    )
    const payload = await encryptSeed(ENTROPY, key)

    const sameKey = await deriveKeyFromPassword(
      "correct horse battery staple",
      salt,
      TEST_ITERATIONS,
    )
    expect(await decryptSeed(payload, sameKey)).toEqual(ENTROPY)
  })

  it("fails with the wrong password", async () => {
    const salt = randomSalt()
    const key = await deriveKeyFromPassword(
      "right password",
      salt,
      TEST_ITERATIONS,
    )
    const payload = await encryptSeed(ENTROPY, key)

    const wrongKey = await deriveKeyFromPassword(
      "wrong password",
      salt,
      TEST_ITERATIONS,
    )
    await expect(decryptSeed(payload, wrongKey)).rejects.toThrow()
  })

  it("with a PRF-derived key", async () => {
    const prfOutput = new Uint8Array(32).fill(7)
    const key = await deriveKeyFromPrf(prfOutput)
    const payload = await encryptSeed(ENTROPY, key)
    expect(
      await decryptSeed(payload, await deriveKeyFromPrf(prfOutput)),
    ).toEqual(ENTROPY)
  })

  it("with a wallet-signature-derived key", async () => {
    // A canonical 65-byte secp256k1 signature; whether the wallet re-signs
    // deterministically is the signature module's concern (ui), not this one's.
    const signature = new Uint8Array(65).fill(9)
    const salt = randomSalt()
    const key = await deriveKeyFromSignature(signature, salt)
    const payload = await encryptSeed(ENTROPY, key)
    expect(
      await decryptSeed(payload, await deriveKeyFromSignature(signature, salt)),
    ).toEqual(ENTROPY)
  })

  it("produces different ciphertexts per encryption (fresh IV)", async () => {
    const key = await deriveKeyFromPrf(new Uint8Array(32).fill(1))
    expect(await encryptSeed(ENTROPY, key)).not.toBe(
      await encryptSeed(ENTROPY, key),
    )
  })
})

// Known-answer vectors: fixed key material and a payload sealed with this
// module. A round-trip above still passes if the HKDF info string, the IV or
// salt length, the AES key size or the PBKDF2 default changes; these do not,
// and the docs' "Storage layout" page promises hosts exactly these bytes.
describe("seed encryption known answers", () => {
  const SALT = Uint8Array.from({ length: 32 }, (_, i) => i)

  it("pins the password path (PBKDF2-SHA256, default iterations)", async () => {
    expect(PASSWORD_KDF_ITERATIONS).toBe(600_000)
    const key = await deriveKeyFromPassword(
      "correct horse battery staple",
      SALT,
    )
    const payload =
      "960e15b5ac56351da6dd82a9fc9e7d674dd8e31836577a2dc7c099537281756c70baf56637dbbac5e2f81aa9"
    expect(await decryptSeed(payload, key)).toEqual(ENTROPY)
  })

  it("pins the wallet-signature path (HKDF-SHA256 with salt)", async () => {
    const signature = Uint8Array.from({ length: 65 }, (_, i) => (i * 7) & 0xff)
    const key = await deriveKeyFromSignature(signature, SALT)
    const payload =
      "da3ed25e43ecd2729f70be252ea684989a98986a5324e257fcf9b8af54794a01200cadf4b19d9e41eb5cab5c"
    expect(await decryptSeed(payload, key)).toEqual(ENTROPY)
  })

  it("pins the passkey path (HKDF-SHA256, empty salt)", async () => {
    const prf = Uint8Array.from({ length: 32 }, (_, i) => 255 - i)
    const key = await deriveKeyFromPrf(prf)
    const payload =
      "dd9b64259046ee06badf87f5b418200baec96341c33717bd633d850172bb064aa4fff3d7aec4e2c1ad69dd53"
    expect(await decryptSeed(payload, key)).toEqual(ENTROPY)
  })

  it("lays out IV (12) || ciphertext as lowercase hex", async () => {
    const payload = await encryptSeed(
      ENTROPY,
      await deriveKeyFromPrf(new Uint8Array(32)),
    )
    // 12-byte IV + 16-byte entropy + 16-byte GCM tag = 44 bytes.
    expect(payload).toMatch(/^[0-9a-f]{88}$/)
  })
})
