// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import { deriveSecret, deriveSharingKey } from "./key-derivation"
import { publicKeyFromPrivate, compressPublicKey } from "../proxy/act/crypto"
import { uint8ArrayToHex } from "./hex"

describe("deriveSharingKey (#519)", () => {
  const derivationKey = "ab".repeat(32)

  it("is a pure function of the derivation key", () => {
    const a = deriveSharingKey(derivationKey)
    const b = deriveSharingKey(derivationKey)
    expect(a.publicKey).toBe(b.publicKey)
    expect(a.secret).toEqual(b.secret)
    expect(deriveSharingKey("cd".repeat(32)).publicKey).not.toBe(a.publicKey)
  })

  it("equals deriveSecret(derivationKey, 'act-sharing'), so #692 can swap it in", async () => {
    const { secret } = deriveSharingKey(derivationKey)
    expect(uint8ArrayToHex(secret)).toBe(
      await deriveSecret(derivationKey, "act-sharing"),
    )
  })

  it("reports the public key the ACT module derives from the secret", () => {
    const { secret, publicKey } = deriveSharingKey(derivationKey)
    const { x, y } = publicKeyFromPrivate(secret)
    expect(publicKey).toBe(uint8ArrayToHex(compressPublicKey(x, y)))
  })
})
