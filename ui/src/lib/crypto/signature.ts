// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The canonical form of a wallet's `personal_sign` result.
 *
 * The seed-encryption key is derived from these exact bytes, so the
 * representation is part of the on-disk format: a wallet that reports the
 * recovery id as 0/1 rather than 27/28 must still unlock a seed that was
 * sealed the other way round.
 *
 * Three encodings reach here, and all three must land on the same bytes:
 *   - 65 bytes with `v` as 0/1 or 27/28 — what most wallets return;
 *   - 64 bytes, EIP-2098 "compact", with the recovery bit packed into the top
 *     bit of `s`;
 *   - 65 bytes with `v` folded per EIP-155 (`chainId * 2 + 35 + yParity`),
 *     which some wallets emit for `personal_sign` too.
 * viem's `parseSignature` reads only the first, so the other two are unpacked
 * before it sees them — a wallet emitting either must not be locked out of a
 * seed it sealed itself.
 *
 * Pure, and kept out of `eth-wallet.ts` so the format can be pinned by tests
 * without dragging in the wallet-connection machinery.
 */
import {
  type Hex,
  compactSignatureToSignature,
  parseCompactSignature,
  parseSignature,
  serializeSignature,
} from 'viem'

/** `0x` + 64 bytes: an EIP-2098 compact signature (r ‖ yParityAndS). */
const COMPACT_HEX_LENGTH = 130
/** `0x` + 65 bytes: r ‖ s ‖ v, the usual form. Nothing longer is a signature. */
const FULL_HEX_LENGTH = 132
/** Hex characters holding `v`, the last byte of the full form. */
const V_HEX_LENGTH = 2
/** At or above this, `v` carries a folded chain id (EIP-155) rather than a plain id. */
const EIP155_V_FLOOR = 35
/** What the canonical form offsets the recovery id by. */
const V_OFFSET = 27
const HEX_RADIX = 16

export function canonicalSignature(signature: string): Hex {
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error('The wallet returned a signature that is not hex.')
  }
  const hex = signature as Hex

  if (hex.length === COMPACT_HEX_LENGTH) {
    // Unpacks the parity bit out of `s` and restores the full 65-byte form,
    // so a compact signature seals and unseals the same vault as its long twin.
    return serializeSignature(compactSignatureToSignature(parseCompactSignature(hex)))
  }

  if (hex.length === FULL_HEX_LENGTH) {
    const v = parseInt(hex.slice(-V_HEX_LENGTH), HEX_RADIX)
    if (v >= EIP155_V_FLOOR) {
      // The chain id is noise here — `personal_sign` is not a transaction, and
      // only the parity survives into the canonical bytes.
      const parity = (v - EIP155_V_FLOOR) % 2
      const folded = (V_OFFSET + parity).toString(HEX_RADIX)
      return serializeSignature(parseSignature(`${hex.slice(0, -V_HEX_LENGTH)}${folded}` as Hex))
    }
  }

  // Everything else is viem's to accept or reject: 0/1 and 27/28 parse, and a
  // `v` in neither range (or a length that is no signature at all) throws
  // rather than deriving a key from bytes nobody can reproduce.
  return serializeSignature(parseSignature(hex))
}
