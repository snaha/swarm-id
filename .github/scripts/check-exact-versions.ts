// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Fails when a dependency or override names a range instead of an exact version
// (AGENTS.md, "Dependency versions are exact"). Zero dependencies, run by Node's
// own type stripping: `pnpm check:versions`.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const NPM_ALIAS = /^npm:(?:@[^/@]+\/)?[^/@]+@(.+)$/
// `pnpm publish` rewrites `workspace:*` to the exact version; `workspace:^` would ship a range.
const WORKSPACE_EXACT = 'workspace:*'
// Peer dependencies are ranges by design: they state what a consumer may bring.
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const
const WORKSPACE_FILE = 'pnpm-workspace.yaml'

type Manifest = Partial<Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>> & {
  pnpm?: { overrides?: Record<string, string> }
}

function isExact(spec: string): boolean {
  if (spec === WORKSPACE_EXACT) return true
  const alias = NPM_ALIAS.exec(spec)
  return EXACT_VERSION.test(alias ? alias[1] : spec)
}

// The `overrides:` block of pnpm-workspace.yaml: one `key: value` per line. A line
// this cannot read fails the check, so an unusual entry is never skipped unseen.
function workspaceOverrides(text: string): Record<string, string> {
  const overrides: Record<string, string> = {}
  let inBlock = false
  for (const [index, line] of text.split('\n').entries()) {
    if (/^overrides:\s*$/.test(line)) {
      inBlock = true
      continue
    }
    if (!inBlock || /^\s*(#.*)?$/.test(line)) continue
    if (/^\S/.test(line)) break
    const entry =
      /^\s+('[^']*'|"[^"]*"|[^\s'"#][^:]*?):\s*('[^']*'|"[^"]*"|[^\s#]+)\s*(#.*)?$/.exec(line)
    if (!entry)
      throw new Error(`${WORKSPACE_FILE}:${index + 1}: cannot read override "${line.trim()}"`)
    overrides[unquote(entry[1])] = unquote(entry[2])
  }
  return overrides
}

function unquote(value: string): string {
  return /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value
}

const manifests = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((path) => path === 'package.json' || path.endsWith('/package.json'))

const violations: string[] = []
const report = (where: string, name: string, spec: string) => {
  if (!isExact(spec)) violations.push(`${where}: ${name} "${spec}"`)
}

for (const path of manifests) {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      report(`${path} ${field}`, name, spec)
    }
  }
  for (const [selector, spec] of Object.entries(manifest.pnpm?.overrides ?? {})) {
    report(`${path} pnpm.overrides`, selector, spec)
  }
}

for (const [selector, spec] of Object.entries(
  workspaceOverrides(readFileSync(WORKSPACE_FILE, 'utf8')),
)) {
  report(`${WORKSPACE_FILE} overrides`, selector, spec)
}

if (violations.length > 0) {
  console.error(`Not an exact version (${violations.length}):`)
  for (const violation of violations) console.error(`  ${violation}`)
  console.error(
    `\nPin each to the exact version its lockfile resolves, e.g. "^13.0.0" -> "13.0.0", or "${WORKSPACE_EXACT}" for a workspace package.`,
  )
  process.exit(1)
}

console.log(`All dependency versions are exact (${manifests.length} manifests, ${WORKSPACE_FILE}).`)
