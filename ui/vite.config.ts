// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

import { stampWorkerDev } from '../lib/dev/vite-stamp-worker.js'

/**
 * Swap the dev funding seam for its inert stub in a shipped build, so the local
 * payment rail — and the anvil cheat codes and dev faucet private key it pulls
 * in behind `@swarm-id/multichain/dev` — never reach a production bundle.
 *
 * A plugin rather than a `resolve.alias` entry, because SvelteKit's own `$lib`
 * alias resolves the specifier first and ours would never see it. The alias
 * plugin re-resolves what it rewrote with `skipSelf`, so a `pre` plugin does
 * get the absolute path — which is what this matches.
 *
 * Verify with a build, not by reading: CI greps the built assets for markers
 * that sit on the leak path (`resolveLocalRail` → the local rail → the solver
 * address and the source-chain URL), and every match must be inside the `/dev`
 * route's own `_app/immutable/nodes/` chunk — the one place the dev tree is
 * allowed. The seam is unenforceable by inspection, and it has been silently
 * broken by a single stray import before.
 */
function stubDevFunding(): Plugin {
  const stub = fileURLToPath(
    new URL('./src/lib/payment/dev-funding.production.ts', import.meta.url),
  )
  // Anchored past an optional extension, so it cannot swallow the stub itself.
  const seam = /[/\\]lib[/\\]payment[/\\]dev-funding(\.ts)?$/
  return {
    name: 'swarm-id:stub-dev-funding',
    enforce: 'pre',
    apply: 'build',
    resolveId(source, importer) {
      // Only the `$lib` alias hands this hook an absolute path. A sibling in
      // the same directory importing `./dev-funding` arrives as written, and
      // would sail straight past an anchored pattern — so resolve it first.
      const id = source.startsWith('.') && importer ? resolve(dirname(importer), source) : source
      return seam.test(id) ? stub : undefined
    },
  }
}

export default defineConfig(({ command }) => ({
  plugins: [tailwindcss(), sveltekit(), stampWorkerDev(), stubDevFunding()],
  resolve: {
    // Dev consumes the lib SOURCE for reliable HMR (#347); `vite build`
    // resolves the published dist bundle via package exports as before.
    alias:
      command === 'serve'
        ? {
            '@snaha/swarm-id': fileURLToPath(new URL('../lib/src/index.ts', import.meta.url)),
          }
        : undefined,
  },
  optimizeDeps: {
    exclude: ['@snaha/swarm-id'],
  },
  test: {
    include: ['src/**/*.{test,spec}.{js,ts}'],
    // `*.live.test.ts` talks to a hosted service; it runs from
    // `vitest.live.config.ts` so `check:all` stays offline-clean.
    exclude: ['src/**/*.live.test.ts'],
  },
}))
