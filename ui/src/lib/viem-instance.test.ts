// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// `@swarm-id/multichain` ships TS source and compiles into this bundle, so if
// pnpm keys its viem differently from ui's (abitype's `zod` peer is part of
// the key), Rollup emits two viems and two oxes (#734).
const LOCKFILE = readFileSync(new URL('../../../pnpm-lock.yaml', import.meta.url), 'utf8')

function importerVersion(importer: string, dependency: string): string | undefined {
  const section = LOCKFILE.split(`\n  ${importer}:\n`)[1]?.split(/\n\n/)[0]
  return section?.match(new RegExp(`\\n      ${dependency}:\\n.*\\n        version: (.+)`))?.[1]
}

describe('viem instance', () => {
  it('is the same resolved package for ui and multichain', () => {
    const ui = importerVersion('ui', 'viem')
    expect(ui).toBeDefined()
    expect(importerVersion('multichain', 'viem')).toBe(ui)
  })
})
