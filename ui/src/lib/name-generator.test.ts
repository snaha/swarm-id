// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'

import { generateName } from './name-generator'

const RUNS = 200

describe('generateName', () => {
  it('returns two capitalised words separated by a single space', () => {
    expect(generateName()).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/)
  })

  it('always produces a non-empty two-part name', () => {
    for (let i = 0; i < RUNS; i++) {
      const parts = generateName().split(' ')
      expect(parts).toHaveLength(2)
      expect(parts[0].length).toBeGreaterThan(0)
      expect(parts[1].length).toBeGreaterThan(0)
    }
  })

  it('produces more than one distinct value across many runs', () => {
    const seen = new Set<string>()
    for (let i = 0; i < RUNS; i++) {
      seen.add(generateName())
    }
    expect(seen.size).toBeGreaterThan(1)
  })
})
