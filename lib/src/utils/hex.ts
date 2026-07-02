// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Hex utilities
 *
 * Canonical location for hex conversion functions
 */

import type { Address } from "../schemas"

/**
 * Convert a hex string (optional 0x prefix) to Uint8Array
 *
 * @param hexString - Hex string (e.g., "deadbeef" or "0xdeadbeef")
 * @returns Uint8Array
 * @throws {Error} If the input has odd length or non-hex characters — a
 *   malformed value must fail loudly, not silently decode to zero bytes
 */
export function hexToUint8Array(hexString: string): Uint8Array {
  const hex = hexString.replace(/^0x/i, "")
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("Invalid hex string.")
  }

  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }

  return bytes
}

/**
 * Convert a Uint8Array to hex string
 *
 * @param bytes - Uint8Array to convert
 * @returns Hex string (e.g., "deadbeef")
 */
export function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Create a validated hex address string (40 lowercase hex chars).
 * Accepts optional 0x prefix and any case.
 *
 * @param input - Ethereum address string (with or without 0x prefix)
 * @returns Normalized 40-character lowercase hex string
 * @throws {Error} If the input is not a valid 40-char hex address
 */
export function hexAddress(input: string): Address {
  const clean = input.replace(/^0x/i, "").toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new Error(
      `Invalid hex address: expected 40 hex characters (with optional 0x prefix), got "${input}"`,
    )
  }
  return clean
}
