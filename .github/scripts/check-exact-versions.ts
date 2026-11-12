// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Fails when a dependency or override names a range instead of an exact version
// (AGENTS.md, "Dependency versions are exact"): `pnpm check:versions`. Reads every
// package.json git does not ignore and the overrides of every pnpm lockfile.
// `packageExtensions` are not checked: they extend third-party packages, and the
// lockfile pins what they resolve to.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
// Node's type stripping resolves no extensionless import.
import {
  type Manifest,
  WORKSPACE_EXACT,
  isExactOverride,
  lockfileOverrides,
  manifestRanges,
} from './exact-versions.ts'

const LIST_FILES = ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
const files = execFileSync('git', LIST_FILES, { encoding: 'utf8' })
  .split('\0')
  .filter((path) => path !== '' && existsSync(path))
const named = (name: string) =>
  [...new Set(files)].filter((path) => path === name || path.endsWith(`/${name}`))
const manifests = named('package.json')
const lockfiles = named('pnpm-lock.yaml')

const violations: string[] = []
for (const path of manifests) {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest
  for (const [where, spec] of manifestRanges(manifest)) {
    violations.push(`${path} ${where} "${spec}"`)
  }
}
for (const path of lockfiles) {
  for (const [selector, spec] of Object.entries(
    lockfileOverrides(readFileSync(path, 'utf8'), path),
  )) {
    if (!isExactOverride(spec)) violations.push(`${path} overrides ${selector} "${spec}"`)
  }
}

if (violations.length > 0) {
  console.error(`Not an exact version (${violations.length}):`)
  for (const violation of violations) console.error(`  ${violation}`)
  console.error(
    `\nPin each to the exact version its lockfile resolves, e.g. "^13.0.0" -> "13.0.0", or "${WORKSPACE_EXACT}" for a workspace package. An override may also reference a direct dependency, "$name". Fix an override in pnpm-workspace.yaml, then run pnpm install.`,
  )
  process.exit(1)
}

console.log(
  `All dependency versions are exact (${manifests.length} manifests, ${lockfiles.length} lockfiles).`,
)
