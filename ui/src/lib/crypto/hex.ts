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
 * store bare hex. Use this for the public/private-key strings. For addresses
 * prefer `new EthAddress(value)`, which also normalizes EIP-55 case.
 */
export function strip0x(value: string): string {
  return value.startsWith('0x') ? value.slice(2) : value
}

/**
 * Add a `0x` prefix to a bare hex string (idempotent: an already-prefixed value
 * is returned unchanged). Throws on a non-hex string so a malformed value can't
 * be handed off as hex. The inverse of `strip0x`, for presenting bare stored hex
 * to UI or code that expects the `0x` form.
 */
export function prefix0x(value: string): string {
  if (value.startsWith('0x')) return value
  if (!HEX_PATTERN.test(value)) {
    throw new Error('Invalid hex string.')
  }
  return `0x${value}`
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
