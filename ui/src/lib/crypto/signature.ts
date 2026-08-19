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
 * Pure, and kept out of `eth-wallet.ts` so the format can be pinned by tests
 * without dragging in the wallet-connection machinery.
 */
import { type Hex, parseSignature, serializeSignature } from 'viem'

export function canonicalSignature(signature: string): Hex {
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error('The wallet returned a signature that is not hex.')
  }
  return serializeSignature(parseSignature(signature as Hex))
}
