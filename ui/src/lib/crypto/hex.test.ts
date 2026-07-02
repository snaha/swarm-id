// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'

import { prefix0x, strip0x } from './hex'

describe('strip0x', () => {
  it('removes a leading 0x', () => {
    expect(strip0x('0xdeadbeef')).toBe('deadbeef')
  })

  it('leaves a bare string unchanged', () => {
    expect(strip0x('deadbeef')).toBe('deadbeef')
  })
})

describe('prefix0x', () => {
  it('adds a 0x to a bare hex string', () => {
    expect(prefix0x('deadbeef')).toBe('0xdeadbeef')
  })

  it('is idempotent when already prefixed', () => {
    expect(prefix0x('0xdeadbeef')).toBe('0xdeadbeef')
  })

  it('throws on a non-hex string', () => {
    expect(() => prefix0x('nothex!')).toThrow('Invalid hex string.')
  })

  it('is the inverse of strip0x', () => {
    expect(strip0x(prefix0x('deadbeef'))).toBe('deadbeef')
  })
})
