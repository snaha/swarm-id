// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'

import { canonicalSignature } from './signature'

/**
 * Golden vectors, not a re-derivation: these bytes are what the seed vaults on
 * people's devices were encrypted under, so the expected values are written out
 * literally. A change here locks existing accounts out of their recovery
 * phrase — which is why this file exists at all.
 *
 * Signed by anvil's account #0 over the wallet flow's fixed message.
 */
const R = '4db6c144936ca45c38f374e1dcaec9be0d1a967239951a0737c4d25e6cbfd21e'
const S = '30bb83ab191df2d457cd78d76f5b284a575ab790a6998e8e23f67c9ebfe0c73b'
const R_AND_S = R + S
const CANONICAL_1C = `0x${R_AND_S}1c`
const CANONICAL_1B = `0x${R_AND_S}1b`

/**
 * The same signature in EIP-2098 compact form: 64 bytes, with the recovery bit
 * packed into the top bit of `s`. This fixture's `s` starts with `3` — top bit
 * clear — so parity 0 is `r ‖ s` unchanged, and parity 1 only sets that bit
 * (`3 | 8 = b`). Both must unpack back to the very same canonical bytes as the
 * 65-byte forms below: a wallet that switched representations would otherwise
 * derive a different key and lock its own vault.
 */
const COMPACT_PARITY_0 = `0x${R}${S}`
const COMPACT_PARITY_1 = `0x${R}b${S.slice(1)}`

describe('canonicalSignature', () => {
  it.each([
    ['27/28 form, as most wallets report it', `0x${R_AND_S}1c`, CANONICAL_1C],
    ['the other parity', `0x${R_AND_S}1b`, CANONICAL_1B],
    ['0/1 form, normalised up', `0x${R_AND_S}01`, CANONICAL_1C],
    ['0/1 form, other parity', `0x${R_AND_S}00`, CANONICAL_1B],
    // EIP-2098: 64 bytes, parity packed into s.
    ['compact form, parity 0', COMPACT_PARITY_0, CANONICAL_1B],
    ['compact form, parity 1', COMPACT_PARITY_1, CANONICAL_1C],
    // EIP-155-folded v (chainId * 2 + 35 + yParity). The chain id is noise for
    // a personal_sign; only the parity reaches the canonical bytes, so chain 1
    // and chain 100 land on the same two answers.
    ['v folded for chain 1, parity 0 (v=37)', `0x${R_AND_S}25`, CANONICAL_1B],
    ['v folded for chain 1, parity 1 (v=38)', `0x${R_AND_S}26`, CANONICAL_1C],
    ['v folded for chain 100, parity 0 (v=235)', `0x${R_AND_S}eb`, CANONICAL_1B],
    ['v folded for chain 100, parity 1 (v=236)', `0x${R_AND_S}ec`, CANONICAL_1C],
  ])('serialises %s', (_label, input, expected) => {
    expect(canonicalSignature(input)).toBe(expected)
  })

  // The property behind the table: representation is not supposed to matter,
  // since it is the derived key — not the signature — that has to survive.
  it.each([
    ['parity 0', COMPACT_PARITY_0, `0x${R_AND_S}1b`],
    ['parity 1', COMPACT_PARITY_1, `0x${R_AND_S}1c`],
  ])('reads the compact and the 65-byte form as one signature (%s)', (_label, compact, full) => {
    expect(canonicalSignature(compact)).toBe(canonicalSignature(full))
  })

  it('rejects a signature it cannot read rather than deriving from garbage', () => {
    expect(() => canonicalSignature('0xdeadbeef')).toThrow()
  })

  // Between the plain ids and the EIP-155 range there is nothing to read: a `v`
  // there is a wallet doing something we cannot reproduce, and guessing a
  // parity for it would seal a vault that never reopens.
  it('rejects a v that is neither a plain recovery id nor an EIP-155 fold', () => {
    expect(() => canonicalSignature(`0x${R_AND_S}1d`)).toThrow()
  })
})
