// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// What `pnpm check:versions` counts as exact, and where it reads the specs from.
// Zero dependencies, run by Node's own type stripping.

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const NPM_ALIAS = /^npm:(?:@[^/@]+\/)?[^/@]+@(.+)$/
// An override may name a direct dependency's spec instead, which is checked where it is declared.
const DEPENDENCY_REFERENCE = /^\$(?:@[^/\s]+\/)?[^/\s]+$/
// `pnpm publish` rewrites `workspace:*` to the exact version; `workspace:^` would ship a range.
export const WORKSPACE_EXACT = 'workspace:*'
// Peer dependencies are ranges by design: they state what a consumer may bring.
export const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
] as const

export type Manifest = Partial<Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>>

export function isExact(spec: string): boolean {
  if (spec === WORKSPACE_EXACT) return true
  const alias = NPM_ALIAS.exec(spec)
  return EXACT_VERSION.test(alias ? alias[1] : spec)
}

export function isExactOverride(spec: string): boolean {
  return DEPENDENCY_REFERENCE.test(spec) || isExact(spec)
}

/** Each `"<field> <name>"` whose spec is a range, with that spec. */
export function manifestRanges(manifest: Manifest): [string, string][] {
  return DEPENDENCY_FIELDS.flatMap((field) =>
    Object.entries(manifest[field] ?? {})
      .filter(([, spec]) => !isExact(spec))
      .map(([name, spec]): [string, string] => [`${field} ${name}`, spec]),
  )
}

/**
 * The `overrides:` block of a pnpm lockfile, which pnpm writes in one form: a bare top-level
 * `overrides:`, then one `  key: value` line per entry up to a blank line. `--frozen-lockfile`
 * keeps it equal to `pnpm-workspace.yaml`, however that file spells it. A line that is not in
 * that form throws, so an entry is never skipped unseen.
 */
export function lockfileOverrides(text: string, file: string): Record<string, string> {
  const overrides: Record<string, string> = {}
  const lines = text.split('\n')
  const start = lines.indexOf('overrides:')
  if (start === -1) return overrides
  for (let index = start + 1; index < lines.length && lines[index] !== ''; index++) {
    const entry = /^ {2}('[^']*'|[^\s':][^:]*): (\S+)$/.exec(lines[index])
    if (!entry) throw new Error(`${file}:${index + 1}: cannot read override "${lines[index]}"`)
    overrides[unquote(entry[1])] = unquote(entry[2])
  }
  return overrides
}

function unquote(value: string): string {
  return /^'.*'$/.test(value) ? value.slice(1, -1).replaceAll("''", "'") : value
}
