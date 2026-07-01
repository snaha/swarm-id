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

/**
 * Strip a leading `0x` from a hex string (returns it unchanged if there is
 * none): ethers returns keys `0x`-prefixed, but the lib and the shared records
 * store bare hex. Use this for the public/private-key strings that aren't
 * wrapped in a bee-js type. For addresses prefer `new EthAddress(value)`, which
 * strips the prefix AND normalizes EIP-55 mixed-case to lowercase — a plain
 * prefix strip does not lowercase.
 */
export function strip0x(value: string): string {
  return value.startsWith('0x') ? value.slice(2) : value
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
