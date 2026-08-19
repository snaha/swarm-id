// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Byte⇄hex conversion comes from the lib (`uint8ArrayToHex`/`hexToUint8Array`)
// — this module only holds the 0x-prefix helpers the lib has no use for.

const HEX_PATTERN = /^[0-9a-fA-F]*$/

/**
 * Strip a leading `0x` from a hex string (returns it unchanged if there is
 * none): the derivation returns keys `0x`-prefixed, but the lib and the shared records
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
