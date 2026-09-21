// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { encryptEnvelope, decryptEnvelope } from "./envelope"
import { deriveAesGcmKey } from "../utils/key-derivation"
import {
  TEST_DERIVATION_KEY_HEX,
  DIFFERENT_DERIVATION_KEY_HEX,
} from "../test-fixtures"

const CONTEXT = "envelope-test"

describe("encryptEnvelope / decryptEnvelope", () => {
  it("round-trips a payload", async () => {
    const key = await deriveAesGcmKey(TEST_DERIVATION_KEY_HEX, CONTEXT)
    const plaintext = '{"hello":"world"}'

    const ciphertext = await encryptEnvelope(plaintext, key)
    expect(ciphertext).not.toBe(plaintext)
    expect(await decryptEnvelope(ciphertext, key)).toBe(plaintext)
  })

  it("produces different ciphertext for the same input (random IV)", async () => {
    const key = await deriveAesGcmKey(TEST_DERIVATION_KEY_HEX, CONTEXT)
    const plaintext = '{"test":true}'

    const ct1 = await encryptEnvelope(plaintext, key)
    const ct2 = await encryptEnvelope(plaintext, key)
    expect(ct1).not.toBe(ct2)
  })

  it("rejects a different key", async () => {
    const key = await deriveAesGcmKey(TEST_DERIVATION_KEY_HEX, CONTEXT)
    const otherKey = await deriveAesGcmKey(
      DIFFERENT_DERIVATION_KEY_HEX,
      CONTEXT,
    )

    const ciphertext = await encryptEnvelope("secret", key)
    await expect(decryptEnvelope(ciphertext, otherKey)).rejects.toThrow()
  })

  it("rejects a tampered payload", async () => {
    const key = await deriveAesGcmKey(TEST_DERIVATION_KEY_HEX, CONTEXT)
    const bytes = Buffer.from(await encryptEnvelope("secret", key), "base64")
    bytes[bytes.length - 1] ^= 1
    const tampered = bytes.toString("base64")
    await expect(decryptEnvelope(tampered, key)).rejects.toThrow()
  })
})
