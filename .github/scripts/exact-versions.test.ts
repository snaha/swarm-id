// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
// Node's type stripping resolves no extensionless import.
import { isExact, isExactOverride, lockfileOverrides, manifestRanges } from './exact-versions.ts'

const LOCKFILE = 'pnpm-lock.yaml'

describe('isExact', () => {
  for (const spec of [
    '13.0.0',
    '1.0.0-rc.1',
    '1.0.0+build.5',
    'npm:foo@1.2.3',
    'npm:@scope/foo@1.2.3',
    'workspace:*',
  ]) {
    it(`accepts ${spec}`, () => assert.equal(isExact(spec), true))
  }
  for (const spec of [
    '^13.0.0',
    '~13.0.0',
    '>=1.0.0',
    '1.x',
    '1.0',
    '*',
    'latest',
    'github:owner/repo',
    'npm:foo@^1.2.3',
    'catalog:',
    'workspace:^',
    'workspace:~',
  ]) {
    it(`rejects ${spec}`, () => assert.equal(isExact(spec), false))
  }
})

describe('isExactOverride', () => {
  it('accepts a reference to a direct dependency', () => {
    assert.equal(isExactOverride('$foo'), true)
    assert.equal(isExactOverride('$@scope/foo'), true)
  })
  it('rejects a range', () => assert.equal(isExactOverride('^8.22.1'), false))
})

describe('manifestRanges', () => {
  it('lists the ranges of every dependency field, and nothing else', () => {
    const ranges = manifestRanges({
      dependencies: { a: '1.0.0', b: '^1.0.0' },
      devDependencies: { c: '~2.0.0' },
      optionalDependencies: { d: 'latest' },
    })
    assert.deepEqual(ranges, [
      ['dependencies b', '^1.0.0'],
      ['devDependencies c', '~2.0.0'],
      ['optionalDependencies d', 'latest'],
    ])
  })
})

describe('lockfileOverrides', () => {
  it('reads the block pnpm writes', () => {
    const text = [
      "lockfileVersion: '9.0'",
      '',
      'overrides:',
      '  ws@^8: ^8.22.1',
      "  '@ethersphere/bee-js>zod': 4.6.7",
      '',
      'importers:',
      '  .:',
    ].join('\n')
    assert.deepEqual(lockfileOverrides(text, LOCKFILE), {
      'ws@^8': '^8.22.1',
      '@ethersphere/bee-js>zod': '4.6.7',
    })
  })
  it('reads a block that runs to the end of the file', () => {
    assert.deepEqual(lockfileOverrides('overrides:\n  ws@^8: 8.22.1', LOCKFILE), {
      'ws@^8': '8.22.1',
    })
  })
  it('reads a lockfile with CRLF line endings', () => {
    const text = ['overrides:', '  ws@^8: ^8.22.1', '', 'importers:'].join('\r\n')
    assert.deepEqual(lockfileOverrides(text, LOCKFILE), { 'ws@^8': '^8.22.1' })
  })
  it('reads nothing from a lockfile without overrides', () => {
    assert.deepEqual(lockfileOverrides("lockfileVersion: '9.0'\n", LOCKFILE), {})
  })
  for (const line of [
    '  ws@^8:',
    '    ws@^8: 8.22.1',
    '  ws@^8: { version: 8.22.1 }',
    'ws@^8: 8.22.1',
  ]) {
    it(`throws on a line it cannot read: ${JSON.stringify(line)}`, () => {
      assert.throws(
        () => lockfileOverrides(`overrides:\n${line}\n`, LOCKFILE),
        /cannot read override/,
      )
    })
  }
})
