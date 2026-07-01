// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'

import { bytesToHex, hexToBytes, prefix0x, strip0x } from './hex'

describe('bytesToHex', () => {
  it('encodes bytes as zero-padded lowercase hex', () => {
    expect(bytesToHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe('00010f10ff')
  })

  it('encodes empty input as an empty string', () => {
    expect(bytesToHex(new Uint8Array())).toBe('')
  })
})

describe('hexToBytes', () => {
  it('decodes with or without a 0x prefix', () => {
    expect([...hexToBytes('00010f10ff')]).toEqual([0, 1, 15, 16, 255])
    expect([...hexToBytes('0x00010f10ff')]).toEqual([0, 1, 15, 16, 255])
  })

  it('round-trips with bytesToHex', () => {
    const bytes = new Uint8Array([1, 2, 3, 250])
    expect([...hexToBytes(bytesToHex(bytes))]).toEqual([...bytes])
  })

  it('throws on an odd-length string', () => {
    expect(() => hexToBytes('abc')).toThrow('Invalid hex string.')
  })

  it('throws on non-hex characters', () => {
    expect(() => hexToBytes('zz')).toThrow('Invalid hex string.')
  })
})

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
