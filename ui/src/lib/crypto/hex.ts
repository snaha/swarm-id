// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const HEX_BASE = 16
const HEX_CHARS_PER_BYTE = 2

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(HEX_BASE).padStart(HEX_CHARS_PER_BYTE, '0'))
    .join('')
}

export function hexToBytes(hex: string): Uint8Array {
  const stripped = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(stripped.length / HEX_CHARS_PER_BYTE)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(
      stripped.slice(i * HEX_CHARS_PER_BYTE, (i + 1) * HEX_CHARS_PER_BYTE),
      HEX_BASE,
    )
  }
  return bytes
}
