// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import {
  ACT_SHARING_LABEL,
  BACKUP_KEY_LABEL,
  DERIVATION_KEY_LABEL,
  POSTAGE_SIGNER_LABEL,
  SWARM_ENCRYPTION_LABEL,
  deriveSecret,
  deriveSecretSync,
  deriveSharingKey,
} from "./key-derivation"
import { publicKeyFromPrivate, compressPublicKey } from "../proxy/act/crypto"
import { uint8ArrayToHex } from "./hex"

const PARENT_KEY = "ab".repeat(32)

// Output equivalence is the whole game (#692): stored derivation keys, app
// secrets, bus topics and feed owners must not move. The Web Crypto path is
// what every stored key came from, so the noble path is held to it, and both
// to a literal so neither can drift without this test saying so.
describe("deriveSecretSync", () => {
  it("is byte-identical to deriveSecret for every label of the tree", async () => {
    for (const label of [
      DERIVATION_KEY_LABEL,
      SWARM_ENCRYPTION_LABEL,
      POSTAGE_SIGNER_LABEL,
      BACKUP_KEY_LABEL,
      ACT_SHARING_LABEL,
      "https://swarm-app.local:8080",
    ]) {
      expect(deriveSecretSync(PARENT_KEY, label)).toBe(
        await deriveSecret(PARENT_KEY, label),
      )
    }
  })

  it("matches the vector Web Crypto gave for a fixed key and label", () => {
    expect(deriveSecretSync(PARENT_KEY, ACT_SHARING_LABEL)).toBe(
      "0840849cb37e59e129a59eaf61ea8eb36c6a53914c6d91df575744e1775eedf6",
    )
    expect(deriveSecretSync(PARENT_KEY, POSTAGE_SIGNER_LABEL)).toBe(
      "12e8a6eec78c11c5ed44398aa3449119eabf89e72a01eec9662e230c2f5289d4",
    )
  })
})

describe("deriveSharingKey (#519)", () => {
  it("is a pure function of the derivation key", () => {
    const a = deriveSharingKey(PARENT_KEY)
    const b = deriveSharingKey(PARENT_KEY)
    expect(a.publicKey).toBe(b.publicKey)
    expect(a.secret).toEqual(b.secret)
    expect(deriveSharingKey("cd".repeat(32)).publicKey).not.toBe(a.publicKey)
  })

  it("is deriveSecret under the act-sharing label", async () => {
    const { secret } = deriveSharingKey(PARENT_KEY)
    expect(uint8ArrayToHex(secret)).toBe(
      await deriveSecret(PARENT_KEY, ACT_SHARING_LABEL),
    )
  })

  it("reports the public key the ACT module derives from the secret", () => {
    const { secret, publicKey } = deriveSharingKey(PARENT_KEY)
    const { x, y } = publicKeyFromPrivate(secret)
    expect(publicKey).toBe(uint8ArrayToHex(compressPublicKey(x, y)))
  })
})
