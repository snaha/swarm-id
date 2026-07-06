// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'

import { generateDockerName } from './docker-name'

const ADDRESS_A = '0x1234567890abcdef1234567890abcdef12345678'
const ADDRESS_B = '0xfedcba0987654321fedcba0987654321fedcba09'

describe('generateDockerName', () => {
  it('returns two capitalised words separated by a single space', () => {
    expect(generateDockerName(ADDRESS_A)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/)
  })

  it('is deterministic — same address always yields the same name', () => {
    expect(generateDockerName(ADDRESS_A)).toBe(generateDockerName(ADDRESS_A))
  })

  it('is insensitive to 0x prefix and case', () => {
    expect(generateDockerName(ADDRESS_A.slice(2).toUpperCase())).toBe(generateDockerName(ADDRESS_A))
  })

  it('yields different names for different addresses', () => {
    expect(generateDockerName(ADDRESS_A)).not.toBe(generateDockerName(ADDRESS_B))
  })
})
