// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

import { stampWorkerDev } from '../lib/dev/vite-stamp-worker.js'

/**
 * Swap the dev-only modules for inert stubs in a shipped build, so the local
 * payment rail — and the anvil cheat codes and dev faucet private key it pulls
 * in behind `@swarm-id/multichain/dev` — never reach a production bundle. Two
 * things import that tree:
 *
 * - the dev funding seam, `$lib/payment/dev-funding`, the one module
 *   production code may reach it through;
 * - the `/dev` route, which imports it directly and keeps its own copy. Its
 *   `prerender = false` only keeps a `dev.html` out of the static output — the
 *   adapter's `index.html` fallback serves the route anyway wherever the host
 *   has a catch-all, and the client router then loads its chunk, dev tools and
 *   all, on the production domain. The stub answers 404.
 *
 * The two are swapped differently. The seam's import is redirected to the stub
 * module: a plugin rather than a `resolve.alias` entry, because SvelteKit's
 * own `$lib` alias resolves the specifier first and ours would never see it —
 * the alias plugin re-resolves what it rewrote with `skipSelf`, so a `pre`
 * plugin does get the absolute path, which is what the pattern matches. The
 * route's page keeps its id and is handed the stub's SOURCE instead: SvelteKit
 * looks a route's component up in the Vite manifest by its source path, and a
 * redirected id is simply not there. (Its `+page.ts` needs no swap — it
 * carries only `prerender = false`, and imports nothing.)
 *
 * Verify with a build, not by reading: CI greps the built assets for markers
 * that sit on the leak path (`resolveLocalRail` → the local rail → the solver
 * address and the source-chain URL, and a label of the `/dev` page itself),
 * and no chunk may carry any of them. The swaps are unenforceable by
 * inspection, and the seam has been silently broken by a single stray import
 * before.
 */
function stubDevOnlyModules(): Plugin {
  // Each stub is spelled out as `new URL(…, import.meta.url)` so knip can follow
  // it — a helper wrapping the literal hides the file, and knip reports it unused.
  // Anchored past an optional extension, so it cannot swallow the stub itself.
  const seam = /[/\\]lib[/\\]payment[/\\]dev-funding(\.ts)?$/
  const seamStub = fileURLToPath(
    new URL('./src/lib/payment/dev-funding.production.ts', import.meta.url),
  )
  const routePage = /[/\\]src[/\\]routes[/\\]dev[/\\]\+page\.svelte$/
  const routeStub = fileURLToPath(
    new URL('./src/routes/dev/page.production.svelte', import.meta.url),
  )
  return {
    name: 'swarm-id:stub-dev-only-modules',
    enforce: 'pre',
    apply: 'build',
    resolveId(source, importer) {
      // Only the `$lib` alias hands this hook an absolute path. A sibling in
      // the same directory importing `./dev-funding` arrives as written, and
      // would sail straight past an anchored pattern — so resolve it first.
      const id = source.startsWith('.') && importer ? resolve(dirname(importer), source) : source
      return seam.test(id) ? seamStub : undefined
    },
    load(id) {
      return routePage.test(id) ? readFileSync(routeStub, 'utf8') : undefined
    },
  }
}

export default defineConfig(({ command }) => ({
  plugins: [tailwindcss(), sveltekit(), stampWorkerDev(), stubDevOnlyModules()],
  resolve: {
    // Dev consumes the lib SOURCE for reliable HMR (#347); `vite build`
    // resolves the published dist bundle via package exports as before.
    alias:
      command === 'serve'
        ? {
            '@snaha/swarm-id/internal': fileURLToPath(
              new URL('../lib/src/internal.ts', import.meta.url),
            ),
            '@snaha/swarm-id': fileURLToPath(new URL('../lib/src/index.ts', import.meta.url)),
          }
        : undefined,
  },
  optimizeDeps: {
    exclude: ['@snaha/swarm-id', '@snaha/swarm-id/internal'],
  },
  test: {
    include: ['src/**/*.{test,spec}.{js,ts}'],
    // Component tests are Playwright's, not vitest's. And `*.live.test.ts`
    // talks to a hosted service; it runs from `vitest.live.config.ts` so
    // `check:all` stays offline-clean.
    exclude: ['src/**/*.ct.{test,spec}.{js,ts}', 'src/**/*.live.test.ts'],
  },
}))
