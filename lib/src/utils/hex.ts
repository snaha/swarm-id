// Copyright 2024 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Hex utilities
 *
 * Re-exports hex conversion functions from key-derivation
 */

import type { Address } from "../schemas"

export { hexToUint8Array, uint8ArrayToHex } from "./key-derivation"

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
