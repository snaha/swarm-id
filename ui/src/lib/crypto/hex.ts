// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const HEX_BASE = 16
const HEX_CHARS_PER_BYTE = 2
const HEX_PATTERN = /^[0-9a-fA-F]*$/

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(HEX_BASE).padStart(HEX_CHARS_PER_BYTE, '0'))
    .join('')
}

/** Decode a hex string (optional 0x prefix); throws on malformed input. */
export function hexToBytes(hex: string): Uint8Array {
  const stripped = hex.startsWith('0x') ? hex.slice(2) : hex
  if (stripped.length % HEX_CHARS_PER_BYTE !== 0 || !HEX_PATTERN.test(stripped)) {
    throw new Error('Invalid hex string.')
  }
  const bytes = new Uint8Array(stripped.length / HEX_CHARS_PER_BYTE)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(
      stripped.slice(i * HEX_CHARS_PER_BYTE, (i + 1) * HEX_CHARS_PER_BYTE),
      HEX_BASE,
    )
  }
  return bytes
}
