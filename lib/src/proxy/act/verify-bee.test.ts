import { describe, it, expect } from "vitest"
import { counterModeEncrypt } from "./crypto"

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

describe("Verify CTR mode matches Bee decryption", () => {
  // Values from actual Bee debug logs
  const encryptedRef =
    "daae5cf4b3978362e7975548de9139ee6cfd5b4422179b23a55eded1b975ea52"
  const accessKey =
    "f264f1e4a6c0104a295bc650b80dc38635eb56ba047b6c9b41bd7241cf4bbf99"
  const beeDecryptedRef =
    "ffe4a41dcc711ab78148a37c92599c116a75e2ee02a16cd651eee9a077e7af5b"

  it("should decrypt to same value as Bee", () => {
    // Our decrypt(encryptedRef, accessKey) should equal beeDecryptedRef
    const ourDecrypted = counterModeEncrypt(
      hexToBytes(encryptedRef),
      hexToBytes(accessKey),
    )
    console.log("Our decrypted:", bytesToHex(ourDecrypted))
    console.log("Bee decrypted:", beeDecryptedRef)
    expect(bytesToHex(ourDecrypted)).toBe(beeDecryptedRef)
  })

  it("should encrypt original to same value Bee received", () => {
    // If Bee decrypted correctly, then encrypt(beeDecryptedRef, accessKey) should equal encryptedRef
    const ourEncrypted = counterModeEncrypt(
      hexToBytes(beeDecryptedRef),
      hexToBytes(accessKey),
    )
    console.log("Our encrypted:", bytesToHex(ourEncrypted))
    console.log("Bee received:", encryptedRef)
    expect(bytesToHex(ourEncrypted)).toBe(encryptedRef)
  })
})
