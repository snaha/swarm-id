// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The paste-able form of a failure, for the drive dialogs' "View details".
 *
 * Deliberately NOT `error.stack`, which was worse than nothing for two
 * independent reasons:
 *
 * - V8 prefixes the stack with `Error: <message>`; SpiderMonkey and
 *   JavaScriptCore emit the frames alone (`name@url:line:col`). So on Firefox
 *   and Safari the panel showed frames and no message — the one thing the
 *   reader needed was the only thing missing, while the same code looked fine
 *   in Chrome.
 * - The UI production build ships no sourcemaps, so those frames read
 *   `b@…/chunks/DKDmvjIk.js:3:10302` — a location nobody can resolve, us
 *   included.
 *
 * What is worth pasting is the `cause` chain. This codebase wraps on purpose —
 * `CreatePendingError`, `SizeIncreasePendingError`, `payment/drive-operation.ts`
 * — and the wrapper carries the calm sentence written for the user while the
 * cause carries the diagnosis. Only the wrapper was ever shown.
 */

/** A link that is not an `Error`: a thrown string, a postMessage payload. */
function describe(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  try {
    // `??` because `JSON.stringify(undefined)` is `undefined`, not a string.
    return JSON.stringify(value) ?? String(value)
  } catch {
    // Cyclic, or holding a BigInt. `String` still says something.
    return String(value)
  }
}

/**
 * Every link of the chain, one per line, deepest last.
 *
 * Returns `''` when there is nothing the dialog is not already showing above
 * the button — a plain `Error` with no cause, whose message is the whole story.
 * `drive-dialog-status.svelte` hides the affordance on an empty string, so
 * "View details" never promises detail it does not have.
 */
export function failureDetail(caught: unknown): string {
  if (!(caught instanceof Error)) {
    return describe(caught)
  }

  const links: string[] = []
  // A `cause` chain is ordinary data and can be made to loop; a bug report is
  // not worth hanging the dialog for.
  const seen = new Set<unknown>()
  let current: unknown = caught

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    if (!(current instanceof Error)) {
      links.push(describe(current))
      break
    }
    links.push(`${current.name}: ${current.message}`)
    current = current.cause
  }

  if (links.length === 1 && caught.name === 'Error') {
    return ''
  }
  return links.join('\ncaused by ')
}
