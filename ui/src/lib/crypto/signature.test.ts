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
const R_AND_S =
  '4db6c144936ca45c38f374e1dcaec9be0d1a967239951a0737c4d25e6cbfd21e' +
  '30bb83ab191df2d457cd78d76f5b284a575ab790a6998e8e23f67c9ebfe0c73b'
const CANONICAL_1C = `0x${R_AND_S}1c`
const CANONICAL_1B = `0x${R_AND_S}1b`

describe('canonicalSignature', () => {
  it.each([
    ['27/28 form, as most wallets report it', `0x${R_AND_S}1c`, CANONICAL_1C],
    ['the other parity', `0x${R_AND_S}1b`, CANONICAL_1B],
    ['0/1 form, normalised up', `0x${R_AND_S}01`, CANONICAL_1C],
    ['0/1 form, other parity', `0x${R_AND_S}00`, CANONICAL_1B],
  ])('serialises %s', (_label, input, expected) => {
    expect(canonicalSignature(input)).toBe(expected)
  })

  it('rejects a signature it cannot read rather than deriving from garbage', () => {
    expect(() => canonicalSignature('0xdeadbeef')).toThrow()
  })
})
