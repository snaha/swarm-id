// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Hex utilities
 *
 * Canonical location for hex conversion functions
 */

import type { Address } from "../schemas"

/**
 * Convert a hex string to Uint8Array
 *
 * @param hexString - Hex string (e.g., "deadbeef")
 * @returns Uint8Array
 */
export function hexToUint8Array(hexString: string): Uint8Array {
  // Remove any whitespace and ensure even length
  const hex = hexString.replace(/\s/g, "")
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid hex string: length must be even")
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
